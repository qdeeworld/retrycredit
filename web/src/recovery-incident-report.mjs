import { serializeRecoveryPairDiagnostics } from "../../src/recovery-pair-report.mjs";
import { validateRecoveryPairDraft, walletsMatch } from "./recovery-ui-state.mjs";

// Display/export boundary only. Never consumed by eligibility or release code.
export function validateRecoveryIncidentReport(value, pair, config) {
  const report = serializeRecoveryPairDiagnostics(value);
  const draft = validateRecoveryPairDraft(pair);
  if (!report || !draft.valid || !config?.campaign || !config?.rule) return null;
  const terms = report.campaign;
  if (!walletsMatch(terms.poolAddress, config.poolAddress)
    || terms.campaignNumber !== config.campaignNumber
    || terms.termsHash !== config.campaign.termsHash?.toLowerCase()
    || terms.creditAmount !== config.campaign.creditAmount
    || terms.deadline !== config.campaign.deadline
    || ["startBlock", "endBlock", "maxBlockGap", "maxQuantity"].some((key) => terms[key] !== config.rule[key])
    || ["failedTransactionHash", "successfulTransactionHash"].some((key) => report.pair[key] !== draft.pair[key].toLowerCase())) return null;
  return report;
}

export function recoveryIncidentExport(report) {
  const safe = serializeRecoveryPairDiagnostics(report);
  if (!safe) return null;
  return JSON.stringify({
    ...safe,
    exportNotice: "Advisory source inspection, not an Attestcoin attestation, ownership signature, reimbursement promise or eligibility authorization. Recheck the pair in the current campaign before acting.",
    transactions: {
      failed: `https://etherscan.io/tx/${safe.pair.failedTransactionHash}`,
      successful: `https://etherscan.io/tx/${safe.pair.successfulTransactionHash}`,
    },
  }, null, 2);
}
