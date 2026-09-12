import { AbiCoder, getAddress, keccak256 } from "ethers";
import { formatRecoveryHelperMessage, RECOVERY_HELPER_MODE } from "../../src/recovery-helper-consent.mjs";
import { recoveryCampaignAvailability, recoveryCampaignsMatch, recoveryPairsMatch, recoveryRecordMatchesConfig, validatePairEligibilityResponse, validateRecoveryHostedAdmission, walletsMatch } from "./recovery-ui-state.mjs";

export { RECOVERY_HELPER_MODE };
export const HELPER_RESUME_KEY = "retrycredit.community-helper.public-operation.v1";
export const HELPER_RESUME_FRESH_MS = 15 * 60_000;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TERMINAL = new Set(["settled", "reverted", "stopped"]);
const STATES = new Set(["submitted", "admitted", "broadcast-prepared", ...TERMINAL]);
const STOP_REASONS = new Set(["eligibility-changed", "proof-unavailable", "proof-invalid", "simulation-rejected", "fee-cap", "prebroadcast-failed", "operator-abandoned"]);

export function helperEnabled(config) {
  return config?.enabled === true && config?.readOnly !== true && config?.contractVersion === "v2"
    && config?.capabilities?.communityHelper === true && config?.helper?.enabled === true
    && config?.helper?.mode === RECOVERY_HELPER_MODE
    && config?.helper?.recipientConsent === false && config?.helper?.helperReceivesCredit === false;
}

export function helperAdmissionAvailable(config) {
  return helperEnabled(config) && config.helper.available === true && config.helper.admissionState === "available"
    && recoveryCampaignAvailability(config) === "open";
}

export function helperOperationIdentity(config, sourceWallet, pair) {
  if (config?.settlement?.chainId !== 102031 || !positiveInteger(config?.campaignNumber)
    || !address(config?.poolAddress) || !address(sourceWallet) || !validPair(pair)) throw mismatch();
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "address", "bytes32", "bytes32"],
    [config.settlement.chainId, config.poolAddress, config.campaignNumber, sourceWallet,
      pair.failedTransactionHash, pair.successfulTransactionHash],
  ));
}

export function validateHelperDiscovery(response, config) {
  if (!["found", "none-in-window", "exhausted", "unavailable"].includes(response?.status)
    || !Number.isSafeInteger(response.checkedCandidates) || response.checkedCandidates < 0 || response.checkedCandidates > 4
    || !Number.isSafeInteger(response.totalCandidates) || response.totalCandidates < response.checkedCandidates
    || typeof response.moreCandidates !== "boolean") throw mismatch();
  if (response.status !== "found") {
    if (response.match !== null) throw mismatch();
    return { ...response, match: null };
  }
  if (response.checkedCandidates < 1 || !validPair(response.match?.pair)) throw mismatch();
  const match = validatePairEligibilityResponse({ response: response.match, requestedPair: response.match.pair, config });
  if (match.status !== "eligible" || match.eligible !== true) throw mismatch();
  return { ...response, match };
}

export function validateHelperChallenge({ response, requester, eligibility, config, currentOrigin, now = Date.now() } = {}) {
  if (!helperAdmissionAvailable(config)
    || !recoveryRecordMatchesConfig(eligibility, config) || eligibility?.status !== "eligible"
    || eligibility?.eligible !== true || !walletsMatch(response?.requester, requester)
    || walletsMatch(requester, eligibility.wallet)
    || !walletsMatch(response?.sourceWallet, eligibility.wallet)
    || !walletsMatch(response?.poolAddress, config.poolAddress) || response?.campaignNumber !== config.campaignNumber
    || response?.mode !== RECOVERY_HELPER_MODE || !recoveryPairsMatch(response?.pair, eligibility.pair)
    || config.publicOrigin !== currentOrigin
    || !positiveInteger(response?.issuedAt) || !positiveInteger(response?.expiresAt)
    || response.expiresAt !== response.issuedAt + 300
    || response.issuedAt > Math.floor(now / 1_000) + 60 || response.expiresAt <= Math.floor(now / 1_000)) throw mismatch();
  if (validateRecoveryHostedAdmission(response.hostedAdmission, { config, wallet: eligibility.wallet })?.available !== true) throw mismatch();
  const expectedId = helperOperationIdentity(config, eligibility.wallet, eligibility.pair);
  if (response.operationId !== expectedId) throw mismatch();
  const expectedMessage = formatRecoveryHelperMessage({
    origin: config.publicOrigin, poolAddress: getAddress(config.poolAddress), campaignNumber: config.campaignNumber,
    settlementChainId: config.settlement.chainId, requester: getAddress(requester), sourceWallet: getAddress(eligibility.wallet),
    operationId: expectedId, failedTransactionHash: eligibility.pair.failedTransactionHash.toLowerCase(),
    successfulTransactionHash: eligibility.pair.successfulTransactionHash.toLowerCase(),
    issuedAt: response.issuedAt, expiresAt: response.expiresAt,
  });
  if (response.message !== expectedMessage) throw mismatch();
  return Object.freeze({ mode: RECOVERY_HELPER_MODE, requester: getAddress(requester), sourceWallet: getAddress(eligibility.wallet),
    poolAddress: getAddress(config.poolAddress), campaignNumber: config.campaignNumber, operationId: expectedId,
    pair: publicPair(eligibility.pair), issuedAt: response.issuedAt, expiresAt: response.expiresAt, message: expectedMessage });
}

export function canContinueHelperAuthorization({ initialConfig, currentConfig, requester, currentAccount, operationCurrent, expiresAt, now = Date.now() } = {}) {
  return operationCurrent === true && helperAdmissionAvailable(currentConfig) && recoveryCampaignsMatch(initialConfig, currentConfig)
    && recoveryCampaignAvailability(currentConfig) === "open" && walletsMatch(requester, currentAccount)
    && (expiresAt === undefined || expiresAt * 1_000 > now);
}

export function helperOperationIsTerminal(operation) { return TERMINAL.has(operation?.state); }

export function helperRequestDefinitelyRefused(error) {
  return Number.isInteger(error?.status) && error.status >= 400 && error.status < 500
    && new Set(["RECOVERY_CHALLENGE_INVALID", "RECOVERY_SIGNATURE_INVALID", "RECOVERY_PAIR_WALLET_MISMATCH",
      "RECOVERY_PAIR_INVALID", "RECOVERY_PAIR_INELIGIBLE", "RECOVERY_NOT_FOUND", "RECOVERY_CLOSED", "RECOVERY_FULL",
      "RECOVERY_CLAIMED", "RECOVERY_HELPER_USE_OWNER_FLOW", "HELPER_LEDGER_BUSY", "HELPER_LEDGER_SOURCE_RESERVED", "HELPER_LEDGER_BUDGET_EXHAUSTED",
      "HELPER_LEDGER_EXPIRED", "HELPER_LEDGER_FEE_CAP"]).has(error.code);
}

export function validateHelperOperation(response, expected, config) {
  if (!response || !STATES.has(response.state) || response.state === "submitted"
    || ![RECOVERY_HELPER_MODE, "owner"].includes(response.mode) || response.recipientConsent !== (response.mode === "owner") || response.helperReceivesCredit !== false
    || !address(response.requester) || (response.mode === "owner" && !walletsMatch(response.requester, response.sourceWallet))
    || (response.mode === RECOVERY_HELPER_MODE && walletsMatch(response.requester, response.sourceWallet))
    || !walletsMatch(response.sourceWallet, expected?.sourceWallet)
    || !recoveryPairsMatch(response.pair, expected?.pair) || response.operationId !== expected?.operationId
    || response.operationId !== helperOperationIdentity(config, expected.sourceWallet, expected.pair)) throw mismatch();
  const hasTransaction = ["broadcast-prepared", "settled", "reverted"].includes(response.state);
  if ((hasTransaction && !HASH.test(response.transactionHash)) || (!hasTransaction && response.transactionHash !== null)
    || (TERMINAL.has(response.state) && response.state !== "stopped" && !positiveInteger(response.blockNumber))
    || (!["settled", "reverted"].includes(response.state) && response.blockNumber !== null)
    || (response.state === "stopped" ? !STOP_REASONS.has(response.reason) : response.reason !== null)) throw mismatch();
  return Object.freeze({ operationId: response.operationId, mode: response.mode,
    requester: getAddress(response.requester), sourceWallet: getAddress(response.sourceWallet), pair: publicPair(response.pair),
    state: response.state, transactionHash: response.transactionHash, blockNumber: response.blockNumber,
    reason: response.reason, recipientConsent: response.recipientConsent, helperReceivesCredit: false });
}

// Public identity only. A stale pending identity stays locked until durable status
// is checked; freshness expiry never becomes permission to submit another release.
export function saveHelperResume(operation, config, { storage = browserStorage(), now = Date.now() } = {}) {
  if (!storage || !STATES.has(operation?.state) || !Number.isSafeInteger(now) || now < 0) return null;
  let record;
  try {
    if (operation.mode !== RECOVERY_HELPER_MODE || !address(operation.requester) || !address(operation.sourceWallet)
      || operation.operationId !== helperOperationIdentity(config, operation.sourceWallet, operation.pair)) return null;
    const previous = readHelperResume(config, { storage, now });
    const createdAt = previous?.operationId === operation.operationId ? previous.createdAt : now;
    record = { version: 1, mode: RECOVERY_HELPER_MODE, poolAddress: getAddress(config.poolAddress),
      campaignNumber: config.campaignNumber, operationId: operation.operationId, requester: getAddress(operation.requester),
      sourceWallet: getAddress(operation.sourceWallet), pair: publicPair(operation.pair), state: operation.state,
      createdAt, updatedAt: now, expiresAt: createdAt + HELPER_RESUME_FRESH_MS };
    storage.setItem(HELPER_RESUME_KEY, JSON.stringify(record));
  } catch { return null; }
  return record;
}

export function readHelperResume(config, { storage = browserStorage(), now = Date.now() } = {}) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HELPER_RESUME_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw);
    const keys = ["version", "mode", "poolAddress", "campaignNumber", "operationId", "requester", "sourceWallet", "pair", "state", "createdAt", "updatedAt", "expiresAt"];
    if (!record || Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))
      || record.version !== 1 || record.mode !== RECOVERY_HELPER_MODE || !STATES.has(record.state)
      || !walletsMatch(record.poolAddress, config?.poolAddress) || record.campaignNumber !== config?.campaignNumber
      || !address(record.requester) || !address(record.sourceWallet)
      || record.operationId !== helperOperationIdentity(config, record.sourceWallet, record.pair)
      || Object.keys(record.pair).length !== 2
      || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 || record.createdAt > now
      || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt || record.updatedAt > now
      || record.expiresAt !== record.createdAt + HELPER_RESUME_FRESH_MS) return null;
    return Object.freeze({ ...record, pair: publicPair(record.pair), stale: now >= record.expiresAt });
  } catch { return null; }
}

export function clearHelperResume({ storage = browserStorage() } = {}) {
  try { storage?.removeItem(HELPER_RESUME_KEY); } catch { /* Storage is optional; the server ledger is authoritative. */ }
}

export function helperErrorCopy(error, { submitted = false } = {}) {
  if (submitted) return "The request may still be processing. Its pair is locked. Check public status; no signature or release request will be repeated.";
  if ([4001, "ACTION_REJECTED"].includes(error?.code)) return "The wallet request was closed. No recovery request was sent.";
  if (error?.code === "RECOVERY_HELPER_USE_OWNER_FLOW") return "This is your source wallet. Select Recover my retry to use the owner authorization instead. No helper request was sent.";
  if (["HELPER_LEDGER_BUDGET_EXHAUSTED", "HELPER_LEDGER_EXPIRED", "RECOVERY_HELPER_FEE_CAP"].includes(error?.code)) return "This helper pilot has reached its spending limit. No new recovery can start here; existing operations can still be checked.";
  if (error?.code === "HELPER_LEDGER_SOURCE_RESERVED") return "This source wallet already has a reserved recovery. No new request was admitted. Find another recovery to help with.";
  if (["HELPER_LEDGER_BUSY", "HELPER_LEDGER_OPERATION_ACTIVE"].includes(error?.code) || error?.status === 429) return "The sponsor is already processing a recovery. Wait a moment before trying this pair again.";
  if (error?.code === "RECOVERY_RESPONSE_MISMATCH") return "The response did not match this exact helper request. Nothing new will be authorized. Check the pair again.";
  if (["RECOVERY_CLOSED", "RECOVERY_FULL", "RECOVERY_CLAIMED"].includes(error?.code)) return "This recovery is no longer available. Search again for a currently eligible pair.";
  return "The helper service could not finish this step. Your pair is preserved. Try again when the service is available.";
}

function browserStorage() { try { return globalThis.sessionStorage; } catch { return null; } }
function address(value) { try { return typeof value === "string" && !/^0x0{40}$/i.test(value) && Boolean(getAddress(value)); } catch { return false; } }
function positiveInteger(value) { return Number.isSafeInteger(value) && value > 0; }
function validPair(pair) { return HASH.test(pair?.failedTransactionHash) && HASH.test(pair?.successfulTransactionHash) && pair.failedTransactionHash.toLowerCase() !== pair.successfulTransactionHash.toLowerCase(); }
function publicPair(pair) { return { failedTransactionHash: pair.failedTransactionHash.toLowerCase(), successfulTransactionHash: pair.successfulTransactionHash.toLowerCase() }; }
function mismatch() { return Object.assign(new Error("The response did not match the exact helper request."), { code: "RECOVERY_RESPONSE_MISMATCH" }); }
