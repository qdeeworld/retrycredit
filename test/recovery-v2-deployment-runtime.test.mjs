import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Interface, keccak256, toUtf8Bytes } from "ethers";

import {
  RECOVERY_V2_FROZEN_DEPLOYMENT,
  RECOVERY_V2_RUNTIME_ENV,
  buildRecoveryV2DeploymentManifest,
  buildRecoveryV2InitCode,
  createRecoveryV2DeploymentController,
  createRecoveryV2VerificationHooks,
  deriveRecoveryV2DeploymentArmDigest,
  deriveRecoveryV2PrepareArmDigest,
  loadRecoveryV2DeploymentArtifact,
} from "../src/recovery-v2-deployment-runtime.mjs";

const embeddedArtifactUrl = new URL(
  "../src/deployment-artifacts/RetryCreditRecoveryCampaignV2.json",
  import.meta.url,
);
const HASH_A = `0x${"11".repeat(32)}`;
const RECEIPT_BLOCK_HASH = `0x${"ab".repeat(32)}`;
const FINALIZED_BLOCK_HASH = `0x${"cd".repeat(32)}`;

test("the runtime maps the real embedded artifact and exact production constructor", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const initCode = buildRecoveryV2InitCode(artifact);

  assert.equal(artifact.contractName, "RetryCreditRecoveryCampaignV2");
  assert.equal(artifact.abiHash, RECOVERY_V2_FROZEN_DEPLOYMENT.artifact.abiHash);
  assert.equal(artifact.bytecodeHash, RECOVERY_V2_FROZEN_DEPLOYMENT.artifact.creationBytecodeHash);
  assert.equal(artifact.runtimeCodeHash, "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07");
  assert.equal(keccak256(initCode), "0xd069ba5cc3a80251a47b9915c9692e97d9a61d72e903bf590c28a42d4a2b33a6");

  const env = await exactArmedEnvironment(HASH_A, artifact);
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  assert.equal(manifest.constructorArgs[4].rule.startBlock, 15_527_904);
  assert.equal(manifest.constructorArgs[4].rule.endBlock, 25_836_490);
  assert.equal(manifest.constructorArgs[4].creditAmount, "100000000000000000");
  assert.equal(manifest.constructorArgs[4].maxClaims, 10);
  assert.equal(manifest.constructorArgs[4].deadline, 1_790_207_940);
  assert.equal(manifest.value, "1000000000000000000");
  assert.equal(manifest.maxPriorityFeePerGas, "0");
});

test("artifact drift in ABI, creation bytecode, or payload fails closed", async () => {
  const embedded = JSON.parse(await readFile(embeddedArtifactUrl, "utf8"));
  const cases = [
    { mutate(value) { value.abi[0].stateMutability = "nonpayable"; }, code: "RECOVERY_V2_ARTIFACT_ABI_MISMATCH" },
    { mutate(value) { value.creationBytecode = `${value.creationBytecode.slice(0, -2)}00`; }, code: "RECOVERY_V2_ARTIFACT_CREATION_HASH_MISMATCH" },
    { mutate(value) { value.payloadSha256 = `0x${"00".repeat(32)}`; }, code: "RECOVERY_V2_ARTIFACT_PAYLOAD_MISMATCH" },
  ];
  for (const entry of cases) {
    const artifact = structuredClone(embedded);
    entry.mutate(artifact);
    await assert.rejects(
      loadRecoveryV2DeploymentArtifact({ artifact }),
      (error) => error?.code === entry.code,
      entry.code,
    );
  }
});

test("disabled construction is inert and prepare mode can never run the lifecycle", async () => {
  let artifactReads = 0;
  let providerBuilds = 0;
  const disabled = await createRecoveryV2DeploymentController({
    env: {},
    readArtifact: async () => { artifactReads += 1; throw new Error("must stay inert"); },
    providerFactory() { providerBuilds += 1; throw new Error("must stay inert"); },
  });
  assert.equal(disabled.mode, "disabled");
  assert.deepEqual(await disabled.run(), {
    status: "blocked",
    reason: "RECOVERY_V2_DEPLOYMENT_DISABLED",
  });
  assert.deepEqual(disabled.readiness(), {
    ready: true,
    statusCode: 200,
    mode: "disabled",
    deploymentState: "disabled",
    publicProfile: "v1",
  });
  assert.equal(artifactReads, 0);
  assert.equal(providerBuilds, 0);

  const prepareArtifact = await loadRecoveryV2DeploymentArtifact();
  const prepare = await createRecoveryV2DeploymentController({
    env: await exactPrepareEnvironment(prepareArtifact),
    artifact: prepareArtifact,
  });
  assert.deepEqual(await prepare.run(), {
    status: "blocked",
    reason: "RECOVERY_V2_PREPARE_NEVER_BROADCASTS",
  });
  assert.equal(prepare.readiness().ready, true);
  assert.equal(prepare.readiness().publicProfile, "v1");
});

test("prepare signs the exact type-2 request but returns only four public fingerprints", async () => {
  const raw = "0x1234";
  const expectedHash = keccak256(raw);
  let signedRequest;
  let providerBuilds = 0;
  const wallet = {
    async getAddress() { return RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress; },
    async signTransaction(transaction) {
      signedRequest = transaction;
      return raw;
    },
  };
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const controller = await createRecoveryV2DeploymentController({
    env: await exactPrepareEnvironment(artifact),
    artifact,
    wallet,
    providerFactory() { providerBuilds += 1; throw new Error("prepare must not build providers"); },
    transactionParser() {
      return {
        ...signedRequest,
        hash: expectedHash,
        from: RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress,
      };
    },
  });

  const result = await controller.prepare();
  assert.deepEqual(result, {
    transactionHash: expectedHash,
    contractAddress: "0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8",
    initCodeHash: "0xd069ba5cc3a80251a47b9915c9692e97d9a61d72e903bf590c28a42d4a2b33a6",
    runtimeCodeHash: "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07",
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "contractAddress",
    "initCodeHash",
    "runtimeCodeHash",
    "transactionHash",
  ]);
  assert.equal(signedRequest.type, 2);
  assert.equal(signedRequest.chainId, 102031);
  assert.equal(signedRequest.nonce, 55);
  assert.equal(signedRequest.to, null);
  assert.equal(signedRequest.value, 1_000_000_000_000_000_000n);
  assert.equal(signedRequest.gasLimit, 3_200_000n);
  assert.equal(signedRequest.maxFeePerGas, 2_000_000_000n);
  assert.equal(signedRequest.maxPriorityFeePerGas, 0n);
  assert.deepEqual(signedRequest.accessList, []);
  assert.equal(keccak256(signedRequest.data), RECOVERY_V2_FROZEN_DEPLOYMENT.expectedInitCodeHash);
  assert.equal(providerBuilds, 0);
  assert.doesNotMatch(JSON.stringify(result), /1234|signature|private|arm/i);
});

test("prepare rejects a substituted signer before signing", async () => {
  let signs = 0;
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const controller = await createRecoveryV2DeploymentController({
    env: await exactPrepareEnvironment(artifact),
    artifact,
    wallet: {
      async getAddress() { return "0x0000000000000000000000000000000000000011"; },
      async signTransaction() { signs += 1; return "0x1234"; },
    },
  });
  await assert.rejects(
    controller.prepare(),
    (error) => error?.code === "RECOVERY_V2_SIGNER_MISMATCH",
  );
  assert.equal(signs, 0);
});

test("prepare requires an exact revision-bound signing authorization before wallet access", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const exact = await exactPrepareEnvironment(artifact);
  let walletReads = 0;
  const wallet = {
    async getAddress() { walletReads += 1; return RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress; },
    async signTransaction() { walletReads += 1; throw new Error("must stay untouched"); },
  };
  const cases = [
    [without(exact, RECOVERY_V2_RUNTIME_ENV.prepareArm), "RECOVERY_V2_PREPARE_ARM_INVALID"],
    [
      { ...exact, [RECOVERY_V2_RUNTIME_ENV.prepareArm]: `0x${"00".repeat(32)}` },
      "RECOVERY_V2_PREPARE_ARM_MISMATCH",
    ],
    [
      { ...exact, [RECOVERY_V2_RUNTIME_ENV.revision]: "34".repeat(20) },
      "RECOVERY_V2_REVISION_MISMATCH",
    ],
  ];
  for (const [env, code] of cases) {
    await assert.rejects(
      createRecoveryV2DeploymentController({ env, artifact, wallet }),
      (error) => error?.code === code,
      code,
    );
  }
  assert.equal(walletReads, 0);
});

test("arming is deterministic from public prepare data and named env only", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const env = baseArmedEnvironment(HASH_A);
  const first = await deriveRecoveryV2DeploymentArmDigest({ env, artifact });
  const second = await deriveRecoveryV2DeploymentArmDigest({ env, artifact });
  assert.equal(first, second);
  assert.match(first, /^0x[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(env), /private|signature|raw/i);

  env[RECOVERY_V2_RUNTIME_ENV.arm] = first;
  let lifecycleInput;
  let walletSigns = 0;
  const providers = providerPair();
  const controller = await createRecoveryV2DeploymentController({
    env,
    artifact,
    wallet: {
      async getAddress() { return RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress; },
      async signTransaction() { walletSigns += 1; throw new Error("runner must remain inert"); },
    },
    providers,
    lifecycleRunner: async (input) => {
      lifecycleInput = input;
      return Object.freeze({ status: "blocked", reason: "TEST_INERT" });
    },
  });
  assert.equal(controller.mode, "armed");
  assert.equal(controller.readiness().statusCode, 503);
  assert.deepEqual(await controller.run(), { status: "blocked", reason: "TEST_INERT" });
  assert.equal(controller.readiness().statusCode, 503);
  assert.equal(walletSigns, 0);
  assert.equal(lifecycleInput.provider, providers.primary);
  assert.equal(lifecycleInput.manifest.expectedTransactionHash, HASH_A);
  assert.equal(lifecycleInput.manifest.render.revision, env.RENDER_GIT_COMMIT);
  assert.equal(lifecycleInput.manifest.chainCheckpoint.blockNumber, 5_375_351);
  assert.equal(lifecycleInput.manifest.chainCheckpoint.blockHash, RECOVERY_V2_FROZEN_DEPLOYMENT.checkpoint.blockHash);
  assert.equal(typeof lifecycleInput.verification.verifyPreBroadcast, "function");
  assert.equal(typeof lifecycleInput.verification.verifyLegacyBinding, "function");
  assert.equal(typeof lifecycleInput.verification.verifyInitialCampaign, "function");
});

test("armed readiness is 200 only for the exact sanitized finalized-plus-two result", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const env = await exactArmedEnvironment(HASH_A, artifact);
  const finalized = {
    status: "finalized",
    reason: "FINALIZED_PLUS_TWO_VERIFIED",
    chainId: 102031,
    nonce: 55,
    transactionHash: HASH_A,
    contractAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.contractAddress,
    receiptBlockNumber: 200,
    finalizedBlockNumber: 202,
    rawTransaction: "0xsecret",
    arm: "must-not-escape",
  };
  const controller = await createRecoveryV2DeploymentController({
    env,
    artifact,
    wallet: {
      async getAddress() { return RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress; },
      async signTransaction() { throw new Error("inert"); },
    },
    providers: providerPair(),
    lifecycleRunner: async () => finalized,
  });
  assert.equal(controller.readiness().statusCode, 503);
  const result = await controller.run();
  assert.equal(controller.readiness().statusCode, 200);
  assert.equal(controller.readiness().ready, true);
  assert.equal(controller.readiness().publicProfile, "v1");
  assert.equal("rawTransaction" in result, false);
  assert.equal("arm" in result, false);

  const wrongHash = await createRecoveryV2DeploymentController({
    env,
    artifact,
    wallet: {
      async getAddress() { return RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress; },
      async signTransaction() { throw new Error("inert"); },
    },
    providers: providerPair(),
    lifecycleRunner: async () => ({ ...finalized, transactionHash: `0x${"22".repeat(32)}` }),
  });
  await wrongHash.run();
  assert.equal(wrongHash.readiness().statusCode, 503);
});

test("armed mode rejects stale revision, identity drift, malformed window, or absent arm before RPC", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const exact = await exactArmedEnvironment(HASH_A, artifact);
  const cases = [
    [without(exact, RECOVERY_V2_RUNTIME_ENV.arm), "RECOVERY_V2_ARM_INVALID"],
    [{ ...exact, RENDER_SERVICE_ID: "srv-wrong" }, "RECOVERY_V2_RENDER_IDENTITY_MISMATCH"],
    [{ ...exact, [RECOVERY_V2_RUNTIME_ENV.revision]: "22".repeat(20) }, "RECOVERY_V2_REVISION_MISMATCH"],
    [{ ...exact, [RECOVERY_V2_RUNTIME_ENV.notAfter]: String(Number(exact[RECOVERY_V2_RUNTIME_ENV.notBefore]) + 901) }, "RECOVERY_V2_BROADCAST_WINDOW_INVALID"],
    [{ ...exact, [RECOVERY_V2_RUNTIME_ENV.transactionHash]: HASH_A.toUpperCase() }, "RECOVERY_V2_TRANSACTION_HASH_INVALID"],
  ];
  for (const [env, code] of cases) {
    let providerBuilds = 0;
    await assert.rejects(
      createRecoveryV2DeploymentController({
        env,
        artifact,
        providerFactory() { providerBuilds += 1; return providerPair(); },
      }),
      (error) => error?.code === code,
      code,
    );
    assert.equal(providerBuilds, 0, code);
  }
});

test("prebroadcast verification requires official simulation, gas margin, balance, and audit agreement", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const env = await exactArmedEnvironment(HASH_A, artifact);
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  const initCode = buildRecoveryV2InitCode(artifact);
  const primary = preflightProvider();
  const audit = preflightProvider({ audit: true });
  const hooks = createRecoveryV2VerificationHooks({
    primaryProvider: primary,
    auditProvider: audit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  const context = preflightContext(manifest, initCode, artifact);
  const verified = await hooks.verifyPreBroadcast(context);
  assert.deepEqual(verified, {
    schema: "retrycredit.recovery-v2-preflight-result.v1",
    bindingHash: context.bindingHash,
    primaryVerified: true,
    auditVerified: true,
  });
  assert.equal(primary.broadcasts, 0);
  assert.equal(audit.broadcasts, 0);

  const codeDrift = createRecoveryV2VerificationHooks({
    primaryProvider: preflightProvider(),
    auditProvider: preflightProvider({ audit: true, predictedCode: "0x01" }),
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  assert.equal(await codeDrift.verifyPreBroadcast(context), false);

  const thinGasMargin = createRecoveryV2VerificationHooks({
    primaryProvider: preflightProvider({ gasEstimate: 2_700_000n }),
    auditProvider: preflightProvider({ audit: true }),
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  assert.equal(await thinGasMargin.verifyPreBroadcast(context), false);

  const changedUnsigned = structuredClone(context);
  changedUnsigned.transaction.maxPriorityFeePerGas = 1n;
  assert.equal(await hooks.verifyPreBroadcast(changedUnsigned), false);
});

test("post-finality hooks verify canonical tx, receipt, logs, code and getters across both providers", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const env = await exactArmedEnvironment(HASH_A, artifact);
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  const initCode = buildRecoveryV2InitCode(artifact);
  const primary = postFinalityProvider({ artifact, manifest, initCode });
  const audit = postFinalityProvider({ artifact, manifest, initCode });
  const hooks = createRecoveryV2VerificationHooks({
    primaryProvider: primary,
    auditProvider: audit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  const context = {
    transactionHash: manifest.expectedTransactionHash,
    contractAddress: manifest.expectedContractAddress,
    receiptBlockNumber: 200,
    finalizedBlockNumber: 202,
  };
  assert.equal(await hooks.verifyLegacyBinding(context), true);
  assert.equal(await hooks.verifyInitialCampaign(context), true);

  const driftedAudit = postFinalityProvider({
    artifact,
    manifest,
    initCode,
    campaignTermsHash: `0x${"99".repeat(32)}`,
  });
  const driftedHooks = createRecoveryV2VerificationHooks({
    primaryProvider: primary,
    auditProvider: driftedAudit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  assert.equal(await driftedHooks.verifyLegacyBinding(context), false);

  const earlyReleasePrimary = postFinalityProvider({
    artifact,
    manifest,
    initCode,
    legacyClaimCount: 3,
    v2ClaimCount: 1,
  });
  const earlyReleaseAudit = postFinalityProvider({
    artifact,
    manifest,
    initCode,
    legacyClaimCount: 3,
    v2ClaimCount: 1,
  });
  const earlyReleaseHooks = createRecoveryV2VerificationHooks({
    primaryProvider: earlyReleasePrimary,
    auditProvider: earlyReleaseAudit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  assert.equal(await earlyReleaseHooks.verifyLegacyBinding(context), true);
});

test("post-finality verification retries after a transient provider rejection", async () => {
  const artifact = await loadRecoveryV2DeploymentArtifact();
  const env = await exactArmedEnvironment(HASH_A, artifact);
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  const initCode = buildRecoveryV2InitCode(artifact);
  const primary = postFinalityProvider({ artifact, manifest, initCode });
  const audit = postFinalityProvider({ artifact, manifest, initCode });
  const stableGetNetwork = primary.getNetwork;
  let networkCalls = 0;
  primary.getNetwork = async () => {
    networkCalls += 1;
    if (networkCalls === 1) throw new Error("temporary primary outage");
    return stableGetNetwork();
  };
  const hooks = createRecoveryV2VerificationHooks({
    primaryProvider: primary,
    auditProvider: audit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  const context = {
    transactionHash: manifest.expectedTransactionHash,
    contractAddress: manifest.expectedContractAddress,
    receiptBlockNumber: 200,
    finalizedBlockNumber: 202,
  };

  await assert.rejects(hooks.verifyLegacyBinding(context), /temporary primary outage/);
  assert.equal(await hooks.verifyLegacyBinding(context), true);
  assert.equal(await hooks.verifyInitialCampaign(context), true);
  assert.equal(networkCalls, 2);

  const driftedGetterProvider = postFinalityProvider({
    artifact,
    manifest,
    initCode,
    campaignTermsHash: `0x${"99".repeat(32)}`,
  });
  const recoveredAudit = postFinalityProvider({ artifact, manifest, initCode });
  const stableAuditCall = recoveredAudit.call;
  recoveredAudit.call = driftedGetterProvider.call;
  const mismatchHooks = createRecoveryV2VerificationHooks({
    primaryProvider: postFinalityProvider({ artifact, manifest, initCode }),
    auditProvider: recoveredAudit,
    artifact,
    manifest,
    initCode,
    hashBytecode: testCodeHash,
  });
  assert.equal(await mismatchHooks.verifyLegacyBinding(context), false);
  recoveredAudit.call = stableAuditCall;
  assert.equal(await mismatchHooks.verifyLegacyBinding(context), true);
});

function baseArmedEnvironment(transactionHash) {
  const revision = "12".repeat(20);
  return {
    [RECOVERY_V2_RUNTIME_ENV.mode]: "armed",
    [RECOVERY_V2_RUNTIME_ENV.revision]: revision,
    [RECOVERY_V2_RUNTIME_ENV.transactionHash]: transactionHash,
    [RECOVERY_V2_RUNTIME_ENV.notBefore]: "1787720000",
    [RECOVERY_V2_RUNTIME_ENV.notAfter]: "1787720600",
    RENDER: "true",
    RENDER_SERVICE_ID: "srv-da5n322jobas73f8tp70",
    RENDER_SERVICE_NAME: "retrycredit-api",
    RENDER_SERVICE_TYPE: "web",
    RENDER_GIT_REPO_SLUG: "dolepee/retrycredit",
    RENDER_EXTERNAL_HOSTNAME: "retrycredit-api.onrender.com",
    RENDER_GIT_BRANCH: "main",
    RENDER_GIT_COMMIT: revision,
    RENDER_INSTANCE_ID: "instance-test-1",
    IS_PULL_REQUEST: "false",
    PUBLIC_ORIGIN: "https://retrycredit.dolepee.com",
    ALLOWED_ORIGIN: "https://retrycredit.dolepee.com",
    RETRYCREDIT_PUBLIC_ENABLED: "true",
    RETRYCREDIT_RECOVERY_ENABLED: "true",
    RETRYCREDIT_RECOVERY_POOL_ADDRESS: "0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66",
    RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "1",
    RETRYCREDIT_LEGACY_WRITES_ENABLED: "false",
  };
}

async function exactArmedEnvironment(transactionHash, artifact) {
  const env = baseArmedEnvironment(transactionHash);
  env[RECOVERY_V2_RUNTIME_ENV.arm] = await deriveRecoveryV2DeploymentArmDigest({ env, artifact });
  return env;
}

async function exactPrepareEnvironment(artifact) {
  const env = baseArmedEnvironment(HASH_A);
  env[RECOVERY_V2_RUNTIME_ENV.mode] = "prepare";
  delete env[RECOVERY_V2_RUNTIME_ENV.transactionHash];
  delete env[RECOVERY_V2_RUNTIME_ENV.notBefore];
  delete env[RECOVERY_V2_RUNTIME_ENV.notAfter];
  env[RECOVERY_V2_RUNTIME_ENV.prepareArm] = await deriveRecoveryV2PrepareArmDigest({ env, artifact });
  return env;
}

function preflightContext(manifest, initCode, artifact) {
  const binding = {
    schema: "retrycredit.recovery-v2-preflight.v1",
    chainId: 102031,
    nonce: 55,
    signerAddress: manifest.signerAddress,
    expectedContractAddress: manifest.expectedContractAddress,
    expectedTransactionHash: manifest.expectedTransactionHash,
    expectedRuntimeCodeHash: manifest.artifact.runtimeCodeHash,
    expectedInitCodeHash: manifest.expectedInitCodeHash,
    value: manifest.value,
    gasLimit: manifest.gasLimit,
    maxFeePerGas: manifest.maxFeePerGas,
    maxPriorityFeePerGas: manifest.maxPriorityFeePerGas,
    chainCheckpoint: { ...manifest.chainCheckpoint },
    transaction: {
      type: 2,
      chainId: 102031,
      nonce: 55,
      to: null,
      value: manifest.value,
      data: initCode,
      gasLimit: manifest.gasLimit,
      maxFeePerGas: manifest.maxFeePerGas,
      maxPriorityFeePerGas: manifest.maxPriorityFeePerGas,
      accessList: [],
    },
    constructorArgs: structuredClone(manifest.constructorArgs),
    artifact: { ...manifest.artifact },
  };
  return {
    ...binding,
    bindingHash: keccak256(toUtf8Bytes(canonicalJson(binding))),
  };
}

function providerPair() {
  return { primary: providerShape(true), audit: providerShape(false) };
}

function providerShape(primary) {
  const provider = {
    async getNetwork() {},
    async getBlock() {},
    async getBlockNumber() {},
    async getTransactionReceipt() {},
    async getTransaction() {},
    async getTransactionCount() {},
    async getCode() {},
    async getBalance() {},
    async call() {},
  };
  if (primary) {
    provider.estimateGas = async () => 0n;
    provider.broadcastTransaction = async () => { throw new Error("inert"); };
  }
  return provider;
}

function preflightProvider({
  audit = false,
  predictedCode = "0x",
  gasEstimate = 2_500_000n,
} = {}) {
  const provider = providerShape(!audit);
  provider.broadcasts = 0;
  provider.getNetwork = async () => ({ chainId: 102031n });
  provider.getBlock = async (block) => {
    assert.equal(block, RECOVERY_V2_FROZEN_DEPLOYMENT.checkpoint.blockNumber);
    return {
      number: RECOVERY_V2_FROZEN_DEPLOYMENT.checkpoint.blockNumber,
      hash: RECOVERY_V2_FROZEN_DEPLOYMENT.checkpoint.blockHash,
    };
  };
  provider.call = async () => "0x6000";
  provider.getTransactionCount = async (address, tag) => {
    assert.ok(tag === "latest" || tag === "pending");
    return address === RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress ? 55 : 0;
  };
  provider.getCode = async () => predictedCode;
  provider.getBalance = async () => 2_000_000_000_000_000_000n;
  if (!audit) {
    provider.estimateGas = async () => gasEstimate;
    provider.broadcastTransaction = async () => { provider.broadcasts += 1; };
  }
  return provider;
}

function postFinalityProvider({
  artifact,
  manifest,
  initCode,
  campaignTermsHash,
  legacyClaimCount = 1,
  v2ClaimCount = 0,
} = {}) {
  const provider = providerShape(true);
  const iface = new Interface(artifact.abi);
  const legacyIface = new Interface([
    "function retryVerifier() view returns(address)",
    "function predicate() view returns(address)",
    "function chainInfo() view returns(address)",
    "function getCampaign(uint256) view returns((address sponsor,uint256 creditAmount,uint32 maxClaims,uint32 claimCount,uint64 deadline,uint256 fundedAmount,bytes32 termsHash,bool remainderRecovered))",
    "function getRule(uint256) view returns((address feeRecipient,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint8 maxQuantity))",
  ]);
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  const actualCampaignTermsHash = campaignTermsHash ?? frozen.initialCampaign.termsHash;
  const legacyEvent = iface.encodeEventLog(iface.getEvent("LegacyCampaignBound"), [
    frozen.legacy.poolAddress,
    1,
    frozen.signerAddress,
    frozen.legacy.termsHash,
    frozen.legacy.deadline,
    frozen.legacy.rule.startBlock,
    frozen.legacy.rule.endBlock,
  ]);
  const campaignEvent = iface.encodeEventLog(iface.getEvent("CampaignCreated"), [
    1,
    frozen.signerAddress,
    frozen.initialCampaign.rule.feeRecipient,
    frozen.initialCampaign.creditAmount,
    frozen.initialCampaign.maxClaims,
    frozen.initialCampaign.deadline,
    frozen.initialCampaign.rule.startBlock,
    frozen.initialCampaign.rule.endBlock,
    actualCampaignTermsHash,
  ]);
  const logs = [legacyEvent, campaignEvent].map((entry) => ({
    address: frozen.contractAddress,
    blockNumber: 200,
    blockHash: RECEIPT_BLOCK_HASH,
    transactionHash: manifest.expectedTransactionHash,
    topics: entry.topics,
    data: entry.data,
  }));
  provider.getNetwork = async () => ({ chainId: 102031n });
  provider.getBlock = async (block) => {
    if (block === frozen.checkpoint.blockNumber) {
      return {
        number: frozen.checkpoint.blockNumber,
        hash: frozen.checkpoint.blockHash,
        timestamp: 1_787_718_480,
      };
    }
    if (block === 200) return { number: 200, hash: RECEIPT_BLOCK_HASH, timestamp: 1_787_720_000 };
    if (block === 202) return { number: 202, hash: FINALIZED_BLOCK_HASH, timestamp: 1_787_720_030 };
    if (block === "finalized") return { number: 202, hash: FINALIZED_BLOCK_HASH, timestamp: 1_787_720_030 };
    throw new Error("unexpected block");
  };
  provider.getBlockNumber = async () => 202;
  provider.getTransactionReceipt = async () => ({
    hash: manifest.expectedTransactionHash,
    blockNumber: 200,
    blockHash: RECEIPT_BLOCK_HASH,
    status: 1,
    contractAddress: frozen.contractAddress,
    from: frozen.signerAddress,
    to: null,
    logs,
  });
  provider.getTransaction = async () => ({
    hash: manifest.expectedTransactionHash,
    blockNumber: 200,
    blockHash: RECEIPT_BLOCK_HASH,
    type: 2,
    chainId: 102031n,
    nonce: 55,
    from: frozen.signerAddress,
    to: null,
    value: BigInt(frozen.value),
    data: initCode,
    gasLimit: BigInt(frozen.gasLimit),
    maxFeePerGas: BigInt(frozen.maxFeePerGas),
    maxPriorityFeePerGas: 0n,
    accessList: [],
  });
  provider.getCode = async (address) => (
    address === frozen.contractAddress ? "0x6000" : "0x6001"
  );
  provider.getTransactionCount = async () => 1;
  const v2Remaining = BigInt(frozen.value)
    - BigInt(frozen.initialCampaign.creditAmount) * BigInt(v2ClaimCount);
  provider.getBalance = async () => v2Remaining;
  provider.call = async ({ to, data }) => {
    if (to === frozen.contractAddress) {
      const parsed = iface.parseTransaction({ data });
      return encodeV2Getter(
        iface,
        parsed.name,
        actualCampaignTermsHash,
        v2ClaimCount,
        legacyClaimCount === 3,
      );
    }
    if (to === frozen.legacy.poolAddress) {
      const parsed = legacyIface.parseTransaction({ data });
      return encodeLegacyGetter(legacyIface, parsed.name, legacyClaimCount);
    }
    throw new Error("unexpected getter target");
  };
  provider.estimateGas = async () => 2_500_000n;
  provider.broadcastTransaction = async () => { throw new Error("post-finality must not broadcast"); };
  return provider;
}

function encodeV2Getter(iface, name, campaignTermsHash, claimCount, releasesUnlocked) {
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  const remaining = BigInt(frozen.value)
    - BigInt(frozen.initialCampaign.creditAmount) * BigInt(claimCount);
  const scalars = {
    retryVerifier: frozen.verifierAddress,
    predicate: frozen.predicateAddress,
    chainInfo: frozen.chainInfoAddress,
    CHAIN_INFO: frozen.chainInfoAddress,
    legacyPool: frozen.legacy.poolAddress,
    legacySponsor: frozen.signerAddress,
    legacyTermsHash: frozen.legacy.termsHash,
    legacyBindingHash: frozen.legacy.bindingHash,
    legacyStartBlock: frozen.legacy.rule.startBlock,
    legacyEndBlock: frozen.legacy.rule.endBlock,
    legacyDeadline: frozen.legacy.deadline,
    LEGACY_CAMPAIGN_NUMBER: 1,
    SOURCE_CHAIN_KEY: 3,
    SOURCE_CHAIN_ID: 1,
    MAX_CAMPAIGN_DURATION: 30 * 24 * 60 * 60,
    campaignCount: 1,
    accountedBalance: remaining,
    remainingAccounted: remaining,
    releasesUnlocked,
  };
  if (name === "getCampaign") {
    return iface.encodeFunctionResult(name, [[
      frozen.signerAddress,
      frozen.initialCampaign.creditAmount,
      frozen.initialCampaign.maxClaims,
      claimCount,
      frozen.initialCampaign.deadline,
      frozen.value,
      campaignTermsHash,
      false,
    ]]);
  }
  if (name === "getRule") {
    const rule = frozen.initialCampaign.rule;
    return iface.encodeFunctionResult(name, [[
      rule.feeRecipient,
      rule.startBlock,
      rule.endBlock,
      rule.maxBlockGap,
      rule.maxQuantity,
    ]]);
  }
  if (!(name in scalars)) throw new Error(`unexpected V2 getter ${name}`);
  return iface.encodeFunctionResult(name, [scalars[name]]);
}

function encodeLegacyGetter(iface, name, claimCount) {
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  if (name === "getCampaign") {
    return iface.encodeFunctionResult(name, [[
      frozen.signerAddress,
      "100000000000000000",
      3,
      claimCount,
      frozen.legacy.deadline,
      "300000000000000000",
      frozen.legacy.termsHash,
      false,
    ]]);
  }
  if (name === "getRule") {
    const rule = frozen.legacy.rule;
    return iface.encodeFunctionResult(name, [[
      rule.feeRecipient,
      rule.startBlock,
      rule.endBlock,
      rule.maxBlockGap,
      rule.maxQuantity,
    ]]);
  }
  const values = {
    retryVerifier: frozen.verifierAddress,
    predicate: frozen.predicateAddress,
    chainInfo: frozen.chainInfoAddress,
  };
  return iface.encodeFunctionResult(name, [values[name]]);
}

function testCodeHash(code) {
  if (code === "0x6000") return RECOVERY_V2_FROZEN_DEPLOYMENT.expectedRuntimeCodeHash;
  return keccak256(code);
}

function without(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
