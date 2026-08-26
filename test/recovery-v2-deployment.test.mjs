import assert from "node:assert/strict";
import test from "node:test";

import {
  Interface,
  Transaction,
  Wallet,
  concat,
  getAddress,
  getCreateAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";

import {
  RECOVERY_V1_PROFILE,
  RECOVERY_V2_ARM_ENV,
  RECOVERY_V2_CHAIN_ID,
  RECOVERY_V2_DEPLOYMENT_NONCE,
  RECOVERY_V2_DEPLOYMENT_SCHEMA,
  RECOVERY_V2_PREFLIGHT_RESULT_SCHEMA,
  recoveryV2DeploymentArmDigest,
  runRecoveryV2DeploymentLifecycle,
} from "../src/recovery-v2-deployment.mjs";

const sponsorKey = `0x${"31".repeat(32)}`;
const otherKey = `0x${"32".repeat(32)}`;
const legacyPool = RECOVERY_V1_PROFILE.poolAddress;
const runtimeCode = "0x600160005260206000f3";
const deploymentAbi = [
  {
    inputs: [
      { internalType: "address", name: "retryVerifier", type: "address" },
      { internalType: "address", name: "chainInfoOverride", type: "address" },
      { internalType: "address", name: "legacyPool", type: "address" },
      { internalType: "bytes32", name: "expectedLegacyTermsHash", type: "bytes32" },
      {
        internalType: "struct RetryCreditRecoveryCampaignV2.InitialCampaign",
        name: "initial",
        type: "tuple",
        components: [
          {
            internalType: "struct SeaDropPaidRetryPredicateV1.Rule",
            name: "rule",
            type: "tuple",
            components: [
              { internalType: "address", name: "feeRecipient", type: "address" },
              { internalType: "uint64", name: "startBlock", type: "uint64" },
              { internalType: "uint64", name: "endBlock", type: "uint64" },
              { internalType: "uint32", name: "maxBlockGap", type: "uint32" },
              { internalType: "uint8", name: "maxQuantity", type: "uint8" },
            ],
          },
          { internalType: "uint256", name: "creditAmount", type: "uint256" },
          { internalType: "uint32", name: "maxClaims", type: "uint32" },
          { internalType: "uint64", name: "deadline", type: "uint64" },
        ],
      },
    ],
    stateMutability: "payable",
    type: "constructor",
  },
];
const deploymentBytecode = "0x6080604052600060005560016000f3";

test("an exact arm constructs and broadcasts only the committed payable type-2 nonce-55 creation", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture);

  const result = await run(fixture, provider);

  assert.equal(result.status, "broadcast");
  assert.equal(result.reason, "IDENTICAL_RAW_ACCEPTED");
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(provider.broadcasts[0], fixture.rawTransaction);
  const transaction = Transaction.from(provider.broadcasts[0]);
  assert.equal(transaction.type, 2);
  assert.equal(transaction.chainId, BigInt(RECOVERY_V2_CHAIN_ID));
  assert.equal(transaction.nonce, RECOVERY_V2_DEPLOYMENT_NONCE);
  assert.equal(transaction.to, null);
  assert.equal(transaction.value, BigInt(fixture.manifest.value));
  assert.equal(transaction.hash, fixture.manifest.expectedTransactionHash);
  assert.equal(
    getCreateAddress({ from: transaction.from, nonce: transaction.nonce }),
    fixture.manifest.expectedContractAddress,
  );
  assert.deepEqual(Object.keys(result).sort(), [
    "chainId",
    "contractAddress",
    "latestNonce",
    "nonce",
    "pendingNonce",
    "reason",
    "status",
    "transactionHash",
  ]);
});

test("the exact type-2 deployment permits the production zero priority fee", async () => {
  const fixture = await deploymentFixture({ maxPriorityFeePerGas: 0n });
  const provider = new DeploymentProvider(fixture);
  const result = await run(fixture, provider);
  assert.equal(result.status, "broadcast");
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(Transaction.from(provider.broadcasts[0]).maxPriorityFeePerGas, 0n);
});

test("every Render, non-PR, revision, legacy-write, and V1 profile guard is mandatory", async () => {
  const fixture = await deploymentFixture();
  const exactIdentityKeys = [
    "RENDER",
    "RENDER_SERVICE_ID",
    "RENDER_SERVICE_NAME",
    "RENDER_SERVICE_TYPE",
    "RENDER_GIT_REPO_SLUG",
    "RENDER_EXTERNAL_HOSTNAME",
    "RENDER_GIT_BRANCH",
    "RENDER_GIT_COMMIT",
    "IS_PULL_REQUEST",
    "PUBLIC_ORIGIN",
    "ALLOWED_ORIGIN",
    "RETRYCREDIT_PUBLIC_ENABLED",
    "RETRYCREDIT_RECOVERY_ENABLED",
    "RETRYCREDIT_RECOVERY_POOL_ADDRESS",
    "RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER",
    "RETRYCREDIT_LEGACY_WRITES_ENABLED",
  ];

  for (const key of exactIdentityKeys) {
    const provider = new DeploymentProvider(fixture);
    const env = { ...fixture.env };
    delete env[key];
    const result = await run(fixture, provider, { env });
    assert.equal(result.status, "blocked", key);
    assert.equal(result.reason, "RENDER_IDENTITY_INCOMPLETE", key);
    assert.equal(provider.broadcasts.length, 0, key);
    assert.equal(provider.reads, 0, key);
  }

  const mismatches = {
    RENDER: "false",
    RENDER_SERVICE_ID: "srv-da5nh93m8hqs73da7170",
    RENDER_SERVICE_NAME: "retrycredit-api-duplicate",
    RENDER_SERVICE_TYPE: "worker",
    RENDER_GIT_REPO_SLUG: "attacker/retrycredit",
    RENDER_EXTERNAL_HOSTNAME: "retrycredit-api-6fs3.onrender.com",
    RENDER_GIT_BRANCH: "pull/99/head",
    RENDER_GIT_COMMIT: "cd".repeat(20),
    IS_PULL_REQUEST: "true",
    PUBLIC_ORIGIN: "https://example.test",
    ALLOWED_ORIGIN: "https://example.test",
    RETRYCREDIT_PUBLIC_ENABLED: "false",
    RETRYCREDIT_RECOVERY_ENABLED: "false",
    RETRYCREDIT_RECOVERY_POOL_ADDRESS: getAddress("0x0000000000000000000000000000000000000011"),
    RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "2",
    RETRYCREDIT_LEGACY_WRITES_ENABLED: "true",
  };
  for (const [key, value] of Object.entries(mismatches)) {
    const provider = new DeploymentProvider(fixture);
    const result = await run(fixture, provider, { env: { ...fixture.env, [key]: value } });
    assert.equal(result.status, "blocked", key);
    assert.equal(result.reason, "RENDER_IDENTITY_MISMATCH", key);
    assert.equal(provider.broadcasts.length, 0, key);
    assert.equal(provider.reads, 0, key);
  }
});

test("the instance identity and one exact arm digest fail closed when missing or mismatched", async () => {
  const fixture = await deploymentFixture();
  const cases = [
    [{ ...fixture.env, RENDER_INSTANCE_ID: "" }, "RENDER_INSTANCE_ID_INCOMPLETE"],
    [{ ...fixture.env, RENDER_INSTANCE_ID: "bad instance" }, "RENDER_INSTANCE_ID_INCOMPLETE"],
    [without(fixture.env, "RENDER_INSTANCE_ID"), "RENDER_INSTANCE_ID_INCOMPLETE"],
    [without(fixture.env, RECOVERY_V2_ARM_ENV), "DEPLOYMENT_NOT_ARMED"],
    [{ ...fixture.env, [RECOVERY_V2_ARM_ENV]: `0x${"00".repeat(32)}` }, "DEPLOYMENT_ARM_MISMATCH"],
  ];
  for (const [env, reason] of cases) {
    const provider = new DeploymentProvider(fixture);
    const result = await run(fixture, provider, { env });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(provider.reads, 0);
    assert.equal(provider.broadcasts.length, 0);
  }
});

test("broadcast requires an independent preflight hook and never signs after a failed check", async () => {
  const fixture = await deploymentFixture();
  const scenarios = [
    [{}, "blocked", "PREBROADCAST_VERIFICATION_PENDING"],
    [{ async verifyPreBroadcast() { throw new Error("private provider failure"); } }, "blocked", "PREBROADCAST_VERIFICATION_UNAVAILABLE"],
    [{ async verifyPreBroadcast() { return false; } }, "conflict", "PREBROADCAST_VERIFICATION_FAILED"],
  ];

  for (const [verification, status, reason] of scenarios) {
    const provider = new DeploymentProvider(fixture);
    const wallet = trackingWallet(fixture.wallet);
    const result = await run(fixture, provider, { verification, wallet });
    assert.equal(result.status, status);
    assert.equal(result.reason, reason);
    assert.equal(wallet.signCalls, 0);
    assert.equal(provider.broadcasts.length, 0);
  }
});

test("preflight is structurally bound to the exact unsigned transaction and two providers", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture);
  const contexts = [];
  const result = await run(fixture, provider, {
    verification: {
      async verifyPreBroadcast(context) {
        contexts.push(context);
        return verifiedPreflight(context);
      },
    },
  });
  assert.equal(result.status, "broadcast");
  assert.equal(contexts.length, 2);
  assert.deepEqual(contexts[0], contexts[1]);
  const context = contexts[0];
  const signed = Transaction.from(fixture.rawTransaction);
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.transaction), true);
  assert.equal(Object.isFrozen(context.constructorArgs), true);
  assert.equal("provider" in context, false);
  assert.equal("wallet" in context, false);
  assert.equal("rawTransaction" in context, false);
  assert.equal(context.expectedTransactionHash, fixture.manifest.expectedTransactionHash);
  assert.equal(context.expectedContractAddress, fixture.manifest.expectedContractAddress);
  assert.equal(context.expectedInitCodeHash, fixture.manifest.expectedInitCodeHash);
  assert.equal(context.expectedRuntimeCodeHash, fixture.artifact.runtimeCodeHash);
  assert.equal(context.transaction.type, 2);
  assert.equal(context.transaction.chainId, RECOVERY_V2_CHAIN_ID);
  assert.equal(context.transaction.nonce, RECOVERY_V2_DEPLOYMENT_NONCE);
  assert.equal(context.transaction.to, null);
  assert.equal(context.transaction.data, signed.data);
  assert.equal(context.transaction.value, signed.value.toString());
  assert.equal(context.transaction.gasLimit, signed.gasLimit.toString());
  assert.equal(context.transaction.maxFeePerGas, signed.maxFeePerGas.toString());
  assert.equal(
    context.transaction.maxPriorityFeePerGas,
    signed.maxPriorityFeePerGas.toString(),
  );

  const invalidResults = [
    (exact) => ({ ...exact, primaryVerified: false }),
    (exact) => ({ ...exact, auditVerified: false }),
    (exact) => ({ ...exact, bindingHash: `0x${"00".repeat(32)}` }),
    (exact) => ({ ...exact, extra: true }),
  ];
  for (const invalidResult of invalidResults) {
    const blockedProvider = new DeploymentProvider(fixture);
    const blocked = await run(fixture, blockedProvider, {
      verification: {
        async verifyPreBroadcast(exactContext) {
          return invalidResult(verifiedPreflight(exactContext));
        },
      },
    });
    assert.equal(blocked.status, "conflict");
    assert.equal(blocked.reason, "PREBROADCAST_VERIFICATION_FAILED");
    assert.equal(blockedProvider.broadcasts.length, 0);
  }
});

test("the arm binds a short broadcast window and an immutable Creditcoin checkpoint", async () => {
  const fixture = await deploymentFixture();
  const before = await run(fixture, new DeploymentProvider(fixture), {
    clock: () => fixture.manifest.broadcastWindow.notBefore - 1,
  });
  assert.equal(before.status, "blocked");
  assert.equal(before.reason, "BROADCAST_WINDOW_NOT_OPEN");

  const after = await run(fixture, new DeploymentProvider(fixture), {
    clock: () => fixture.manifest.broadcastWindow.notAfter + 1,
  });
  assert.equal(after.status, "blocked");
  assert.equal(after.reason, "BROADCAST_WINDOW_CLOSED");

  const boundary = await run(fixture, new DeploymentProvider(fixture), {
    clock: () => fixture.manifest.broadcastWindow.notAfter,
  });
  assert.equal(boundary.status, "broadcast");

  const wrongChain = await run(fixture, new DeploymentProvider(fixture, { networkChainId: 1 }));
  assert.equal(wrongChain.status, "blocked");
  assert.equal(wrongChain.reason, "CHAIN_ID_MISMATCH");

  const wrongCheckpoint = await run(fixture, new DeploymentProvider(fixture, {
    checkpointHash: `0x${"77".repeat(32)}`,
  }));
  assert.equal(wrongCheckpoint.status, "blocked");
  assert.equal(wrongCheckpoint.reason, "CHAIN_CHECKPOINT_MISMATCH");

  const longWindowManifest = {
    ...fixture.manifest,
    broadcastWindow: {
      notBefore: fixture.manifest.broadcastWindow.notBefore,
      notAfter: fixture.manifest.broadcastWindow.notBefore + 901,
    },
  };
  const longWindow = await run(fixture, new DeploymentProvider(fixture), {
    manifest: longWindowManifest,
    env: armEnvironment(fixture.env, longWindowManifest, fixture.artifact),
  });
  assert.equal(longWindow.status, "blocked");
  assert.equal(longWindow.reason, "BROADCAST_WINDOW_INVALID");
});

test("artifact-dependent values are explicit and pending or mismatched artifacts never reach the wallet", async () => {
  const fixture = await deploymentFixture();
  const cases = [
    [undefined, "ARTIFACT_PENDING"],
    [{ ...fixture.artifact, bytecode: "0x" }, "ARTIFACT_BYTECODE_PENDING"],
    [{ ...fixture.artifact, abiHash: `0x${"00".repeat(32)}` }, "ARTIFACT_ABI_HASH_MISMATCH"],
    [{ ...fixture.artifact, bytecodeHash: `0x${"00".repeat(32)}` }, "ARTIFACT_BYTECODE_HASH_MISMATCH"],
    [{ ...fixture.artifact, runtimeCodeHash: `0x${"00".repeat(32)}` }, "ARTIFACT_MANIFEST_MISMATCH"],
  ];
  for (const [artifact, reason] of cases) {
    const provider = new DeploymentProvider(fixture);
    const signer = trackingWallet(fixture.wallet);
    const result = await run(fixture, provider, { artifact, wallet: signer });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(signer.signCalls, 0);
    assert.equal(provider.reads, 0);
  }
});

test("the manifest commits exact init code, address, signer, and signed transaction hash", async () => {
  const fixture = await deploymentFixture();
  const alternateAddress = getAddress("0x0000000000000000000000000000000000000011");
  const manifestCases = [
    [{ ...fixture.manifest, expectedTransactionHash: null }, "MANIFEST_TRANSACTION_HASH_PENDING"],
    [{ ...fixture.manifest, expectedInitCodeHash: `0x${"01".repeat(32)}` }, "INIT_CODE_HASH_MISMATCH"],
    [{ ...fixture.manifest, expectedContractAddress: alternateAddress }, "CONTRACT_ADDRESS_MISMATCH"],
  ];
  for (const [manifest, reason] of manifestCases) {
    const env = armEnvironment(fixture.env, manifest, fixture.artifact);
    const provider = new DeploymentProvider({ ...fixture, manifest });
    const result = await run(fixture, provider, { manifest, env });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, reason);
    assert.equal(provider.broadcasts.length, 0);
  }

  const wrongSigner = new Wallet(otherKey);
  const walletResult = await run(fixture, new DeploymentProvider(fixture), { wallet: wrongSigner });
  assert.equal(walletResult.status, "blocked");
  assert.equal(walletResult.reason, "WALLET_IDENTITY_MISMATCH");

  const wrongHashManifest = {
    ...fixture.manifest,
    expectedTransactionHash: `0x${"12".repeat(32)}`,
  };
  const wrongHashResult = await run(fixture, new DeploymentProvider({ ...fixture, manifest: wrongHashManifest }), {
    manifest: wrongHashManifest,
    env: armEnvironment(fixture.env, wrongHashManifest, fixture.artifact),
  });
  assert.equal(wrongHashResult.status, "blocked");
  assert.equal(wrongHashResult.reason, "SIGNED_TRANSACTION_HASH_MISMATCH");
});

test("the nonce matrix broadcasts only at latest/pending 55 and never creates nonce 56", async () => {
  const fixture = await deploymentFixture();
  const matrix = [
    { latest: 54, pending: 54, status: "blocked", reason: "SIGNER_NONCE_BEHIND", broadcasts: 0 },
    { latest: 54, pending: 55, status: "blocked", reason: "SIGNER_NONCE_BEHIND", broadcasts: 0 },
    { latest: 55, pending: 54, status: "conflict", reason: "NONCE_ORDER_INVALID", broadcasts: 0 },
    { latest: 55, pending: 55, status: "broadcast", reason: "IDENTICAL_RAW_ACCEPTED", broadcasts: 1 },
    { latest: 55, pending: 56, status: "conflict", reason: "SIGNER_NONCE_CONSUMED", broadcasts: 0 },
    { latest: 56, pending: 56, status: "conflict", reason: "SIGNER_NONCE_CONSUMED", broadcasts: 0 },
    { latest: 56, pending: 57, status: "conflict", reason: "SIGNER_NONCE_CONSUMED", broadcasts: 0 },
  ];
  for (const entry of matrix) {
    const provider = new DeploymentProvider(fixture, {
      latestNonce: entry.latest,
      pendingNonce: entry.pending,
    });
    const result = await run(fixture, provider);
    assert.equal(result.status, entry.status, `${entry.latest}/${entry.pending}`);
    assert.equal(result.reason, entry.reason, `${entry.latest}/${entry.pending}`);
    assert.equal(provider.broadcasts.length, entry.broadcasts, `${entry.latest}/${entry.pending}`);
    for (const raw of provider.broadcasts) {
      assert.equal(Transaction.from(raw).nonce, 55);
    }
  }
});

test("signing and repeated preflight cannot race a changed nonce, closed window, or failed check", async () => {
  const nonceFixture = await deploymentFixture();
  const nonceProvider = new DeploymentProvider(nonceFixture);
  const nonceWallet = {
    async getAddress() { return nonceFixture.wallet.address; },
    async signTransaction(transaction) {
      const raw = await nonceFixture.wallet.signTransaction(transaction);
      nonceProvider.pendingNonce = 56;
      return raw;
    },
  };
  const nonceResult = await run(nonceFixture, nonceProvider, { wallet: nonceWallet });
  assert.equal(nonceResult.status, "conflict");
  assert.equal(nonceResult.reason, "SIGNER_NONCE_CONSUMED");
  assert.equal(nonceProvider.broadcasts.length, 0);

  const windowFixture = await deploymentFixture();
  const windowProvider = new DeploymentProvider(windowFixture);
  let clockCalls = 0;
  const windowResult = await run(windowFixture, windowProvider, {
    clock: () => {
      clockCalls += 1;
      return clockCalls === 1
        ? windowFixture.now
        : windowFixture.manifest.broadcastWindow.notAfter + 1;
    },
  });
  assert.equal(windowResult.status, "blocked");
  assert.equal(windowResult.reason, "PRESEND_WINDOW_CLOSED");
  assert.equal(windowProvider.broadcasts.length, 0);

  const checkFixture = await deploymentFixture();
  const checkProvider = new DeploymentProvider(checkFixture);
  const checkWallet = trackingWallet(checkFixture.wallet);
  let preflightCalls = 0;
  const checkResult = await run(checkFixture, checkProvider, {
    wallet: checkWallet,
    verification: {
      async verifyPreBroadcast(context) {
        preflightCalls += 1;
        return preflightCalls === 1 ? verifiedPreflight(context) : false;
      },
    },
  });
  assert.equal(checkResult.status, "conflict");
  assert.equal(checkResult.reason, "PREBROADCAST_VERIFICATION_FAILED");
  assert.equal(checkWallet.signCalls, 1);
  assert.equal(preflightCalls, 2);
  assert.equal(checkProvider.broadcasts.length, 0);

  const hookWindowFixture = await deploymentFixture();
  const hookWindowProvider = new DeploymentProvider(hookWindowFixture);
  let hookWindowClockCalls = 0;
  const hookWindowResult = await run(hookWindowFixture, hookWindowProvider, {
    clock: () => {
      hookWindowClockCalls += 1;
      return hookWindowClockCalls < 3
        ? hookWindowFixture.now
        : hookWindowFixture.manifest.broadcastWindow.notAfter + 1;
    },
  });
  assert.equal(hookWindowResult.status, "blocked");
  assert.equal(hookWindowResult.reason, "PRESEND_WINDOW_CLOSED");
  assert.equal(hookWindowClockCalls, 3);
  assert.equal(hookWindowProvider.broadcasts.length, 0);
});

test("every external dependency is time bounded and fails closed", async () => {
  const never = () => new Promise(() => {});

  const identityFixture = await deploymentFixture();
  const identityProvider = new DeploymentProvider(identityFixture);
  const identityResult = await run(identityFixture, identityProvider, {
    externalTimeoutMs: 50,
    wallet: {
      getAddress: never,
      async signTransaction() { throw new Error("must not sign"); },
    },
  });
  assert.equal(identityResult.status, "blocked");
  assert.equal(identityResult.reason, "WALLET_IDENTITY_UNAVAILABLE");
  assert.equal(identityProvider.reads, 0);
  assert.equal(identityProvider.broadcasts.length, 0);

  const stateFixture = await deploymentFixture();
  const stateProvider = new DeploymentProvider(stateFixture);
  stateProvider.getNetwork = never;
  const stateResult = await run(stateFixture, stateProvider, { externalTimeoutMs: 50 });
  assert.equal(stateResult.status, "blocked");
  assert.equal(stateResult.reason, "PROVIDER_STATE_UNAVAILABLE");
  assert.equal(stateProvider.broadcasts.length, 0);

  const signingFixture = await deploymentFixture();
  const signingProvider = new DeploymentProvider(signingFixture);
  const signingResult = await run(signingFixture, signingProvider, {
    externalTimeoutMs: 50,
    wallet: {
      async getAddress() { return signingFixture.wallet.address; },
      signTransaction: never,
    },
  });
  assert.equal(signingResult.status, "blocked");
  assert.equal(signingResult.reason, "TRANSACTION_SIGNING_FAILED");
  assert.equal(signingProvider.broadcasts.length, 0);

  const preflightFixture = await deploymentFixture();
  const preflightProvider = new DeploymentProvider(preflightFixture);
  const preflightResult = await run(preflightFixture, preflightProvider, {
    externalTimeoutMs: 50,
    verification: { verifyPreBroadcast: never },
  });
  assert.equal(preflightResult.status, "blocked");
  assert.equal(preflightResult.reason, "PREBROADCAST_VERIFICATION_UNAVAILABLE");
  assert.equal(preflightProvider.broadcasts.length, 0);

  const finalityFixture = await deploymentFixture();
  const finalityProvider = minedProvider(finalityFixture, {
    receiptBlock: 100,
    latestBlock: 102,
    finalizedBlock: 102,
  });
  finalityProvider.getBlockNumber = never;
  const finalityResult = await run(finalityFixture, finalityProvider, {
    externalTimeoutMs: 50,
    verification: truthChecks(),
  });
  assert.equal(finalityResult.status, "mined");
  assert.equal(finalityResult.reason, "FINALITY_STATE_UNAVAILABLE");
  assert.equal(finalityProvider.broadcasts.length, 0);

  const hookFixture = await deploymentFixture();
  const hookProvider = minedProvider(hookFixture, {
    receiptBlock: 100,
    latestBlock: 102,
    finalizedBlock: 102,
  });
  const hookResult = await run(hookFixture, hookProvider, {
    externalTimeoutMs: 50,
    verification: {
      verifyLegacyBinding: never,
      async verifyInitialCampaign() { return true; },
    },
  });
  assert.equal(hookResult.status, "mined");
  assert.equal(hookResult.reason, "VERIFICATION_HOOK_UNAVAILABLE");
  assert.equal(hookProvider.broadcasts.length, 0);
});

test("rolling or duplicate Render instances can only submit identical raw bytes", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture, { retainPrebroadcastState: true });
  const firstEnv = { ...fixture.env, RENDER_INSTANCE_ID: "instance-new-a" };
  const secondEnv = { ...fixture.env, RENDER_INSTANCE_ID: "instance-new-b" };

  const [first, second] = await Promise.all([
    run(fixture, provider, { env: firstEnv }),
    run(fixture, provider, { env: secondEnv }),
  ]);

  assert.equal(first.status, "broadcast");
  assert.equal(second.status, "broadcast");
  assert.equal(provider.broadcasts.length, 2);
  assert.equal(provider.broadcasts[0], provider.broadcasts[1]);
  assert.equal(keccak256(provider.broadcasts[0]), fixture.manifest.expectedTransactionHash);
  assert.deepEqual(provider.broadcasts.map((raw) => Transaction.from(raw).nonce), [55, 55]);
});

test("a later duplicate observes the exact pending transaction and does not rebroadcast", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture);
  assert.equal((await run(fixture, provider)).status, "broadcast");
  const second = await run(fixture, provider, {
    env: { ...fixture.env, RENDER_INSTANCE_ID: "instance-rolling-replacement" },
  });
  assert.equal(second.status, "pending");
  assert.equal(second.reason, "EXPECTED_TRANSACTION_PENDING");
  assert.equal(provider.broadcasts.length, 1);
});

test("a successful receipt becomes finalized only after finality, two later blocks, and both checks", async () => {
  const fixture = await deploymentFixture();
  const provider = minedProvider(fixture, { receiptBlock: 100, latestBlock: 102, finalizedBlock: 102 });
  const calls = [];
  const result = await run(fixture, provider, {
    verification: {
      async verifyLegacyBinding(context) {
        calls.push(["legacy", context]);
        return true;
      },
      async verifyInitialCampaign(context) {
        calls.push(["campaign", context]);
        return true;
      },
    },
  });

  assert.equal(result.status, "finalized");
  assert.equal(result.reason, "FINALIZED_PLUS_TWO_VERIFIED");
  assert.equal(result.receiptBlockNumber, 100);
  assert.equal(result.latestBlockNumber, 102);
  assert.equal(result.finalizedBlockNumber, 102);
  assert.equal(result.confirmations, 3);
  assert.deepEqual(calls.map(([name]) => name), ["legacy", "campaign"]);
  assert.equal(calls[0][1].contractAddress, fixture.manifest.expectedContractAddress);
  assert.equal(provider.broadcasts.length, 0);
});

test("finality and post-finality verification remain fail closed", async () => {
  const fixture = await deploymentFixture();
  const scenarios = [
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 101, finalizedBlock: 100 }),
      verification: truthChecks(),
      status: "mined",
      reason: "AWAITING_FINALIZED_PLUS_TWO",
    },
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 102, finalizedBlock: 99 }),
      verification: truthChecks(),
      status: "mined",
      reason: "AWAITING_FINALIZED_PLUS_TWO",
    },
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 102, finalizedBlock: 102 }),
      verification: {},
      status: "mined",
      reason: "VERIFICATION_HOOKS_PENDING",
    },
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 102, finalizedBlock: 102 }),
      verification: { async verifyLegacyBinding() { return true; }, async verifyInitialCampaign() { return false; } },
      status: "conflict",
      reason: "POST_FINALITY_VERIFICATION_FAILED",
    },
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 102, finalizedBlock: 102 }),
      verification: { async verifyLegacyBinding() { throw new Error("rpc secret"); }, async verifyInitialCampaign() { return true; } },
      status: "mined",
      reason: "VERIFICATION_HOOK_UNAVAILABLE",
    },
    {
      provider: minedProvider(fixture, { receiptBlock: 100, latestBlock: 101, finalizedBlock: 102 }),
      verification: truthChecks(),
      status: "conflict",
      reason: "FINALITY_ORDER_INVALID",
    },
  ];
  for (const scenario of scenarios) {
    const result = await run(fixture, scenario.provider, { verification: scenario.verification });
    assert.equal(result.status, scenario.status);
    assert.equal(result.reason, scenario.reason);
    assert.equal(scenario.provider.broadcasts.length, 0);
  }
});

test("canonical receipt-block, transaction, and historical runtime mismatches are terminal", async () => {
  const fixture = await deploymentFixture();

  const reorgedBlock = minedProvider(fixture, {
    receiptBlock: 100,
    latestBlock: 102,
    finalizedBlock: 102,
  });
  reorgedBlock.receiptBlockHash = `0x${"77".repeat(32)}`;

  const missingTransaction = minedProvider(fixture, {
    receiptBlock: 100,
    latestBlock: 102,
    finalizedBlock: 102,
  });
  const missingTransactionGetBlock = missingTransaction.getBlock.bind(missingTransaction);
  missingTransaction.getBlock = async (tag) => {
    const block = await missingTransactionGetBlock(tag);
    return tag === 100 ? { ...block, transactions: [] } : block;
  };

  const wrongHistoricalRuntime = minedProvider(fixture, {
    receiptBlock: 100,
    latestBlock: 102,
    finalizedBlock: 102,
  });
  const wrongHistoricalGetCode = wrongHistoricalRuntime.getCode.bind(wrongHistoricalRuntime);
  wrongHistoricalRuntime.getCode = async (address, tag) => (
    tag === 100 ? "0x6002" : wrongHistoricalGetCode(address, tag)
  );

  for (const provider of [reorgedBlock, missingTransaction, wrongHistoricalRuntime]) {
    const result = await run(fixture, provider, { verification: truthChecks() });
    assert.equal(result.status, "conflict");
    assert.equal(result.reason, "CANONICAL_DEPLOYMENT_MISMATCH");
    assert.equal(provider.broadcasts.length, 0);
  }
});

test("a reverted creation is terminal and is never replaced", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture, {
    latestNonce: 56,
    pendingNonce: 56,
    transaction: Transaction.from(fixture.rawTransaction),
    receipt: {
      hash: fixture.manifest.expectedTransactionHash,
      status: 0,
      blockNumber: 100,
      blockHash: `0x${"88".repeat(32)}`,
      from: fixture.manifest.signerAddress,
      to: null,
      contractAddress: null,
    },
  });

  const result = await run(fixture, provider);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "DEPLOYMENT_TRANSACTION_REVERTED");
  assert.equal(provider.broadcasts.length, 0);
});

test("transaction, receipt, address, runtime, and post-deploy nonce conflicts never broadcast", async () => {
  const fixture = await deploymentFixture();
  const wrongTransaction = transactionView(fixture.rawTransaction);
  wrongTransaction.gasLimit += 1n;
  const occupiedCode = "0x6002";
  const cases = [
    [new DeploymentProvider(fixture, { transaction: wrongTransaction }), "EXPECTED_TRANSACTION_CONFLICT"],
    [new DeploymentProvider(fixture, { code: occupiedCode, addressNonce: 1 }), "PREDICTED_ADDRESS_OCCUPIED"],
    [minedProvider(fixture, { runtimeCode: occupiedCode }), "DEPLOYED_CODE_CONFLICT"],
    [minedProvider(fixture, { latestNonce: 57, pendingNonce: 57 }), "SIGNER_NONCE_ADVANCED"],
    [new DeploymentProvider(fixture, {
      latestNonce: 56,
      pendingNonce: 56,
      transaction: Transaction.from(fixture.rawTransaction),
      receipt: {
        hash: fixture.manifest.expectedTransactionHash,
        status: 1,
        blockNumber: 100,
        blockHash: `0x${"88".repeat(32)}`,
        from: fixture.manifest.signerAddress,
        to: null,
        contractAddress: getAddress("0x0000000000000000000000000000000000000011"),
      },
    }), "RECEIPT_IDENTITY_CONFLICT"],
  ];
  for (const [provider, reason] of cases) {
    const result = await run(fixture, provider, { verification: truthChecks() });
    assert.equal(result.reason, reason);
    assert.notEqual(result.status, "broadcast");
    assert.equal(provider.broadcasts.length, 0);
  }
});

test("an accepted-but-disconnected broadcast reconciles by exact hash; an unknown broadcast stays uncertain", async () => {
  const fixture = await deploymentFixture();
  const accepted = new DeploymentProvider(fixture, { broadcastFailure: "after" });
  const acceptedResult = await run(fixture, accepted);
  assert.equal(acceptedResult.status, "pending");
  assert.equal(acceptedResult.reason, "EXPECTED_TRANSACTION_PENDING");
  assert.equal(accepted.broadcasts.length, 1);

  const unknown = new DeploymentProvider(fixture, { broadcastFailure: "before" });
  const unknownResult = await run(fixture, unknown);
  assert.equal(unknownResult.status, "broadcast-uncertain");
  assert.equal(unknownResult.reason, "IDENTICAL_RAW_BROADCAST_UNCERTAIN");
  assert.equal(unknown.broadcasts.length, 1);
  assert.equal(Transaction.from(unknown.broadcasts[0]).nonce, 55);
});

test("a broadcast that lands after the timeout is only reconciled and never replaced", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture);
  provider.broadcastTransaction = async (rawTransaction) => {
    provider.broadcasts.push(rawTransaction);
    setTimeout(() => {
      provider.transaction = Transaction.from(rawTransaction);
      provider.pendingNonce = 56;
    }, 75);
    return new Promise(() => {});
  };

  const uncertain = await run(fixture, provider, { externalTimeoutMs: 50 });
  assert.equal(uncertain.status, "broadcast-uncertain");
  assert.equal(uncertain.reason, "IDENTICAL_RAW_BROADCAST_UNCERTAIN");
  assert.equal(provider.broadcasts.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const reconciled = await run(fixture, provider, { externalTimeoutMs: 50 });
  assert.equal(reconciled.status, "pending");
  assert.equal(reconciled.reason, "EXPECTED_TRANSACTION_PENDING");
  assert.equal(provider.broadcasts.length, 1);
});

test("a provider-reported hash mismatch is a conflict and cannot trigger a second transaction", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture, { responseHash: `0x${"ab".repeat(32)}` });
  const result = await run(fixture, provider);
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "BROADCAST_HASH_MISMATCH");
  assert.equal(provider.broadcasts.length, 1);
  assert.equal(Transaction.from(provider.broadcasts[0]).nonce, 55);
});

test("all returned states are frozen, allowlisted, and redact the arm, raw bytes, bytecode, and secret", async () => {
  const fixture = await deploymentFixture();
  const provider = new DeploymentProvider(fixture);
  const result = await run(fixture, provider);
  const serialized = JSON.stringify(result);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(serialized.includes(sponsorKey.slice(2)), false);
  assert.equal(serialized.includes(fixture.rawTransaction.slice(2)), false);
  assert.equal(serialized.includes(fixture.artifact.bytecode.slice(2)), false);
  assert.equal(serialized.includes(fixture.env[RECOVERY_V2_ARM_ENV].slice(2)), false);
  assert.equal("rawTransaction" in result, false);
  assert.equal("armDigest" in result, false);
  assert.equal("manifest" in result, false);
  assert.equal("artifact" in result, false);

  const maliciousArm = `secret-${sponsorKey}`;
  const blocked = await run(fixture, new DeploymentProvider(fixture), {
    env: { ...fixture.env, [RECOVERY_V2_ARM_ENV]: maliciousArm },
  });
  assert.equal(JSON.stringify(blocked).includes(maliciousArm), false);
  assert.deepEqual(Object.keys(blocked).sort(), [
    "chainId",
    "contractAddress",
    "nonce",
    "reason",
    "status",
    "transactionHash",
  ]);
});

async function deploymentFixture(options = {}) {
  const wallet = new Wallet(sponsorKey);
  const abiHash = keccak256(toUtf8Bytes(canonicalJson(deploymentAbi)));
  const artifact = {
    contractName: "RetryCreditRecoveryCampaignV2",
    abi: deploymentAbi,
    abiHash,
    bytecode: deploymentBytecode,
    bytecodeHash: keccak256(deploymentBytecode),
    runtimeCodeHash: keccak256(runtimeCode),
  };
  const constructorArgs = [
    legacyPool,
    getAddress("0x0000000000000000000000000000000000000000"),
    legacyPool,
    `0x${"77".repeat(32)}`,
    {
      rule: {
        feeRecipient: getAddress("0x0000a26b00c1F0DF003000390027140000fAa719"),
        startBlock: 1,
        endBlock: 2,
        maxBlockGap: 1,
        maxQuantity: 1,
      },
      creditAmount: "100000000000000000",
      maxClaims: 10,
      deadline: 1_900_000_000,
    },
  ];
  const initCode = concat([
    artifact.bytecode,
    new Interface(artifact.abi).encodeDeploy(constructorArgs),
  ]);
  const render = {
    serviceId: "srv-da5n322jobas73f8tp70",
    serviceName: "retrycredit-api",
    serviceType: "web",
    repoSlug: "dolepee/retrycredit",
    hostname: "retrycredit-api.onrender.com",
    branch: "main",
    revision: "ab".repeat(20),
  };
  const unsigned = {
    type: 2,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    to: null,
    value: 1_000_000_000_000_000_000n,
    data: initCode,
    gasLimit: 5_000_000n,
    maxFeePerGas: 4_000_000_000n,
    maxPriorityFeePerGas: options.maxPriorityFeePerGas ?? 1_000_000_000n,
    accessList: [],
  };
  const rawTransaction = await wallet.signTransaction(unsigned);
  const manifest = {
    schema: RECOVERY_V2_DEPLOYMENT_SCHEMA,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    signerAddress: wallet.address,
    expectedContractAddress: getCreateAddress({ from: wallet.address, nonce: RECOVERY_V2_DEPLOYMENT_NONCE }),
    expectedTransactionHash: keccak256(rawTransaction),
    expectedInitCodeHash: keccak256(initCode),
    value: unsigned.value.toString(),
    gasLimit: unsigned.gasLimit.toString(),
    maxFeePerGas: unsigned.maxFeePerGas.toString(),
    maxPriorityFeePerGas: unsigned.maxPriorityFeePerGas.toString(),
    constructorArgs,
    artifact: {
      contractName: artifact.contractName,
      abiHash: artifact.abiHash,
      bytecodeHash: artifact.bytecodeHash,
      runtimeCodeHash: artifact.runtimeCodeHash,
    },
    broadcastWindow: {
      notBefore: 1_800_000_000,
      notAfter: 1_800_000_600,
    },
    chainCheckpoint: {
      blockNumber: 5_000_000,
      blockHash: `0x${"99".repeat(32)}`,
    },
    render,
    v1Profile: { ...RECOVERY_V1_PROFILE },
  };
  const env = armEnvironment({
    RENDER: "true",
    RENDER_SERVICE_ID: render.serviceId,
    RENDER_SERVICE_NAME: render.serviceName,
    RENDER_SERVICE_TYPE: render.serviceType,
    RENDER_GIT_REPO_SLUG: render.repoSlug,
    RENDER_EXTERNAL_HOSTNAME: render.hostname,
    RENDER_GIT_BRANCH: render.branch,
    RENDER_GIT_COMMIT: render.revision,
    RENDER_INSTANCE_ID: "instance-current-a",
    IS_PULL_REQUEST: "false",
    PUBLIC_ORIGIN: RECOVERY_V1_PROFILE.publicOrigin,
    ALLOWED_ORIGIN: RECOVERY_V1_PROFILE.allowedOrigin,
    RETRYCREDIT_PUBLIC_ENABLED: RECOVERY_V1_PROFILE.publicEnabled,
    RETRYCREDIT_RECOVERY_ENABLED: RECOVERY_V1_PROFILE.recoveryEnabled,
    RETRYCREDIT_RECOVERY_POOL_ADDRESS: RECOVERY_V1_PROFILE.poolAddress,
    RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: RECOVERY_V1_PROFILE.campaignNumber,
    RETRYCREDIT_LEGACY_WRITES_ENABLED: RECOVERY_V1_PROFILE.legacyWritesEnabled,
  }, manifest, artifact);
  return {
    wallet,
    artifact,
    manifest,
    env,
    rawTransaction,
    now: manifest.broadcastWindow.notBefore + 1,
  };
}

class DeploymentProvider {
  constructor(fixture, options = {}) {
    this.fixture = fixture;
    this.latestNonce = options.latestNonce ?? 55;
    this.pendingNonce = options.pendingNonce ?? this.latestNonce;
    this.addressNonce = options.addressNonce ?? 0;
    this.code = options.code ?? "0x";
    this.transaction = options.transaction ?? null;
    this.receipt = options.receipt ?? null;
    this.receiptBlockHash = options.receiptBlockHash ?? `0x${"88".repeat(32)}`;
    this.latestBlock = options.latestBlock ?? 0;
    this.finalizedBlock = options.finalizedBlock ?? 0;
    this.networkChainId = options.networkChainId ?? RECOVERY_V2_CHAIN_ID;
    this.checkpointHash = options.checkpointHash ?? fixture.manifest.chainCheckpoint.blockHash;
    this.broadcastFailure = options.broadcastFailure ?? null;
    this.responseHash = options.responseHash ?? null;
    this.retainPrebroadcastState = options.retainPrebroadcastState ?? false;
    this.broadcasts = [];
    this.reads = 0;
  }

  async getNetwork() {
    this.reads += 1;
    return { chainId: BigInt(this.networkChainId) };
  }

  async getTransactionReceipt(hash) {
    this.reads += 1;
    assert.equal(hash, this.fixture.manifest.expectedTransactionHash);
    return this.receipt;
  }

  async getTransaction(hash) {
    this.reads += 1;
    assert.equal(hash, this.fixture.manifest.expectedTransactionHash);
    return this.transaction;
  }

  async getTransactionCount(address, blockTag) {
    this.reads += 1;
    const normalized = getAddress(address);
    if (normalized === this.fixture.manifest.expectedContractAddress) {
      assert.equal(blockTag, "latest");
      return this.addressNonce;
    }
    assert.equal(normalized, this.fixture.manifest.signerAddress);
    return blockTag === "pending" ? this.pendingNonce : this.latestNonce;
  }

  async getCode(address, blockTag) {
    this.reads += 1;
    assert.equal(getAddress(address), this.fixture.manifest.expectedContractAddress);
    assert.ok(blockTag === "latest" || blockTag === this.receipt?.blockNumber);
    return this.code;
  }

  async broadcastTransaction(rawTransaction) {
    this.broadcasts.push(rawTransaction);
    if (this.broadcastFailure === "before") throw new Error(`provider failure ${rawTransaction}`);
    if (!this.retainPrebroadcastState) {
      this.transaction = Transaction.from(rawTransaction);
      this.pendingNonce = 56;
    }
    if (this.broadcastFailure === "after") throw new Error(`lost response ${rawTransaction}`);
    return { hash: this.responseHash ?? keccak256(rawTransaction) };
  }

  async getBlockNumber() {
    this.reads += 1;
    return this.latestBlock;
  }

  async getBlock(tag) {
    this.reads += 1;
    if (tag === this.fixture.manifest.chainCheckpoint.blockNumber) {
      return { number: tag, hash: this.checkpointHash };
    }
    if (tag === this.receipt?.blockNumber) {
      return {
        number: tag,
        hash: this.receiptBlockHash,
        transactions: [this.fixture.manifest.expectedTransactionHash],
      };
    }
    assert.equal(tag, "finalized");
    return { number: this.finalizedBlock };
  }
}

function minedProvider(fixture, options = {}) {
  const receiptBlock = options.receiptBlock ?? 100;
  const receiptBlockHash = options.receiptBlockHash ?? `0x${"88".repeat(32)}`;
  return new DeploymentProvider(fixture, {
    latestNonce: options.latestNonce ?? 56,
    pendingNonce: options.pendingNonce ?? 56,
    addressNonce: options.addressNonce ?? 1,
    code: options.runtimeCode ?? runtimeCode,
    transaction: Transaction.from(fixture.rawTransaction),
    receipt: {
      hash: fixture.manifest.expectedTransactionHash,
      status: 1,
      blockNumber: receiptBlock,
      blockHash: receiptBlockHash,
      from: fixture.manifest.signerAddress,
      to: null,
      contractAddress: fixture.manifest.expectedContractAddress,
    },
    latestBlock: options.latestBlock ?? receiptBlock + 2,
    finalizedBlock: options.finalizedBlock ?? receiptBlock,
    receiptBlockHash,
  });
}

async function run(fixture, provider, overrides = {}) {
  return runRecoveryV2DeploymentLifecycle({
    manifest: overrides.manifest ?? fixture.manifest,
    artifact: Object.prototype.hasOwnProperty.call(overrides, "artifact")
      ? overrides.artifact
      : fixture.artifact,
    env: overrides.env ?? fixture.env,
    provider,
    wallet: overrides.wallet ?? fixture.wallet,
    verification: Object.prototype.hasOwnProperty.call(overrides, "verification")
      ? overrides.verification
      : { async verifyPreBroadcast(context) { return verifiedPreflight(context); } },
    clock: overrides.clock ?? (() => fixture.now),
    externalTimeoutMs: overrides.externalTimeoutMs,
  });
}

function trackingWallet(wallet) {
  return {
    address: wallet.address,
    signCalls: 0,
    async getAddress() { return wallet.address; },
    async signTransaction(transaction) {
      this.signCalls += 1;
      return wallet.signTransaction(transaction);
    },
  };
}

function transactionView(rawTransaction) {
  const parsed = Transaction.from(rawTransaction);
  return {
    hash: parsed.hash,
    from: parsed.from,
    to: parsed.to,
    type: parsed.type,
    chainId: parsed.chainId,
    nonce: parsed.nonce,
    value: parsed.value,
    data: parsed.data,
    gasLimit: parsed.gasLimit,
    maxFeePerGas: parsed.maxFeePerGas,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
    accessList: parsed.accessList,
  };
}

function armEnvironment(base, manifest, artifact) {
  let digest;
  try {
    digest = recoveryV2DeploymentArmDigest({ manifest, artifact });
  } catch {
    digest = `0x${"ff".repeat(32)}`;
  }
  return { ...base, [RECOVERY_V2_ARM_ENV]: digest };
}

function without(object, key) {
  const copy = { ...object };
  delete copy[key];
  return copy;
}

function truthChecks() {
  return {
    async verifyLegacyBinding() { return true; },
    async verifyInitialCampaign() { return true; },
  };
}

function verifiedPreflight(context) {
  return {
    schema: RECOVERY_V2_PREFLIGHT_RESULT_SCHEMA,
    bindingHash: context.bindingHash,
    primaryVerified: true,
    auditVerified: true,
  };
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
