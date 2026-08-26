import { readFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blockProver, chainInfo, proofProvider } from "@gluwa/usc-sdk";
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  id,
  isHexString,
  keccak256,
  parseEther,
} from "ethers";

const CC3_CHAIN_ID = 102_031;
const SOURCE_CHAIN_ID = 1;
const SOURCE_CHAIN_KEY = 3;
const NATIVE_VERIFIER = getAddress("0x0000000000000000000000000000000000000fd2");
const CHAIN_INFO = getAddress("0x0000000000000000000000000000000000000fd3");
const SEA_DROP = getAddress("0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
const OPEN_SEA_FEE_RECIPIENT = getAddress("0x0000a26b00c1F0DF003000390027140000fAa719");
const OPEN_SEA_ATTRIBUTION_SUFFIX = "0x3d958fe2";
const CREDIT_AMOUNT = parseEther("0.1");
const MAX_CLAIMS = 3;
const CAMPAIGN_FUNDING = parseEther("0.3");
const CAMPAIGN_DURATION_SECONDS = 14 * 24 * 60 * 60;
const MINIMUM_OPERATOR_BALANCE = CAMPAIGN_FUNDING + parseEther("0.2");
const MAX_BATCH_BLOCK_SPAN = 1_000;
const PROOF_TIMEOUT_MS = 120_000;
const RELEASE_GAS_LIMIT = 8_000_000n;
const DEFAULT_CC3_RPC = "https://rpc.cc3-testnet.creditcoin.network";
const DEFAULT_PROOF_BUILDER = "https://prover.cc3-testnet.creditcoin.network";
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ALREADY_CLAIMED_SELECTOR = id("AlreadyClaimed()").slice(0, 10);
const REPLAY_SELECTOR = id("Replay()").slice(0, 10);

const RULE = Object.freeze({
  feeRecipient: OPEN_SEA_FEE_RECIPIENT,
  startBlock: 25_805_168,
  endBlock: 25_835_360,
  maxBlockGap: 5,
  maxQuantity: 2,
});

const RECOVERY_PAIR = Object.freeze({
  chainKey: SOURCE_CHAIN_KEY,
  beneficiary: getAddress("0x61ceFF58C74dE887604E0A680bF1058a9D5b74D1"),
  failed: Object.freeze({
    transactionHash: "0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff",
    blockNumber: 25_834_612,
  }),
  successful: Object.freeze({
    transactionHash: "0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a",
    blockNumber: 25_834_614,
  }),
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = Object.freeze({
  decoder: "out/EvmV1Decoder.sol/EvmV1Decoder.json",
  predicate: "out/SeaDropPaidRetryPredicateV1.sol/SeaDropPaidRetryPredicateV1.json",
  verifier: "out/AttestcoinSeaDropRetryVerifier.sol/AttestcoinSeaDropRetryVerifier.json",
  campaign: "out/RetryCreditRecoveryCampaign.sol/RetryCreditRecoveryCampaign.json",
});

async function main() {
  const command = parseRunnerCommand(process.argv.slice(2));
  const config = resolveRunnerConfig(command, process.env);
  const secrets = [
    config.privateKey,
    config.cc3Rpc,
    config.proofBuilderUrl,
    config.resumeStatePath,
  ];
  const mode = command === "resume" ? "bounded-resume-only" : "bounded-all-in-one";

  try {
    let evidence;
    if (command === "resume") {
      const resumeState = normalizeResumeState(
        JSON.parse(await readFile(config.resumeStatePath, "utf8")),
      );
      evidence = await resumeLifecycle({
        privateKey: config.privateKey,
        cc3Rpc: config.cc3Rpc,
        proofBuilderUrl: config.proofBuilderUrl,
        resumeState,
      });
    } else {
      evidence = await runLifecycle({
        privateKey: config.privateKey,
        cc3Rpc: config.cc3Rpc,
        proofBuilderUrl: config.proofBuilderUrl,
      });
    }
    writeEvidence(evidence, secrets);
  } catch (error) {
    writeEvidence({
      schemaVersion: "retrycredit.recovery-campaign-evidence.v1",
      mode,
      passed: false,
      stage: error?.lifecycleProgress?.stage ?? "preflight",
      partial: error?.lifecycleProgress?.evidence ?? {},
      error: {
        name: typeof error?.name === "string" ? error.name : "Error",
        message: typeof error?.message === "string" ? error.message : "lifecycle failed",
      },
    }, secrets);
    process.exitCode = 1;
  }
}

export function parseRunnerCommand(args) {
  if (!Array.isArray(args) || args.length !== 1 || !["run", "resume"].includes(args[0])) {
    throw new Error("usage: node scripts/retrycredit-recovery-campaign-runner.mjs <run|resume>");
  }
  return args[0];
}

export function resolveRunnerConfig(command, env = {}) {
  if (command !== "run" && command !== "resume") {
    throw new Error("runner command must be run or resume");
  }
  const privateKey = requirePrivateKey(env.SPIKE_PRIVATE_KEY);
  const cc3Rpc = env.CREDITCOIN_RPC ?? DEFAULT_CC3_RPC;
  const proofBuilderUrl = env.CREDITCOIN_PROOF_BUILDER_URL
    ?? env.ATTESTCOIN_PROOF_BUILDER
    ?? DEFAULT_PROOF_BUILDER;
  let resumeStatePath = null;
  if (command === "resume") {
    if (typeof env.RECOVERY_RESUME_STATE_PATH !== "string" || env.RECOVERY_RESUME_STATE_PATH.trim() === "") {
      throw new Error("RECOVERY_RESUME_STATE_PATH is required for resume mode");
    }
    resumeStatePath = path.resolve(env.RECOVERY_RESUME_STATE_PATH.trim());
  }
  return Object.freeze({ command, privateKey, cc3Rpc, proofBuilderUrl, resumeStatePath });
}

async function runLifecycle({ privateKey, cc3Rpc, proofBuilderUrl }) {
  const provider = new JsonRpcProvider(cc3Rpc, CC3_CHAIN_ID, { staticNetwork: true });
  const operator = new Wallet(privateKey, provider);
  const progress = {
    stage: "preflight",
    evidence: {
      networks: expectedNetworks(),
      operator: operator.address,
      deployments: {},
      transactions: {},
      rule: serializeRule(RULE),
    },
  };

  try {
    if (CAMPAIGN_FUNDING !== CREDIT_AMOUNT * BigInt(MAX_CLAIMS)) {
      throw new Error("campaign funding constants do not multiply exactly");
    }
    const pairGap = RECOVERY_PAIR.successful.blockNumber - RECOVERY_PAIR.failed.blockNumber;
    if (
      RECOVERY_PAIR.failed.blockNumber < RULE.startBlock
      || RECOVERY_PAIR.successful.blockNumber > RULE.endBlock
      || pairGap <= 0
      || pairGap > RULE.maxBlockGap
    ) throw new Error("the exact paid pair is outside the bounded campaign rule");

    await assertNetwork(provider, CC3_CHAIN_ID, "Creditcoin CC3");
    const balance = await provider.getBalance(operator.address);
    if (balance < MINIMUM_OPERATOR_BALANCE) {
      throw new Error("operator balance is below the bounded lifecycle minimum");
    }

    const chainProvider = new chainInfo.PrecompileChainInfoProvider(provider);
    const [ethereum, latestAttestation] = await Promise.all([
      chainProvider.getSupportedChainByKey(SOURCE_CHAIN_KEY),
      chainProvider.getLatestAttestedHeightAndHash(SOURCE_CHAIN_KEY),
    ]);
    if (!ethereum || Number(ethereum.chainId) !== SOURCE_CHAIN_ID) {
      throw new Error("Creditcoin chain key 3 is not bound to Ethereum mainnet");
    }
    if (
      !latestAttestation?.exists
      || Number(latestAttestation.height) < RULE.endBlock
    ) {
      throw new Error("the complete recovery campaign source window is not attested");
    }

    progress.stage = "proof-preflight";
    const builder = new proofProvider.service.ProofBuilder(
      SOURCE_CHAIN_KEY,
      proofBuilderUrl,
      PROOF_TIMEOUT_MS,
    );
    const proofResult = await builder.getBatchProof([
      RECOVERY_PAIR.failed.transactionHash,
      RECOVERY_PAIR.successful.transactionHash,
    ]);
    if (!proofResult?.success || !proofResult.data) {
      throw new Error("Attestcoin did not return the required pair-local batch");
    }
    const normalizedProof = normalizePairBatchProof(proofResult.data, RECOVERY_PAIR);
    const nativeVerifier = new blockProver.PrecompileBlockProver(provider);
    const nativeBatchVerified = await nativeVerifier.verifyBatch(
      SOURCE_CHAIN_KEY,
      normalizedProof.sourceBlocks,
      normalizedProof.encodedTransactions,
      normalizedProof.merkleProofs,
      {
        lowerEndpointDigest: normalizedProof.lowerEndpointDigest,
        roots: normalizedProof.continuityRoots,
      },
    );
    if (!nativeBatchVerified) throw new Error("native Attestcoin batch verification failed");
    progress.evidence.proof = proofEvidence(normalizedProof, nativeBatchVerified);

    const [decoderArtifact, predicateArtifact, verifierArtifact, campaignArtifact] = await Promise.all([
      readArtifact(artifacts.decoder),
      readArtifact(artifacts.predicate),
      readArtifact(artifacts.verifier),
      readArtifact(artifacts.campaign),
    ]);

    progress.stage = "deploy-decoder";
    const decoder = await deployContract("EvmV1Decoder", decoderArtifact, operator, []);
    progress.evidence.deployments.decoder = deploymentEvidence(decoder);

    progress.stage = "deploy-predicate";
    const predicate = await deployContract(
      "SeaDropPaidRetryPredicateV1",
      predicateArtifact,
      operator,
      [],
      { EvmV1Decoder: decoder.address },
    );
    progress.evidence.deployments.predicate = deploymentEvidence(predicate);

    progress.stage = "deploy-verifier";
    const verifier = await deployContract(
      "AttestcoinSeaDropRetryVerifier",
      verifierArtifact,
      operator,
      [predicate.address, ZeroAddress],
    );
    progress.evidence.deployments.verifier = deploymentEvidence(verifier);

    progress.stage = "deploy-campaign";
    const campaign = await deployContract(
      "RetryCreditRecoveryCampaign",
      campaignArtifact,
      operator,
      [verifier.address, ZeroAddress],
    );
    progress.evidence.deployments.campaign = deploymentEvidence(campaign);

    progress.stage = "verify-bindings";
    const bindings = await verifyRuntimeBindings({
      provider,
      decoder,
      predicate,
      verifier,
      campaign,
      predicateArtifact,
      verifierArtifact,
      campaignArtifact,
    });
    progress.evidence.bindings = bindings;

    const predicateContract = new Contract(predicate.address, predicateArtifact.abi, operator);
    const verifierContract = new Contract(verifier.address, verifierArtifact.abi, operator);
    const campaignContract = new Contract(campaign.address, campaignArtifact.abi, operator);
    await predicateContract.validateTerms.staticCall(RULE);

    progress.stage = "simulate-deployed-verifier";
    const contractProof = toContractProof(normalizedProof);
    const predictedRelease = await verifierContract.verifyRelease.staticCall(
      contractProof,
      RULE,
      { gasLimit: RELEASE_GAS_LIMIT },
    );
    const releaseIdentity = normalizeReleaseIdentity(predictedRelease);
    if (releaseIdentity.beneficiary !== RECOVERY_PAIR.beneficiary) {
      throw new Error("the deployed Attestcoin verifier derived an unexpected beneficiary");
    }

    const latestBeforeCampaign = await provider.getBlock("latest");
    if (!latestBeforeCampaign) throw new Error("latest Creditcoin block is unavailable");
    const deadline = Number(latestBeforeCampaign.timestamp) + CAMPAIGN_DURATION_SECONDS;
    const predictedCampaignNumber = await campaignContract.createCampaign.staticCall(
      RULE,
      CREDIT_AMOUNT,
      MAX_CLAIMS,
      deadline,
      { value: CAMPAIGN_FUNDING },
    );
    if (predictedCampaignNumber !== 1n) {
      throw new Error("fresh recovery campaign did not predict campaign number one");
    }

    progress.stage = "create-campaign";
    const campaignReceipt = await sendSuccess(campaignContract.createCampaign(
      RULE,
      CREDIT_AMOUNT,
      MAX_CLAIMS,
      deadline,
      { value: CAMPAIGN_FUNDING },
    ));
    progress.evidence.transactions.campaignCreation = campaignReceipt.hash;
    const campaignEvent = requireEvent(
      campaignContract.interface,
      campaignReceipt,
      "CampaignCreated",
      campaign.address,
    );
    assertCampaignCreatedEvent({
      event: campaignEvent,
      campaignNumber: predictedCampaignNumber,
      sponsor: operator.address,
      deadline,
    });

    const createdState = await readCampaignState(
      campaignContract,
      provider,
      campaign.address,
      predictedCampaignNumber,
    );
    assertCampaignState(createdState, {
      sponsor: operator.address,
      deadline,
      claimCount: 0n,
      accountedBalance: CAMPAIGN_FUNDING,
      remainingAccounted: CAMPAIGN_FUNDING,
      contractBalance: CAMPAIGN_FUNDING,
      claimed: false,
    });
    progress.evidence.campaign = {
      number: predictedCampaignNumber,
      creationTransactionHash: campaignReceipt.hash,
      creationBlockNumber: campaignReceipt.blockNumber,
      deadline,
      durationSeconds: CAMPAIGN_DURATION_SECONDS,
      creditAmount: CREDIT_AMOUNT,
      maxClaims: MAX_CLAIMS,
      fundedAmount: CAMPAIGN_FUNDING,
      termsHash: campaignEvent.termsHash,
      initialAccountedBalance: createdState.accountedBalance,
    };

    progress.stage = "simulate-release";
    await campaignContract.releaseCredit.staticCall(
      predictedCampaignNumber,
      contractProof,
      { gasLimit: RELEASE_GAS_LIMIT },
    );

    progress.stage = "release-credit";
    const releaseTransaction = await operator.sendTransaction({
      to: campaign.address,
      data: campaignContract.interface.encodeFunctionData("releaseCredit", [
        predictedCampaignNumber,
        contractProof,
      ]),
      gasLimit: RELEASE_GAS_LIMIT,
      value: 0,
    });
    progress.evidence.transactions.release = releaseTransaction.hash;
    const releaseReceipt = await releaseTransaction.wait();
    if (!releaseReceipt || Number(releaseReceipt.status) !== 1) {
      throw new Error("credit release transaction failed");
    }
    progress.evidence.transactions.release = releaseReceipt.hash;
    const releaseEvent = requireEvent(
      campaignContract.interface,
      releaseReceipt,
      "CreditReleased",
      campaign.address,
    );
    assertCreditReleasedEvent({
      event: releaseEvent,
      campaignNumber: predictedCampaignNumber,
      operator: operator.address,
      expected: releaseIdentity,
    });

    if (releaseReceipt.blockNumber <= 0) throw new Error("release receipt has an invalid block number");
    const [beneficiaryBefore, beneficiaryAfter, campaignBefore, campaignAfter] = await Promise.all([
      provider.getBalance(RECOVERY_PAIR.beneficiary, releaseReceipt.blockNumber - 1),
      provider.getBalance(RECOVERY_PAIR.beneficiary, releaseReceipt.blockNumber),
      provider.getBalance(campaign.address, releaseReceipt.blockNumber - 1),
      provider.getBalance(campaign.address, releaseReceipt.blockNumber),
    ]);
    const beneficiaryDelta = beneficiaryAfter - beneficiaryBefore;
    const campaignDelta = campaignBefore - campaignAfter;
    if (beneficiaryDelta !== CREDIT_AMOUNT || campaignDelta !== CREDIT_AMOUNT) {
      throw new Error("release did not move the exact fixed credit to the proof-derived beneficiary");
    }

    const releasedState = await readCampaignState(
      campaignContract,
      provider,
      campaign.address,
      predictedCampaignNumber,
      releaseIdentity,
    );
    assertCampaignState(releasedState, {
      sponsor: operator.address,
      deadline,
      claimCount: 1n,
      accountedBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      remainingAccounted: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      contractBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      claimed: true,
      queriesConsumed: true,
      pairConsumed: true,
    });

    progress.stage = "verify-replay";
    const replay = await requireStaticReplayRejection(
      campaignContract,
      predictedCampaignNumber,
      contractProof,
    );

    progress.stage = "complete";
    return {
      schemaVersion: "retrycredit.recovery-campaign-evidence.v1",
      mode: "bounded-all-in-one",
      passed: true,
      networks: {
        destinationChainId: CC3_CHAIN_ID,
        sourceChainId: SOURCE_CHAIN_ID,
        sourceChainKey: SOURCE_CHAIN_KEY,
      },
      operator: operator.address,
      sourceAttestation: {
        latestHeightAtPreflight: Number(latestAttestation.height),
        requiredEndBlock: RULE.endBlock,
        completeWindowAttested: true,
      },
      pair: {
        beneficiary: RECOVERY_PAIR.beneficiary,
        failed: RECOVERY_PAIR.failed,
        successful: RECOVERY_PAIR.successful,
      },
      proof: progress.evidence.proof,
      deployments: progress.evidence.deployments,
      bindings,
      rule: serializeRule(RULE),
      campaign: progress.evidence.campaign,
      release: {
        transactionHash: releaseReceipt.hash,
        blockNumber: releaseReceipt.blockNumber,
        eventCount: 1,
        beneficiary: releaseIdentity.beneficiary,
        beneficiaryBalanceBefore: beneficiaryBefore,
        beneficiaryBalanceAfter: beneficiaryAfter,
        beneficiaryDelta,
        campaignBalanceBefore: campaignBefore,
        campaignBalanceAfter: campaignAfter,
        campaignDelta,
        actionId: releaseIdentity.actionId,
        failureQueryId: releaseIdentity.failureQueryId,
        successQueryId: releaseIdentity.successQueryId,
        pairId: releaseIdentity.pairId,
        claimCount: releasedState.campaign.claimCount,
      },
      accounting: {
        fundedAmount: releasedState.campaign.fundedAmount,
        accountedBalance: releasedState.accountedBalance,
        remainingAccounted: releasedState.remainingAccounted,
        beneficiaryClaimed: releasedState.claimed,
        failureQueryConsumed: releasedState.failureQueryConsumed,
        successQueryConsumed: releasedState.successQueryConsumed,
        pairConsumed: releasedState.pairConsumed,
      },
      replay,
    };
  } catch (error) {
    if (error && typeof error === "object") {
      try {
        error.lifecycleProgress = progress;
      } catch {
        // A frozen provider error still propagates safely, without partial lifecycle metadata.
      }
    }
    throw error;
  } finally {
    provider.destroy();
  }
}

export function normalizeResumeState(state) {
  if (!isRecord(state)) throw new Error("resume state must be a JSON object");
  if (state.schemaVersion !== "retrycredit.recovery-campaign-evidence.v1") {
    throw new Error("resume state has an unsupported schema version");
  }
  if (!["bounded-all-in-one", "bounded-resume-only"].includes(state.mode) || state.passed !== false) {
    throw new Error("resume state must be a failed bounded lifecycle");
  }
  if (!isRecord(state.partial)) throw new Error("resume state is missing partial lifecycle evidence");
  const partial = state.partial;

  const networks = normalizeNetworks(partial.networks);
  const operator = requireNonzeroAddress(partial.operator, "resume operator");
  const rule = serializeRule(partial.rule);
  if (JSON.stringify(rule) !== JSON.stringify(serializeRule(RULE))) {
    throw new Error("resume state rule does not match the bounded campaign rule");
  }

  if (!isRecord(partial.deployments)) throw new Error("resume state is missing deployments");
  const deployments = {};
  for (const label of ["decoder", "predicate", "verifier", "campaign"]) {
    deployments[label] = normalizeDeploymentRecord(partial.deployments[label], label);
  }
  const deploymentAddresses = Object.values(deployments).map((deployment) => deployment.address);
  if (new Set(deploymentAddresses).size !== deploymentAddresses.length) {
    throw new Error("resume deployment addresses must be distinct");
  }
  const deploymentTransactions = Object.values(deployments)
    .map((deployment) => deployment.transactionHash);
  if (new Set(deploymentTransactions).size !== deploymentTransactions.length) {
    throw new Error("resume deployment transactions must be distinct");
  }

  if (!isRecord(partial.transactions)) throw new Error("resume state is missing transactions");
  const campaignCreationTransaction = requireHash(
    partial.transactions.campaignCreation,
    "resume campaign-creation transaction",
  );
  if (!isRecord(partial.campaign)) throw new Error("resume state is missing campaign evidence");
  const campaign = {
    number: requireSafeInteger(partial.campaign.number, "resume campaign number"),
    creationTransactionHash: requireHash(
      partial.campaign.creationTransactionHash,
      "resume campaign creation transaction",
    ),
    creationBlockNumber: requireSafeInteger(
      partial.campaign.creationBlockNumber,
      "resume campaign creation block",
    ),
    deadline: requireSafeInteger(partial.campaign.deadline, "resume campaign deadline"),
    durationSeconds: requireSafeInteger(
      partial.campaign.durationSeconds,
      "resume campaign duration",
    ),
    creditAmount: requireUnsignedBigInt(partial.campaign.creditAmount, "resume credit amount"),
    maxClaims: requireSafeInteger(partial.campaign.maxClaims, "resume maximum claims"),
    fundedAmount: requireUnsignedBigInt(partial.campaign.fundedAmount, "resume funded amount"),
    termsHash: requireHash(partial.campaign.termsHash, "resume campaign terms hash"),
    initialAccountedBalance: requireUnsignedBigInt(
      partial.campaign.initialAccountedBalance,
      "resume initial accounted balance",
    ),
  };
  if (campaign.number !== 1) throw new Error("resume campaign number must be one");
  if (campaign.creationTransactionHash !== campaignCreationTransaction) {
    throw new Error("resume campaign-creation transaction hashes differ");
  }
  if (deploymentTransactions.includes(campaignCreationTransaction)) {
    throw new Error("resume campaign creation must differ from every deployment transaction");
  }
  if (
    campaign.durationSeconds !== CAMPAIGN_DURATION_SECONDS
    || campaign.creditAmount !== CREDIT_AMOUNT
    || campaign.maxClaims !== MAX_CLAIMS
    || campaign.fundedAmount !== CAMPAIGN_FUNDING
    || campaign.initialAccountedBalance !== CAMPAIGN_FUNDING
  ) throw new Error("resume campaign funding or duration differs from the bounded lifecycle");
  if (campaign.termsHash === ZERO_HASH) throw new Error("resume campaign terms hash must be nonzero");

  return freezeDeep({
    schemaVersion: state.schemaVersion,
    failedStage: typeof state.stage === "string" ? state.stage : "unknown",
    networks,
    operator,
    deployments,
    transactions: { campaignCreation: campaignCreationTransaction },
    rule,
    campaign,
  });
}

async function resumeLifecycle({ privateKey, cc3Rpc, proofBuilderUrl, resumeState }) {
  const provider = new JsonRpcProvider(cc3Rpc, CC3_CHAIN_ID, { staticNetwork: true });
  const operator = new Wallet(privateKey, provider);
  const progress = {
    stage: "resume-preflight",
    evidence: {
      networks: resumeState.networks,
      operator: operator.address,
      deployments: resumeState.deployments,
      transactions: { ...resumeState.transactions },
      rule: resumeState.rule,
      campaign: resumeState.campaign,
      resumedFromStage: resumeState.failedStage,
    },
  };

  try {
    if (operator.address !== resumeState.operator) {
      throw new Error("resume signer does not match the original campaign operator");
    }
    if (CAMPAIGN_FUNDING !== CREDIT_AMOUNT * BigInt(MAX_CLAIMS)) {
      throw new Error("campaign funding constants do not multiply exactly");
    }
    await assertNetwork(provider, CC3_CHAIN_ID, "Creditcoin CC3");
    const balance = await provider.getBalance(operator.address);
    if (balance < MINIMUM_OPERATOR_BALANCE - CAMPAIGN_FUNDING) {
      throw new Error("operator balance is below the bounded resume minimum");
    }

    const chainProvider = new chainInfo.PrecompileChainInfoProvider(provider);
    const [ethereum, latestAttestation] = await Promise.all([
      chainProvider.getSupportedChainByKey(SOURCE_CHAIN_KEY),
      chainProvider.getLatestAttestedHeightAndHash(SOURCE_CHAIN_KEY),
    ]);
    if (!ethereum || Number(ethereum.chainId) !== SOURCE_CHAIN_ID) {
      throw new Error("Creditcoin chain key 3 is not bound to Ethereum mainnet");
    }
    if (!latestAttestation?.exists || Number(latestAttestation.height) < RULE.endBlock) {
      throw new Error("the complete recovery campaign source window is not attested");
    }

    progress.stage = "resume-proof-preflight";
    const normalizedProof = await buildAndVerifyNativeProof({ provider, proofBuilderUrl });
    progress.evidence.proof = proofEvidence(normalizedProof, true);

    const [decoderArtifact, predicateArtifact, verifierArtifact, campaignArtifact] = await Promise.all([
      readArtifact(artifacts.decoder),
      readArtifact(artifacts.predicate),
      readArtifact(artifacts.verifier),
      readArtifact(artifacts.campaign),
    ]);

    progress.stage = "resume-verify-deployments";
    await verifyRecordedDeployments({
      provider,
      operator: operator.address,
      deployments: resumeState.deployments,
      decoderArtifact,
      predicateArtifact,
      verifierArtifact,
      campaignArtifact,
    });

    const { decoder, predicate, verifier, campaign } = resumeState.deployments;
    const bindings = await verifyRuntimeBindings({
      provider,
      decoder,
      predicate,
      verifier,
      campaign,
      predicateArtifact,
      verifierArtifact,
      campaignArtifact,
    });
    progress.evidence.bindings = bindings;

    const predicateContract = new Contract(predicate.address, predicateArtifact.abi, operator);
    const verifierContract = new Contract(verifier.address, verifierArtifact.abi, operator);
    const campaignContract = new Contract(campaign.address, campaignArtifact.abi, operator);
    await predicateContract.validateTerms.staticCall(RULE);

    progress.stage = "resume-verify-campaign";
    const campaignCreatedEvent = await verifyCampaignCreation({
      provider,
      campaignContract,
      campaignAddress: campaign.address,
      operator: operator.address,
      resumeCampaign: resumeState.campaign,
      transactionHash: resumeState.transactions.campaignCreation,
    });
    if (campaignCreatedEvent.termsHash.toLowerCase() !== resumeState.campaign.termsHash) {
      throw new Error("resume campaign terms hash differs from its creation event");
    }
    const campaignCount = await campaignContract.campaignCount();
    if (campaignCount !== BigInt(resumeState.campaign.number)) {
      throw new Error("resume campaign count differs from the recorded campaign number");
    }
    progress.stage = "resume-simulate-deployed-verifier";
    const contractProof = toContractProof(normalizedProof);
    const predictedRelease = await verifierContract.verifyRelease.staticCall(
      contractProof,
      RULE,
      { gasLimit: RELEASE_GAS_LIMIT },
    );
    const releaseIdentity = normalizeReleaseIdentity(predictedRelease);
    if (releaseIdentity.beneficiary !== RECOVERY_PAIR.beneficiary) {
      throw new Error("the resumed verifier derived an unexpected beneficiary");
    }
    const preReleaseState = await readCampaignState(
      campaignContract,
      provider,
      campaign.address,
      resumeState.campaign.number,
      releaseIdentity,
    );
    const resumeDisposition = classifyResumeCampaignState(preReleaseState);
    const expectedState = resumeDisposition === "existing-release"
      ? {
        claimCount: 1n,
        accountedBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
        remainingAccounted: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
        contractBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
        claimed: true,
        queriesConsumed: true,
        pairConsumed: true,
      }
      : {
        claimCount: 0n,
        accountedBalance: CAMPAIGN_FUNDING,
        remainingAccounted: CAMPAIGN_FUNDING,
        contractBalance: CAMPAIGN_FUNDING,
        claimed: false,
        queriesConsumed: false,
        pairConsumed: false,
      };
    assertCampaignState(preReleaseState, {
      sponsor: operator.address,
      deadline: resumeState.campaign.deadline,
      termsHash: resumeState.campaign.termsHash,
      ...expectedState,
    });

    if (resumeDisposition === "existing-release") {
      progress.stage = "resume-reconcile-existing-release";
      const reconciled = await reconcileExistingRelease({
        provider,
        campaignContract,
        campaignAddress: campaign.address,
        campaignNumber: resumeState.campaign.number,
        creationBlockNumber: resumeState.campaign.creationBlockNumber,
        operator: operator.address,
        releaseIdentity,
        contractProof,
      });
      progress.evidence.transactions.release = reconciled.releaseReceipt.hash;
      progress.stage = "complete";
      return buildResumeSuccessEvidence({
        resumeState,
        operator: operator.address,
        latestAttestation,
        proof: progress.evidence.proof,
        bindings,
        releaseIdentity,
        releasedState: preReleaseState,
        existingReleaseReconciled: true,
        ...reconciled,
      });
    }

    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock || Number(latestBlock.timestamp) > resumeState.campaign.deadline) {
      throw new Error("resume campaign is already closed");
    }
    progress.stage = "resume-simulate-release";
    await campaignContract.releaseCredit.staticCall(
      resumeState.campaign.number,
      contractProof,
      { gasLimit: RELEASE_GAS_LIMIT },
    );

    progress.stage = "resume-release-credit";
    const releaseTransaction = await operator.sendTransaction({
      to: campaign.address,
      data: campaignContract.interface.encodeFunctionData("releaseCredit", [
        resumeState.campaign.number,
        contractProof,
      ]),
      gasLimit: RELEASE_GAS_LIMIT,
      value: 0,
    });
    progress.evidence.transactions.release = releaseTransaction.hash;
    const releaseReceipt = await releaseTransaction.wait();
    if (!releaseReceipt || Number(releaseReceipt.status) !== 1) {
      throw new Error("resumed credit release transaction failed");
    }
    progress.evidence.transactions.release = releaseReceipt.hash;
    const releaseEvent = requireEvent(
      campaignContract.interface,
      releaseReceipt,
      "CreditReleased",
      campaign.address,
    );
    assertCreditReleasedEvent({
      event: releaseEvent,
      campaignNumber: BigInt(resumeState.campaign.number),
      operator: operator.address,
      expected: releaseIdentity,
    });

    if (releaseReceipt.blockNumber <= 0) throw new Error("release receipt has an invalid block number");
    const [beneficiaryBefore, beneficiaryAfter, campaignBefore, campaignAfter] = await Promise.all([
      provider.getBalance(RECOVERY_PAIR.beneficiary, releaseReceipt.blockNumber - 1),
      provider.getBalance(RECOVERY_PAIR.beneficiary, releaseReceipt.blockNumber),
      provider.getBalance(campaign.address, releaseReceipt.blockNumber - 1),
      provider.getBalance(campaign.address, releaseReceipt.blockNumber),
    ]);
    const beneficiaryDelta = beneficiaryAfter - beneficiaryBefore;
    const campaignDelta = campaignBefore - campaignAfter;
    if (beneficiaryDelta !== CREDIT_AMOUNT || campaignDelta !== CREDIT_AMOUNT) {
      throw new Error("resumed release did not move the exact fixed credit to the beneficiary");
    }

    const releasedState = await readCampaignState(
      campaignContract,
      provider,
      campaign.address,
      resumeState.campaign.number,
      releaseIdentity,
    );
    assertCampaignState(releasedState, {
      sponsor: operator.address,
      deadline: resumeState.campaign.deadline,
      termsHash: resumeState.campaign.termsHash,
      claimCount: 1n,
      accountedBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      remainingAccounted: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      contractBalance: CAMPAIGN_FUNDING - CREDIT_AMOUNT,
      claimed: true,
      queriesConsumed: true,
      pairConsumed: true,
    });

    progress.stage = "resume-verify-replay";
    const replay = await requireStaticReplayRejection(
      campaignContract,
      resumeState.campaign.number,
      contractProof,
    );

    progress.stage = "complete";
    return buildResumeSuccessEvidence({
      resumeState,
      operator: operator.address,
      latestAttestation,
      proof: progress.evidence.proof,
      bindings,
      releaseReceipt,
      releaseIdentity,
      beneficiaryBefore,
      beneficiaryAfter,
      beneficiaryDelta,
      campaignBefore,
      campaignAfter,
      campaignDelta,
      releasedState,
      replay,
      existingReleaseReconciled: false,
    });
  } catch (error) {
    if (error && typeof error === "object") {
      try {
        error.lifecycleProgress = progress;
      } catch {
        // A frozen provider error still propagates without resume metadata.
      }
    }
    throw error;
  } finally {
    provider.destroy();
  }
}

export function classifyResumeCampaignState(state) {
  if (!isRecord(state) || !state.campaign || typeof state.campaign !== "object") {
    throw new Error("resume campaign state is incomplete");
  }
  for (const key of ["claimed", "failureQueryConsumed", "successQueryConsumed", "pairConsumed"]) {
    if (typeof state[key] !== "boolean") throw new Error(`resume campaign ${key} must be boolean`);
  }
  const snapshot = {
    claimCount: requireUnsignedBigInt(state.campaign.claimCount, "resume claim count"),
    accountedBalance: requireUnsignedBigInt(state.accountedBalance, "resume accounted balance"),
    remainingAccounted: requireUnsignedBigInt(
      state.remainingAccounted,
      "resume remaining accounted balance",
    ),
    contractBalance: requireUnsignedBigInt(state.contractBalance, "resume contract balance"),
    claimed: state.claimed,
    failureQueryConsumed: state.failureQueryConsumed,
    successQueryConsumed: state.successQueryConsumed,
    pairConsumed: state.pairConsumed,
  };
  const untouched = snapshot.claimCount === 0n
    && snapshot.accountedBalance === CAMPAIGN_FUNDING
    && snapshot.remainingAccounted === CAMPAIGN_FUNDING
    && snapshot.contractBalance === CAMPAIGN_FUNDING
    && !snapshot.claimed
    && !snapshot.failureQueryConsumed
    && !snapshot.successQueryConsumed
    && !snapshot.pairConsumed;
  if (untouched) return "untouched";

  const exactRelease = snapshot.claimCount === 1n
    && snapshot.accountedBalance === CAMPAIGN_FUNDING - CREDIT_AMOUNT
    && snapshot.remainingAccounted === CAMPAIGN_FUNDING - CREDIT_AMOUNT
    && snapshot.contractBalance === CAMPAIGN_FUNDING - CREDIT_AMOUNT
    && snapshot.claimed
    && snapshot.failureQueryConsumed
    && snapshot.successQueryConsumed
    && snapshot.pairConsumed;
  if (exactRelease) return "existing-release";

  throw new Error("resume campaign state is neither untouched nor one exact landed release");
}

async function reconcileExistingRelease({
  provider,
  campaignContract,
  campaignAddress,
  campaignNumber,
  creationBlockNumber,
  operator,
  releaseIdentity,
  contractProof,
}) {
  const filter = campaignContract.filters.CreditReleased(
    BigInt(campaignNumber),
    RECOVERY_PAIR.beneficiary,
    null,
  );
  const matchingEvents = await campaignContract.queryFilter(filter, creationBlockNumber, "latest");
  if (matchingEvents.length !== 1) {
    throw new Error("expected exactly one existing CreditReleased event for campaign and beneficiary");
  }
  const queriedEvent = matchingEvents[0];
  if (getAddress(queriedEvent.address) !== campaignAddress || !queriedEvent.args) {
    throw new Error("existing CreditReleased event has an invalid emitter or arguments");
  }
  assertCreditReleasedEvent({
    event: queriedEvent.args,
    campaignNumber: BigInt(campaignNumber),
    operator,
    expected: releaseIdentity,
  });

  const transactionHash = requireHash(
    queriedEvent.transactionHash ?? queriedEvent.log?.transactionHash,
    "existing release transaction",
  );
  const [transaction, releaseReceipt] = await Promise.all([
    provider.getTransaction(transactionHash),
    provider.getTransactionReceipt(transactionHash),
  ]);
  if (!transaction || !releaseReceipt) throw new Error("existing release transaction is unavailable");
  const parsedRelease = campaignContract.interface.parseTransaction({
    data: transaction.data,
    value: transaction.value,
  });
  const expectedReleaseData = campaignContract.interface.encodeFunctionData("releaseCredit", [
    campaignNumber,
    contractProof,
  ]).toLowerCase();
  if (
    transaction.hash.toLowerCase() !== transactionHash
    || getAddress(transaction.from) !== operator
    || getAddress(transaction.to) !== campaignAddress
    || transaction.value !== 0n
    || String(transaction.data).toLowerCase() !== expectedReleaseData
    || parsedRelease?.name !== "releaseCredit"
    || parsedRelease.args.campaignNumber !== BigInt(campaignNumber)
    || Number(releaseReceipt.status) !== 1
    || releaseReceipt.hash.toLowerCase() !== transactionHash
    || getAddress(releaseReceipt.from) !== operator
    || getAddress(releaseReceipt.to) !== campaignAddress
    || Number(queriedEvent.blockNumber) !== Number(releaseReceipt.blockNumber)
  ) throw new Error("existing release receipt or transaction drifted");

  const receiptEvent = requireEvent(
    campaignContract.interface,
    releaseReceipt,
    "CreditReleased",
    campaignAddress,
  );
  assertCreditReleasedEvent({
    event: receiptEvent,
    campaignNumber: BigInt(campaignNumber),
    operator,
    expected: releaseIdentity,
  });

  if (releaseReceipt.blockNumber <= 0) throw new Error("release receipt has an invalid block number");
  const deltas = await readReleaseBalanceDeltas(provider, campaignAddress, releaseReceipt.blockNumber);
  if (deltas.beneficiaryDelta !== CREDIT_AMOUNT || deltas.campaignDelta !== CREDIT_AMOUNT) {
    throw new Error("existing release did not move the exact fixed credit to the beneficiary");
  }
  const replay = await requireStaticReplayRejection(campaignContract, campaignNumber, contractProof);
  return { releaseReceipt, ...deltas, replay };
}

async function readReleaseBalanceDeltas(provider, campaignAddress, releaseBlockNumber) {
  const [beneficiaryBefore, beneficiaryAfter, campaignBefore, campaignAfter] = await Promise.all([
    provider.getBalance(RECOVERY_PAIR.beneficiary, releaseBlockNumber - 1),
    provider.getBalance(RECOVERY_PAIR.beneficiary, releaseBlockNumber),
    provider.getBalance(campaignAddress, releaseBlockNumber - 1),
    provider.getBalance(campaignAddress, releaseBlockNumber),
  ]);
  return {
    beneficiaryBefore,
    beneficiaryAfter,
    beneficiaryDelta: beneficiaryAfter - beneficiaryBefore,
    campaignBefore,
    campaignAfter,
    campaignDelta: campaignBefore - campaignAfter,
  };
}

function buildResumeSuccessEvidence({
  resumeState,
  operator,
  latestAttestation,
  proof,
  bindings,
  releaseReceipt,
  releaseIdentity,
  beneficiaryBefore,
  beneficiaryAfter,
  beneficiaryDelta,
  campaignBefore,
  campaignAfter,
  campaignDelta,
  releasedState,
  replay,
  existingReleaseReconciled,
}) {
  return {
    schemaVersion: "retrycredit.recovery-campaign-evidence.v1",
    mode: "bounded-resume-only",
    passed: true,
    networks: resumeState.networks,
    operator,
    sourceAttestation: {
      latestHeightAtPreflight: Number(latestAttestation.height),
      requiredEndBlock: RULE.endBlock,
      completeWindowAttested: true,
    },
    pair: {
      beneficiary: RECOVERY_PAIR.beneficiary,
      failed: RECOVERY_PAIR.failed,
      successful: RECOVERY_PAIR.successful,
    },
    proof,
    deployments: resumeState.deployments,
    bindings,
    rule: resumeState.rule,
    campaign: resumeState.campaign,
    resumeValidation: {
      noDeploymentOrCampaignCreation: true,
      deploymentTransactionsVerified: true,
      campaignCreationVerified: true,
      campaignStateVerified: true,
      existingReleaseReconciled,
    },
    release: {
      transactionHash: releaseReceipt.hash,
      blockNumber: releaseReceipt.blockNumber,
      eventCount: 1,
      beneficiary: releaseIdentity.beneficiary,
      beneficiaryBalanceBefore: beneficiaryBefore,
      beneficiaryBalanceAfter: beneficiaryAfter,
      beneficiaryDelta,
      campaignBalanceBefore: campaignBefore,
      campaignBalanceAfter: campaignAfter,
      campaignDelta,
      actionId: releaseIdentity.actionId,
      failureQueryId: releaseIdentity.failureQueryId,
      successQueryId: releaseIdentity.successQueryId,
      pairId: releaseIdentity.pairId,
      claimCount: releasedState.campaign.claimCount,
    },
    accounting: {
      fundedAmount: releasedState.campaign.fundedAmount,
      accountedBalance: releasedState.accountedBalance,
      remainingAccounted: releasedState.remainingAccounted,
      beneficiaryClaimed: releasedState.claimed,
      failureQueryConsumed: releasedState.failureQueryConsumed,
      successQueryConsumed: releasedState.successQueryConsumed,
      pairConsumed: releasedState.pairConsumed,
    },
    replay,
  };
}

async function buildAndVerifyNativeProof({ provider, proofBuilderUrl }) {
  const builder = new proofProvider.service.ProofBuilder(
    SOURCE_CHAIN_KEY,
    proofBuilderUrl,
    PROOF_TIMEOUT_MS,
  );
  const proofResult = await builder.getBatchProof([
    RECOVERY_PAIR.failed.transactionHash,
    RECOVERY_PAIR.successful.transactionHash,
  ]);
  if (!proofResult?.success || !proofResult.data) {
    throw new Error("Attestcoin did not return the required pair-local batch");
  }
  const normalizedProof = normalizePairBatchProof(proofResult.data, RECOVERY_PAIR);
  const nativeVerifier = new blockProver.PrecompileBlockProver(provider);
  const nativeBatchVerified = await nativeVerifier.verifyBatch(
    SOURCE_CHAIN_KEY,
    normalizedProof.sourceBlocks,
    normalizedProof.encodedTransactions,
    normalizedProof.merkleProofs,
    {
      lowerEndpointDigest: normalizedProof.lowerEndpointDigest,
      roots: normalizedProof.continuityRoots,
    },
  );
  if (!nativeBatchVerified) throw new Error("native Attestcoin batch verification failed");
  return normalizedProof;
}

async function verifyRecordedDeployments({
  provider,
  operator,
  deployments,
  decoderArtifact,
  predicateArtifact,
  verifierArtifact,
  campaignArtifact,
}) {
  const expectedData = {
    decoder: await deploymentTransactionData(decoderArtifact, []),
    predicate: await deploymentTransactionData(
      predicateArtifact,
      [],
      { EvmV1Decoder: deployments.decoder.address },
    ),
    verifier: await deploymentTransactionData(
      verifierArtifact,
      [deployments.predicate.address, ZeroAddress],
    ),
    campaign: await deploymentTransactionData(
      campaignArtifact,
      [deployments.verifier.address, ZeroAddress],
    ),
  };
  for (const label of ["decoder", "predicate", "verifier", "campaign"]) {
    await verifyRecordedDeployment({
      provider,
      operator,
      label,
      deployment: deployments[label],
      expectedData: expectedData[label],
    });
  }
}

async function deploymentTransactionData(artifact, constructorArgs, libraries = {}) {
  const bytecode = linkBytecode(
    artifact.bytecode.object,
    artifact.bytecode.linkReferences ?? {},
    libraries,
  );
  const transaction = await new ContractFactory(artifact.abi, bytecode).getDeployTransaction(
    ...constructorArgs,
  );
  if (typeof transaction.data !== "string" || !isHexString(transaction.data)) {
    throw new Error("could not derive exact deployment transaction data");
  }
  return transaction.data.toLowerCase();
}

async function verifyRecordedDeployment({ provider, operator, label, deployment, expectedData }) {
  const [transaction, receipt, runtimeCode] = await Promise.all([
    provider.getTransaction(deployment.transactionHash),
    provider.getTransactionReceipt(deployment.transactionHash),
    provider.getCode(deployment.address),
  ]);
  if (!transaction || !receipt) throw new Error(`${label} deployment transaction is unavailable`);
  if (
    transaction.hash.toLowerCase() !== deployment.transactionHash
    || getAddress(transaction.from) !== operator
    || transaction.to != null
    || String(transaction.data).toLowerCase() !== expectedData
    || Number(receipt.status) !== 1
    || receipt.hash.toLowerCase() !== deployment.transactionHash
    || getAddress(receipt.from) !== operator
    || receipt.to != null
    || getAddress(receipt.contractAddress) !== deployment.address
    || Number(receipt.blockNumber) !== deployment.blockNumber
  ) throw new Error(`${label} deployment receipt or creation transaction drifted`);
  if (!isHexString(runtimeCode) || runtimeCode === "0x") {
    throw new Error(`${label} deployment has no runtime code`);
  }
  if (keccak256(runtimeCode) !== deployment.runtimeCodeHash) {
    throw new Error(`${label} runtime code hash drifted`);
  }
}

async function verifyCampaignCreation({
  provider,
  campaignContract,
  campaignAddress,
  operator,
  resumeCampaign,
  transactionHash,
}) {
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(transactionHash),
    provider.getTransactionReceipt(transactionHash),
  ]);
  if (!transaction || !receipt) throw new Error("campaign-creation transaction is unavailable");
  if (
    transaction.hash.toLowerCase() !== transactionHash
    || getAddress(transaction.from) !== operator
    || getAddress(transaction.to) !== campaignAddress
    || transaction.value !== CAMPAIGN_FUNDING
    || Number(receipt.status) !== 1
    || receipt.hash.toLowerCase() !== transactionHash
    || getAddress(receipt.from) !== operator
    || getAddress(receipt.to) !== campaignAddress
    || Number(receipt.blockNumber) !== resumeCampaign.creationBlockNumber
  ) throw new Error("campaign-creation receipt or transaction drifted");

  const parsed = campaignContract.interface.parseTransaction({
    data: transaction.data,
    value: transaction.value,
  });
  if (
    parsed?.name !== "createCampaign"
    || JSON.stringify(serializeRule(parsed.args.rule ?? parsed.args[0]))
      !== JSON.stringify(serializeRule(RULE))
    || parsed.args.creditAmount !== CREDIT_AMOUNT
    || parsed.args.maxClaims !== BigInt(MAX_CLAIMS)
    || parsed.args.deadline !== BigInt(resumeCampaign.deadline)
  ) throw new Error("campaign-creation calldata differs from the exact funded terms");

  const event = requireEvent(
    campaignContract.interface,
    receipt,
    "CampaignCreated",
    campaignAddress,
  );
  assertCampaignCreatedEvent({
    event,
    campaignNumber: BigInt(resumeCampaign.number),
    sponsor: operator,
    deadline: resumeCampaign.deadline,
  });
  return event;
}

async function deployContract(label, artifact, signer, constructorArgs, libraries = {}) {
  const bytecode = linkBytecode(
    artifact.bytecode.object,
    artifact.bytecode.linkReferences ?? {},
    libraries,
  );
  const factory = new ContractFactory(artifact.abi, bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error(`${label} deployment did not produce a transaction`);
  const receipt = await transaction.wait();
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} deployment failed`);
  const address = await contract.getAddress();
  const runtimeCode = await signer.provider.getCode(address);
  if (!isHexString(runtimeCode) || runtimeCode === "0x") {
    throw new Error(`${label} deployment has no runtime code`);
  }
  return {
    address: getAddress(address),
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    runtimeCodeHash: keccak256(runtimeCode),
  };
}

async function verifyRuntimeBindings({
  provider,
  decoder,
  predicate,
  verifier,
  campaign,
  predicateArtifact,
  verifierArtifact,
  campaignArtifact,
}) {
  const addresses = [decoder.address, predicate.address, verifier.address, campaign.address];
  const runtimeCodes = await Promise.all(addresses.map((address) => provider.getCode(address)));
  if (runtimeCodes.some((code) => !isHexString(code) || code === "0x")) {
    throw new Error("one or more lifecycle contracts have no runtime code");
  }
  if (new Set(addresses.map((address) => getAddress(address))).size !== addresses.length) {
    throw new Error("lifecycle contract addresses must be distinct");
  }

  const predicateContract = new Contract(predicate.address, predicateArtifact.abi, provider);
  const verifierContract = new Contract(verifier.address, verifierArtifact.abi, provider);
  const campaignContract = new Contract(campaign.address, campaignArtifact.abi, provider);
  const [
    predicateSourceChainId,
    predicateSeaDrop,
    predicateSuffix,
    verifierPredicate,
    verifierNative,
    verifierSourceChainKey,
    verifierSourceChainId,
    campaignVerifier,
    campaignPredicate,
    campaignChainInfo,
    campaignSourceChainKey,
    campaignSourceChainId,
  ] = await Promise.all([
    predicateContract.ETHEREUM_CHAIN_ID(),
    predicateContract.SEADROP(),
    predicateContract.OPENSEA_ATTRIBUTION_SUFFIX(),
    verifierContract.predicate(),
    verifierContract.verifier(),
    verifierContract.SOURCE_CHAIN_KEY(),
    verifierContract.SOURCE_CHAIN_ID(),
    campaignContract.retryVerifier(),
    campaignContract.predicate(),
    campaignContract.chainInfo(),
    campaignContract.SOURCE_CHAIN_KEY(),
    campaignContract.SOURCE_CHAIN_ID(),
  ]);

  const actual = {
    predicateSourceChainId: Number(predicateSourceChainId),
    predicateSeaDrop: getAddress(predicateSeaDrop),
    predicateSuffix: String(predicateSuffix).toLowerCase(),
    verifierPredicate: getAddress(verifierPredicate),
    verifierNative: getAddress(verifierNative),
    verifierSourceChainKey: Number(verifierSourceChainKey),
    verifierSourceChainId: Number(verifierSourceChainId),
    campaignVerifier: getAddress(campaignVerifier),
    campaignPredicate: getAddress(campaignPredicate),
    campaignChainInfo: getAddress(campaignChainInfo),
    campaignSourceChainKey: Number(campaignSourceChainKey),
    campaignSourceChainId: Number(campaignSourceChainId),
  };
  const expected = {
    predicateSourceChainId: SOURCE_CHAIN_ID,
    predicateSeaDrop: SEA_DROP,
    predicateSuffix: OPEN_SEA_ATTRIBUTION_SUFFIX,
    verifierPredicate: predicate.address,
    verifierNative: NATIVE_VERIFIER,
    verifierSourceChainKey: SOURCE_CHAIN_KEY,
    verifierSourceChainId: SOURCE_CHAIN_ID,
    campaignVerifier: verifier.address,
    campaignPredicate: predicate.address,
    campaignChainInfo: CHAIN_INFO,
    campaignSourceChainKey: SOURCE_CHAIN_KEY,
    campaignSourceChainId: SOURCE_CHAIN_ID,
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) throw new Error(`runtime binding mismatch: ${key}`);
  }
  return { ...actual, verified: true };
}

async function readCampaignState(
  campaignContract,
  provider,
  campaignAddress,
  campaignNumber,
  releaseIdentity = null,
) {
  const baseCalls = [
    campaignContract.getCampaign(campaignNumber),
    campaignContract.getRule(campaignNumber),
    campaignContract.accountedBalance(),
    campaignContract.remainingAccounted(campaignNumber),
    provider.getBalance(campaignAddress),
    campaignContract.claimedByCampaign(campaignNumber, RECOVERY_PAIR.beneficiary),
  ];
  const replayCalls = releaseIdentity
    ? [
      campaignContract.consumedQueries(campaignNumber, releaseIdentity.failureQueryId),
      campaignContract.consumedQueries(campaignNumber, releaseIdentity.successQueryId),
      campaignContract.consumedPairs(campaignNumber, releaseIdentity.pairId),
    ]
    : [];
  const [campaign, rule, accountedBalance, remainingAccounted, contractBalance, claimed, ...burns] =
    await Promise.all([...baseCalls, ...replayCalls]);
  return {
    campaign,
    rule,
    accountedBalance,
    remainingAccounted,
    contractBalance,
    claimed,
    failureQueryConsumed: burns[0] ?? false,
    successQueryConsumed: burns[1] ?? false,
    pairConsumed: burns[2] ?? false,
  };
}

function assertCampaignState(state, expected) {
  const campaign = state.campaign;
  if (
    getAddress(campaign.sponsor) !== getAddress(expected.sponsor)
    || campaign.creditAmount !== CREDIT_AMOUNT
    || campaign.maxClaims !== BigInt(MAX_CLAIMS)
    || campaign.claimCount !== expected.claimCount
    || campaign.deadline !== BigInt(expected.deadline)
    || campaign.fundedAmount !== CAMPAIGN_FUNDING
    || !isHexString(campaign.termsHash, 32)
    || campaign.termsHash === ZERO_HASH
    || (expected.termsHash != null && campaign.termsHash.toLowerCase() !== expected.termsHash)
    || campaign.remainderRecovered !== false
  ) {
    throw new Error("campaign terms or counters drifted");
  }
  const rule = serializeRule(state.rule);
  if (JSON.stringify(rule) !== JSON.stringify(serializeRule(RULE))) {
    throw new Error("stored recovery rule drifted");
  }
  for (const [key, actual] of [
    ["accountedBalance", state.accountedBalance],
    ["remainingAccounted", state.remainingAccounted],
    ["contractBalance", state.contractBalance],
  ]) {
    if (actual !== expected[key]) throw new Error(`campaign ${key} drifted`);
  }
  if (state.claimed !== expected.claimed) throw new Error("campaign beneficiary claim state drifted");
  if (expected.queriesConsumed != null) {
    if (
      state.failureQueryConsumed !== expected.queriesConsumed
      || state.successQueryConsumed !== expected.queriesConsumed
    ) throw new Error("campaign query burns were not recorded");
  }
  if (expected.pairConsumed != null && state.pairConsumed !== expected.pairConsumed) {
    throw new Error("campaign pair burn was not recorded");
  }
}

function assertCampaignCreatedEvent({ event, campaignNumber, sponsor, deadline }) {
  if (
    event.campaignNumber !== campaignNumber
    || getAddress(event.sponsor) !== getAddress(sponsor)
    || getAddress(event.feeRecipient) !== OPEN_SEA_FEE_RECIPIENT
    || event.creditAmount !== CREDIT_AMOUNT
    || event.maxClaims !== BigInt(MAX_CLAIMS)
    || event.deadline !== BigInt(deadline)
    || event.startBlock !== BigInt(RULE.startBlock)
    || event.endBlock !== BigInt(RULE.endBlock)
    || !isHexString(event.termsHash, 32)
    || event.termsHash === ZERO_HASH
  ) throw new Error("CampaignCreated event did not match the exact funded terms");
}

export function assertCreditReleasedEvent({ event, campaignNumber, operator, expected }) {
  if (
    event.campaignNumber !== campaignNumber
    || getAddress(event.beneficiary) !== expected.beneficiary
    || event.actionId.toLowerCase() !== expected.actionId
    || event.creditAmount !== CREDIT_AMOUNT
    || event.failureQueryId.toLowerCase() !== expected.failureQueryId
    || event.successQueryId.toLowerCase() !== expected.successQueryId
    || event.pairId.toLowerCase() !== expected.pairId
    || getAddress(event.relayer) !== getAddress(operator)
    || event.claimCount !== 1n
  ) throw new Error("CreditReleased event did not match the simulated release");
}

function normalizeReleaseIdentity(result) {
  const identity = {
    beneficiary: requireNonzeroAddress(result.beneficiary ?? result[0], "release beneficiary"),
    actionId: requireHash(result.actionId ?? result[1], "release action ID"),
    failureQueryId: requireHash(result.failureQueryId ?? result[2], "failure query ID"),
    successQueryId: requireHash(result.successQueryId ?? result[3], "success query ID"),
    pairId: requireHash(result.pairId ?? result[4], "release pair ID"),
  };
  for (const [label, value] of Object.entries(identity)) {
    if (label !== "beneficiary" && value === ZERO_HASH) throw new Error(`${label} must be nonzero`);
  }
  return identity;
}

async function requireStaticReplayRejection(campaign, campaignNumber, proof) {
  try {
    await campaign.releaseCredit.staticCall(campaignNumber, proof, { gasLimit: RELEASE_GAS_LIMIT });
  } catch (error) {
    const data = extractRevertData(error);
    const selector = data?.slice(0, 10).toLowerCase() ?? null;
    if (selector === ALREADY_CLAIMED_SELECTOR) {
      return { rejected: true, selector, reason: "AlreadyClaimed" };
    }
    if (selector === REPLAY_SELECTOR) {
      return { rejected: true, selector, reason: "Replay" };
    }
    throw new Error("release replay was rejected for an unexpected reason");
  }
  throw new Error("release replay unexpectedly simulated successfully");
}

async function sendSuccess(transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (!receipt || Number(receipt.status) !== 1) {
    throw new Error(`transaction ${transaction.hash} failed`);
  }
  return receipt;
}

async function assertNetwork(provider, expectedChainId, label) {
  const chainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (chainId !== expectedChainId) throw new Error(`${label} RPC returned chain ${chainId}`);
}

async function readArtifact(relativePath) {
  const artifact = JSON.parse(await readFile(path.join(repoRoot, relativePath), "utf8"));
  const bytecode = artifact.bytecode?.object;
  const references = artifact.bytecode?.linkReferences ?? {};
  const hasReferences = Object.values(references).some((libraries) =>
    Object.values(libraries).some((positions) => Array.isArray(positions) && positions.length > 0));
  if (
    !Array.isArray(artifact.abi)
    || typeof bytecode !== "string"
    || !bytecode.startsWith("0x")
    || bytecode === "0x"
    || (!hasReferences && !isHexString(bytecode))
  ) throw new Error(`compiled artifact is invalid: ${relativePath}`);
  return artifact;
}

export function linkBytecode(bytecodeObject, references, libraries) {
  if (
    typeof bytecodeObject !== "string"
    || !bytecodeObject.startsWith("0x")
    || bytecodeObject === "0x"
  ) throw new Error("compiled linked bytecode is invalid");
  if (!references || typeof references !== "object" || Array.isArray(references)) {
    throw new Error("artifact link references must be an object");
  }
  if (!libraries || typeof libraries !== "object" || Array.isArray(libraries)) {
    throw new Error("deployed libraries must be an object");
  }

  let bytecode = bytecodeObject;
  const occupied = new Set();
  for (const [sourceName, sourceLibraries] of Object.entries(references)) {
    if (!sourceLibraries || typeof sourceLibraries !== "object" || Array.isArray(sourceLibraries)) {
      throw new Error(`invalid link references for ${sourceName}`);
    }
    for (const [libraryName, positions] of Object.entries(sourceLibraries)) {
      if (!Array.isArray(positions) || positions.length === 0) {
        throw new Error(`invalid link positions for ${sourceName}:${libraryName}`);
      }
      const configured = libraries[`${sourceName}:${libraryName}`] ?? libraries[libraryName];
      if (!configured) throw new Error(`missing deployed library ${sourceName}:${libraryName}`);
      const address = requireNonzeroAddress(configured, `library ${libraryName}`).slice(2).toLowerCase();
      for (const position of positions) {
        const startByte = Number(position?.start);
        const length = Number(position?.length);
        if (!Number.isSafeInteger(startByte) || startByte < 0 || length !== 20) {
          throw new Error(`unsupported ${libraryName} link reference`);
        }
        const start = 2 + startByte * 2;
        const end = start + length * 2;
        if (end > bytecode.length) throw new Error(`${libraryName} link reference is out of bounds`);
        const span = `${start}:${end}`;
        if (occupied.has(span)) throw new Error(`${libraryName} link reference is duplicated`);
        occupied.add(span);
        bytecode = `${bytecode.slice(0, start)}${address}${bytecode.slice(end)}`;
      }
    }
  }
  if (!isHexString(bytecode) || bytecode === "0x") {
    throw new Error("linked deployment bytecode is still invalid");
  }
  return bytecode;
}

export function normalizePairBatchProof(proof, expectedPair) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    throw new Error("Attestcoin batch proof must be an object");
  }
  const pair = normalizeExpectedPair(expectedPair);
  if (Number(proof.chainKey) !== pair.chainKey) {
    throw new Error(`unexpected source chain key ${proof.chainKey}`);
  }
  const fromBlock = requireSafeInteger(proof.fromHeader, "fromHeader");
  const toBlock = requireSafeInteger(proof.toHeader, "toHeader");
  if (fromBlock > toBlock || toBlock - fromBlock > MAX_BATCH_BLOCK_SPAN) {
    throw new Error(`invalid batch block range ${fromBlock}-${toBlock}`);
  }
  if (fromBlock > pair.failed.blockNumber || toBlock < pair.successful.blockNumber) {
    throw new Error("Attestcoin continuity range does not cover the exact recovery pair");
  }
  if (!(proof.merkleProofs instanceof Map)) {
    throw new Error("Attestcoin batch merkleProofs must be a Map");
  }

  const expectedByHash = new Map([
    [pair.failed.transactionHash, pair.failed],
    [pair.successful.transactionHash, pair.successful],
  ]);
  const entriesByHash = new Map();
  for (const [sourceBlockValue, perBlock] of proof.merkleProofs.entries()) {
    const sourceBlock = requireSafeInteger(sourceBlockValue, "sourceBlock");
    if (sourceBlock < fromBlock || sourceBlock > toBlock) {
      throw new Error(`source block ${sourceBlock} is outside the shared proof range`);
    }
    if (!(perBlock instanceof Map)) {
      throw new Error("Attestcoin per-block merkle proofs must be a Map");
    }
    for (const [transactionIndexValue, entry] of perBlock.entries()) {
      const transactionIndex = requireSafeInteger(transactionIndexValue, "transactionIndex", true);
      const transactionHash = requireHash(entry?.txHash, "batch transaction hash");
      const expected = expectedByHash.get(transactionHash);
      if (!expected) throw new Error(`unexpected transaction ${transactionHash} in pair-local batch`);
      if (entriesByHash.has(transactionHash)) {
        throw new Error(`duplicate transaction ${transactionHash} in pair-local batch`);
      }
      if (sourceBlock !== expected.blockNumber) {
        throw new Error(`source block did not match the bound transaction ${transactionHash}`);
      }
      if (!isHexString(entry?.txBytes) || entry.txBytes === "0x") {
        throw new Error("Attestcoin batch contains invalid encoded transaction bytes");
      }
      entriesByHash.set(transactionHash, {
        transactionHash,
        transactionIndex,
        sourceBlock,
        encodedTransaction: entry.txBytes.toLowerCase(),
        merkleProof: normalizeMerkleProof(entry.merkleProof),
      });
    }
  }
  if (
    entriesByHash.size !== 2
    || [...expectedByHash.keys()].some((hash) => !entriesByHash.has(hash))
  ) throw new Error("pair-local batch did not contain exactly both bound transactions");

  const continuity = normalizeContinuityProof(proof.continuityProof);
  const transactionHashes = [pair.failed.transactionHash, pair.successful.transactionHash];
  const ordered = transactionHashes.map((hash) => entriesByHash.get(hash));
  if (ordered[1].sourceBlock <= ordered[0].sourceBlock) {
    throw new Error("pair-local batch does not preserve failure-then-success block order");
  }
  return freezeDeep({
    chainKey: pair.chainKey,
    fromBlock,
    toBlock,
    transactionHashes,
    transactionIndexes: ordered.map((entry) => entry.transactionIndex),
    sourceBlocks: ordered.map((entry) => entry.sourceBlock),
    encodedTransactions: ordered.map((entry) => entry.encodedTransaction),
    merkleProofs: ordered.map((entry) => entry.merkleProof),
    lowerEndpointDigest: continuity.lowerEndpointDigest,
    continuityRoots: continuity.roots,
  });
}

export function requireEvent(contractInterface, receipt, eventName, expectedEmitter) {
  const emitter = getAddress(expectedEmitter);
  const matches = [];
  for (const log of receipt?.logs ?? []) {
    let logEmitter;
    try {
      logEmitter = getAddress(log.address);
    } catch {
      continue;
    }
    if (logEmitter !== emitter) continue;
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed?.name === eventName) matches.push(parsed.args);
    } catch {
      // Ignore unrelated logs emitted by the exact contract.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${eventName} event from ${emitter}`);
  }
  return matches[0];
}

export function serializeRule(rule) {
  if (!rule || typeof rule !== "object") {
    throw new Error("recovery rule must be an object");
  }
  const field = (name, index) => rule[name] ?? rule[index];
  return {
    feeRecipient: requireNonzeroAddress(field("feeRecipient", 0), "rule fee recipient"),
    startBlock: requireSafeInteger(field("startBlock", 1), "rule startBlock"),
    endBlock: requireSafeInteger(field("endBlock", 2), "rule endBlock"),
    maxBlockGap: requireSafeInteger(field("maxBlockGap", 3), "rule maxBlockGap"),
    maxQuantity: requireSafeInteger(field("maxQuantity", 4), "rule maxQuantity"),
  };
}

export function extractRevertData(error) {
  const candidates = [
    error?.data,
    error?.revert?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.cause?.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && isHexString(candidate)) return candidate.toLowerCase();
    if (candidate && typeof candidate === "object") {
      for (const nested of [candidate.data, candidate.result, candidate.return]) {
        if (typeof nested === "string" && isHexString(nested)) return nested.toLowerCase();
      }
    }
  }
  return null;
}

export function sanitizeEvidence(value, secrets = []) {
  const normalizedSecrets = secrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length);
  return sanitizeValue(value, normalizedSecrets, "", new WeakSet());
}

export function stringifyEvidence(value, secrets = []) {
  const sanitized = sanitizeEvidence(value, secrets);
  return `${JSON.stringify(sortKeys(sanitized), null, 2)}\n`;
}

function normalizeExpectedPair(pair) {
  if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
    throw new Error("an exact recovery pair is required");
  }
  const normalized = {
    chainKey: requireSafeInteger(pair.chainKey, "expected chain key"),
    failed: {
      transactionHash: requireHash(pair.failed?.transactionHash, "failed transaction hash"),
      blockNumber: requireSafeInteger(pair.failed?.blockNumber, "failed block"),
    },
    successful: {
      transactionHash: requireHash(pair.successful?.transactionHash, "successful transaction hash"),
      blockNumber: requireSafeInteger(pair.successful?.blockNumber, "successful block"),
    },
  };
  if (normalized.failed.transactionHash === normalized.successful.transactionHash) {
    throw new Error("failure and success transaction hashes must differ");
  }
  if (normalized.successful.blockNumber <= normalized.failed.blockNumber) {
    throw new Error("successful transaction must follow the failed transaction");
  }
  return normalized;
}

function normalizeMerkleProof(proof) {
  if (!proof || !Array.isArray(proof.siblings)) {
    throw new Error("invalid transaction merkle proof");
  }
  const root = requireHash(proof.root, "transaction merkle root");
  const siblings = proof.siblings.map((sibling) => {
    if (typeof sibling?.isLeft !== "boolean") {
      throw new Error("invalid transaction merkle proof sibling direction");
    }
    return {
      hash: requireHash(sibling.hash, "transaction merkle proof sibling"),
      isLeft: sibling.isLeft,
    };
  });
  return { root, siblings };
}

function normalizeContinuityProof(proof) {
  if (!proof || !Array.isArray(proof.roots)) throw new Error("invalid continuity proof");
  return {
    lowerEndpointDigest: requireHash(proof.lowerEndpointDigest, "continuity lower endpoint"),
    roots: proof.roots.map((root) => requireHash(root, "continuity root")),
  };
}

function proofEvidence(proof, nativeBatchVerified) {
  return {
    sourceChainKey: proof.chainKey,
    fromBlock: proof.fromBlock,
    toBlock: proof.toBlock,
    transactionHashes: proof.transactionHashes,
    sourceBlocks: proof.sourceBlocks,
    transactionIndexes: proof.transactionIndexes,
    merkleSiblingCounts: proof.merkleProofs.map((merkleProof) => merkleProof.siblings.length),
    continuityRootCount: proof.continuityRoots.length,
    exactHashBlockOrderBound: true,
    nativeBatchVerified,
  };
}

function toContractProof(proof) {
  return {
    sourceBlocks: proof.sourceBlocks,
    encodedTransactions: proof.encodedTransactions,
    merkleProofs: proof.merkleProofs,
    lowerEndpointDigest: proof.lowerEndpointDigest,
    continuityRoots: proof.continuityRoots,
  };
}

function deploymentEvidence(deployment) {
  return {
    address: deployment.address,
    transactionHash: deployment.transactionHash,
    blockNumber: deployment.blockNumber,
    runtimeCodeHash: deployment.runtimeCodeHash,
  };
}

function expectedNetworks() {
  return {
    destinationChainId: CC3_CHAIN_ID,
    sourceChainId: SOURCE_CHAIN_ID,
    sourceChainKey: SOURCE_CHAIN_KEY,
  };
}

function normalizeNetworks(networks) {
  if (!isRecord(networks)) throw new Error("resume state is missing network identity");
  const normalized = {
    destinationChainId: requireSafeInteger(
      networks.destinationChainId,
      "resume destination chain ID",
    ),
    sourceChainId: requireSafeInteger(networks.sourceChainId, "resume source chain ID"),
    sourceChainKey: requireSafeInteger(networks.sourceChainKey, "resume source chain key"),
  };
  if (JSON.stringify(normalized) !== JSON.stringify(expectedNetworks())) {
    throw new Error("resume state network identity differs from the bounded lifecycle");
  }
  return normalized;
}

function normalizeDeploymentRecord(deployment, label) {
  if (!isRecord(deployment)) throw new Error(`resume state is missing ${label} deployment`);
  const normalized = {
    address: requireNonzeroAddress(deployment.address, `${label} deployment address`),
    transactionHash: requireHash(deployment.transactionHash, `${label} deployment transaction`),
    blockNumber: requireSafeInteger(deployment.blockNumber, `${label} deployment block`),
    runtimeCodeHash: requireHash(deployment.runtimeCodeHash, `${label} runtime code hash`),
  };
  if (normalized.runtimeCodeHash === ZERO_HASH) {
    throw new Error(`${label} runtime code hash must be nonzero`);
  }
  return normalized;
}

function requirePrivateKey(value) {
  if (!value || !isHexString(value, 32) || /^0x0+$/i.test(value)) {
    throw new Error("SPIKE_PRIVATE_KEY must be a nonzero 32-byte key");
  }
  return value;
}

function requireNonzeroAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid address`);
  }
  if (address === ZeroAddress) throw new Error(`${label} must be nonzero`);
  return address;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return value.toLowerCase();
}

function requireUnsignedBigInt(value, label) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  if (
    typeof value !== "bigint"
    && typeof value !== "number"
    && !(typeof value === "string" && /^\d+$/.test(value))
  ) throw new Error(`${label} must be an unsigned integer`);
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} must be an unsigned integer`);
  }
  if (parsed < 0n) throw new Error(`${label} must be an unsigned integer`);
  return parsed;
}

function requireSafeInteger(value, label, allowZero = false) {
  if (
    typeof value !== "number"
    && typeof value !== "bigint"
    && !(typeof value === "string" && /^\d+$/.test(value))
  ) throw new Error(`${label} must be a safe integer`);
  let number;
  try {
    number = Number(value);
  } catch {
    throw new Error(`${label} must be a safe integer`);
  }
  if (
    !Number.isSafeInteger(number)
    || (allowZero ? number < 0 : number <= 0)
  ) throw new Error(`${label} must be a ${allowZero ? "nonnegative" : "positive"} safe integer`);
  return number;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) freezeDeep(nested);
  }
  return value;
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeValue(value, secrets, key, seen) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return redactString(value, secrets, key);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) {
    return {
      name: redactString(value.name, secrets, "name"),
      message: redactString(value.message, secrets, "message"),
    };
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, secrets, key, seen));
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("evidence must not contain circular references");
  seen.add(value);
  const result = {};
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    result[nestedKey] = sanitizeValue(nestedValue, secrets, nestedKey, seen);
  }
  seen.delete(value);
  return result;
}

function redactString(value, secrets, key) {
  if (/private.?key|secret/i.test(key)) return "[redacted]";
  if (/rpc|url/i.test(key)) return "[redacted]";
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), "gi"), "[redacted]");
  }
  redacted = redacted.replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[redacted-url]");
  redacted = redacted.replace(/(?:file:\/\/)?\/(?:Users|home|private|tmp)\/[^\s"'<>]+/g, "[redacted-path]");
  return redacted;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
  return sorted;
}

function writeEvidence(evidence, secrets) {
  process.stdout.write(stringifyEvidence(evidence, secrets));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const secrets = [
      process.env.SPIKE_PRIVATE_KEY,
      process.env.CREDITCOIN_RPC,
      process.env.CREDITCOIN_PROOF_BUILDER_URL,
      process.env.ATTESTCOIN_PROOF_BUILDER,
      process.env.RECOVERY_RESUME_STATE_PATH,
      DEFAULT_CC3_RPC,
      DEFAULT_PROOF_BUILDER,
    ];
    writeEvidence({
      schemaVersion: "retrycredit.recovery-campaign-evidence.v1",
      mode: process.argv[2] === "resume" ? "bounded-resume-only" : "bounded-all-in-one",
      passed: false,
      stage: "startup",
      error: {
        name: typeof error?.name === "string" ? error.name : "Error",
        message: typeof error?.message === "string" ? error.message : "startup failed",
      },
    }, secrets);
    process.exitCode = 1;
  });
}
