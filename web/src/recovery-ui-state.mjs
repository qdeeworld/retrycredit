import { getAddress } from "ethers";

const RECOVERY_CHALLENGE_LIFETIME_SECONDS = 5 * 60;
const RECOVERY_CONSENT_FINAL_LINE = "Authorize proof and relayer submission for this exact pair. The campaign contract derives the credit recipient from Ethereum; no destination can be substituted.";
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const ETHEREUM_ATTESTCOIN_CHAIN_KEY = 3;
const CREDITCOIN_TESTNET_CHAIN_ID = 102031;

function normalizeWallet(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizeHash(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function normalizeCampaignNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeOrigin(value) {
  if (typeof value !== "string") return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function recoveryBoundary(config) {
  const poolAddress = normalizeWallet(config?.poolAddress);
  const campaignNumber = normalizeCampaignNumber(config?.campaignNumber);
  if (!poolAddress || campaignNumber === null) return null;
  return Object.freeze({ poolAddress, campaignNumber });
}

export function walletsMatch(left, right) {
  const normalizedLeft = normalizeWallet(left);
  const normalizedRight = normalizeWallet(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function isRecoveryChallengeExpired(error) {
  return error?.code === "RECOVERY_CHALLENGE_EXPIRED";
}

export function isRecoveryResponseMismatch(error) {
  return error?.code === "RECOVERY_RESPONSE_MISMATCH";
}

export function recoveryConfigsMatch(left, right) {
  const leftIdentity = recoveryConfigIdentity(left);
  const rightIdentity = recoveryConfigIdentity(right);
  return Boolean(leftIdentity && leftIdentity === rightIdentity);
}

export function recoveryCampaignsMatch(left, right) {
  const leftIdentity = recoveryCampaignIdentity(left);
  const rightIdentity = recoveryCampaignIdentity(right);
  return Boolean(leftIdentity && leftIdentity === rightIdentity);
}

export function validateRecoveryConfigResponse(response) {
  if (typeof response?.enabled !== "boolean") throw responseMismatch();
  const hasExpectedNetworks = response?.source?.chainId === ETHEREUM_MAINNET_CHAIN_ID
    && response?.source?.chainKey === ETHEREUM_ATTESTCOIN_CHAIN_KEY
    && response?.settlement?.chainId === CREDITCOIN_TESTNET_CHAIN_ID;
  const hasFeaturedIdentity = isAddress(response?.featuredCase?.wallet)
    && isHash(response?.featuredCase?.failedTransactionHash)
    && isHash(response?.featuredCase?.successfulTransactionHash);
  if (!response.enabled) {
    if (
      response.waking !== false
      || !hasExpectedNetworks
      || response.publicOrigin !== null
      || response.poolAddress !== null
      || response.campaignNumber !== null
      || response.campaign !== null
      || response.rule !== null
      || response.capacity !== null
      || !hasFeaturedIdentity
    ) throw responseMismatch();
    return Object.freeze({ ...response });
  }
  const publicOrigin = normalizeOrigin(response.publicOrigin);
  if (
    response.waking !== false
    || !hasExpectedNetworks
    || !isAddress(response.poolAddress)
    || !Number.isSafeInteger(response.campaignNumber)
    || response.campaignNumber <= 0
    || !publicOrigin
    || publicOrigin !== response.publicOrigin
    || typeof response?.campaign?.creditAmount !== "string"
    || !isPositiveUint(response?.campaign?.creditAmount)
    || !hasFeaturedIdentity
  ) {
    throw responseMismatch();
  }
  return Object.freeze({ ...response, publicOrigin });
}

export function validateEligibilityResponse({ response, requestedWallet, config, expectedPair } = {}) {
  const boundary = requireRecoveryBoundary(config);
  requireResponseWallet(response, requestedWallet);
  requireResponseCampaign(response, boundary);

  const status = response?.status;
  const validStatuses = new Set(["eligible", "claimed", "not-found", "closed", "full"]);
  if (!validStatuses.has(status)) throw responseMismatch();
  if (status === "not-found") {
    if (response.eligible !== false || response.pair != null || response.release != null) {
      throw responseMismatch();
    }
  } else {
    requirePair(response.pair, expectedPair);
    if (status === "eligible" && (response.eligible !== true || response.release != null)) {
      throw responseMismatch();
    }
    if (status === "claimed") {
      if (response.eligible !== false) throw responseMismatch();
      requireRelease(response.release, response, boundary);
    }
    if (["closed", "full"].includes(status) && (response.eligible !== false || response.release != null)) {
      throw responseMismatch();
    }
  }
  requireCreditAmount(response, config, { allowNull: status === "not-found" });
  return bindRecoveryBoundary(response, boundary);
}

export function validateChallengeResponse({ response, wallet, eligibility, config, currentOrigin } = {}) {
  const boundary = requireRecoveryBoundary(config);
  if (!recoveryRecordMatchesConfig(eligibility, config)) throw responseMismatch();
  requireResponseWallet(response, wallet);
  requireResponseCampaign(response, boundary);
  if (!walletsMatch(response?.poolAddress, boundary.poolAddress)) throw responseMismatch();
  requirePair(response?.pair, eligibility?.pair);
  if (
    !Number.isSafeInteger(response?.issuedAt)
    || !Number.isSafeInteger(response?.expiresAt)
    || response.issuedAt <= 0
    || response.expiresAt - response.issuedAt !== RECOVERY_CHALLENGE_LIFETIME_SECONDS
    || normalizeOrigin(currentOrigin) !== config.publicOrigin
  ) {
    throw responseMismatch();
  }
  const expectedMessage = recoveryChallengeMessage({
    config,
    wallet: eligibility.wallet,
    pair: eligibility.pair,
    issuedAt: response.issuedAt,
    expiresAt: response.expiresAt,
  });
  if (response.message !== expectedMessage) throw responseMismatch();
  return response;
}

export function validateReleaseResponse({ response, wallet, eligibility, config } = {}) {
  const boundary = requireRecoveryBoundary(config);
  if (!recoveryRecordMatchesConfig(eligibility, config)) throw responseMismatch();
  requireResponseWallet(response, wallet);
  requireResponseCampaign(response, boundary);
  if (!["released", "claimed"].includes(response?.status)) throw responseMismatch();
  requirePair(response?.pair, eligibility?.pair);
  requireCreditAmount(response, config);
  requireRelease(response?.release, response, boundary);
  return bindRecoveryBoundary(response, boundary);
}

export function createWalletOperationGuard(initialAccount = "") {
  let account = normalizeWallet(initialAccount);
  let version = 0;

  return Object.freeze({
    begin(wallet) {
      version += 1;
      return Object.freeze({ version, wallet: normalizeWallet(wallet) });
    },
    currentAccount() {
      return account;
    },
    isCurrent(operation) {
      return Boolean(
        operation
        && operation.version === version
        && operation.wallet
        && operation.wallet === account
      );
    },
    setAccount(wallet) {
      const next = normalizeWallet(wallet);
      if (next === account) return false;
      account = next;
      version += 1;
      return true;
    },
  });
}

export function selectVisibleRelease({ account, config, eligibility, releaseResult }) {
  if (
    eligibility?.release
    && walletsMatch(eligibility.wallet, account)
    && recoveryRecordMatchesConfig(eligibility, config)
  ) {
    return { ...eligibility, status: "claimed" };
  }
  if (
    releaseResult?.release
    && walletsMatch(releaseResult.wallet, account)
    && recoveryRecordMatchesConfig(releaseResult, config)
  ) return releaseResult;
  return null;
}

export function selectFeaturedRelease({ config, eligibility, releaseResult, featuredEligibility }) {
  const candidates = [featuredEligibility, eligibility, releaseResult];
  for (const record of candidates) {
    if (
      record?.release
      && recoveryRecordMatchesConfig(record, config)
      && recordMatchesFeaturedCase(record, config?.featuredCase)
    ) return record.release;
  }
  return null;
}

export function selectRecoveryEvidence({
  config,
  eligibility,
  releaseResult,
  featuredEligibility,
  featuredCase,
}) {
  const currentEligibility = recoveryRecordMatchesConfig(eligibility, config) ? eligibility : null;
  const currentRelease = recoveryRecordMatchesConfig(releaseResult, config) ? releaseResult : null;
  const currentFeatured = recoveryRecordMatchesConfig(featuredEligibility, config)
    && recordMatchesFeaturedCase(featuredEligibility, config?.featuredCase)
    ? featuredEligibility
    : null;
  if (currentEligibility !== null && currentEligibility !== undefined) {
    return evidenceFromRecord(currentEligibility, "wallet");
  }
  if (currentRelease?.pair) return evidenceFromRecord(currentRelease, "wallet");
  if (currentFeatured?.pair) return evidenceFromRecord(currentFeatured, "featured");
  if (featuredCase) {
    return evidenceFromRecord({
      wallet: featuredCase.wallet,
      pair: featuredCase,
      release: null,
      creditAmount: null,
    }, "featured");
  }
  return emptyEvidence("empty");
}

function evidenceFromRecord(record, source) {
  if (!hasPairIdentity(record?.pair)) return emptyEvidence(source);
  return Object.freeze({
    source,
    wallet: record.wallet ?? null,
    pair: record.pair,
    release: record.release ?? null,
    creditAmount: record.creditAmount ?? null,
  });
}

function emptyEvidence(source) {
  return Object.freeze({
    source,
    wallet: null,
    pair: null,
    release: null,
    creditAmount: null,
  });
}

function hasPairIdentity(pair) {
  return Boolean(pair?.failedTransactionHash && pair?.successfulTransactionHash);
}

export function recoveryRecordMatchesConfig(record, config) {
  if (!record) return false;
  if (!config) return true;
  const boundary = recoveryBoundary(config);
  const bound = recoveryBoundary(record.recoveryBoundary);
  const identity = recoveryCampaignIdentity(config);
  return Boolean(
    boundary
    && bound
    && identity
    && boundary.poolAddress === bound.poolAddress
    && boundary.campaignNumber === bound.campaignNumber
    && normalizeCampaignNumber(record.campaignNumber) === boundary.campaignNumber
    && record.recoveryIdentity === identity
  );
}

function requireRecoveryBoundary(config) {
  const boundary = recoveryBoundary(config);
  const configIdentity = recoveryCampaignIdentity(config);
  if (!config?.enabled || !boundary || !configIdentity) throw responseMismatch();
  return Object.freeze({ ...boundary, configIdentity });
}

function requireResponseWallet(response, expectedWallet) {
  if (!walletsMatch(response?.wallet, expectedWallet)) throw responseMismatch();
}

function requireResponseCampaign(response, boundary) {
  if (normalizeCampaignNumber(response?.campaignNumber) !== boundary.campaignNumber) {
    throw responseMismatch();
  }
}

function requirePair(pair, expectedPair) {
  if (!isHash(pair?.failedTransactionHash) || !isHash(pair?.successfulTransactionHash)) {
    throw responseMismatch();
  }
  if (expectedPair && (
    normalizeHash(pair.failedTransactionHash) !== normalizeHash(expectedPair.failedTransactionHash)
    || normalizeHash(pair.successfulTransactionHash) !== normalizeHash(expectedPair.successfulTransactionHash)
  )) {
    throw responseMismatch();
  }
}

function requireCreditAmount(response, config, { allowNull = false } = {}) {
  if (allowNull && response?.creditAmount == null) return;
  const expected = config?.campaign?.creditAmount;
  if (expected == null || String(response?.creditAmount) !== String(expected)) throw responseMismatch();
}

function requireRelease(release, response, boundary) {
  if (
    !isHash(release?.transactionHash)
    || normalizeCampaignNumber(release?.campaignNumber) !== boundary.campaignNumber
    || !walletsMatch(release?.beneficiary, response?.wallet)
    || String(release?.creditAmount) !== String(response?.creditAmount)
  ) {
    throw responseMismatch();
  }
}

function bindRecoveryBoundary(response, boundary) {
  return Object.freeze({
    ...response,
    recoveryBoundary: Object.freeze({
      poolAddress: boundary.poolAddress,
      campaignNumber: boundary.campaignNumber,
    }),
    recoveryIdentity: recoveryConfigIdentityFromBoundary(boundary),
  });
}

function recoveryChallengeMessage({ config, wallet, pair, issuedAt, expiresAt }) {
  return [
    "RetryCredit recovery consent",
    `Origin: ${config.publicOrigin}`,
    `Settlement: Creditcoin Testnet (${Number(config.settlement.chainId)})`,
    `Recovery pool: ${getAddress(config.poolAddress)}`,
    `Campaign: ${normalizeCampaignNumber(config.campaignNumber)}`,
    `Source wallet and credit recipient: ${getAddress(wallet)}`,
    `Failed Ethereum transaction: ${normalizeHash(pair.failedTransactionHash)}`,
    `Successful Ethereum transaction: ${normalizeHash(pair.successfulTransactionHash)}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
    RECOVERY_CONSENT_FINAL_LINE,
  ].join("\n");
}

function recoveryConfigIdentity(config) {
  const campaignIdentity = recoveryCampaignIdentity(config);
  if (!campaignIdentity) return "";
  const featured = config?.featuredCase;
  if (
    !isAddress(featured?.wallet)
    || !isHash(featured?.failedTransactionHash)
    || !isHash(featured?.successfulTransactionHash)
  ) return "";
  return JSON.stringify([
    campaignIdentity,
    normalizeWallet(featured.wallet),
    normalizeHash(featured.failedTransactionHash),
    normalizeHash(featured.successfulTransactionHash),
  ]);
}

function recoveryCampaignIdentity(config) {
  const boundary = recoveryBoundary(config);
  if (!boundary) return "";
  const publicOrigin = normalizeOrigin(config?.publicOrigin);
  const sourceChainId = Number(config?.source?.chainId);
  const sourceChainKey = Number(config?.source?.chainKey);
  const settlementChainId = Number(config?.settlement?.chainId);
  const creditAmount = config?.campaign?.creditAmount;
  if (
    !publicOrigin
    || !Number.isSafeInteger(sourceChainId)
    || sourceChainId <= 0
    || !Number.isSafeInteger(sourceChainKey)
    || sourceChainKey <= 0
    || !Number.isSafeInteger(settlementChainId)
    || settlementChainId <= 0
    || !isPositiveUint(creditAmount)
  ) return "";
  return JSON.stringify([
    boundary.poolAddress,
    boundary.campaignNumber,
    publicOrigin,
    sourceChainId,
    sourceChainKey,
    settlementChainId,
    String(creditAmount),
  ]);
}

function recoveryConfigIdentityFromBoundary(boundary) {
  return boundary.configIdentity ?? "";
}

function recordMatchesFeaturedCase(record, featuredCase) {
  return Boolean(
    walletsMatch(record?.wallet, featuredCase?.wallet)
    && normalizeHash(record?.pair?.failedTransactionHash)
      === normalizeHash(featuredCase?.failedTransactionHash)
    && normalizeHash(record?.pair?.successfulTransactionHash)
      === normalizeHash(featuredCase?.successfulTransactionHash)
  );
}

function isHash(value) {
  return /^0x[0-9a-f]{64}$/i.test(value ?? "");
}

function isAddress(value) {
  return /^0x[0-9a-f]{40}$/i.test(value ?? "") && !/^0x0{40}$/i.test(value);
}

function isPositiveUint(value) {
  try {
    return /^\d+$/.test(String(value)) && BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function responseMismatch() {
  const error = new Error("The recovery service returned evidence for a different wallet or campaign. Refresh and check this wallet again.");
  error.code = "RECOVERY_RESPONSE_MISMATCH";
  return error;
}
