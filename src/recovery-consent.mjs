export const RECOVERY_CHALLENGE_LIFETIME_SECONDS = 5 * 60;
export const RECOVERY_MAXIMUM_CLOCK_SKEW_SECONDS = 30;
export const RECOVERY_SETTLEMENT_CHAIN_ID = 102_031;
export const RECOVERY_CONSENT_FINAL_LINE = "Authorize proof and relayer submission for this exact pair. The campaign contract derives the credit recipient from Ethereum; no destination can be substituted.";

export function formatRecoveryChallengeMessage({
  origin,
  poolAddress,
  campaignNumber,
  wallet,
  failedTransactionHash,
  successfulTransactionHash,
  issuedAt,
  expiresAt,
  settlementChainId = RECOVERY_SETTLEMENT_CHAIN_ID,
}) {
  return [
    "RetryCredit recovery consent",
    "Origin: " + origin,
    "Settlement: Creditcoin Testnet (" + settlementChainId + ")",
    "Recovery pool: " + poolAddress,
    "Campaign: " + campaignNumber,
    "Source wallet and credit recipient: " + wallet,
    "Failed Ethereum transaction: " + failedTransactionHash,
    "Successful Ethereum transaction: " + successfulTransactionHash,
    "Issued at: " + issuedAt,
    "Expires at: " + expiresAt,
    RECOVERY_CONSENT_FINAL_LINE,
  ].join("\n");
}
