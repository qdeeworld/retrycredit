import {
  ZeroAddress,
  getAddress,
  isHexString,
  verifyMessage,
} from "ethers";

import {
  CloudflareApiError,
  FRESH_READ_MINIMUM_INTERVAL_MS,
  FRESH_READ_NOT_BEFORE_KEY,
} from "./cloudflare-worker-core.mjs";
import {
  RECOVERY_CHALLENGE_LIFETIME_SECONDS,
  RECOVERY_MAXIMUM_CLOCK_SKEW_SECONDS,
  formatRecoveryChallengeMessage,
} from "./recovery-consent.mjs";

const FRESH_READ_HMAC_KEY = "fresh-config:receipt-hmac-key:v1";
const FRESH_READ_USED_AUTHORIZATIONS_KEY = "fresh-config:used-authorizations:v1";
const FRESH_READ_RECEIPT_PREFIX = "v1.";
const FRESH_READ_RECEIPT_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const FRESH_READ_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_FRESH_READ_CREDENTIAL_LENGTH = 2_048;
const MAX_USED_AUTHORIZATIONS_HARD_LIMIT = 2_048;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function createSignedFreshReadControl({
  storage,
  publicOrigin,
  poolAddress,
  campaignNumber,
  now = Date.now,
  minimumIntervalMs = FRESH_READ_MINIMUM_INTERVAL_MS,
  challengeLifetimeSeconds = RECOVERY_CHALLENGE_LIFETIME_SECONDS,
  maximumClockSkewSeconds = RECOVERY_MAXIMUM_CLOCK_SKEW_SECONDS,
  recoverSigner = verifyMessage,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (
    !storage
    || typeof storage.get !== "function"
    || typeof storage.transaction !== "function"
  ) {
    throw new TypeError("Durable Object storage is required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof recoverSigner !== "function") throw new TypeError("recoverSigner must be a function");
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== "function") {
    throw new TypeError("Web Crypto is required");
  }
  requireInterval(minimumIntervalMs);
  requireLifetime(challengeLifetimeSeconds, "challengeLifetimeSeconds", 60, 900);
  requireLifetime(maximumClockSkewSeconds, "maximumClockSkewSeconds", 0, 300);
  const maximumUsedAuthorizations = Math.ceil(
    ((challengeLifetimeSeconds + maximumClockSkewSeconds + 1) * 1_000) / minimumIntervalMs,
  ) + 1;
  if (maximumUsedAuthorizations > MAX_USED_AUTHORIZATIONS_HARD_LIMIT) {
    throw new TypeError("fresh-read replay state would exceed its safe bound");
  }

  const boundary = Object.freeze({
    publicOrigin: requirePublicOrigin(publicOrigin),
    poolAddress: requireConfiguredAddress(poolAddress, "recovery pool"),
    campaignNumber: requireConfiguredPositiveInteger(campaignNumber, "recovery campaign"),
  });

  async function issueReceipt(challenge) {
    const issuedAtMs = requireClock(now());
    const normalized = normalizeChallenge(challenge, boundary, {
      nowSeconds: Math.floor(issuedAtMs / 1_000),
      challengeLifetimeSeconds,
      maximumClockSkewSeconds,
      internal: true,
    });
    const key = await loadReceiptKey({ create: true });
    let receiptBytes;
    try {
      receiptBytes = await cryptoImpl.subtle.sign(
        "HMAC",
        key,
        textEncoder.encode(freshReadReceiptMessage(normalized.message)),
      );
    } catch (error) {
      throw freshReadGateUnavailable(error);
    }
    return FRESH_READ_RECEIPT_PREFIX + encodeBase64Url(new Uint8Array(receiptBytes));
  }

  async function admit(credentialValue) {
    const verificationStartedAtMs = requireClock(now());
    const credential = decodeCredential(credentialValue);
    const normalized = normalizeChallenge(credential, boundary, {
      nowSeconds: Math.floor(verificationStartedAtMs / 1_000),
      challengeLifetimeSeconds,
      maximumClockSkewSeconds,
      internal: false,
    });

    const key = await loadReceiptKey({ create: false });
    const receiptBytes = decodeReceipt(credential.receipt);
    let receiptValid;
    try {
      receiptValid = await cryptoImpl.subtle.verify(
        "HMAC",
        key,
        receiptBytes,
        textEncoder.encode(freshReadReceiptMessage(normalized.message)),
      );
    } catch (error) {
      throw freshReadGateUnavailable(error);
    }
    if (!receiptValid) throw freshReadAuthorizationInvalid();

    let signer;
    try {
      signer = getAddress(recoverSigner(normalized.message, credential.signature));
    } catch (error) {
      throw freshReadAuthorizationInvalid(error);
    }
    if (signer !== normalized.wallet) throw freshReadAuthorizationInvalid();

    let replayDigest;
    try {
      replayDigest = await cryptoImpl.subtle.digest(
        "SHA-256",
        textEncoder.encode(normalized.message),
      );
    } catch (error) {
      throw freshReadGateUnavailable(error);
    }
    const replayId = encodeHex(new Uint8Array(replayDigest));
    const decision = await commitAdmission({
      credential,
      replayId,
    });
    if (decision.admitted !== true) {
      throw new CloudflareApiError(
        "RECOVERY_FRESH_READ_THROTTLED",
        "Fresh campaign data was just checked. Try again in a few seconds.",
        429,
        undefined,
        decision.retryAfter,
      );
    }
  }

  async function loadReceiptKey({ create }) {
    let encoded;
    try {
      if (create) {
        encoded = await storage.transaction(async (transaction) => {
          requireTransaction(transaction);
          const existing = await transaction.get(FRESH_READ_HMAC_KEY);
          if (existing !== undefined) return existing;
          const bytes = new Uint8Array(32);
          cryptoImpl.getRandomValues(bytes);
          const generated = encodeHex(bytes);
          await transaction.put(FRESH_READ_HMAC_KEY, generated);
          return generated;
        });
      } else {
        encoded = await storage.get(FRESH_READ_HMAC_KEY);
      }
    } catch (error) {
      if (error instanceof CloudflareApiError) throw error;
      throw freshReadGateUnavailable(error);
    }
    if (typeof encoded !== "string" || !/^[0-9a-f]{64}$/.test(encoded)) {
      throw freshReadStateInvalid();
    }
    try {
      return await cryptoImpl.subtle.importKey(
        "raw",
        decodeHex(encoded),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
      );
    } catch (error) {
      throw freshReadGateUnavailable(error);
    }
  }

  async function commitAdmission({ credential, replayId }) {
    try {
      return await storage.transaction(async (transaction) => {
        requireTransaction(transaction);
        const committedAtMs = requireClock(now());
        const committedChallenge = normalizeChallenge(credential, boundary, {
          nowSeconds: Math.floor(committedAtMs / 1_000),
          challengeLifetimeSeconds,
          maximumClockSkewSeconds,
          internal: false,
        });
        const notBeforeMs = await transaction.get(FRESH_READ_NOT_BEFORE_KEY);
        if (
          notBeforeMs !== undefined
          && (
            !Number.isSafeInteger(notBeforeMs)
            || notBeforeMs < 0
            || notBeforeMs > committedAtMs + minimumIntervalMs
          )
        ) {
          throw freshReadStateInvalid();
        }

        const nowSeconds = Math.floor(committedAtMs / 1_000);
        const storedAuthorizations = normalizeUsedAuthorizations(
          await transaction.get(FRESH_READ_USED_AUTHORIZATIONS_KEY),
          nowSeconds,
          challengeLifetimeSeconds,
          maximumClockSkewSeconds,
          maximumUsedAuthorizations,
        );
        if (storedAuthorizations.entries.some((entry) => entry.id === replayId)) {
          throw new CloudflareApiError(
            "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
            "This signed campaign check was already used. Check the same pair and authorize again.",
            409,
          );
        }

        if (notBeforeMs !== undefined && committedAtMs < notBeforeMs) {
          if (storedAuthorizations.pruned) {
            await transaction.put(
              FRESH_READ_USED_AUTHORIZATIONS_KEY,
              storedAuthorizations.entries,
            );
          }
          return {
            admitted: false,
            retryAfter: String(Math.max(1, Math.ceil((notBeforeMs - committedAtMs) / 1_000))),
          };
        }

        if (storedAuthorizations.entries.length >= maximumUsedAuthorizations) {
          throw freshReadStateInvalid();
        }
        await transaction.put(FRESH_READ_NOT_BEFORE_KEY, committedAtMs + minimumIntervalMs);
        await transaction.put(FRESH_READ_USED_AUTHORIZATIONS_KEY, [
          ...storedAuthorizations.entries,
          { id: replayId, expiresAt: committedChallenge.expiresAt },
        ]);
        return { admitted: true };
      });
    } catch (error) {
      if (error instanceof CloudflareApiError) throw error;
      throw freshReadGateUnavailable(error);
    }
  }

  return Object.freeze({ issueReceipt, admit });
}

export function encodeFreshReadCredential(credential) {
  return encodeBase64Url(textEncoder.encode(JSON.stringify(credential)));
}

function decodeCredential(value) {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_FRESH_READ_CREDENTIAL_LENGTH
    || !FRESH_READ_CREDENTIAL_PATTERN.test(value)
    || value.length % 4 === 1
  ) {
    throw freshReadAuthorizationInvalid();
  }
  let bytes;
  let decoded;
  try {
    bytes = decodeBase64Url(value);
    if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
    decoded = JSON.parse(textDecoder.decode(bytes));
  } catch (error) {
    throw freshReadAuthorizationInvalid(error);
  }
  requireExactObject(
    decoded,
    ["v", "wallet", "pair", "issuedAt", "expiresAt", "signature", "receipt"],
  );
  requireExactObject(decoded.pair, ["failedTransactionHash", "successfulTransactionHash"]);
  if (decoded.v !== 1) throw freshReadAuthorizationInvalid();
  if (typeof decoded.signature !== "string" || !isHexString(decoded.signature, 65)) {
    throw freshReadAuthorizationInvalid();
  }
  if (typeof decoded.receipt !== "string" || !FRESH_READ_RECEIPT_PATTERN.test(decoded.receipt)) {
    throw freshReadAuthorizationInvalid();
  }
  return decoded;
}

function normalizeChallenge(value, boundary, options) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid challenge");
    const wallet = getAddress(value.wallet);
    if (wallet === ZeroAddress) throw new Error("zero wallet");
    const failedTransactionHash = requireCredentialHash(
      value.pair?.failedTransactionHash,
      "failed transaction hash",
    );
    const successfulTransactionHash = requireCredentialHash(
      value.pair?.successfulTransactionHash,
      "successful transaction hash",
    );
    if (failedTransactionHash === successfulTransactionHash) throw new Error("duplicate pair");
    const issuedAt = requireCredentialTimestamp(value.issuedAt);
    const expiresAt = requireCredentialTimestamp(value.expiresAt);
    if (issuedAt > options.nowSeconds + options.maximumClockSkewSeconds) {
      throw new CloudflareApiError(
        "RECOVERY_CHALLENGE_INVALID",
        "The recovery challenge is not active yet.",
        401,
      );
    }
    if (expiresAt !== issuedAt + options.challengeLifetimeSeconds || expiresAt < options.nowSeconds) {
      throw new CloudflareApiError(
        "RECOVERY_CHALLENGE_EXPIRED",
        "The recovery challenge expired; sign a fresh one.",
        401,
      );
    }
    const message = formatRecoveryChallengeMessage({
      origin: boundary.publicOrigin,
      poolAddress: boundary.poolAddress,
      campaignNumber: boundary.campaignNumber,
      wallet,
      failedTransactionHash,
      successfulTransactionHash,
      issuedAt,
      expiresAt,
    });
    if (options.internal) {
      if (
        value.message !== message
        || getAddress(value.poolAddress) !== boundary.poolAddress
        || Number(value.campaignNumber) !== boundary.campaignNumber
      ) {
        throw new Error("challenge boundary mismatch");
      }
    }
    return Object.freeze({
      wallet,
      failedTransactionHash,
      successfulTransactionHash,
      issuedAt,
      expiresAt,
      message,
    });
  } catch (error) {
    if (error instanceof CloudflareApiError && !options.internal) throw error;
    if (options.internal) throw freshReadGateUnavailable(error);
    throw freshReadAuthorizationInvalid(error);
  }
}

function normalizeUsedAuthorizations(
  value,
  nowSeconds,
  challengeLifetimeSeconds,
  maximumClockSkewSeconds,
  maximumUsedAuthorizations,
) {
  if (value === undefined) return { entries: [], pruned: false };
  if (!Array.isArray(value) || value.length > maximumUsedAuthorizations) {
    throw freshReadStateInvalid();
  }
  const seen = new Set();
  const entries = [];
  let pruned = false;
  for (const entry of value) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, "id")
      || !Object.hasOwn(entry, "expiresAt")
      || typeof entry.id !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.id)
      || !Number.isSafeInteger(entry.expiresAt)
      || entry.expiresAt <= 0
      || entry.expiresAt > nowSeconds + challengeLifetimeSeconds + maximumClockSkewSeconds + 1
      || seen.has(entry.id)
    ) {
      throw freshReadStateInvalid();
    }
    seen.add(entry.id);
    if (entry.expiresAt < nowSeconds) {
      pruned = true;
    } else {
      entries.push({ id: entry.id, expiresAt: entry.expiresAt });
    }
  }
  return { entries, pruned };
}

function freshReadReceiptMessage(challengeMessage) {
  return [
    "RetryCredit fresh-read admission receipt",
    "Version: 1",
    "Method: GET",
    "Path: /api/recovery/config?fresh=1",
    challengeMessage,
  ].join("\n");
}

function decodeReceipt(value) {
  try {
    const encoded = value.slice(FRESH_READ_RECEIPT_PREFIX.length);
    const bytes = decodeBase64Url(encoded);
    if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== encoded) {
      throw new Error("non-canonical receipt");
    }
    return bytes;
  } catch (error) {
    throw freshReadAuthorizationInvalid(error);
  }
}

function requireExactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw freshReadAuthorizationInvalid();
  }
  const allowed = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((field) => !allowed.has(field))) {
    throw freshReadAuthorizationInvalid();
  }
}

function requireCredentialHash(value, label) {
  if (typeof value !== "string" || !isHexString(value, 32)) throw new Error(label);
  return value.toLowerCase();
}

function requireCredentialTimestamp(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid timestamp");
  return value;
}

function requirePublicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.origin !== value || !["https:", "http:"].includes(url.protocol)) throw new Error();
    return value;
  } catch (error) {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", "public origin is invalid", 503, error);
  }
}

function requireConfiguredAddress(value, label) {
  try {
    const address = getAddress(value);
    if (address === ZeroAddress) throw new Error();
    return address;
  } catch (error) {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", label + " is invalid", 503, error);
  }
}

function requireConfiguredPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", label + " is invalid", 503);
  }
  return number;
}

function requireInterval(value) {
  if (
    !Number.isSafeInteger(value)
    || value < 1_000
    || value > 60_000
    || value % 1_000 !== 0
  ) {
    throw new TypeError("minimumIntervalMs must be a whole number of seconds from 1 to 60");
  }
}

function requireLifetime(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(name + " is outside its safe range");
  }
}

function requireClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw freshReadGateUnavailable();
  return value;
}

function requireTransaction(transaction) {
  if (!transaction || typeof transaction.get !== "function" || typeof transaction.put !== "function") {
    throw new TypeError("Durable Object transaction is unavailable");
  }
}

function encodeHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value) {
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function freshReadAuthorizationInvalid(cause) {
  return new CloudflareApiError(
    "RECOVERY_FRESH_AUTHORIZATION_INVALID",
    "The signed campaign-check authorization is invalid.",
    401,
    cause,
  );
}

function freshReadStateInvalid() {
  return new CloudflareApiError(
    "RECOVERY_FRESH_READ_STATE_INVALID",
    "Fresh campaign data cannot be checked right now",
    503,
  );
}

function freshReadGateUnavailable(cause) {
  return new CloudflareApiError(
    "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
    "Fresh campaign data cannot be checked right now",
    503,
    cause,
  );
}
