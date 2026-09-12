export const RECOVERY_HELPER_MODE = "community-helper-v1";
export const RECOVERY_HELPER_FINAL_LINE = "I request a sponsor-funded recovery for this exact source pair. The helper receives no credit and cannot choose its destination. This is my request, not the source owner's consent. A completed release consumes that source wallet's one-time sponsor credit.";

// Pure formatting shared with the wallet client. Validation and independent
// source derivation remain server responsibilities; these fields grant no
// on-chain authority and are not a destination-selection API.
export function formatRecoveryHelperMessage({
  origin, poolAddress, campaignNumber, requester, sourceWallet, operationId,
  failedTransactionHash, successfulTransactionHash, issuedAt, expiresAt,
  settlementChainId = 102_031,
}) {
  return [
    "RetryCredit community helper request v1",
    "Origin: " + origin,
    "Settlement: Creditcoin Testnet (" + settlementChainId + ")",
    "Recovery pool: " + poolAddress,
    "Campaign: " + campaignNumber,
    "Helper requester: " + requester,
    "Ethereum-derived source wallet and credit recipient: " + sourceWallet,
    "Failed Ethereum transaction: " + failedTransactionHash,
    "Successful Ethereum transaction: " + successfulTransactionHash,
    "Operation: " + operationId,
    "Issued at: " + issuedAt,
    "Expires at: " + expiresAt,
    RECOVERY_HELPER_FINAL_LINE,
  ].join("\n");
}
