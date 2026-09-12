import { createHelperLedgerClient } from "./helper-ledger-client.mjs";
import { normalizeLedgerPolicy } from "./helper-ledger-policy.mjs";
import { RECOVERY_HELPER_CANDIDATES } from "./recovery-helper-candidates.mjs";

// This pilot may consume only the existing nine remaining fixed credits.
// Configuration may lower these ceilings, never raise them implicitly.
export const RECOVERY_HELPER_PILOT_CEILINGS = Object.freeze({
  maxAttempts: 9,
  maxPayouts: 9,
  maxFeeWei: "2000000000000000",
  maxTotalFeeWei: "18000000000000000",
  creditWei: "100000000000000000",
});

// Run before constructing any legacy service, not in a caught recovery startup
// branch. A malformed helper activation must never leave an old writer live.
export function assertRecoveryHelperIsolation(env = {}) {
  const enabled = env.RETRYCREDIT_HELPER_ENABLED;
  const configured = ["RETRYCREDIT_HELPER_LEDGER_URL", "RETRYCREDIT_HELPER_LEDGER_TOKEN", "RETRYCREDIT_HELPER_LEDGER_POLICY"]
    .some(key => typeof env[key] === "string" && env[key].trim() !== "");
  if (enabled === undefined || enabled === "" || enabled === "false") {
    if (configured) throw new Error("Configured helper spending cannot be bypassed by disabling its Node coordinator; pause ledger admission instead");
    return;
  }
  if (enabled !== "true" || env.RETRYCREDIT_LEGACY_WRITES_ENABLED === "true"
    || env.RETRYCREDIT_PUBLIC_ENABLED === "true") {
    throw new Error("Community helper activation forbids legacy/public writers and malformed enable flags");
  }
}

export function createRecoveryHelperOptions(env = {}, bootstrap = {}) {
  assertRecoveryHelperIsolation(env);
  const enabled = env.RETRYCREDIT_HELPER_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") return {};
  if (enabled !== "true" || !bootstrap.enabled
    || env.RETRYCREDIT_RECOVERY_CONTRACT_VERSION !== "v2"
    || env.RETRYCREDIT_LEGACY_WRITES_ENABLED === "true"
    || env.RETRYCREDIT_PUBLIC_ENABLED === "true") {
    throw new Error("Community helper mode requires explicit V2-only recovery configuration");
  }
  let policy;
  try {
    policy = normalizeLedgerPolicy(JSON.parse(env.RETRYCREDIT_HELPER_LEDGER_POLICY));
    const { identity, limits } = policy;
    const cap = RECOVERY_HELPER_PILOT_CEILINGS;
    if (identity.chainId !== 102031
      || identity.poolAddress !== bootstrap.poolAddress?.toLowerCase()
      || identity.campaignNumber !== Number(bootstrap.campaignNumber)
      || limits.maxAttempts > cap.maxAttempts || limits.maxPayouts > cap.maxPayouts
      || BigInt(limits.maxFeeWei) > BigInt(cap.maxFeeWei)
      || BigInt(limits.maxTotalFeeWei) > BigInt(cap.maxTotalFeeWei)
      || limits.creditWei !== cap.creditWei) throw new Error();
  } catch {
    throw new Error("Community helper mode requires an exact campaign policy within the pilot spending ceilings");
  }
  const helperLedger = createHelperLedgerClient({
    url: env.RETRYCREDIT_HELPER_LEDGER_URL,
    token: env.RETRYCREDIT_HELPER_LEDGER_TOKEN,
    ...policy,
  });
  return {
    helperLedger,
    helperMaxFeeWei: policy.limits.maxFeeWei,
    helperCandidates: RECOVERY_HELPER_CANDIDATES,
  };
}
