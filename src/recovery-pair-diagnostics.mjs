import { inspectSeaDropRecoveryPair } from "./seadrop-recovery.mjs";
import { RECOVERY_PAIR_DIAGNOSTICS_SCHEMA, serializeRecoveryPairDiagnostics } from "./recovery-pair-report.mjs";

export { RECOVERY_PAIR_DIAGNOSTICS_SCHEMA, serializeRecoveryPairDiagnostics } from "./recovery-pair-report.mjs";

// Fixed text and selected public fields only. A failed diagnostic never changes
// the authoritative resolver's success/error result or its 422/503 distinction.
export function buildRecoveryPairDiagnostics({ facts, pair, rule, campaign, checkedAt, now = Date.now }) {
  try {
    const inspection = inspectSeaDropRecoveryPair({ ...facts, pair, rule });
    if (!inspection) return null;
    return serializeRecoveryPairDiagnostics({
      schema: RECOVERY_PAIR_DIAGNOSTICS_SCHEMA,
      authority: "advisory-source-check",
      attestationVerified: false,
      checkedAt: checkedAt ?? new Date(now()).toISOString(),
      sourceChainId: 1,
      pair,
      campaign: {
        ...campaign,
        startBlock: Number(rule.startBlock),
        endBlock: Number(rule.endBlock),
        maxBlockGap: Number(rule.maxBlockGap),
        maxQuantity: Number(rule.maxQuantity),
      },
      ...inspection,
    });
  } catch {
    return null;
  }
}
