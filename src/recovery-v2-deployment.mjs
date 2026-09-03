import {
  Interface,
  Transaction,
  concat,
  getAddress,
  getCreateAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";

export const RECOVERY_V2_DEPLOYMENT_SCHEMA = "retrycredit.recovery-v2-deployment.v1";
export const RECOVERY_V2_PREFLIGHT_SCHEMA = "retrycredit.recovery-v2-preflight.v1";
export const RECOVERY_V2_PREFLIGHT_RESULT_SCHEMA = "retrycredit.recovery-v2-preflight-result.v1";
export const RECOVERY_V2_ARM_ENV = "RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_ARM_DIGEST";
export const RECOVERY_V2_DEPLOYMENT_NONCE = 55;
export const RECOVERY_V2_CHAIN_ID = 102031;
export const RECOVERY_V2_POST_FINALITY_BLOCKS = 2;
export const RECOVERY_V2_EXTERNAL_TIMEOUT_MS = 15_000;

export const RECOVERY_V1_PROFILE = Object.freeze({
  publicOrigin: "https://retrycredit.dolepee.com",
  allowedOrigin: "https://retrycredit.dolepee.com",
  publicEnabled: "true",
  recoveryEnabled: "true",
  poolAddress: "0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66",
  campaignNumber: "1",
  legacyWritesEnabled: "false",
});

export const RECOVERY_V2_DEPLOYMENT_STATUS = Object.freeze({
  BLOCKED: "blocked",
  CONFLICT: "conflict",
  BROADCAST: "broadcast",
  BROADCAST_UNCERTAIN: "broadcast-uncertain",
  PENDING: "pending",
  MINED: "mined",
  FINALIZED: "finalized",
  FAILED: "failed",
});

const MANIFEST_KEYS = Object.freeze([
  "schema",
  "chainId",
  "nonce",
  "signerAddress",
  "expectedContractAddress",
  "expectedTransactionHash",
  "expectedInitCodeHash",
  "value",
  "gasLimit",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
  "constructorArgs",
  "artifact",
  "broadcastWindow",
  "chainCheckpoint",
  "render",
  "v1Profile",
]);
const ARTIFACT_FINGERPRINT_KEYS = Object.freeze([
  "contractName",
  "abiHash",
  "bytecodeHash",
  "runtimeCodeHash",
]);
const ARTIFACT_KEYS = Object.freeze([
  "contractName",
  "abi",
  "abiHash",
  "bytecode",
  "bytecodeHash",
  "runtimeCodeHash",
]);
const RENDER_KEYS = Object.freeze([
  "serviceId",
  "serviceName",
  "serviceType",
  "repoSlug",
  "hostname",
  "branch",
  "revision",
]);
const BROADCAST_WINDOW_KEYS = Object.freeze(["notBefore", "notAfter"]);
const CHAIN_CHECKPOINT_KEYS = Object.freeze(["blockNumber", "blockHash"]);
const V1_PROFILE_KEYS = Object.freeze(Object.keys(RECOVERY_V1_PROFILE));

const RENDER_ENVIRONMENT = Object.freeze({
  RENDER: "render",
  RENDER_SERVICE_ID: "serviceId",
  RENDER_SERVICE_NAME: "serviceName",
  RENDER_SERVICE_TYPE: "serviceType",
  RENDER_GIT_REPO_SLUG: "repoSlug",
  RENDER_EXTERNAL_HOSTNAME: "hostname",
  RENDER_GIT_BRANCH: "branch",
  RENDER_GIT_COMMIT: "revision",
});

const V1_ENVIRONMENT = Object.freeze({
  PUBLIC_ORIGIN: "publicOrigin",
  ALLOWED_ORIGIN: "allowedOrigin",
  RETRYCREDIT_PUBLIC_ENABLED: "publicEnabled",
  RETRYCREDIT_RECOVERY_ENABLED: "recoveryEnabled",
  RETRYCREDIT_RECOVERY_POOL_ADDRESS: "poolAddress",
  RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "campaignNumber",
  RETRYCREDIT_LEGACY_WRITES_ENABLED: "legacyWritesEnabled",
});

/**
 * Produce the only deployment arm accepted by this lifecycle. The digest binds
 * the exact Render revision, V1 rollback profile, artifact fingerprints,
 * constructor init code, signer, fees, value, nonce, expected address, and
 * expected signed-transaction hash. It contains no private key or raw bytes.
 */
export function recoveryV2DeploymentArmDigest({ manifest, artifact }) {
  const immutableManifest = validateManifest(manifest);
  const immutableArtifact = validateArtifact(artifact);
  requireArtifactMatch(immutableManifest, immutableArtifact);
  return keccak256(toUtf8Bytes(canonicalJson({
    domain: "RetryCredit Recovery V2 deployment arm",
    version: 1,
    manifest: immutableManifest,
    artifact: {
      contractName: immutableArtifact.contractName,
      abiHash: immutableArtifact.abiHash,
      bytecodeHash: immutableArtifact.bytecodeHash,
      runtimeCodeHash: immutableArtifact.runtimeCodeHash,
    },
  })));
}

/**
 * Execute one fail-closed reconciliation pass. This function has no HTTP
 * surface and never exposes the private key, init code, signed bytes, or arm
 * digest. The sole mutation it can perform is broadcasting the one manifest-
 * committed raw transaction when both signer nonces are exactly 55.
 */
export async function runRecoveryV2DeploymentLifecycle({
  manifest: manifestInput,
  artifact: artifactInput,
  env = {},
  provider,
  wallet,
  runtimeRepoSlug,
  verification = {},
  clock = () => Math.floor(Date.now() / 1000),
  externalTimeoutMs = RECOVERY_V2_EXTERNAL_TIMEOUT_MS,
} = {}) {
  let manifest;
  let artifact;
  try {
    manifest = validateManifest(manifestInput);
    artifact = validateArtifact(artifactInput);
    requireArtifactMatch(manifest, artifact);
    const effectiveRuntimeRepoSlug = runtimeRepoSlug === undefined
      ? manifest.render.repoSlug
      : exactPatternString(
        runtimeRepoSlug,
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        "RUNTIME_REPOSITORY_INVALID",
      );
    const reconciliationOnly = effectiveRuntimeRepoSlug !== manifest.render.repoSlug;
    requireDependencies(provider, wallet, { mutationAllowed: !reconciliationOnly });
    const timeoutMs = requireExternalTimeout(externalTimeoutMs);
    requireExactRuntimeIdentity(env, manifest, effectiveRuntimeRepoSlug);

    const armDigest = recoveryV2DeploymentArmDigest({ manifest, artifact });
    requireExactArm(env, armDigest);

    const initCode = buildInitCode(manifest, artifact);
    const transaction = buildFrozenTransaction(manifest, initCode);
    if (!reconciliationOnly) {
      let signerAddress;
      try {
        signerAddress = await bounded(resolveWalletAddress(wallet), timeoutMs);
      } catch (error) {
        if (error instanceof DeploymentLifecycleFault) throw error;
        throw fault("WALLET_IDENTITY_UNAVAILABLE", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
      }
      if (signerAddress !== manifest.signerAddress) {
        throw fault("WALLET_IDENTITY_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
      }

      const predictedAddress = getCreateAddress({
        from: signerAddress,
        nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
      });
      if (predictedAddress !== manifest.expectedContractAddress) {
        throw fault("CONTRACT_ADDRESS_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
      }
    }

    let state;
    try {
      state = await bounded(readDeploymentState(provider, manifest), timeoutMs);
    } catch (error) {
      if (error instanceof DeploymentLifecycleFault) throw error;
      throw fault("PROVIDER_STATE_UNAVAILABLE", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }

    const reconciled = await reconcileDeployment({
      provider,
      manifest,
      artifact,
      verification,
      state,
      timeoutMs,
    });
    if (reconciled) return reconciled;

    // A successor repository may observe the exact historical deployment but
    // can never inherit its signing or broadcast authority.
    if (reconciliationOnly) {
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
        "RUNTIME_REPOSITORY_MIGRATION_RECONCILIATION_ONLY",
        manifest,
        state,
      );
    }

    // This is the sole mutation boundary. Never send a replacement, a cancel,
    // or nonce 56. A rolling duplicate can only produce these identical bytes.
    if (
      state.latestNonce !== RECOVERY_V2_DEPLOYMENT_NONCE
      || state.pendingNonce !== RECOVERY_V2_DEPLOYMENT_NONCE
    ) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "NONCE_NOT_EXACTLY_55", manifest, state);
    }

    const preBroadcast = await runPreBroadcastVerification({
      manifest,
      artifact,
      transaction,
      verification,
      state,
      timeoutMs,
    });
    if (preBroadcast) return preBroadcast;

    const now = resolveClock(clock);
    if (now < manifest.broadcastWindow.notBefore) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED, "BROADCAST_WINDOW_NOT_OPEN", manifest, state);
    }
    if (now > manifest.broadcastWindow.notAfter) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED, "BROADCAST_WINDOW_CLOSED", manifest, state);
    }

    let rawTransaction;
    try {
      rawTransaction = await bounded(wallet.signTransaction(transaction), timeoutMs);
    } catch {
      throw fault("TRANSACTION_SIGNING_FAILED", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }
    requireSignedTransaction(rawTransaction, transaction, manifest);

    let beforeBroadcast;
    try {
      beforeBroadcast = await bounded(readDeploymentState(provider, manifest), timeoutMs);
    } catch {
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
        "PRESEND_STATE_UNAVAILABLE",
        manifest,
        state,
      );
    }
    const presendReconciled = await reconcileDeployment({
      provider,
      manifest,
      artifact,
      verification,
      state: beforeBroadcast,
      timeoutMs,
    });
    if (presendReconciled) return presendReconciled;
    if (
      beforeBroadcast.latestNonce !== RECOVERY_V2_DEPLOYMENT_NONCE
      || beforeBroadcast.pendingNonce !== RECOVERY_V2_DEPLOYMENT_NONCE
    ) {
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT,
        "PRESEND_NONCE_CHANGED",
        manifest,
        beforeBroadcast,
      );
    }
    const presendNow = resolveClock(clock);
    if (
      presendNow < manifest.broadcastWindow.notBefore
      || presendNow > manifest.broadcastWindow.notAfter
    ) {
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
        "PRESEND_WINDOW_CLOSED",
        manifest,
        beforeBroadcast,
      );
    }
    const repeatedPreBroadcast = await runPreBroadcastVerification({
      manifest,
      artifact,
      transaction,
      verification,
      state: beforeBroadcast,
      timeoutMs,
    });
    if (repeatedPreBroadcast) return repeatedPreBroadcast;
    const broadcastNow = resolveClock(clock);
    if (
      broadcastNow < manifest.broadcastWindow.notBefore
      || broadcastNow > manifest.broadcastWindow.notAfter
    ) {
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
        "PRESEND_WINDOW_CLOSED",
        manifest,
        beforeBroadcast,
      );
    }

    try {
      const broadcast = await bounded(provider.broadcastTransaction(rawTransaction), timeoutMs);
      if (!broadcast || normalizeHash(broadcast.hash) !== manifest.expectedTransactionHash) {
        return safeResult(
          RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT,
          "BROADCAST_HASH_MISMATCH",
          manifest,
          state,
        );
      }
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BROADCAST,
        "IDENTICAL_RAW_ACCEPTED",
        manifest,
        state,
      );
    } catch {
      // A provider may accept the transaction and then lose the response. Read
      // state once more; never compensate with a different transaction.
      let after;
      try {
        after = await bounded(readDeploymentState(provider, manifest), timeoutMs);
        const afterReconcile = await reconcileDeployment({
          provider,
          manifest,
          artifact,
          verification,
          state: after,
          timeoutMs,
        });
        if (afterReconcile) return afterReconcile;
      } catch {
        return safeResult(
          RECOVERY_V2_DEPLOYMENT_STATUS.BROADCAST_UNCERTAIN,
          "BROADCAST_RECONCILIATION_UNAVAILABLE",
          manifest,
        );
      }
      return safeResult(
        RECOVERY_V2_DEPLOYMENT_STATUS.BROADCAST_UNCERTAIN,
        "IDENTICAL_RAW_BROADCAST_UNCERTAIN",
        manifest,
        after,
      );
    }
  } catch (error) {
    const lifecycleFault = error instanceof DeploymentLifecycleFault
      ? error
      : fault("DEPLOYMENT_INPUT_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    return safeResult(lifecycleFault.status, lifecycleFault.code, manifest);
  }
}

function validateManifest(input) {
  requirePlainObject(input, "MANIFEST_PENDING");
  requireExactKeys(input, MANIFEST_KEYS, "MANIFEST_SHAPE_INVALID");
  if (input.schema !== RECOVERY_V2_DEPLOYMENT_SCHEMA) {
    throw fault("MANIFEST_SCHEMA_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (input.chainId !== RECOVERY_V2_CHAIN_ID || input.nonce !== RECOVERY_V2_DEPLOYMENT_NONCE) {
    throw fault("MANIFEST_NETWORK_OR_NONCE_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }

  const signerAddress = exactAddress(input.signerAddress, "MANIFEST_SIGNER_INVALID");
  const expectedContractAddress = exactAddress(
    input.expectedContractAddress,
    "MANIFEST_CONTRACT_ADDRESS_INVALID",
  );
  const expectedTransactionHash = exactHash(
    input.expectedTransactionHash,
    "MANIFEST_TRANSACTION_HASH_PENDING",
  );
  const expectedInitCodeHash = exactHash(
    input.expectedInitCodeHash,
    "MANIFEST_INIT_CODE_HASH_PENDING",
  );
  const value = exactDecimal(input.value, "MANIFEST_VALUE_INVALID", { positive: true });
  const gasLimit = exactDecimal(input.gasLimit, "MANIFEST_GAS_LIMIT_INVALID", { positive: true });
  const maxFeePerGas = exactDecimal(input.maxFeePerGas, "MANIFEST_MAX_FEE_INVALID", { positive: true });
  const maxPriorityFeePerGas = exactDecimal(
    input.maxPriorityFeePerGas,
    "MANIFEST_PRIORITY_FEE_INVALID",
  );
  if (BigInt(maxPriorityFeePerGas) > BigInt(maxFeePerGas)) {
    throw fault("MANIFEST_FEE_ORDER_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (!Array.isArray(input.constructorArgs)) {
    throw fault("MANIFEST_CONSTRUCTOR_ARGS_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }

  const artifact = validateArtifactFingerprint(input.artifact);
  const broadcastWindow = validateBroadcastWindow(input.broadcastWindow);
  const chainCheckpoint = validateChainCheckpoint(input.chainCheckpoint);
  const render = validateRenderManifest(input.render);
  const v1Profile = validateV1Profile(input.v1Profile);
  const constructorArgs = cloneJsonValue(input.constructorArgs, "MANIFEST_CONSTRUCTOR_ARGS_INVALID");

  return deepFreeze({
    schema: input.schema,
    chainId: input.chainId,
    nonce: input.nonce,
    signerAddress,
    expectedContractAddress,
    expectedTransactionHash,
    expectedInitCodeHash,
    value,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    constructorArgs,
    artifact,
    broadcastWindow,
    chainCheckpoint,
    render,
    v1Profile,
  });
}

function validateBroadcastWindow(input) {
  requirePlainObject(input, "BROADCAST_WINDOW_PENDING");
  requireExactKeys(input, BROADCAST_WINDOW_KEYS, "BROADCAST_WINDOW_SHAPE_INVALID");
  const notBefore = exactSafeInteger(input.notBefore, "BROADCAST_NOT_BEFORE_INVALID", { positive: true });
  const notAfter = exactSafeInteger(input.notAfter, "BROADCAST_NOT_AFTER_INVALID", { positive: true });
  if (notAfter <= notBefore || notAfter - notBefore > 15 * 60) {
    throw fault("BROADCAST_WINDOW_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return Object.freeze({ notBefore, notAfter });
}

function validateChainCheckpoint(input) {
  requirePlainObject(input, "CHAIN_CHECKPOINT_PENDING");
  requireExactKeys(input, CHAIN_CHECKPOINT_KEYS, "CHAIN_CHECKPOINT_SHAPE_INVALID");
  return Object.freeze({
    blockNumber: exactSafeInteger(input.blockNumber, "CHAIN_CHECKPOINT_BLOCK_INVALID", { positive: true }),
    blockHash: exactHash(input.blockHash, "CHAIN_CHECKPOINT_HASH_PENDING"),
  });
}

function validateArtifact(input) {
  requirePlainObject(input, "ARTIFACT_PENDING");
  requireExactKeys(input, ARTIFACT_KEYS, "ARTIFACT_SHAPE_INVALID");
  const contractName = exactNonemptyString(input.contractName, "ARTIFACT_NAME_INVALID");
  if (contractName !== "RetryCreditRecoveryCampaignV2") {
    throw fault("ARTIFACT_IDENTITY_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (!Array.isArray(input.abi) || input.abi.length === 0) {
    throw fault("ARTIFACT_ABI_PENDING", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const abi = cloneJsonValue(input.abi, "ARTIFACT_ABI_INVALID");
  requireExactConstructorAbi(abi);
  const abiHash = exactHash(input.abiHash, "ARTIFACT_ABI_HASH_PENDING");
  const calculatedAbiHash = keccak256(toUtf8Bytes(canonicalJson(abi)));
  if (abiHash !== calculatedAbiHash) {
    throw fault("ARTIFACT_ABI_HASH_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (!isHexString(input.bytecode) || input.bytecode === "0x") {
    throw fault("ARTIFACT_BYTECODE_PENDING", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const bytecode = input.bytecode.toLowerCase();
  const bytecodeHash = exactHash(input.bytecodeHash, "ARTIFACT_BYTECODE_HASH_PENDING");
  if (keccak256(bytecode) !== bytecodeHash) {
    throw fault("ARTIFACT_BYTECODE_HASH_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const runtimeCodeHash = exactHash(
    input.runtimeCodeHash,
    "ARTIFACT_RUNTIME_CODE_HASH_PENDING",
  );
  return deepFreeze({ contractName, abi, abiHash, bytecode, bytecodeHash, runtimeCodeHash });
}

function requireExactConstructorAbi(abi) {
  const constructors = abi.filter((entry) => entry?.type === "constructor");
  if (constructors.length !== 1 || constructors[0].stateMutability !== "payable") {
    throw fault("ARTIFACT_CONSTRUCTOR_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const inputs = constructors[0].inputs;
  const expectedTypes = ["address", "address", "address", "bytes32", "tuple"];
  if (
    !Array.isArray(inputs)
    || inputs.length !== expectedTypes.length
    || inputs.some((input, index) => input?.type !== expectedTypes[index])
  ) {
    throw fault("ARTIFACT_CONSTRUCTOR_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const initialComponents = inputs[4]?.components;
  const expectedInitialTypes = ["tuple", "uint256", "uint32", "uint64"];
  const ruleComponents = initialComponents?.[0]?.components;
  const expectedRuleTypes = ["address", "uint64", "uint64", "uint32", "uint8"];
  if (
    !Array.isArray(initialComponents)
    || initialComponents.length !== expectedInitialTypes.length
    || initialComponents.some((input, index) => input?.type !== expectedInitialTypes[index])
    || !Array.isArray(ruleComponents)
    || ruleComponents.length !== expectedRuleTypes.length
    || ruleComponents.some((input, index) => input?.type !== expectedRuleTypes[index])
  ) {
    throw fault("ARTIFACT_CONSTRUCTOR_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function validateArtifactFingerprint(input) {
  requirePlainObject(input, "MANIFEST_ARTIFACT_PENDING");
  requireExactKeys(input, ARTIFACT_FINGERPRINT_KEYS, "MANIFEST_ARTIFACT_SHAPE_INVALID");
  return deepFreeze({
    contractName: exactNonemptyString(input.contractName, "MANIFEST_ARTIFACT_NAME_INVALID"),
    abiHash: exactHash(input.abiHash, "MANIFEST_ARTIFACT_ABI_HASH_PENDING"),
    bytecodeHash: exactHash(input.bytecodeHash, "MANIFEST_ARTIFACT_BYTECODE_HASH_PENDING"),
    runtimeCodeHash: exactHash(input.runtimeCodeHash, "MANIFEST_RUNTIME_CODE_HASH_PENDING"),
  });
}

function validateRenderManifest(input) {
  requirePlainObject(input, "RENDER_MANIFEST_PENDING");
  requireExactKeys(input, RENDER_KEYS, "RENDER_MANIFEST_SHAPE_INVALID");
  const serviceId = exactPatternString(input.serviceId, /^srv-[a-z0-9]+$/, "RENDER_SERVICE_ID_INVALID");
  const serviceName = exactPatternString(
    input.serviceName,
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "RENDER_SERVICE_NAME_INVALID",
  );
  if (input.serviceType !== "web") {
    throw fault("RENDER_SERVICE_TYPE_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const repoSlug = exactPatternString(
    input.repoSlug,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "RENDER_REPOSITORY_INVALID",
  );
  const hostname = exactPatternString(
    input.hostname,
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    "RENDER_HOSTNAME_INVALID",
  );
  const branch = exactPatternString(input.branch, /^[^\s\x00-\x1f]+$/, "RENDER_BRANCH_INVALID");
  const revision = exactPatternString(input.revision, /^[0-9a-f]{40}$/, "RENDER_REVISION_INVALID");
  return deepFreeze({ serviceId, serviceName, serviceType: "web", repoSlug, hostname, branch, revision });
}

function validateV1Profile(input) {
  requirePlainObject(input, "V1_PROFILE_PENDING");
  requireExactKeys(input, V1_PROFILE_KEYS, "V1_PROFILE_SHAPE_INVALID");
  const normalized = {
    publicOrigin: exactNonemptyString(input.publicOrigin, "V1_PUBLIC_ORIGIN_INVALID"),
    allowedOrigin: exactNonemptyString(input.allowedOrigin, "V1_ALLOWED_ORIGIN_INVALID"),
    publicEnabled: exactNonemptyString(input.publicEnabled, "V1_PUBLIC_MODE_INVALID"),
    recoveryEnabled: exactNonemptyString(input.recoveryEnabled, "V1_RECOVERY_MODE_INVALID"),
    poolAddress: exactAddress(input.poolAddress, "V1_POOL_ADDRESS_INVALID"),
    campaignNumber: exactNonemptyString(input.campaignNumber, "V1_CAMPAIGN_INVALID"),
    legacyWritesEnabled: exactNonemptyString(input.legacyWritesEnabled, "LEGACY_WRITE_GUARD_INVALID"),
  };
  for (const key of V1_PROFILE_KEYS) {
    if (normalized[key] !== RECOVERY_V1_PROFILE[key]) {
      throw fault("V1_PROFILE_NOT_CURRENT", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }
  }
  return deepFreeze(normalized);
}

function requireArtifactMatch(manifest, artifact) {
  for (const key of ARTIFACT_FINGERPRINT_KEYS) {
    if (manifest.artifact[key] !== artifact[key]) {
      throw fault("ARTIFACT_MANIFEST_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }
  }
}

function requireDependencies(provider, wallet, { mutationAllowed = true } = {}) {
  const providerMethods = [
    "getNetwork",
    "getBlock",
    "getBlockNumber",
    "getTransactionReceipt",
    "getTransaction",
    "getTransactionCount",
    "getCode",
  ];
  if (mutationAllowed) providerMethods.push("broadcastTransaction");
  if (!provider || providerMethods.some((method) => typeof provider[method] !== "function")) {
    throw fault("PROVIDER_DEPENDENCY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (mutationAllowed && (!wallet || typeof wallet.signTransaction !== "function")) {
    throw fault("WALLET_DEPENDENCY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function requireExactRuntimeIdentity(env, manifest, runtimeRepoSlug = manifest.render.repoSlug) {
  if (!env || typeof env !== "object") {
    throw fault("RENDER_IDENTITY_INCOMPLETE", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const expected = {};
  for (const [environmentKey, manifestKey] of Object.entries(RENDER_ENVIRONMENT)) {
    expected[environmentKey] = environmentKey === "RENDER_GIT_REPO_SLUG"
      ? runtimeRepoSlug
      : manifestKey === "render"
        ? "true"
        : manifest.render[manifestKey];
  }
  expected.IS_PULL_REQUEST = "false";
  for (const [environmentKey, profileKey] of Object.entries(V1_ENVIRONMENT)) {
    expected[environmentKey] = manifest.v1Profile[profileKey];
  }

  for (const [key, value] of Object.entries(expected)) {
    if (typeof env[key] !== "string" || env[key] === "") {
      throw fault("RENDER_IDENTITY_INCOMPLETE", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }
    if (env[key] !== value) {
      throw fault("RENDER_IDENTITY_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    }
  }
  if (
    typeof env.RENDER_INSTANCE_ID !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(env.RENDER_INSTANCE_ID)
  ) {
    throw fault("RENDER_INSTANCE_ID_INCOMPLETE", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function requireExactArm(env, armDigest) {
  if (typeof env[RECOVERY_V2_ARM_ENV] !== "string" || env[RECOVERY_V2_ARM_ENV] === "") {
    throw fault("DEPLOYMENT_NOT_ARMED", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (env[RECOVERY_V2_ARM_ENV] !== armDigest) {
    throw fault("DEPLOYMENT_ARM_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function buildInitCode(manifest, artifact) {
  let encodedArguments;
  try {
    encodedArguments = new Interface(artifact.abi).encodeDeploy(manifest.constructorArgs);
  } catch {
    throw fault("CONSTRUCTOR_ENCODING_FAILED", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const initCode = concat([artifact.bytecode, encodedArguments]);
  if (keccak256(initCode) !== manifest.expectedInitCodeHash) {
    throw fault("INIT_CODE_HASH_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return initCode;
}

function buildFrozenTransaction(manifest, initCode) {
  return Object.freeze({
    type: 2,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    to: null,
    value: BigInt(manifest.value),
    data: initCode,
    gasLimit: BigInt(manifest.gasLimit),
    maxFeePerGas: BigInt(manifest.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(manifest.maxPriorityFeePerGas),
    accessList: Object.freeze([]),
  });
}

async function resolveWalletAddress(wallet) {
  let address;
  try {
    address = typeof wallet.getAddress === "function" ? await wallet.getAddress() : wallet.address;
    return getAddress(address);
  } catch {
    throw fault("WALLET_IDENTITY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function requireSignedTransaction(rawTransaction, expected, manifest) {
  if (!isHexString(rawTransaction) || rawTransaction === "0x") {
    throw fault("SIGNED_TRANSACTION_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  let signed;
  try {
    signed = Transaction.from(rawTransaction);
  } catch {
    throw fault("SIGNED_TRANSACTION_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (
    signed.type !== 2
    || signed.chainId !== BigInt(expected.chainId)
    || signed.nonce !== RECOVERY_V2_DEPLOYMENT_NONCE
    || signed.to !== null
    || getAddress(signed.from) !== manifest.signerAddress
    || signed.value !== expected.value
    || signed.data.toLowerCase() !== expected.data.toLowerCase()
    || signed.gasLimit !== expected.gasLimit
    || signed.maxFeePerGas !== expected.maxFeePerGas
    || signed.maxPriorityFeePerGas !== expected.maxPriorityFeePerGas
    || (signed.accessList?.length ?? 0) !== 0
  ) {
    throw fault("SIGNED_TRANSACTION_FIELDS_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (keccak256(rawTransaction) !== manifest.expectedTransactionHash) {
    throw fault("SIGNED_TRANSACTION_HASH_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

async function runPreBroadcastVerification({
  manifest,
  artifact,
  transaction,
  verification,
  state,
  timeoutMs,
}) {
  if (typeof verification.verifyPreBroadcast !== "function") {
    return safeResult(
      RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
      "PREBROADCAST_VERIFICATION_PENDING",
      manifest,
      state,
    );
  }
  let verified;
  const context = buildPreflightContext({ manifest, artifact, transaction });
  try {
    verified = await bounded(verification.verifyPreBroadcast(context), timeoutMs);
  } catch {
    return safeResult(
      RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED,
      "PREBROADCAST_VERIFICATION_UNAVAILABLE",
      manifest,
      state,
    );
  }
  if (!preflightResultMatches(verified, context)) {
    return safeResult(
      RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT,
      "PREBROADCAST_VERIFICATION_FAILED",
      manifest,
      state,
    );
  }
  return null;
}

function buildPreflightContext({ manifest, artifact, transaction }) {
  const binding = {
    schema: RECOVERY_V2_PREFLIGHT_SCHEMA,
    chainId: manifest.chainId,
    nonce: manifest.nonce,
    signerAddress: manifest.signerAddress,
    expectedContractAddress: manifest.expectedContractAddress,
    expectedTransactionHash: manifest.expectedTransactionHash,
    expectedInitCodeHash: manifest.expectedInitCodeHash,
    expectedRuntimeCodeHash: artifact.runtimeCodeHash,
    value: manifest.value,
    gasLimit: manifest.gasLimit,
    maxFeePerGas: manifest.maxFeePerGas,
    maxPriorityFeePerGas: manifest.maxPriorityFeePerGas,
    constructorArgs: manifest.constructorArgs,
    artifact: manifest.artifact,
    chainCheckpoint: manifest.chainCheckpoint,
    transaction: {
      type: transaction.type,
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      to: transaction.to,
      value: transaction.value.toString(),
      data: transaction.data,
      gasLimit: transaction.gasLimit.toString(),
      maxFeePerGas: transaction.maxFeePerGas.toString(),
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
      accessList: [],
    },
  };
  return deepFreeze({
    ...binding,
    bindingHash: keccak256(toUtf8Bytes(canonicalJson(binding))),
  });
}

function preflightResultMatches(result, context) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const keys = Object.keys(result).sort();
  const expectedKeys = ["auditVerified", "bindingHash", "primaryVerified", "schema"];
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && result.schema === RECOVERY_V2_PREFLIGHT_RESULT_SCHEMA
    && result.bindingHash === context.bindingHash
    && result.primaryVerified === true
    && result.auditVerified === true;
}

async function readDeploymentState(provider, manifest) {
  const network = await provider.getNetwork();
  if (Number(network?.chainId) !== RECOVERY_V2_CHAIN_ID) {
    throw fault("CHAIN_ID_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const checkpoint = await provider.getBlock(manifest.chainCheckpoint.blockNumber);
  if (
    normalizeBlockNumber(checkpoint?.number) !== manifest.chainCheckpoint.blockNumber
    || normalizeHash(checkpoint?.hash) !== manifest.chainCheckpoint.blockHash
  ) {
    throw fault("CHAIN_CHECKPOINT_MISMATCH", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  const [receipt, transaction, latestNonceValue, pendingNonceValue, code, addressNonceValue] = await Promise.all([
    provider.getTransactionReceipt(manifest.expectedTransactionHash),
    provider.getTransaction(manifest.expectedTransactionHash),
    provider.getTransactionCount(manifest.signerAddress, "latest"),
    provider.getTransactionCount(manifest.signerAddress, "pending"),
    provider.getCode(manifest.expectedContractAddress, "latest"),
    provider.getTransactionCount(manifest.expectedContractAddress, "latest"),
  ]);
  const latestNonce = exactNonce(latestNonceValue);
  const pendingNonce = exactNonce(pendingNonceValue);
  const addressNonce = exactNonce(addressNonceValue);
  if (!isHexString(code)) throw new Error("invalid provider code");
  return Object.freeze({
    receipt: receipt ?? null,
    transaction: transaction ?? null,
    latestNonce,
    pendingNonce,
    code: code.toLowerCase(),
    addressNonce,
  });
}

async function reconcileDeployment({ provider, manifest, artifact, verification, state, timeoutMs }) {
  if (state.pendingNonce < state.latestNonce) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "NONCE_ORDER_INVALID", manifest, state);
  }
  if (state.transaction && !transactionMatches(state.transaction, manifest)) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "EXPECTED_TRANSACTION_CONFLICT", manifest, state);
  }

  if (state.receipt) {
    if (!receiptIdentityMatches(state.receipt, manifest)) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "RECEIPT_IDENTITY_CONFLICT", manifest, state);
    }
    if (normalizeReceiptStatus(state.receipt.status) === 0) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.FAILED, "DEPLOYMENT_TRANSACTION_REVERTED", manifest, state, {
        receiptBlockNumber: normalizeBlockNumber(state.receipt.blockNumber),
      });
    }
    if (normalizeReceiptStatus(state.receipt.status) !== 1) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "RECEIPT_STATUS_INVALID", manifest, state);
    }
    if (!state.transaction) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "MINED_TRANSACTION_PROPAGATING", manifest, state, {
        receiptBlockNumber: normalizeBlockNumber(state.receipt.blockNumber),
      });
    }
    if (state.latestNonce > 56 || state.pendingNonce > 56) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "SIGNER_NONCE_ADVANCED", manifest, state, {
        receiptBlockNumber: normalizeBlockNumber(state.receipt.blockNumber),
      });
    }
    if (state.latestNonce !== 56 || state.pendingNonce !== 56) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "MINED_STATE_PROPAGATING", manifest, state, {
        receiptBlockNumber: normalizeBlockNumber(state.receipt.blockNumber),
      });
    }
    if (state.code === "0x" || state.addressNonce === 0) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "CONTRACT_STATE_PROPAGATING", manifest, state, {
        receiptBlockNumber: normalizeBlockNumber(state.receipt.blockNumber),
      });
    }
    if (state.addressNonce !== 1 || keccak256(state.code) !== artifact.runtimeCodeHash) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "DEPLOYED_CODE_CONFLICT", manifest, state);
    }
    return reconcileFinality({ provider, manifest, artifact, verification, state, timeoutMs });
  }

  if (state.code !== "0x" || state.addressNonce !== 0) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "PREDICTED_ADDRESS_OCCUPIED", manifest, state);
  }
  if (state.transaction) {
    if (state.latestNonce > 56 || state.pendingNonce > 56) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "SIGNER_NONCE_ADVANCED", manifest, state);
    }
    if (state.latestNonce === 55 && state.pendingNonce === 56) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.PENDING, "EXPECTED_TRANSACTION_PENDING", manifest, state);
    }
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.PENDING, "EXPECTED_TRANSACTION_OBSERVED", manifest, state);
  }
  if (state.latestNonce < 55 || state.pendingNonce < 55) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED, "SIGNER_NONCE_BEHIND", manifest, state);
  }
  if (state.latestNonce > 55 || state.pendingNonce > 55) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "SIGNER_NONCE_CONSUMED", manifest, state);
  }
  return null;
}

async function reconcileFinality({ provider, manifest, artifact, verification, state, timeoutMs }) {
  const receiptBlockNumber = normalizeBlockNumber(state.receipt.blockNumber);
  if (receiptBlockNumber === null) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "RECEIPT_BLOCK_INVALID", manifest, state);
  }
  let receiptBlockHash;
  try {
    receiptBlockHash = normalizeHash(state.receipt.blockHash);
  } catch {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "RECEIPT_BLOCK_HASH_INVALID", manifest, state);
  }
  let latestBlockNumber;
  let finalizedBlockNumber;
  let canonicalReceiptBlock;
  let refreshedReceipt;
  let refreshedTransaction;
  let historicalCode;
  try {
    [
      latestBlockNumber,
      finalizedBlockNumber,
      canonicalReceiptBlock,
      refreshedReceipt,
      refreshedTransaction,
      historicalCode,
    ] = await bounded(Promise.all([
      typeof verification.getLatestBlockNumber === "function"
        ? verification.getLatestBlockNumber()
        : provider.getBlockNumber(),
      typeof verification.getFinalizedBlockNumber === "function"
        ? verification.getFinalizedBlockNumber()
        : provider.getBlock("finalized").then((block) => block?.number),
      provider.getBlock(receiptBlockNumber),
      provider.getTransactionReceipt(manifest.expectedTransactionHash),
      provider.getTransaction(manifest.expectedTransactionHash),
      provider.getCode(manifest.expectedContractAddress, receiptBlockNumber),
    ]), timeoutMs);
    latestBlockNumber = normalizeBlockNumber(latestBlockNumber);
    finalizedBlockNumber = normalizeBlockNumber(finalizedBlockNumber);
  } catch {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "FINALITY_STATE_UNAVAILABLE", manifest, state, {
      receiptBlockNumber,
    });
  }
  if (latestBlockNumber === null || finalizedBlockNumber === null) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "FINALITY_STATE_UNAVAILABLE", manifest, state, {
      receiptBlockNumber,
    });
  }
  if (finalizedBlockNumber > latestBlockNumber) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "FINALITY_ORDER_INVALID", manifest, state, {
      receiptBlockNumber,
      latestBlockNumber,
      finalizedBlockNumber,
    });
  }
  let canonicalBlockHash;
  try {
    canonicalBlockHash = normalizeHash(canonicalReceiptBlock?.hash);
  } catch {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "CANONICAL_RECEIPT_BLOCK_UNAVAILABLE", manifest, state, {
      receiptBlockNumber,
    });
  }
  let refreshedReceiptBlockHash = null;
  try {
    if (refreshedReceipt) refreshedReceiptBlockHash = normalizeHash(refreshedReceipt.blockHash);
  } catch {
    refreshedReceiptBlockHash = null;
  }
  if (
    normalizeBlockNumber(canonicalReceiptBlock?.number) !== receiptBlockNumber
    || canonicalBlockHash !== receiptBlockHash
    || !Array.isArray(canonicalReceiptBlock?.transactions)
    || !canonicalReceiptBlock.transactions.some((hash) => {
      try { return normalizeHash(hash) === manifest.expectedTransactionHash; } catch { return false; }
    })
    || !refreshedReceipt
    || !receiptIdentityMatches(refreshedReceipt, manifest)
    || normalizeReceiptStatus(refreshedReceipt.status) !== 1
    || normalizeBlockNumber(refreshedReceipt.blockNumber) !== receiptBlockNumber
    || refreshedReceiptBlockHash !== receiptBlockHash
    || !refreshedTransaction
    || !transactionMatches(refreshedTransaction, manifest)
    || !isHexString(historicalCode)
    || historicalCode === "0x"
    || keccak256(historicalCode) !== artifact.runtimeCodeHash
  ) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "CANONICAL_DEPLOYMENT_MISMATCH", manifest, state, {
      receiptBlockNumber,
    });
  }
  const confirmations = Math.max(0, latestBlockNumber - receiptBlockNumber + 1);
  if (
    finalizedBlockNumber < receiptBlockNumber + RECOVERY_V2_POST_FINALITY_BLOCKS
  ) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "AWAITING_FINALIZED_PLUS_TWO", manifest, state, {
      receiptBlockNumber,
      latestBlockNumber,
      finalizedBlockNumber,
      confirmations,
    });
  }

  const checks = [verification.verifyLegacyBinding, verification.verifyInitialCampaign];
  if (checks.some((check) => typeof check !== "function")) {
    return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "VERIFICATION_HOOKS_PENDING", manifest, state, {
      receiptBlockNumber,
      latestBlockNumber,
      finalizedBlockNumber,
      confirmations,
    });
  }
  const context = Object.freeze({
    transactionHash: manifest.expectedTransactionHash,
    contractAddress: manifest.expectedContractAddress,
    receiptBlockNumber,
    finalizedBlockNumber,
  });
  for (const check of checks) {
    let result;
    try {
      result = await bounded(check(context), timeoutMs);
    } catch {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.MINED, "VERIFICATION_HOOK_UNAVAILABLE", manifest, state, {
        receiptBlockNumber,
        latestBlockNumber,
        finalizedBlockNumber,
        confirmations,
      });
    }
    if (result !== true) {
      return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.CONFLICT, "POST_FINALITY_VERIFICATION_FAILED", manifest, state, {
        receiptBlockNumber,
        latestBlockNumber,
        finalizedBlockNumber,
        confirmations,
      });
    }
  }
  return safeResult(RECOVERY_V2_DEPLOYMENT_STATUS.FINALIZED, "FINALIZED_PLUS_TWO_VERIFIED", manifest, state, {
    receiptBlockNumber,
    latestBlockNumber,
    finalizedBlockNumber,
    confirmations,
  });
}

function transactionMatches(transaction, manifest) {
  try {
    const hash = normalizeHash(transaction.hash);
    const from = getAddress(transaction.from);
    const to = transaction.to == null ? null : getAddress(transaction.to);
    const type = Number(transaction.type);
    const chainId = Number(transaction.chainId);
    const nonce = Number(transaction.nonce);
    const value = BigInt(transaction.value);
    const data = String(transaction.data ?? transaction.input).toLowerCase();
    const gasLimit = BigInt(transaction.gasLimit ?? transaction.gas);
    const maxFeePerGas = BigInt(transaction.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(transaction.maxPriorityFeePerGas);
    const accessList = transaction.accessList ?? [];
    return hash === manifest.expectedTransactionHash
      && from === manifest.signerAddress
      && to === null
      && type === 2
      && chainId === RECOVERY_V2_CHAIN_ID
      && nonce === RECOVERY_V2_DEPLOYMENT_NONCE
      && value === BigInt(manifest.value)
      && keccak256(data) === manifest.expectedInitCodeHash
      && gasLimit === BigInt(manifest.gasLimit)
      && maxFeePerGas === BigInt(manifest.maxFeePerGas)
      && maxPriorityFeePerGas === BigInt(manifest.maxPriorityFeePerGas)
      && Array.isArray(accessList)
      && accessList.length === 0;
  } catch {
    return false;
  }
}

function receiptIdentityMatches(receipt, manifest) {
  try {
    const receiptHash = normalizeHash(receipt.hash ?? receipt.transactionHash);
    const blockHash = normalizeHash(receipt.blockHash);
    const blockNumber = normalizeBlockNumber(receipt.blockNumber);
    const status = normalizeReceiptStatus(receipt.status);
    const contractAddress = receipt.contractAddress == null ? null : getAddress(receipt.contractAddress);
    const from = receipt.from == null ? manifest.signerAddress : getAddress(receipt.from);
    const to = receipt.to == null ? null : getAddress(receipt.to);
    return receiptHash === manifest.expectedTransactionHash
      && blockHash !== null
      && blockNumber !== null
      && (
        (status === 0 && contractAddress === null)
        || (status === 1 && contractAddress === manifest.expectedContractAddress)
      )
      && from === manifest.signerAddress
      && to === null;
  } catch {
    return false;
  }
}

function safeResult(status, reason, manifest, state, details = {}) {
  const result = { status, reason };
  if (manifest) {
    result.chainId = RECOVERY_V2_CHAIN_ID;
    result.nonce = RECOVERY_V2_DEPLOYMENT_NONCE;
    result.transactionHash = manifest.expectedTransactionHash;
    result.contractAddress = manifest.expectedContractAddress;
  }
  if (state) {
    result.latestNonce = state.latestNonce;
    result.pendingNonce = state.pendingNonce;
  }
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null) result[key] = value;
  }
  return Object.freeze(result);
}

function exactAddress(value, code) {
  if (typeof value !== "string") throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  let normalized;
  try {
    normalized = getAddress(value);
  } catch {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (value !== normalized) throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  return normalized;
}

function exactHash(value, code) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return value;
}

function normalizeHash(value) {
  if (typeof value !== "string" || !isHexString(value, 32)) throw new Error("invalid hash");
  return value.toLowerCase();
}

function exactDecimal(value, code, { positive = false } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (positive && BigInt(value) === 0n) throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  return value;
}

function exactNonemptyString(value, code) {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return value;
}

function exactPatternString(value, pattern, code) {
  const exact = exactNonemptyString(value, code);
  if (!pattern.test(exact)) throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  return exact;
}

function exactNonce(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid nonce");
  return number;
}

function exactSafeInteger(value, code, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return value;
}

function requireExternalTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 50 || value > 60_000) {
    throw fault("EXTERNAL_TIMEOUT_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return value;
}

async function bounded(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("external operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function resolveClock(clock) {
  if (typeof clock !== "function") {
    throw fault("CLOCK_DEPENDENCY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  let value;
  try {
    value = clock();
  } catch {
    throw fault("CLOCK_DEPENDENCY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw fault("CLOCK_DEPENDENCY_INVALID", RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
  return value;
}

function normalizeReceiptStatus(value) {
  try {
    const status = Number(value);
    return status === 0 || status === 1 ? status : null;
  } catch {
    return null;
  }
}

function normalizeBlockNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function requireExactKeys(value, expectedKeys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
  }
}

function cloneJsonValue(value, code) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry, code));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const cloned = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "undefined" || typeof entry === "function") {
        throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
      }
      cloned[key] = cloneJsonValue(entry, code);
    }
    return cloned;
  }
  throw fault(code, RECOVERY_V2_DEPLOYMENT_STATUS.BLOCKED);
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("non-canonical number");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("non-canonical value");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

class DeploymentLifecycleFault extends Error {
  constructor(code, status) {
    super(code);
    this.name = "DeploymentLifecycleFault";
    this.code = code;
    this.status = status;
  }
}

function fault(code, status) {
  return new DeploymentLifecycleFault(code, status);
}
