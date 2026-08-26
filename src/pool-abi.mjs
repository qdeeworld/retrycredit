const proofTuple = "(uint64 sourceBlock,bytes encodedTransaction,bytes32 merkleRoot,(bytes32 hash,bool isLeft)[] siblings,bytes32 lowerEndpointDigest,bytes32[] continuityRoots)";

export const poolAbiV1 = [
  "function campaignCount() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns ((address sponsor,address recipient,uint256 minimumAmount,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline,uint256 fundedPool,uint256 claimantCount,uint256 sharePerClaim,uint256 withdrawnCount,bool finalized))",
  "function registered(uint256 campaignId,address claimant) view returns (bool)",
  "function withdrawn(uint256 campaignId,address claimant) view returns (bool)",
  `function registerClaim(uint256 campaignId,${proofTuple} proof)`,
];

export const poolAbiV2 = [
  "function campaignCount() view returns (uint256)",
  "function getCampaign(uint256 campaignId) view returns ((address sponsor,address recipient,uint256 minimumAmount,uint256 maximumWeight,uint64 startBlock,uint64 endBlock,uint64 registrationDeadline,uint64 withdrawalDeadline,uint256 fundedPool,uint256 claimantCount,uint256 totalWeight,uint256 sharePerClaim,uint256 totalPaid,uint256 withdrawnCount,uint8 claimTemplate,uint8 payoutPolicy,bool finalized))",
  "function getInteractionRule(uint256 campaignId) view returns ((address target,bytes4 selector,address requiredEventEmitter,bytes32 requiredEventSignature,uint8 claimantTopicIndex,uint64 startBlock,uint64 endBlock))",
  "function registered(uint256 campaignId,address claimant) view returns (bool)",
  "function withdrawn(uint256 campaignId,address claimant) view returns (bool)",
  "function claimWeights(uint256 campaignId,address claimant) view returns (uint256)",
  `function registerClaim(uint256 campaignId,${proofTuple} proof)`,
  `function registerInteractionClaim(uint256 campaignId,${proofTuple} proof)`,
];

export function selectPoolAbi(version = "1") {
  if (String(version) === "1") return poolAbiV1;
  if (String(version) === "2") return poolAbiV2;
  throw new Error(`Unsupported RULEDROP_POOL_VERSION: ${version}`);
}

export const poolAbi = poolAbiV1;

const recoveryBatchProofTuple = "(uint64[] sourceBlocks,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,bytes32 lowerEndpointDigest,bytes32[] continuityRoots)";

export const recoveryCampaignAbi = [
  "event CreditReleased(uint256 indexed campaignNumber,address indexed beneficiary,bytes32 indexed actionId,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address relayer,uint32 claimCount)",
  "function campaignCount() view returns (uint256)",
  "function getCampaign(uint256 campaignNumber) view returns ((address sponsor,uint256 creditAmount,uint32 maxClaims,uint32 claimCount,uint64 deadline,uint256 fundedAmount,bytes32 termsHash,bool remainderRecovered))",
  "function getRule(uint256 campaignNumber) view returns ((address feeRecipient,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint8 maxQuantity))",
  "function claimedByCampaign(uint256 campaignNumber,address beneficiary) view returns (bool)",
  "function consumedQueries(uint256 campaignNumber,bytes32 queryId) view returns (bool)",
  "function consumedPairs(uint256 campaignNumber,bytes32 pairId) view returns (bool)",
  "function retryVerifier() view returns (address)",
  "function predicate() view returns (address)",
  "function chainInfo() view returns (address)",
  "function SOURCE_CHAIN_KEY() view returns (uint64)",
  "function SOURCE_CHAIN_ID() view returns (uint64)",
  `function releaseCredit(uint256 campaignNumber,${recoveryBatchProofTuple} proof)`,
];

export const recoveryVerifierAbi = [
  "function predicate() view returns (address)",
  "function verifier() view returns (address)",
  "function SOURCE_CHAIN_KEY() view returns (uint64)",
  "function SOURCE_CHAIN_ID() view returns (uint64)",
];

export const seaDropPaidRetryPredicateAbi = [
  "function ETHEREUM_CHAIN_ID() view returns (uint64)",
  "function SEADROP() view returns (address)",
  "function MINT_SIGNED_SELECTOR() view returns (bytes4)",
  "function MAX_ATTESTCOIN_BATCH_BLOCK_GAP() view returns (uint32)",
];

export const nativeQueryVerifierAbi = [
  "function calculateTxIndex((bytes32 root,(bytes32 hash,bool isLeft)[] siblings) merkleProof) view returns (uint64)",
];
