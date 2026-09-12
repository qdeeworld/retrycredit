import React from "react";
import { AlertCircle } from "lucide-react";

// Keep the submitted public identity inspectable without implying that disputed
// source semantics or a payout have been independently confirmed.
export function HelperEvidenceConflict({ operation }) {
  const pair = operation?.pair;
  return <div className="evidence-empty">
    <AlertCircle aria-hidden="true" />
    <div>
      <strong>Recovery evidence does not match</strong>
      <p>The submitted source pair remains attached below. Conflicting public records do not confirm a credit. Check this operation&apos;s status without signing again.</p>
      {pair?.failedTransactionHash && <a className="secondary-action" href={`https://etherscan.io/tx/${pair.failedTransactionHash}`} target="_blank" rel="noreferrer">Inspect submitted failed transaction</a>}
      {pair?.successfulTransactionHash && <a className="secondary-action" href={`https://etherscan.io/tx/${pair.successfulTransactionHash}`} target="_blank" rel="noreferrer">Inspect submitted retry transaction</a>}
      {!pair && <p>The operation identity could not be validated. No unverified source or release details are shown.</p>}
    </div>
  </div>;
}
