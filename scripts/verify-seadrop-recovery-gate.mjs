import { ethers } from "ethers";
import { blockProver, chainInfo, proofProvider } from "@gluwa/usc-sdk";

import {
  OPEN_SEA_FEE_RECIPIENT,
  OPEN_SEA_CALLDATA_SUFFIX,
  SEA_DROP_MAINNET,
  validateSeaDropRecoveryPair,
} from "../src/seadrop-recovery.mjs";

const CREDITCOIN_RPC =
  process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const PROOF_BUILDER =
  process.env.CREDITCOIN_PROOF_BUILDER_URL
  ?? "https://prover.cc3-testnet.creditcoin.network";
const ETHEREUM_CHAIN_KEY = 3;
const DESTINATION_CHAIN_ID = 102031n;
const PROOF_TIMEOUT_MS = 120_000;

const DEFAULT_ETHEREUM_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://eth.drpc.org",
];

const ETHEREUM_RPCS = (
  process.env.ETHEREUM_RPC_URLS?.split(",") ?? DEFAULT_ETHEREUM_RPCS
)
  .map((value) => value.trim())
  .filter(Boolean);

const PAIRS = Object.freeze([
  {
    id: "qdmoney-vata-free",
    failedTransactionHash:
      "0xd2ba7a54e9afc7032f9b24caf61a88ab654b08f1b79a85d53de8596b1e7ba84a",
    successfulTransactionHash:
      "0xe241a86a27d96b4d5752d4ea2f5c6218e31863229adc761d174f1a15d3ef62cf",
    profile: {
      sourceChainId: 1,
      seaDrop: SEA_DROP_MAINNET,
      nftContract: "0x6081B754134F988185b8c733A975C51c14e64cd7",
      feeRecipient: OPEN_SEA_FEE_RECIPIENT,
      minterIfNotPayer: ethers.ZeroAddress,
      quantity: 1n,
      valueWei: 0n,
      mintParams: {
        mintPrice: 0n,
        maxTotalMintableByWallet: 1n,
        startTime: 1_776_265_200n,
        endTime: 1_776_268_800n,
        dropStageIndex: 2n,
        maxTokenSupplyForStage: 3_000n,
        feeBps: 1_000n,
        restrictFeeRecipients: true,
      },
      maxBlockGap: 5,
      requirePaid: false,
      calldataSuffix: OPEN_SEA_CALLDATA_SUFFIX,
    },
  },
  {
    id: "unrelated-wallet-paid",
    failedTransactionHash:
      "0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff",
    successfulTransactionHash:
      "0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a",
    profile: {
      sourceChainId: 1,
      seaDrop: SEA_DROP_MAINNET,
      nftContract: "0x39dc450bc38e173b02f9141317af581502fc12a2",
      feeRecipient: OPEN_SEA_FEE_RECIPIENT,
      minterIfNotPayer: ethers.ZeroAddress,
      quantity: 2n,
      valueWei: 5_000_000_000_000_000n,
      mintParams: {
        mintPrice: 2_500_000_000_000_000n,
        maxTotalMintableByWallet: 2n,
        startTime: 1_787_689_800n,
        endTime: 1_787_693_400n,
        dropStageIndex: 2n,
        maxTokenSupplyForStage: 250n,
        feeBps: 1_000n,
        restrictFeeRecipients: true,
      },
      maxBlockGap: 5,
      requirePaid: true,
      calldataSuffix: OPEN_SEA_CALLDATA_SUFFIX,
    },
  },
]);

if (ETHEREUM_RPCS.length === 0) throw new Error("no Ethereum mainnet RPC is configured");

const destinationProvider = new ethers.JsonRpcProvider(
  CREDITCOIN_RPC,
  DESTINATION_CHAIN_ID,
  { staticNetwork: true },
);
const destinationNetwork = await destinationProvider.getNetwork();
if (destinationNetwork.chainId !== DESTINATION_CHAIN_ID) {
  throw new Error(`unexpected destination chain ${destinationNetwork.chainId}`);
}

const chainProvider = new chainInfo.PrecompileChainInfoProvider(destinationProvider);
const ethereum = await chainProvider.getSupportedChainByKey(ETHEREUM_CHAIN_KEY);
if (!ethereum || ethereum.chainId !== 1) {
  throw new Error("Ethereum mainnet chain key 3 is unavailable");
}
const latest = await chainProvider.getLatestAttestedHeightAndHash(ETHEREUM_CHAIN_KEY);
if (!latest.exists) throw new Error("Ethereum mainnet has no live Attestcoin attestation");

const builder = new proofProvider.service.ProofBuilder(
  ETHEREUM_CHAIN_KEY,
  PROOF_BUILDER,
  PROOF_TIMEOUT_MS,
);
const verifier = new blockProver.PrecompileBlockProver(destinationProvider);
const verifiedPairs = [];

for (const pair of PAIRS) {
  const source = await fetchPairFromPublicEthereum(pair);
  const semantic = validateSeaDropRecoveryPair({ ...source, profile: pair.profile });
  const proofResult = await builder.getBatchProof([
    pair.failedTransactionHash,
    pair.successfulTransactionHash,
  ]);
  if (!proofResult.success || !proofResult.data) {
    throw new Error(`Attestcoin rejected the pair-local batch for ${pair.id}`);
  }

  const batch = bindBatchToSemanticPair(proofResult.data, semantic);
  const verified = await verifier.verifyBatch(
    ETHEREUM_CHAIN_KEY,
    batch.sourceBlocks,
    batch.encodedTransactions,
    batch.merkleProofs,
    proofResult.data.continuityProof,
  );
  if (!verified) throw new Error(`native Attestcoin verification failed for ${pair.id}`);

  verifiedPairs.push({
    id: pair.id,
    semantic,
    nativeBatch: {
      sourceChainKey: ETHEREUM_CHAIN_KEY,
      fromBlock: batch.fromBlock,
      toBlock: batch.toBlock,
      transactionHashes: batch.transactionHashes,
      sourceBlocks: batch.sourceBlocks,
      merkleSiblingCounts: batch.merkleProofs.map((proof) => proof.siblings.length),
      continuityRootCount: proofResult.data.continuityProof.roots.length,
      verified,
    },
  });
}

console.log(
  JSON.stringify(
    {
      gate: "retrycredit-seadrop-recovery-v2",
      destinationChainId: Number(destinationNetwork.chainId),
      sourceChainId: 1,
      sourceChainKey: ETHEREUM_CHAIN_KEY,
      latestAttestedHeight: Number(latest.height),
      pairLocalBatchCount: verifiedPairs.length,
      pairs: verifiedPairs,
      passed: verifiedPairs.length === PAIRS.length && verifiedPairs.every((pair) => pair.nativeBatch.verified),
    },
    null,
    2,
  ),
);

destinationProvider.destroy();

async function fetchPairFromPublicEthereum(pair) {
  for (const rpc of ETHEREUM_RPCS) {
    const provider = new ethers.JsonRpcProvider(rpc, 1, { staticNetwork: true });
    try {
      const network = await provider.getNetwork();
      if (network.chainId !== 1n) continue;
      const [failedTransaction, failedReceipt, successfulTransaction, successfulReceipt] =
        await Promise.all([
          provider.getTransaction(pair.failedTransactionHash),
          provider.getTransactionReceipt(pair.failedTransactionHash),
          provider.getTransaction(pair.successfulTransactionHash),
          provider.getTransactionReceipt(pair.successfulTransactionHash),
        ]);
      if (!failedTransaction || !failedReceipt || !successfulTransaction || !successfulReceipt) {
        continue;
      }
      return { failedTransaction, failedReceipt, successfulTransaction, successfulReceipt };
    } catch {
      // Try the next public endpoint without emitting URLs or provider errors into gate output.
    } finally {
      provider.destroy();
    }
  }
  throw new Error(`public Ethereum mainnet lookup failed for ${pair.id}`);
}

function bindBatchToSemanticPair(proof, semantic) {
  if (Number(proof.chainKey) !== ETHEREUM_CHAIN_KEY) {
    throw new Error(`unexpected proof chain key ${proof.chainKey}`);
  }
  if (!(proof.merkleProofs instanceof Map)) {
    throw new Error("Attestcoin batch merkleProofs must be a Map");
  }

  const expected = new Map([
    [semantic.failed.transactionHash, semantic.failed.blockNumber],
    [semantic.successful.transactionHash, semantic.successful.blockNumber],
  ]);
  const entries = new Map();

  for (const [sourceBlockValue, perBlock] of proof.merkleProofs.entries()) {
    const sourceBlock = Number(sourceBlockValue);
    if (!Number.isSafeInteger(sourceBlock) || sourceBlock <= 0 || !(perBlock instanceof Map)) {
      throw new Error("Attestcoin returned a malformed per-block proof map");
    }
    for (const entry of perBlock.values()) {
      const transactionHash = normalizeHash(entry.txHash);
      if (!expected.has(transactionHash)) {
        throw new Error(`Attestcoin batch included an unexpected transaction ${transactionHash}`);
      }
      if (entries.has(transactionHash)) {
        throw new Error(`Attestcoin batch duplicated transaction ${transactionHash}`);
      }
      if (expected.get(transactionHash) !== sourceBlock) {
        throw new Error(`Attestcoin source block did not match Ethereum for ${transactionHash}`);
      }
      if (typeof entry.txBytes !== "string" || !ethers.isHexString(entry.txBytes)) {
        throw new Error("Attestcoin batch included invalid encoded transaction bytes");
      }
      if (!entry.merkleProof || !Array.isArray(entry.merkleProof.siblings)) {
        throw new Error("Attestcoin batch included an invalid transaction Merkle proof");
      }
      entries.set(transactionHash, {
        sourceBlock,
        encodedTransaction: entry.txBytes,
        merkleProof: entry.merkleProof,
      });
    }
  }

  if (entries.size !== expected.size) {
    throw new Error("Attestcoin pair-local batch did not contain exactly both requested transactions");
  }
  if (!proof.continuityProof || !Array.isArray(proof.continuityProof.roots)) {
    throw new Error("Attestcoin pair-local batch has no shared continuity proof");
  }

  const transactionHashes = [...expected.keys()];
  const ordered = transactionHashes.map((hash) => entries.get(hash));
  const fromBlock = Number(proof.fromHeader);
  const toBlock = Number(proof.toHeader);
  if (
    !Number.isSafeInteger(fromBlock)
    || !Number.isSafeInteger(toBlock)
    || fromBlock > semantic.failed.blockNumber
    || toBlock < semantic.successful.blockNumber
  ) {
    throw new Error("Attestcoin continuity range does not cover the semantic pair");
  }

  return {
    fromBlock,
    toBlock,
    transactionHashes,
    sourceBlocks: ordered.map((entry) => entry.sourceBlock),
    encodedTransactions: ordered.map((entry) => entry.encodedTransaction),
    merkleProofs: ordered.map((entry) => entry.merkleProof),
  };
}

function normalizeHash(value) {
  if (typeof value !== "string" || !ethers.isHexString(value, 32)) {
    throw new Error("Attestcoin batch transaction hash must be 32 bytes");
  }
  return value.toLowerCase();
}
