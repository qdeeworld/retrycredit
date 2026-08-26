export const RECOVERY_RESUME_SCHEMA = "retrycredit.recovery-resume-state";
export const RECOVERY_RESUME_VERSION = 1;
export const RECOVERY_RESUME_STORAGE_KEY = "retrycredit.recovery-resume-state.v1";
export const RECOVERY_RESUME_TTL_MS = 15 * 60 * 1_000;
export const RECOVERY_RESUME_STATUSES = Object.freeze([
  "proof-queued",
  "proof-building",
  "release-relaying",
  "release-processing",
  "release-uncertain",
  "released",
  "already-claimed",
]);

const RECOVERY_RESUME_STATUS_SET = new Set(RECOVERY_RESUME_STATUSES);
const RECORD_KEYS = Object.freeze([
  "campaignNumber",
  "createdAt",
  "expiresAt",
  "failedTransactionHash",
  "failureQueryId",
  "pairId",
  "poolAddress",
  "releaseTransactionHash",
  "schema",
  "status",
  "successQueryId",
  "successfulTransactionHash",
  "ttlMs",
  "updatedAt",
  "version",
  "wallet",
].sort());

/**
 * Persists only the public identity of a recovery that has already been
 * submitted. Extra input fields are intentionally ignored so a caller cannot
 * accidentally serialize a signature, raw transaction, proof, or challenge.
 */
export function saveRecoveryResumeState(state, { sessionStorage, now = Date.now() } = {}) {
  const storage = resolveSessionStorage(sessionStorage);
  const timestamp = normalizeTimestamp(now);
  const normalized = normalizeInputState(state);
  const suppliedCreatedAt = state?.createdAt == null ? null : normalizeTimestamp(state.createdAt);
  if (!storage || timestamp === null || !normalized) {
    if (storage) clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }

  const previous = readStoredRecord(storage, timestamp);
  if (state?.createdAt != null && suppliedCreatedAt === null) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  if (
    previous
    && identitiesMatch(previous, normalized)
    && suppliedCreatedAt !== null
    && suppliedCreatedAt !== previous.createdAt
  ) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  const createdAt = previous
    && identitiesMatch(previous, normalized)
    && previous.createdAt <= timestamp
    ? previous.createdAt
    : suppliedCreatedAt ?? timestamp;
  const expiresAt = createdAt + RECOVERY_RESUME_TTL_MS;
  if (
    !Number.isSafeInteger(expiresAt)
    || createdAt > timestamp
    || timestamp >= expiresAt
  ) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }

  const record = Object.freeze({
    schema: RECOVERY_RESUME_SCHEMA,
    version: RECOVERY_RESUME_VERSION,
    status: normalized.status,
    poolAddress: normalized.poolAddress,
    campaignNumber: normalized.campaignNumber,
    wallet: normalized.wallet,
    failedTransactionHash: normalized.failedTransactionHash,
    successfulTransactionHash: normalized.successfulTransactionHash,
    failureQueryId: normalized.failureQueryId,
    successQueryId: normalized.successQueryId,
    pairId: normalized.pairId,
    releaseTransactionHash: normalized.releaseTransactionHash,
    createdAt,
    updatedAt: timestamp,
    ttlMs: RECOVERY_RESUME_TTL_MS,
    expiresAt,
  });

  try {
    storage.setItem(RECOVERY_RESUME_STORAGE_KEY, JSON.stringify(record));
    return record;
  } catch {
    return null;
  }
}

/**
 * Restores a submitted recovery only when every public identity component
 * matches the caller's current pool, campaign, wallet, and transaction pair.
 */
export function loadRecoveryResumeState(expected, { sessionStorage, now = Date.now() } = {}) {
  const storage = resolveSessionStorage(sessionStorage);
  if (!storage) return null;

  const timestamp = normalizeTimestamp(now);
  const expectedIdentity = normalizeIdentity(expected);
  if (timestamp === null || !expectedIdentity) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }

  const record = readStoredRecord(storage, timestamp);
  if (!record || !identitiesMatch(record, expectedIdentity)) {
    if (record) clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  return record;
}

/**
 * Returns a strictly validated public candidate after a reload when only the
 * live campaign boundary is known. The caller must recheck the stored pair and
 * match its freshly derived wallet before restoring any status. This function
 * never authorizes or submits a release.
 */
export function loadRecoveryResumeCandidate(expectedCampaign, { sessionStorage, now = Date.now() } = {}) {
  const storage = resolveSessionStorage(sessionStorage);
  if (!storage) return null;

  const timestamp = normalizeTimestamp(now);
  const boundary = normalizeCampaignBoundary(expectedCampaign);
  if (timestamp === null || !boundary) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }

  const record = readStoredRecord(storage, timestamp);
  if (
    !record
    || record.poolAddress !== boundary.poolAddress
    || record.campaignNumber !== boundary.campaignNumber
  ) {
    if (record) clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  return record;
}

export function clearRecoveryResumeState({ sessionStorage } = {}) {
  const storage = resolveSessionStorage(sessionStorage);
  if (!storage) return false;
  try {
    storage.removeItem(RECOVERY_RESUME_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function readStoredRecord(storage, now) {
  let raw;
  try {
    raw = storage.getItem(RECOVERY_RESUME_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  if (!isValidStoredRecord(record, now)) {
    clearRecoveryResumeState({ sessionStorage: storage });
    return null;
  }
  return Object.freeze({ ...record });
}

function normalizeInputState(state) {
  const identity = normalizeIdentity(state);
  const status = typeof state?.status === "string" ? state.status : "";
  const failureQueryId = normalizeOptionalHash(state?.failureQueryId);
  const successQueryId = normalizeOptionalHash(state?.successQueryId);
  const pairId = normalizeOptionalHash(state?.pairId);
  const releaseTransactionHash = normalizeOptionalHash(state?.releaseTransactionHash);
  if (
    !identity
    || !RECOVERY_RESUME_STATUS_SET.has(status)
    || failureQueryId === undefined
    || successQueryId === undefined
    || pairId === undefined
    || releaseTransactionHash === undefined
    || (failureQueryId && successQueryId && failureQueryId === successQueryId)
  ) return null;

  return {
    ...identity,
    status,
    failureQueryId,
    successQueryId,
    pairId,
    releaseTransactionHash,
  };
}

function normalizeIdentity(value) {
  const boundary = normalizeCampaignBoundary(value);
  const wallet = normalizeAddress(value?.wallet);
  const failedTransactionHash = normalizeHash(value?.failedTransactionHash);
  const successfulTransactionHash = normalizeHash(value?.successfulTransactionHash);
  if (
    !boundary
    || !wallet
    || !failedTransactionHash
    || !successfulTransactionHash
    || failedTransactionHash === successfulTransactionHash
  ) return null;
  return {
    ...boundary,
    wallet,
    failedTransactionHash,
    successfulTransactionHash,
  };
}

function normalizeCampaignBoundary(value) {
  const poolAddress = normalizeAddress(value?.poolAddress);
  const campaignNumber = normalizeCampaignNumber(value?.campaignNumber);
  return poolAddress && campaignNumber !== null ? { poolAddress, campaignNumber } : null;
}

function isValidStoredRecord(record, now) {
  if (!isPlainObject(record)) return false;
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== RECORD_KEYS[index])) {
    return false;
  }
  if (
    record.schema !== RECOVERY_RESUME_SCHEMA
    || record.version !== RECOVERY_RESUME_VERSION
    || record.ttlMs !== RECOVERY_RESUME_TTL_MS
    || !RECOVERY_RESUME_STATUS_SET.has(record.status)
  ) return false;

  const identity = normalizeIdentity(record);
  if (!identity || !identitiesMatch(record, identity)) return false;
  if (
    record.poolAddress !== identity.poolAddress
    || record.campaignNumber !== identity.campaignNumber
    || record.wallet !== identity.wallet
    || record.failedTransactionHash !== identity.failedTransactionHash
    || record.successfulTransactionHash !== identity.successfulTransactionHash
  ) return false;

  const optionalHashes = [
    record.failureQueryId,
    record.successQueryId,
    record.pairId,
    record.releaseTransactionHash,
  ];
  if (optionalHashes.some((value) => normalizeOptionalHash(value) !== value)) return false;
  if (
    record.failureQueryId
    && record.successQueryId
    && record.failureQueryId === record.successQueryId
  ) return false;

  if (
    normalizeTimestamp(record.createdAt) === null
    || normalizeTimestamp(record.updatedAt) === null
    || normalizeTimestamp(record.expiresAt) === null
    || record.createdAt > record.updatedAt
    || record.updatedAt > now
    || record.expiresAt !== record.createdAt + RECOVERY_RESUME_TTL_MS
    || now >= record.expiresAt
  ) return false;
  return true;
}

function identitiesMatch(left, right) {
  return Boolean(
    left
    && right
    && left.poolAddress === right.poolAddress
    && left.campaignNumber === right.campaignNumber
    && left.wallet === right.wallet
    && left.failedTransactionHash === right.failedTransactionHash
    && left.successfulTransactionHash === right.successfulTransactionHash
  );
}

function normalizeAddress(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized) || /^0x0{40}$/.test(normalized)) return "";
  return normalized;
}

function normalizeHash(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized) || /^0x0{64}$/.test(normalized)) return "";
  return normalized;
}

function normalizeOptionalHash(value) {
  if (value === undefined || value === null) return null;
  return normalizeHash(value) || undefined;
}

function normalizeCampaignNumber(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  try {
    const parsed = BigInt(value.trim());
    return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isPlainObject(value) {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
  );
}

function resolveSessionStorage(explicitStorage) {
  let storage = explicitStorage;
  if (storage === undefined) {
    try {
      storage = globalThis.sessionStorage;
    } catch {
      return null;
    }
  }
  return storage
    && typeof storage.getItem === "function"
    && typeof storage.setItem === "function"
    && typeof storage.removeItem === "function"
    ? storage
    : null;
}
