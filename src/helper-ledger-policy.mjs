import { AbiCoder, keccak256 } from "ethers";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT = (1n << 256n) - 1n;
export const HELPER_LEDGER_STATES = Object.freeze([
  "admitted", "broadcast-prepared", "settled", "reverted", "stopped",
]);
export const HELPER_LEDGER_STOP_REASONS = Object.freeze([
  "eligibility-changed", "proof-unavailable", "proof-invalid", "simulation-rejected",
  "fee-cap", "prebroadcast-failed",
]);

export function ledgerError(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

export function requireRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  }
  return value;
}

export function ledgerHash(value) {
  if (typeof value !== "string" || !HASH.test(value)) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  return value.toLowerCase();
}

export function ledgerAddress(value) {
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) {
    throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  }
  return value.toLowerCase();
}

export function ledgerUint(value, { zero = false } = {}) {
  if (typeof value !== "string" || !UINT.test(value) || BigInt(value) > MAX_UINT
    || (!zero && BigInt(value) === 0n)) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  return value;
}

export function ledgerInteger(value, { zero = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > max) {
    throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  }
  return value;
}

export function normalizeLedgerIdentity(value) {
  requireRecord(value, ["chainId", "poolAddress", "campaignNumber", "relayerAddress"]);
  return {
    chainId: ledgerInteger(value.chainId),
    poolAddress: ledgerAddress(value.poolAddress),
    campaignNumber: ledgerInteger(value.campaignNumber),
    relayerAddress: ledgerAddress(value.relayerAddress),
  };
}

export function normalizeLedgerLimits(value) {
  requireRecord(value, ["maxAttempts", "maxPayouts", "maxTotalFeeWei", "maxFeeWei", "creditWei", "expiresAt"]);
  const limits = {
    maxAttempts: ledgerInteger(value.maxAttempts, { max: 32 }),
    maxPayouts: ledgerInteger(value.maxPayouts, { max: 32 }),
    maxTotalFeeWei: ledgerUint(value.maxTotalFeeWei),
    maxFeeWei: ledgerUint(value.maxFeeWei),
    creditWei: ledgerUint(value.creditWei),
    expiresAt: ledgerInteger(value.expiresAt),
  };
  if (BigInt(limits.maxFeeWei) > BigInt(limits.maxTotalFeeWei)) {
    throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  }
  return limits;
}

export function normalizeLedgerPolicy(value) {
  requireRecord(value, ["identity", "limits"]);
  return { identity: normalizeLedgerIdentity(value.identity), limits: normalizeLedgerLimits(value.limits) };
}

// This identity must never include a build revision, authentication token, expiry,
// budget, helper address, relayer, or process ID. Those rotations must not reset
// campaign-wide spending. The signer remains bound in the immutable stored policy.
export function helperLedgerAtom(identity) {
  const normalized = normalizeLedgerIdentity(identity);
  return ["retrycredit-spending", normalized.chainId, normalized.poolAddress,
    normalized.campaignNumber].join(":");
}

export function normalizeLedgerPair(value) {
  requireRecord(value, ["failedTransactionHash", "successfulTransactionHash"]);
  const pair = {
    failedTransactionHash: ledgerHash(value.failedTransactionHash),
    successfulTransactionHash: ledgerHash(value.successfulTransactionHash),
  };
  if (pair.failedTransactionHash === pair.successfulTransactionHash) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  return pair;
}

export function helperOperationId(identity, sourceWallet, pair) {
  const scope = normalizeLedgerIdentity(identity);
  const source = ledgerAddress(sourceWallet);
  const evidence = normalizeLedgerPair(pair);
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "address", "bytes32", "bytes32"],
    [scope.chainId, scope.poolAddress, scope.campaignNumber, source,
      evidence.failedTransactionHash, evidence.successfulTransactionHash],
  ));
}

export function normalizeLedgerReservation(identity, value) {
  requireRecord(value, ["operationId", "mode", "requester", "sourceWallet", "pair", "maxFeeWei"]);
  const operation = {
    operationId: ledgerHash(value.operationId),
    mode: value.mode,
    requester: ledgerAddress(value.requester),
    sourceWallet: ledgerAddress(value.sourceWallet),
    pair: normalizeLedgerPair(value.pair),
    maxFeeWei: ledgerUint(value.maxFeeWei),
  };
  if (!["owner", "community-helper-v1"].includes(operation.mode)
    || (operation.mode === "owner" && operation.requester !== operation.sourceWallet)
    || (operation.mode === "community-helper-v1" && operation.requester === operation.sourceWallet)
    || operation.operationId !== helperOperationId(identity, operation.sourceWallet, operation.pair)) {
    throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  }
  return operation;
}
