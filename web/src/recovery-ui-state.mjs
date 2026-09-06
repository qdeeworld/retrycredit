import { getAddress } from "ethers";

const RECOVERY_CHALLENGE_LIFETIME_SECONDS = 5 * 60;
const RECOVERY_CONSENT_FINAL_LINE = "Authorize proof and relayer submission for this exact pair. The campaign contract derives the credit recipient from Ethereum; no destination can be substituted.";
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const ETHEREUM_ATTESTCOIN_CHAIN_KEY = 3;
const CREDITCOIN_TESTNET_CHAIN_ID = 102031;
const RECOVERY_READ_ONLY_REASONS = new Set(["isolated-cloudflare-staging", "isolated-readonly-staging"]);
const RECOVERY_FRESH_READ_ADMISSION_MODES = new Set(["anonymous-v1", "pair-signature-v1"]);
const RECOVERY_FRESH_READ_RECEIPT_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const ROUTESCAN_ATTRIBUTION = Object.freeze({
  label: "Powered by Routescan.io APIs",
  url: "https://routescan.io/",
});

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

export function normalizeEthereumTransactionReference(value) {
  const reference = typeof value === "string" ? value.trim() : "";
  if (isHash(reference)) return normalizeHash(reference);
  const match = reference.match(/^https:\/\/etherscan\.io\/tx\/(0x[0-9a-fA-F]{64})$/);
  if (match) return normalizeHash(match[1]);

  const error = new Error("Enter a 66-character transaction hash or a canonical etherscan.io transaction URL.");
  error.code = "RECOVERY_PAIR_INPUT_INVALID";
  throw error;
}

export function validateRecoveryPairDraft(draft = {}) {
  const errors = {};
  let failedTransactionHash = "";
  let successfulTransactionHash = "";

  try {
    failedTransactionHash = normalizeEthereumTransactionReference(draft.failedTransactionHash);
  } catch (error) {
    errors.failedTransactionHash = error.message;
  }
  try {
    successfulTransactionHash = normalizeEthereumTransactionReference(draft.successfulTransactionHash);
  } catch (error) {
    errors.successfulTransactionHash = error.message;
  }
  if (
    failedTransactionHash
    && successfulTransactionHash
    && failedTransactionHash === successfulTransactionHash
  ) {
    errors.successfulTransactionHash = "The completed retry must be a different transaction from the failed attempt.";
  }

  const valid = Object.keys(errors).length === 0;
  return Object.freeze({
    valid,
    errors: Object.freeze(errors),
    pair: valid
      ? Object.freeze({ failedTransactionHash, successfulTransactionHash })
      : null,
  });
}

export function recoveryPairsMatch(left, right) {
  return Boolean(
    isHash(left?.failedTransactionHash)
    && isHash(left?.successfulTransactionHash)
    && normalizeHash(left.failedTransactionHash) === normalizeHash(right?.failedTransactionHash)
    && normalizeHash(left.successfulTransactionHash) === normalizeHash(right?.successfulTransactionHash)
  );
}

export function isRecoveryChallengeExpired(error) {
  return error?.code === "RECOVERY_CHALLENGE_EXPIRED";
}

export function isRecoveryResponseMismatch(error) {
  return error?.code === "RECOVERY_RESPONSE_MISMATCH";
}

export function isRecoveryPairInvalid(error) {
  return error?.status === 422 && [
    "RECOVERY_PAIR_INVALID",
    "RECOVERY_NOT_FOUND",
    "RECOVERY_PAIR_INELIGIBLE",
  ].includes(error?.code);
}

export function isRecoveryRateLimited(error) {
  return error?.rateLimited === true || error?.status === 429 || error?.code === "RECOVERY_BUSY";
}

export function isRecoveryFreshAuthorizationUsed(error) {
  return error?.status === 409 && error?.code === "RECOVERY_FRESH_READ_AUTHORIZATION_USED";
}

export function isRecoveryFreshAuthorizationRejected(error) {
  return error?.status === 401 && [
    "RECOVERY_FRESH_AUTHORIZATION_REQUIRED",
    "RECOVERY_FRESH_AUTHORIZATION_INVALID",
  ].includes(error?.code);
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

export function isRecoveryConfigReadable(config) {
  return config?.enabled === true || Boolean(
    config?.enabled === false
    && config?.readOnly === true
    && RECOVERY_READ_ONLY_REASONS.has(config?.readOnlyReason)
  );
}

export function canContinueRecoveryAuthorization({ operationCurrent, initialConfig, currentConfig } = {}) {
  const initialState = recoveryAuthorizationStateIdentity(initialConfig);
  const currentState = recoveryAuthorizationStateIdentity(currentConfig);
  return Boolean(operationCurrent === true
    && currentConfig?.enabled === true
    && currentConfig?.readOnly !== true
    && recoveryCampaignsMatch(initialConfig, currentConfig)
    && recoveryCampaignAvailability(currentConfig) === "open"
    && initialState
    && initialState === currentState);
}

export function recoveryAuthorizationInterruptionFlow({ operationCurrent, currentConfig } = {}) {
  if (operationCurrent !== true) return null;
  if (!isRecoveryConfigReadable(currentConfig)) return "service-unavailable";
  const availability = recoveryCampaignAvailability(currentConfig);
  if (availability === "full") return "campaign-full";
  if (availability === "closed") return "campaign-closed";
  return "campaign-changed";
}

export function recoveryEligibleInspectionFlow({ config, connectedAccount, sourceWallet } = {}) {
  if (config?.readOnly === true && isRecoveryConfigReadable(config)) return "qualifying";
  return connectedAccount && !walletsMatch(connectedAccount, sourceWallet)
    ? "wrong-wallet"
    : "qualifying";
}

export function recoveryEligibleAccountUpdateFlow({
  config,
  connectedAccount,
  sourceWallet,
  currentFlow,
  externalChange = false,
  previousAccount = "",
} = {}) {
  const authorizationWalletMismatch = !walletsMatch(connectedAccount, sourceWallet);
  if (
    config?.readOnly !== true
    && authorizationWalletMismatch
    && externalChange === true
    && previousAccount
    && currentFlow === "authorization-requested"
  ) return "account-changed";
  return recoveryEligibleInspectionFlow({ config, connectedAccount, sourceWallet });
}

export function selectDiscoveryAttribution(value) {
  if (
    value?.label !== ROUTESCAN_ATTRIBUTION.label
    || value?.url !== ROUTESCAN_ATTRIBUTION.url
  ) return null;
  return ROUTESCAN_ATTRIBUTION;
}

export function recoveryCampaignAvailability(config) {
  if (!isRecoveryConfigReadable(config) || !config?.campaign || !config?.capacity) return "unavailable";
  const remaining = Number(config.capacity.remaining);
  const deadline = Number(config.campaign.deadline);
  const deadlinePassed = Number.isSafeInteger(deadline)
    && Math.floor(Date.now() / 1_000) > deadline;
  if (config.campaign.releaseState === "closed" || deadlinePassed) return "closed";
  if (config.campaign.releaseState === "full" || remaining === 0) return "full";
  if (config.contractVersion === "v2" && config?.lineage?.releasesUnlocked === false) {
    return "continuation-waiting";
  }
  if (!deadlinePassed && config.campaign.open === true && remaining > 0) return "open";
  return "closed";
}

export function validateRecoveryConfigResponse(response) {
  if (typeof response?.enabled !== "boolean") throw responseMismatch();
  if (response?.readOnly !== undefined && typeof response.readOnly !== "boolean") throw responseMismatch();
  const readOnly = response.readOnly === true;
  if (response.enabled && readOnly) throw responseMismatch();
  const hasExpectedNetworks = response?.source?.chainId === ETHEREUM_MAINNET_CHAIN_ID
    && response?.source?.chainKey === ETHEREUM_ATTESTCOIN_CHAIN_KEY
    && response?.settlement?.chainId === CREDITCOIN_TESTNET_CHAIN_ID;
  const hasFeaturedIdentity = isAddress(response?.featuredCase?.wallet)
    && isHash(response?.featuredCase?.failedTransactionHash)
    && isHash(response?.featuredCase?.successfulTransactionHash);
  const hasExpectedConsent = response?.consent?.scope === "hosted-relayer"
    && response?.consent?.protocolEnforced === false
    && RECOVERY_FRESH_READ_ADMISSION_MODES.has(response?.consent?.freshReadAdmission);
  if (!response.enabled && !readOnly) {
    if (
      response.waking !== false
      || !hasExpectedNetworks
      || response.publicOrigin !== null
      || response.poolAddress !== null
      || response.campaignNumber !== null
      || response.campaign !== null
      || response.rule !== null
      || response.capacity !== null
      || !hasExpectedConsent
      || !hasFeaturedIdentity
    ) throw responseMismatch();
    return Object.freeze({ ...response });
  }
  if (readOnly && !RECOVERY_READ_ONLY_REASONS.has(response.readOnlyReason)) throw responseMismatch();
  const publicOrigin = normalizeOrigin(response.publicOrigin);
  const totalCapacity = Number(response?.capacity?.total);
  const claimedCapacity = Number(response?.capacity?.claimed);
  const remainingCapacity = Number(response?.capacity?.remaining);
  const campaignMaxClaims = Number(response?.campaign?.maxClaims);
  const campaignClaimCount = Number(response?.campaign?.claimCount);
  const campaignRemainingClaims = Number(response?.campaign?.remainingClaims);
  const campaignDeadline = Number(response?.campaign?.deadline);
  const campaignReleaseState = response?.campaign?.releaseState;
  const ruleStartBlock = Number(response?.rule?.startBlock);
  const ruleEndBlock = Number(response?.rule?.endBlock);
  const ruleMaxBlockGap = Number(response?.rule?.maxBlockGap);
  const ruleMaxQuantity = Number(response?.rule?.maxQuantity);
  const contractVersion = response?.contractVersion;
  let campaignFundingMatches = false;
  try {
    campaignFundingMatches = BigInt(response?.campaign?.fundedAmount)
      === BigInt(response?.campaign?.creditAmount) * BigInt(campaignMaxClaims);
  } catch {
    campaignFundingMatches = false;
  }
  if (
    response.waking !== false
    || !hasExpectedNetworks
    || !isAddress(response.poolAddress)
    || !Number.isSafeInteger(response.campaignNumber)
    || response.campaignNumber <= 0
    || !publicOrigin
    || publicOrigin !== response.publicOrigin
    || !isAddress(response.verifierAddress)
    || !isAddress(response.predicateAddress)
    || !isAddress(response?.campaign?.sponsor)
    || typeof response?.campaign?.creditAmount !== "string"
    || !isPositiveUint(response?.campaign?.creditAmount)
    || !isPositiveUint(response?.campaign?.fundedAmount)
    || !isNonzeroHash(response?.campaign?.termsHash)
    || typeof response?.campaign?.open !== "boolean"
    || !["continuation-waiting", "release-unlocked", "closed", "full"].includes(campaignReleaseState)
    || !validRecoveryLineageConfig(response)
    || !Number.isSafeInteger(campaignMaxClaims)
    || !Number.isSafeInteger(campaignClaimCount)
    || !Number.isSafeInteger(campaignRemainingClaims)
    || !Number.isSafeInteger(campaignDeadline)
    || campaignMaxClaims <= 0
    || campaignClaimCount < 0
    || campaignRemainingClaims < 0
    || campaignClaimCount + campaignRemainingClaims !== campaignMaxClaims
    || campaignDeadline <= 0
    || !campaignFundingMatches
    || !isAddress(response?.rule?.feeRecipient)
    || !Number.isSafeInteger(ruleStartBlock)
    || !Number.isSafeInteger(ruleEndBlock)
    || !Number.isSafeInteger(ruleMaxBlockGap)
    || !Number.isSafeInteger(ruleMaxQuantity)
    || ruleStartBlock < 0
    || ruleEndBlock <= ruleStartBlock
    || ruleMaxBlockGap <= 0
    || ruleMaxBlockGap > 1_000
    || ruleMaxQuantity <= 0
    || !Number.isSafeInteger(totalCapacity)
    || !Number.isSafeInteger(claimedCapacity)
    || !Number.isSafeInteger(remainingCapacity)
    || totalCapacity <= 0
    || claimedCapacity < 0
    || remainingCapacity < 0
    || claimedCapacity + remainingCapacity !== totalCapacity
    || campaignMaxClaims !== totalCapacity
    || campaignClaimCount !== claimedCapacity
    || campaignRemainingClaims !== remainingCapacity
    || (remainingCapacity === 0 && response.campaign.open)
    || (campaignReleaseState === "full" && remainingCapacity !== 0)
    || (remainingCapacity === 0 && !["full", "closed"].includes(campaignReleaseState))
    || (campaignReleaseState === "release-unlocked") !== response.campaign.open
    || (campaignReleaseState === "continuation-waiting" && (
      contractVersion !== "v2"
      || response.lineage.releasesUnlocked
      || remainingCapacity === 0
    ))
    || (contractVersion === "v2" && !response.lineage.releasesUnlocked && response.campaign.open)
    || response?.capabilities?.selfServePairIntake !== true
    || !hasExpectedConsent
    || !hasFeaturedIdentity
  ) {
    throw responseMismatch();
  }
  return Object.freeze({ ...response, publicOrigin });
}

export function validatePairEligibilityResponse({ response, requestedPair, config } = {}) {
  const boundary = requireRecoveryBoundary(config, { allowReadOnly: true });
  if (!isAddress(response?.wallet)) throw responseMismatch();
  requireResponseCampaign(response, boundary);
  requireAnalyzedPair(response?.pair, requestedPair, config);

  const status = response?.status;
  if (!new Set(["eligible", "processing", "claimed", "continuation-waiting", "closed", "full"]).has(status)) {
    throw responseMismatch();
  }
  const lineageStatus = requireEligibilityLineage(response, config, status);
  if (status === "eligible" && (response.eligible !== true || response.release != null)) {
    throw responseMismatch();
  }
  if (status === "claimed") {
    if (response.eligible !== false) throw responseMismatch();
    if (lineageStatus === "claimed-current") {
      requireRelease(response.release, response, boundary);
    } else if (response.release != null) {
      throw responseMismatch();
    }
  }
  if (status === "processing" && (response.eligible !== false || response.release != null)) {
    throw responseMismatch();
  }
  if (["continuation-waiting", "closed", "full"].includes(status)
    && (response.eligible !== false || response.release != null)) {
    throw responseMismatch();
  }
  if (typeof response?.reason !== "string" || response.reason.trim() === "") throw responseMismatch();
  requireCreditAmount(response, config);
  return bindRecoveryBoundary(response, boundary);
}

export function validateEligibilityResponse({ response, requestedWallet, config, expectedPair } = {}) {
  const boundary = requireRecoveryBoundary(config, { allowReadOnly: true });
  requireResponseWallet(response, requestedWallet);
  requireResponseCampaign(response, boundary);

  const status = response?.status;
  const validStatuses = new Set(["eligible", "claimed", "not-found", "continuation-waiting", "closed", "full"]);
  if (!validStatuses.has(status)) throw responseMismatch();
  if (status === "not-found") {
    if (response.eligible !== false || response.pair != null || response.release != null || response.lineage != null) {
      throw responseMismatch();
    }
  } else {
    const lineageStatus = requireEligibilityLineage(response, config, status);
    requirePair(response.pair, expectedPair);
    if (status === "eligible" && (response.eligible !== true || response.release != null)) {
      throw responseMismatch();
    }
    if (status === "claimed") {
      if (response.eligible !== false) throw responseMismatch();
      if (lineageStatus === "claimed-current") {
        requireRelease(response.release, response, boundary);
      } else if (response.release != null) {
        throw responseMismatch();
      }
    }
    if (["continuation-waiting", "closed", "full"].includes(status)
      && (response.eligible !== false || response.release != null)) {
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
  const freshReadAdmission = config?.consent?.freshReadAdmission;
  if (
    (freshReadAdmission === "pair-signature-v1"
      && (
        typeof response.freshReadReceipt !== "string"
        || !RECOVERY_FRESH_READ_RECEIPT_PATTERN.test(response.freshReadReceipt)
      ))
    || (freshReadAdmission === "anonymous-v1" && response.freshReadReceipt !== undefined)
  ) {
    throw responseMismatch();
  }
  return response;
}

export function validateReleaseResponse({ response, wallet, eligibility, config } = {}) {
  const boundary = requireRecoveryBoundary(config);
  if (!recoveryRecordMatchesConfig(eligibility, config)) throw responseMismatch();
  requireResponseWallet(response, wallet);
  requireResponseCampaign(response, boundary);
  if (!["released", "claimed"].includes(response?.status)) throw responseMismatch();
  if (requireEligibilityLineage(response, config, "claimed") !== "claimed-current") {
    throw responseMismatch();
  }
  requirePair(response?.pair, eligibility?.pair);
  requireCreditAmount(response, config);
  requireRelease(response?.release, response, boundary);
  return bindRecoveryBoundary(response, boundary);
}

export function validatePairReleaseResponse({ response, wallet, eligibility, config } = {}) {
  const boundary = requireRecoveryBoundary(config);
  if (!recoveryRecordMatchesConfig(eligibility, config)) throw responseMismatch();
  requireResponseWallet(response, wallet);
  requireResponseCampaign(response, boundary);
  if (!["released", "claimed"].includes(response?.status)) throw responseMismatch();
  if (requireEligibilityLineage(response, config, "claimed") !== "claimed-current") {
    throw responseMismatch();
  }
  requireAnalyzedPair(response?.pair, eligibility?.pair, config);
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

export function createPairOperationGuard() {
  let version = 0;

  return Object.freeze({
    begin(pair) {
      version += 1;
      return Object.freeze({ version, pair: pairIdentity(pair) });
    },
    invalidate() {
      version += 1;
      return version;
    },
    isCurrent(operation, pair) {
      return Boolean(
        operation
        && operation.version === version
        && operation.pair
        && (pair === undefined || operation.pair === pairIdentity(pair))
      );
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

function pairIdentity(pair) {
  if (!isHash(pair?.failedTransactionHash) || !isHash(pair?.successfulTransactionHash)) return "";
  return `${normalizeHash(pair.failedTransactionHash)}:${normalizeHash(pair.successfulTransactionHash)}`;
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

function requireRecoveryBoundary(config, { allowReadOnly = false } = {}) {
  const boundary = recoveryBoundary(config);
  const configIdentity = recoveryCampaignIdentity(config);
  const modeAllowed = allowReadOnly
    ? isRecoveryConfigReadable(config)
    : config?.enabled === true && config?.readOnly !== true;
  if (!modeAllowed || !boundary || !configIdentity) throw responseMismatch();
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

function requireAnalyzedPair(pair, expectedPair, config) {
  requirePair(pair, expectedPair);
  const failedBlock = Number(pair?.failed?.blockNumber);
  const successfulBlock = Number(pair?.successful?.blockNumber);
  const failedNonce = Number(pair?.failed?.nonce);
  const successfulNonce = Number(pair?.successful?.nonce);
  const quantity = Number(pair?.quantity);
  const mintedTokenIds = pair?.successful?.mintedTokenIds;
  const ruleStartBlock = Number(config?.rule?.startBlock);
  const ruleEndBlock = Number(config?.rule?.endBlock);
  const ruleMaxBlockGap = Number(config?.rule?.maxBlockGap);
  const ruleMaxQuantity = Number(config?.rule?.maxQuantity);
  let exactPaidValue = false;
  try {
    exactPaidValue = BigInt(pair?.valueWei) === BigInt(pair?.mintPriceWei) * BigInt(pair?.quantity);
  } catch {
    exactPaidValue = false;
  }
  if (
    Number(pair?.sourceChainId) !== Number(config?.source?.chainId)
    || Number(pair?.sourceChainKey) !== Number(config?.source?.chainKey)
    || !isAddress(pair?.nftContract)
    || !isPositiveUint(pair?.quantity)
    || !Number.isSafeInteger(quantity)
    || quantity <= 0
    || !isPositiveUint(pair?.mintPriceWei)
    || !isPositiveUint(pair?.valueWei)
    || !Number.isSafeInteger(failedBlock)
    || failedBlock < 0
    || !Number.isSafeInteger(successfulBlock)
    || successfulBlock <= failedBlock
    || !Number.isSafeInteger(failedNonce)
    || failedNonce < 0
    || !Number.isSafeInteger(successfulNonce)
    || successfulNonce !== failedNonce + 1
    || failedBlock < ruleStartBlock
    || successfulBlock > ruleEndBlock
    || successfulBlock - failedBlock > ruleMaxBlockGap
    || quantity > ruleMaxQuantity
    || !exactPaidValue
    || !Array.isArray(mintedTokenIds)
    || mintedTokenIds.length !== quantity
    || mintedTokenIds.some((tokenId) => !/^\d+$/.test(String(tokenId)))
    || new Set(mintedTokenIds.map(String)).size !== mintedTokenIds.length
  ) {
    throw responseMismatch();
  }
  if (expectedPair?.failed && (
    Number(pair.sourceChainId) !== Number(expectedPair.sourceChainId)
    || Number(pair.sourceChainKey) !== Number(expectedPair.sourceChainKey)
    || !walletsMatch(pair.nftContract, expectedPair.nftContract)
    || String(pair.quantity) !== String(expectedPair.quantity)
    || String(pair.mintPriceWei) !== String(expectedPair.mintPriceWei)
    || String(pair.valueWei) !== String(expectedPair.valueWei)
    || failedBlock !== Number(expectedPair.failed.blockNumber)
    || failedNonce !== Number(expectedPair.failed.nonce)
    || successfulBlock !== Number(expectedPair.successful?.blockNumber)
    || successfulNonce !== Number(expectedPair.successful?.nonce)
    || JSON.stringify(mintedTokenIds.map(String))
      !== JSON.stringify(expectedPair.successful?.mintedTokenIds?.map(String))
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
  const blockNumber = Number(release?.blockNumber);
  const claimCount = Number(release?.claimCount);
  if (
    !isHash(release?.transactionHash)
    || !Number.isSafeInteger(blockNumber)
    || blockNumber < 0
    || normalizeCampaignNumber(release?.campaignNumber) !== boundary.campaignNumber
    || !walletsMatch(release?.beneficiary, response?.wallet)
    || String(release?.creditAmount) !== String(response?.creditAmount)
    || !isNonzeroHash(release?.actionId)
    || !isNonzeroHash(release?.failureQueryId)
    || !isNonzeroHash(release?.successQueryId)
    || !isNonzeroHash(release?.pairId)
    || normalizeHash(release.failureQueryId) === normalizeHash(release.successQueryId)
    || !isAddress(release?.relayer)
    || !Number.isSafeInteger(claimCount)
    || claimCount <= 0
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
  const contractVersion = config?.contractVersion;
  const lineage = config?.lineage;
  const accessMode = config?.enabled === true && config?.readOnly !== true
    ? "write-enabled"
    : isRecoveryConfigReadable(config)
      ? "read-only"
      : "";
  if (
    !publicOrigin
    || !Number.isSafeInteger(sourceChainId)
    || sourceChainId <= 0
    || !Number.isSafeInteger(sourceChainKey)
    || sourceChainKey <= 0
    || !Number.isSafeInteger(settlementChainId)
    || settlementChainId <= 0
    || !isPositiveUint(creditAmount)
    || !["v1", "v2"].includes(contractVersion)
    || !lineage
    || !accessMode
  ) return "";
  const predecessor = lineage.predecessor;
  return JSON.stringify([
    boundary.poolAddress,
    boundary.campaignNumber,
    publicOrigin,
    sourceChainId,
    sourceChainKey,
    settlementChainId,
    String(creditAmount),
    contractVersion,
    accessMode,
    lineage.scope,
    lineage.releasesUnlocked,
    predecessor
      ? [
          normalizeWallet(predecessor.poolAddress),
          normalizeCampaignNumber(predecessor.campaignNumber),
          normalizeWallet(predecessor.sponsor),
          normalizeHash(predecessor.termsHash),
          Number(predecessor.deadline),
          Number(predecessor.startBlock),
          Number(predecessor.endBlock),
        ]
      : null,
  ]);
}

function recoveryAuthorizationStateIdentity(config) {
  const campaignIdentity = recoveryCampaignIdentity(config);
  const campaign = config?.campaign;
  const rule = config?.rule;
  const capacity = config?.capacity;
  if (!campaignIdentity || !campaign || !rule || !capacity) return "";
  return JSON.stringify([
    campaignIdentity,
    config?.consent?.freshReadAdmission,
    normalizeWallet(config.verifierAddress),
    normalizeWallet(config.predicateAddress),
    normalizeWallet(campaign.sponsor),
    String(campaign.maxClaims),
    String(campaign.claimCount),
    String(campaign.remainingClaims),
    String(campaign.deadline),
    String(campaign.fundedAmount),
    normalizeHash(campaign.termsHash),
    campaign.releaseState,
    campaign.open,
    normalizeWallet(rule.feeRecipient),
    String(rule.startBlock),
    String(rule.endBlock),
    String(rule.maxBlockGap),
    String(rule.maxQuantity),
    String(capacity.total),
    String(capacity.claimed),
    String(capacity.remaining),
  ]);
}

function validRecoveryLineageConfig(response) {
  const version = response?.contractVersion;
  const lineage = response?.lineage;
  if (!["v1", "v2"].includes(version) || !lineage || typeof lineage !== "object") return false;
  if (typeof lineage.releasesUnlocked !== "boolean") return false;
  if (version === "v1") {
    return lineage.scope === "campaign"
      && lineage.releasesUnlocked === true
      && lineage.predecessor === null;
  }
  const predecessor = lineage.predecessor;
  const predecessorCampaign = normalizeCampaignNumber(predecessor?.campaignNumber);
  const predecessorDeadline = Number(predecessor?.deadline);
  const predecessorStart = Number(predecessor?.startBlock);
  const predecessorEnd = Number(predecessor?.endBlock);
  const campaignDeadline = Number(response?.campaign?.deadline);
  const currentStart = Number(response?.rule?.startBlock);
  const currentEnd = Number(response?.rule?.endBlock);
  return lineage.scope === "sponsor"
    && predecessor !== null
    && typeof predecessor === "object"
    && isAddress(predecessor.poolAddress)
    && normalizeWallet(predecessor.poolAddress) !== normalizeWallet(response?.poolAddress)
    && predecessorCampaign !== null
    && isAddress(predecessor.sponsor)
    && walletsMatch(predecessor.sponsor, response?.campaign?.sponsor)
    && isNonzeroHash(predecessor.termsHash)
    && Number.isSafeInteger(predecessorDeadline)
    && predecessorDeadline > 0
    && predecessorDeadline < campaignDeadline
    && Number.isSafeInteger(predecessorStart)
    && predecessorStart >= 0
    && Number.isSafeInteger(predecessorEnd)
    && predecessorEnd > predecessorStart
    && predecessorStart >= currentStart
    && predecessorEnd <= currentEnd;
}

function requireEligibilityLineage(response, config, status) {
  const lineage = response?.lineage;
  const expectedScope = config?.lineage?.scope;
  if (!lineage || lineage.scope !== expectedScope) throw responseMismatch();
  const allowedStatuses = config?.contractVersion === "v2"
    ? new Set(["unused", "claimed-current", "claimed-predecessor", "claimed-sponsor"])
    : new Set(["unused", "claimed-current"]);
  if (!allowedStatuses.has(lineage.status)) throw responseMismatch();
  const claimed = status === "claimed";
  if (claimed !== lineage.status.startsWith("claimed-")) throw responseMismatch();
  return lineage.status;
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

function isNonzeroHash(value) {
  return isHash(value) && !/^0x0{64}$/i.test(value);
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
  const error = new Error("The recovery service returned evidence for a different pair, wallet, or campaign. Refresh and check the pair again.");
  error.code = "RECOVERY_RESPONSE_MISMATCH";
  return error;
}
