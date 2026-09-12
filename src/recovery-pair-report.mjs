import { getAddress, isHexString } from "ethers";

export const RECOVERY_PAIR_DIAGNOSTICS_SCHEMA = "retrycredit.pair-diagnostics/1";
const SUMMARY = "These advisory source checks explain why this pair does not fit the campaign. They are not an Attestcoin proof or a credit authorization.";
const NOT_CHECKED = "A prerequisite check did not pass, so this check was not performed.";
const CHECKS = Object.freeze({
  "source-network": ["Ethereum Mainnet", "Both source transactions identify Ethereum Mainnet.", "The source transactions do not both identify Ethereum Mainnet."],
  "transaction-type": ["Supported transaction type", "Both transactions use the supported type-2 envelope.", "This campaign requires two type-2 Ethereum transactions."],
  "action-family": ["Canonical SeaDrop mint", "Both calls are canonical SeaDrop mintSigned actions.", "Both transactions must call the canonical SeaDrop mintSigned action with supported calldata."],
  "same-wallet": ["Same source wallet", "Both transactions have the same source sender.", "The two transactions have different source senders."],
  "receipt-status": ["Failure then completion", "The first receipt failed without logs and the second succeeded.", "The receipts must show failure without logs followed by success."],
  "nonce-order": ["Consecutive source nonce", "The successful transaction uses the source wallet's next nonce.", "The successful transaction does not use the source wallet's next nonce."],
  "block-gap": ["Bounded retry interval", "The successful transaction follows within the campaign's block-gap limit.", "The successful transaction must follow the failed one within the campaign's block-gap limit."],
  "campaign-window": ["Funded source window", "Both source transactions fit the campaign's fixed block window.", "The source transactions fall outside this campaign's fixed block window."],
  "paid-mint": ["Supported paid-mint terms", "The first mint has an exact nonzero payment and supported payer and fee restrictions.", "The first mint does not meet the required paid value, payer, or fee-restriction terms."],
  "mint-identity": ["Same paid mint", "Both calls preserve every required stable mint field and payment.", "The completed call changes a required stable mint field or payment."],
  "mint-outcome": ["Exact NFT mint outcome", "The success receipt contains the exact SeaDrop event and expected NFT mints to the source wallet.", "The success receipt does not contain the exact required SeaDrop event and NFT mint outcome."],
  "campaign-fee-recipient": ["Funded fee recipient", "Both calls use the fee recipient fixed by this campaign.", "A mint's fee recipient differs from the funded campaign's fee recipient."],
  "campaign-quantity": ["Funded mint quantity", "Both mint quantities fit the campaign's maximum quantity.", "A mint quantity exceeds this campaign's maximum quantity."],
});
const CHECK_IDS = Object.freeze(Object.keys(CHECKS));
const STATUSES = new Set(["pass", "fail", "not-checked"]);

// Reconstruct text from the catalog even for internally attached errors: never
// forward a provider error, cause, arbitrary object, calldata, or signature.
export function serializeRecoveryPairDiagnostics(value) {
  try {
    if (value?.schema !== RECOVERY_PAIR_DIAGNOSTICS_SCHEMA
      || value.authority !== "advisory-source-check"
      || value.attestationVerified !== false
      || value.sourceChainId !== 1
      || typeof value.checkedAt !== "string"
      || value.checkedAt.length !== 24
      || new Date(value.checkedAt).toISOString() !== value.checkedAt
      || !Array.isArray(value.checks)
      || value.checks.length !== CHECK_IDS.length) return null;
    const checks = CHECK_IDS.map((id, index) => {
      const check = value.checks[index];
      if (check?.id !== id || !STATUSES.has(check.status)) throw new Error("invalid check");
      const [label, pass, fail] = CHECKS[id];
      return Object.freeze({
        id,
        label,
        status: check.status,
        message: check.status === "pass" ? pass : check.status === "fail" ? fail : NOT_CHECKED,
      });
    });
    if (!checks.some(({ status }) => status === "fail")) return null;
    const pair = Object.freeze({
      failedTransactionHash: hash(value.pair.failedTransactionHash),
      successfulTransactionHash: hash(value.pair.successfulTransactionHash),
    });
    if (pair.failedTransactionHash === pair.successfulTransactionHash) return null;
    const campaign = Object.freeze({
      poolAddress: address(value.campaign.poolAddress),
      campaignNumber: integer(value.campaign.campaignNumber, 1),
      termsHash: hash(value.campaign.termsHash),
      startBlock: integer(value.campaign.startBlock),
      endBlock: integer(value.campaign.endBlock, 1),
      maxBlockGap: integer(value.campaign.maxBlockGap, 1),
      maxQuantity: integer(value.campaign.maxQuantity, 1),
      creditAmount: positiveWei(value.campaign.creditAmount),
      deadline: integer(value.campaign.deadline, 1),
    });
    if (campaign.startBlock >= campaign.endBlock) return null;
    return Object.freeze({
      schema: RECOVERY_PAIR_DIAGNOSTICS_SCHEMA,
      authority: "advisory-source-check",
      attestationVerified: false,
      checkedAt: value.checkedAt,
      sourceChainId: 1,
      pair,
      campaign,
      summary: SUMMARY,
      checks: Object.freeze(checks),
      facts: Object.freeze({
        failed: sourceFacts(value.facts.failed),
        successful: sourceFacts(value.facts.successful),
      }),
    });
  } catch {
    return null;
  }
}

function sourceFacts(value) {
  const status = integer(value.status);
  if (status !== 0 && status !== 1) throw new Error("invalid receipt status");
  return Object.freeze({ blockNumber: integer(value.blockNumber, 1), nonce: integer(value.nonce), status });
}

function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("invalid integer");
  return value;
}

function positiveWei(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,77}$/.test(value)) throw new Error("invalid amount");
  return value;
}

function hash(value) {
  if (typeof value !== "string" || !isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error("invalid hash");
  return value.toLowerCase();
}

function address(value) {
  const normalized = getAddress(value);
  if (/^0x0{40}$/i.test(normalized)) throw new Error("invalid address");
  return normalized;
}
