import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  concat,
  getAddress,
  getCreateAddress,
  isHexString,
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
  RECOVERY_V2_PREFLIGHT_SCHEMA,
  recoveryV2DeploymentArmDigest,
  runRecoveryV2DeploymentLifecycle,
} from "./recovery-v2-deployment.mjs";

const ARTIFACT_URL = new URL(
  "./deployment-artifacts/RetryCreditRecoveryCampaignV2.json",
  import.meta.url,
);

export const RECOVERY_V2_RUNTIME_ENV = Object.freeze({
  mode: "RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE",
  revision: "RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_REVISION",
  prepareArm: "RETRYCREDIT_RECOVERY_V2_PREPARE_ARM_DIGEST",
  transactionHash: "RETRYCREDIT_RECOVERY_V2_EXPECTED_TRANSACTION_HASH",
  notBefore: "RETRYCREDIT_RECOVERY_V2_BROADCAST_NOT_BEFORE",
  notAfter: "RETRYCREDIT_RECOVERY_V2_BROADCAST_NOT_AFTER",
  arm: RECOVERY_V2_ARM_ENV,
});

export const RECOVERY_V2_RUNTIME_MODE = Object.freeze({
  DISABLED: "disabled",
  PREPARE: "prepare",
  ARMED: "armed",
});

export const RECOVERY_V2_PRIMARY_RPC = "https://rpc.cc3-testnet.creditcoin.network";
export const RECOVERY_V2_AUDIT_RPC = "https://creditcoin-testnet.blockscout.com/api/eth-rpc";
export const RECOVERY_V2_RPC_TIMEOUT_MS = 12_000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LEGACY_CAMPAIGN_NUMBER = 1;
const GAS_ESTIMATE_MARGIN_BPS = 12_000n;
const BASIS_POINTS = 10_000n;

export const RECOVERY_V2_FROZEN_DEPLOYMENT = deepFreeze({
  signerAddress: "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db",
  contractAddress: "0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8",
  value: "1000000000000000000",
  gasLimit: "3200000",
  maxFeePerGas: "2000000000",
  maxPriorityFeePerGas: "0",
  expectedInitCodeHash: "0xd069ba5cc3a80251a47b9915c9692e97d9a61d72e903bf590c28a42d4a2b33a6",
  expectedRuntimeCodeHash: "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07",
  artifact: {
    schemaVersion: "retrycredit.recovery-v2-forge-artifact.v1",
    contractName: "RetryCreditRecoveryCampaignV2",
    sourceName: "contracts/src/RetryCreditRecoveryCampaignV2.sol",
    abiHash: "0x0f25b60489c7934cb5a37d33ff6acb121b725bbbe48f4a56787aa68454253461",
    creationBytecodeHash: "0xff6b22c298edf702eb46b04d7be96bf6d80251cfa4962ba3fe697e759d527589",
    deployedBytecodeTemplateHash: "0x86eddd668acafe424be74cc0074075c76723dde9a71f14842ef6d662f088e018",
    payloadSha256: "0x5bf9739153d08a6ef588fb17536abab66f3efc8c9d03fff4cf96cdb486089d8f",
    initCodeBytes: 15_517,
    runtimeTemplateBytes: 9_139,
  },
  checkpoint: {
    blockNumber: 5_375_351,
    blockHash: "0x236dc2d22a35a7a678ef0327771b02cd235587bf56358b99a1fbc2b122352501",
  },
  render: {
    serviceId: "srv-da5n322jobas73f8tp70",
    serviceName: "retrycredit-api",
    serviceType: "web",
    repoSlug: "dolepee/retrycredit",
    hostname: "retrycredit-api.onrender.com",
    branch: "main",
  },
  verifierAddress: "0x151f65d1199Dbb4dD9842681D15650d18332A4Ab",
  predicateAddress: "0xC51E1cA69554Bb9D44a20fd837C217cAAFd6D814",
  chainInfoAddress: "0x0000000000000000000000000000000000000fD3",
  legacy: {
    poolAddress: "0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66",
    campaignNumber: LEGACY_CAMPAIGN_NUMBER,
    sponsor: "0x813C4BF413BeeA09a7f61450Bd9a9Fa321ED25Db",
    termsHash: "0x7209cc16cf9fcbca83fee3d0dfb4c27e27097924abeed91dc9e3d959cae189b4",
    bindingHash: "0x05b491b2a78243954542601dce8a3eb285c72177c045853ae6c53161210b8d4e",
    deadline: 1_788_910_440,
    rule: {
      feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
      startBlock: 25_805_168,
      endBlock: 25_835_360,
      maxBlockGap: 5,
      maxQuantity: 2,
    },
  },
  initialCampaign: {
    rule: {
      feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
      startBlock: 15_527_904,
      endBlock: 25_836_490,
      maxBlockGap: 5,
      maxQuantity: 2,
    },
    creditAmount: "100000000000000000",
    maxClaims: 10,
    deadline: 1_790_207_940,
    termsHash: "0xfef285bf2f0d86d448edf34f7160e3f18931c733ba65f5c918431944de79b92c",
  },
});

const CONSTRUCTOR_ARGUMENTS = deepFreeze([
  RECOVERY_V2_FROZEN_DEPLOYMENT.verifierAddress,
  ZERO_ADDRESS,
  RECOVERY_V2_FROZEN_DEPLOYMENT.legacy.poolAddress,
  RECOVERY_V2_FROZEN_DEPLOYMENT.legacy.termsHash,
  {
    rule: { ...RECOVERY_V2_FROZEN_DEPLOYMENT.initialCampaign.rule },
    creditAmount: RECOVERY_V2_FROZEN_DEPLOYMENT.initialCampaign.creditAmount,
    maxClaims: RECOVERY_V2_FROZEN_DEPLOYMENT.initialCampaign.maxClaims,
    deadline: RECOVERY_V2_FROZEN_DEPLOYMENT.initialCampaign.deadline,
  },
]);

const LEGACY_ABI = Object.freeze([
  "function retryVerifier() view returns(address)",
  "function predicate() view returns(address)",
  "function chainInfo() view returns(address)",
  "function getCampaign(uint256) view returns((address sponsor,uint256 creditAmount,uint32 maxClaims,uint32 claimCount,uint64 deadline,uint256 fundedAmount,bytes32 termsHash,bool remainderRecovered))",
  "function getRule(uint256) view returns((address feeRecipient,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint8 maxQuantity))",
]);

/**
 * Read and validate the source-embedded Forge projection, then map it to the
 * deliberately smaller artifact shape accepted by the deployment lifecycle.
 */
export async function loadRecoveryV2DeploymentArtifact({
  artifact: injectedArtifact,
  readArtifact = (url) => readFile(url, "utf8"),
} = {}) {
  if (
    injectedArtifact
    && typeof injectedArtifact === "object"
    && "bytecode" in injectedArtifact
    && "runtimeCodeHash" in injectedArtifact
  ) {
    requireMappedArtifact(injectedArtifact);
    return deepFreeze({
      contractName: injectedArtifact.contractName,
      abi: structuredClone(injectedArtifact.abi),
      abiHash: injectedArtifact.abiHash,
      bytecode: injectedArtifact.bytecode.toLowerCase(),
      bytecodeHash: injectedArtifact.bytecodeHash,
      runtimeCodeHash: injectedArtifact.runtimeCodeHash,
    });
  }
  let artifact = injectedArtifact;
  if (artifact === undefined) {
    let text;
    try {
      text = await readArtifact(ARTIFACT_URL);
      artifact = JSON.parse(text);
    } catch {
      throw runtimeFault("RECOVERY_V2_ARTIFACT_UNAVAILABLE");
    }
  }
  requirePlainObject(artifact, "RECOVERY_V2_ARTIFACT_INVALID");

  const expected = RECOVERY_V2_FROZEN_DEPLOYMENT.artifact;
  if (
    artifact.schemaVersion !== expected.schemaVersion
    || artifact.contractName !== expected.contractName
    || artifact.sourceName !== expected.sourceName
    || artifact.initCodeBytes !== expected.initCodeBytes
    || artifact.runtimeTemplateBytes !== expected.runtimeTemplateBytes
  ) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_IDENTITY_MISMATCH");
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_ABI_INVALID");
  }
  const abiHash = keccak256(toUtf8Bytes(canonicalJson(artifact.abi)));
  if (abiHash !== expected.abiHash) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_ABI_MISMATCH");
  }
  requireBytecode(artifact.creationBytecode, "RECOVERY_V2_ARTIFACT_CREATION_BYTECODE_INVALID");
  requireBytecode(artifact.deployedBytecode, "RECOVERY_V2_ARTIFACT_RUNTIME_TEMPLATE_INVALID");
  if (
    artifact.creationBytecodeHash !== expected.creationBytecodeHash
    || keccak256(artifact.creationBytecode) !== expected.creationBytecodeHash
  ) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_CREATION_HASH_MISMATCH");
  }
  if (
    artifact.deployedBytecodeTemplateHash !== expected.deployedBytecodeTemplateHash
    || keccak256(artifact.deployedBytecode) !== expected.deployedBytecodeTemplateHash
  ) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_RUNTIME_TEMPLATE_MISMATCH");
  }
  const { payloadSha256, ...payload } = artifact;
  if (
    payloadSha256 !== expected.payloadSha256
    || sha256Hex(JSON.stringify(payload)) !== expected.payloadSha256
  ) {
    throw runtimeFault("RECOVERY_V2_ARTIFACT_PAYLOAD_MISMATCH");
  }

  return deepFreeze({
    contractName: artifact.contractName,
    abi: structuredClone(artifact.abi),
    abiHash,
    bytecode: artifact.creationBytecode.toLowerCase(),
    bytecodeHash: expected.creationBytecodeHash,
    runtimeCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedRuntimeCodeHash,
  });
}

export function buildRecoveryV2InitCode(artifact) {
  requireMappedArtifact(artifact);
  let encoded;
  try {
    encoded = new Interface(artifact.abi).encodeDeploy(CONSTRUCTOR_ARGUMENTS);
  } catch {
    throw runtimeFault("RECOVERY_V2_CONSTRUCTOR_ENCODING_FAILED");
  }
  const initCode = concat([artifact.bytecode, encoded]).toLowerCase();
  if (keccak256(initCode) !== RECOVERY_V2_FROZEN_DEPLOYMENT.expectedInitCodeHash) {
    throw runtimeFault("RECOVERY_V2_INIT_CODE_MISMATCH");
  }
  return initCode;
}

/** Build the only armed manifest. All release-specific values come from env. */
export function buildRecoveryV2DeploymentManifest({ env, artifact }) {
  requirePlainObject(env, "RECOVERY_V2_ENVIRONMENT_INVALID");
  requireMappedArtifact(artifact);
  requireArmedIdentity(env);

  const revision = exactEnvironmentRevision(env, RECOVERY_V2_RUNTIME_ENV.revision);
  if (env.RENDER_GIT_COMMIT !== revision) {
    throw runtimeFault("RECOVERY_V2_REVISION_MISMATCH");
  }
  const expectedTransactionHash = exactEnvironmentHash(
    env,
    RECOVERY_V2_RUNTIME_ENV.transactionHash,
    "RECOVERY_V2_TRANSACTION_HASH_INVALID",
  );
  const notBefore = exactEnvironmentInteger(
    env,
    RECOVERY_V2_RUNTIME_ENV.notBefore,
    "RECOVERY_V2_NOT_BEFORE_INVALID",
  );
  const notAfter = exactEnvironmentInteger(
    env,
    RECOVERY_V2_RUNTIME_ENV.notAfter,
    "RECOVERY_V2_NOT_AFTER_INVALID",
  );
  if (notAfter <= notBefore || notAfter - notBefore > 15 * 60) {
    throw runtimeFault("RECOVERY_V2_BROADCAST_WINDOW_INVALID");
  }

  return deepFreeze({
    schema: RECOVERY_V2_DEPLOYMENT_SCHEMA,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    signerAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress,
    expectedContractAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.contractAddress,
    expectedTransactionHash,
    expectedInitCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedInitCodeHash,
    value: RECOVERY_V2_FROZEN_DEPLOYMENT.value,
    gasLimit: RECOVERY_V2_FROZEN_DEPLOYMENT.gasLimit,
    maxFeePerGas: RECOVERY_V2_FROZEN_DEPLOYMENT.maxFeePerGas,
    maxPriorityFeePerGas: RECOVERY_V2_FROZEN_DEPLOYMENT.maxPriorityFeePerGas,
    constructorArgs: structuredClone(CONSTRUCTOR_ARGUMENTS),
    artifact: {
      contractName: artifact.contractName,
      abiHash: artifact.abiHash,
      bytecodeHash: artifact.bytecodeHash,
      runtimeCodeHash: artifact.runtimeCodeHash,
    },
    broadcastWindow: { notBefore, notAfter },
    chainCheckpoint: { ...RECOVERY_V2_FROZEN_DEPLOYMENT.checkpoint },
    render: {
      ...RECOVERY_V2_FROZEN_DEPLOYMENT.render,
      revision,
    },
    v1Profile: { ...RECOVERY_V1_PROFILE },
  });
}

/**
 * Offline arming helper. It needs only the public prepare result copied into
 * the explicitly named env fields; it never receives a wallet or raw bytes.
 */
export async function deriveRecoveryV2DeploymentArmDigest({
  env,
  artifact: artifactInput,
  readArtifact,
} = {}) {
  const artifact = await loadRecoveryV2DeploymentArtifact({
    artifact: artifactInput,
    ...(readArtifact ? { readArtifact } : {}),
  });
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  return recoveryV2DeploymentArmDigest({ manifest, artifact });
}

/**
 * Derive the explicit authorization required before the Render process may
 * sign the frozen deployment transaction in prepare mode. This digest is
 * public and binds the exact release revision and artifact; it is distinct
 * from the later broadcast arm, which also binds the signed transaction hash
 * and short broadcast window.
 */
export async function deriveRecoveryV2PrepareArmDigest({
  env,
  artifact: artifactInput,
  readArtifact,
} = {}) {
  const artifact = await loadRecoveryV2DeploymentArtifact({
    artifact: artifactInput,
    ...(readArtifact ? { readArtifact } : {}),
  });
  return recoveryV2PrepareArmDigest({ env, artifact });
}

export function createRecoveryV2DeploymentProviders({ timeoutMs = RECOVERY_V2_RPC_TIMEOUT_MS } = {}) {
  const boundedTimeout = requireTimeout(timeoutMs);
  return Object.freeze({
    primary: createBoundedProvider(RECOVERY_V2_PRIMARY_RPC, boundedTimeout),
    audit: createBoundedProvider(RECOVERY_V2_AUDIT_RPC, boundedTimeout),
  });
}

/**
 * Create an inert controller. Neither construction nor import signs,
 * broadcasts, or contacts an RPC. The caller must explicitly invoke a mode-
 * appropriate method.
 */
export async function createRecoveryV2DeploymentController({
  env = {},
  artifact: artifactInput,
  readArtifact,
  wallet: injectedWallet,
  privateKey,
  providers: injectedProviders,
  providerFactory = createRecoveryV2DeploymentProviders,
  lifecycleRunner = runRecoveryV2DeploymentLifecycle,
  clock = () => Math.floor(Date.now() / 1_000),
  timeoutMs = RECOVERY_V2_RPC_TIMEOUT_MS,
  transactionParser = (raw) => Transaction.from(raw),
  hashBytecode = keccak256,
} = {}) {
  const mode = resolveMode(env);
  const boundedTimeout = requireTimeout(timeoutMs);
  if (mode === RECOVERY_V2_RUNTIME_MODE.DISABLED) {
    return Object.freeze({
      mode,
      readiness() { return inactiveReadiness(mode); },
      async prepare() { throw runtimeFault("RECOVERY_V2_PREPARE_MODE_REQUIRED"); },
      async run() {
        return Object.freeze({ status: "blocked", reason: "RECOVERY_V2_DEPLOYMENT_DISABLED" });
      },
    });
  }

  const artifact = await loadRecoveryV2DeploymentArtifact({
    artifact: artifactInput,
    ...(readArtifact ? { readArtifact } : {}),
  });
  const initCode = buildRecoveryV2InitCode(artifact);

  if (mode === RECOVERY_V2_RUNTIME_MODE.PREPARE) {
    const prepareArmDigest = recoveryV2PrepareArmDigest({ env, artifact });
    requireExactPrepareArm(env, prepareArmDigest);
    return Object.freeze({
      mode,
      readiness() { return inactiveReadiness(mode); },
      async prepare() {
        const wallet = resolveWallet(injectedWallet, privateKey);
        return prepareFrozenTransaction({
          wallet,
          initCode,
          timeoutMs: boundedTimeout,
          transactionParser,
        });
      },
      async run() {
        return Object.freeze({ status: "blocked", reason: "RECOVERY_V2_PREPARE_NEVER_BROADCASTS" });
      },
    });
  }

  requireExactArmShape(env);
  const manifest = buildRecoveryV2DeploymentManifest({ env, artifact });
  let lastResult = Object.freeze({
    status: "blocked",
    reason: "RECOVERY_V2_DEPLOYMENT_NOT_VERIFIED",
  });
  return Object.freeze({
    mode,
    readiness() { return armedReadiness(lastResult, manifest); },
    async prepare() { throw runtimeFault("RECOVERY_V2_PREPARE_MODE_REQUIRED"); },
    async run() {
      if (armedReadiness(lastResult, manifest).ready) return lastResult;
      const wallet = resolveWallet(injectedWallet, privateKey);
      const providers = resolveProviders(injectedProviders, providerFactory, boundedTimeout);
      const verification = createRecoveryV2VerificationHooks({
        primaryProvider: providers.primary,
        auditProvider: providers.audit,
        artifact,
        manifest,
        initCode,
        timeoutMs: boundedTimeout,
        hashBytecode,
      });
      const result = await lifecycleRunner({
        manifest,
        artifact,
        env,
        provider: providers.primary,
        wallet,
        verification,
        clock,
        externalTimeoutMs: boundedTimeout,
      });
      const sanitized = sanitizeLifecycleResult(result);
      if (!armedReadiness(lastResult, manifest).ready || armedReadiness(sanitized, manifest).ready) {
        lastResult = sanitized;
      }
      return sanitized;
    },
  });
}

export function createRecoveryV2VerificationHooks({
  primaryProvider,
  auditProvider,
  artifact,
  manifest,
  initCode = buildRecoveryV2InitCode(artifact),
  timeoutMs = RECOVERY_V2_RPC_TIMEOUT_MS,
  hashBytecode = keccak256,
} = {}) {
  const boundedTimeout = requireTimeout(timeoutMs);
  requireMappedArtifact(artifact);
  requirePlainObject(manifest, "RECOVERY_V2_MANIFEST_INVALID");
  requireProvider(primaryProvider, true);
  requireProvider(auditProvider, false);
  if (typeof hashBytecode !== "function") throw runtimeFault("RECOVERY_V2_HASHER_INVALID");
  const contractInterface = new Interface(artifact.abi);
  const legacyInterface = new Interface(LEGACY_ABI);
  let postFinalityVerification;

  async function verifyPreBroadcast(context) {
    const preflightBinding = context && typeof context === "object"
      ? Object.fromEntries(Object.entries(context).filter(([key]) => key !== "bindingHash"))
      : null;
    let calculatedBindingHash;
    try {
      calculatedBindingHash = keccak256(toUtf8Bytes(canonicalJson(preflightBinding)));
    } catch {
      return false;
    }
    const suppliedTransaction = context?.transaction ?? context?.unsignedTransaction;
    const contextContractAddress = context?.contractAddress ?? context?.expectedContractAddress;
    const contextValue = context?.value ?? decimalTransactionField(suppliedTransaction?.value);
    const contextGasLimit = context?.gasLimit ?? decimalTransactionField(suppliedTransaction?.gasLimit);
    const contextMaxFee = context?.maxFeePerGas
      ?? decimalTransactionField(suppliedTransaction?.maxFeePerGas);
    if (
      context?.schema !== RECOVERY_V2_PREFLIGHT_SCHEMA
      || context?.chainId !== RECOVERY_V2_CHAIN_ID
      || context?.nonce !== RECOVERY_V2_DEPLOYMENT_NONCE
      || context?.bindingHash !== calculatedBindingHash
      || contextContractAddress !== manifest.expectedContractAddress
      || context?.signerAddress !== manifest.signerAddress
      || context?.chainCheckpoint?.blockNumber !== manifest.chainCheckpoint.blockNumber
      || context?.chainCheckpoint?.blockHash !== manifest.chainCheckpoint.blockHash
      || contextValue !== manifest.value
      || contextGasLimit !== manifest.gasLimit
      || contextMaxFee !== manifest.maxFeePerGas
      || context?.maxPriorityFeePerGas !== manifest.maxPriorityFeePerGas
      || context?.expectedInitCodeHash !== manifest.expectedInitCodeHash
    ) return false;
    if (context.provider !== undefined && context.provider !== primaryProvider) return false;
    if (suppliedTransaction !== undefined && !unsignedTransactionMatches(suppliedTransaction, initCode)) {
      return false;
    }
    if (
      (context.expectedTransactionHash !== undefined
        && context.expectedTransactionHash !== manifest.expectedTransactionHash)
      || (context.expectedContractAddress !== undefined
        && context.expectedContractAddress !== manifest.expectedContractAddress)
      || (context.expectedRuntimeCodeHash !== undefined
        && context.expectedRuntimeCodeHash !== artifact.runtimeCodeHash)
      || (context.constructorArgs !== undefined
        && !snapshotsMatch(context.constructorArgs, manifest.constructorArgs))
      || (context.artifact !== undefined
        && !snapshotsMatch(context.artifact, manifest.artifact))
    ) return false;

    const simulationRequest = frozenTransactionRequest(initCode, { includeFrom: true });
    const [
      primaryNetwork,
      auditNetwork,
      primaryCheckpoint,
      auditCheckpoint,
      simulation,
      gasEstimate,
      signerBalance,
      primaryLatestNonce,
      primaryPendingNonce,
      auditLatestNonce,
      auditPendingNonce,
      primaryCode,
      auditCode,
      primaryAddressNonce,
      auditAddressNonce,
    ] = await boundedAll([
      () => primaryProvider.getNetwork(),
      () => auditProvider.getNetwork(),
      () => primaryProvider.getBlock(manifest.chainCheckpoint.blockNumber),
      () => auditProvider.getBlock(manifest.chainCheckpoint.blockNumber),
      () => primaryProvider.call({ ...simulationRequest, blockTag: "latest" }),
      () => primaryProvider.estimateGas(simulationRequest),
      () => primaryProvider.getBalance(manifest.signerAddress, "latest"),
      () => primaryProvider.getTransactionCount(manifest.signerAddress, "latest"),
      () => primaryProvider.getTransactionCount(manifest.signerAddress, "pending"),
      () => auditProvider.getTransactionCount(manifest.signerAddress, "latest"),
      () => auditProvider.getTransactionCount(manifest.signerAddress, "pending"),
      () => primaryProvider.getCode(manifest.expectedContractAddress, "latest"),
      () => auditProvider.getCode(manifest.expectedContractAddress, "latest"),
      () => primaryProvider.getTransactionCount(manifest.expectedContractAddress, "latest"),
      () => auditProvider.getTransactionCount(manifest.expectedContractAddress, "latest"),
    ], boundedTimeout);

    if (!networkMatches(primaryNetwork) || !networkMatches(auditNetwork)) return false;
    if (!checkpointMatches(primaryCheckpoint, manifest) || !checkpointMatches(auditCheckpoint, manifest)) {
      return false;
    }
    if (!isHexString(simulation) || simulation === "0x") return false;
    if (exactCodeHash(hashBytecode, simulation) !== artifact.runtimeCodeHash) return false;
    const estimated = exactBigInt(gasEstimate);
    const gasLimit = BigInt(manifest.gasLimit);
    if (estimated <= 0n || estimated * GAS_ESTIMATE_MARGIN_BPS > gasLimit * BASIS_POINTS) return false;
    const requiredBalance = BigInt(manifest.value) + gasLimit * BigInt(manifest.maxFeePerGas);
    if (exactBigInt(signerBalance) < requiredBalance) return false;
    if (
      exactNonce(primaryLatestNonce) !== RECOVERY_V2_DEPLOYMENT_NONCE
      || exactNonce(primaryPendingNonce) !== RECOVERY_V2_DEPLOYMENT_NONCE
      || exactNonce(auditLatestNonce) !== RECOVERY_V2_DEPLOYMENT_NONCE
      || exactNonce(auditPendingNonce) !== RECOVERY_V2_DEPLOYMENT_NONCE
      || normalizeCode(primaryCode) !== "0x"
      || normalizeCode(auditCode) !== "0x"
      || exactNonce(primaryAddressNonce) !== 0
      || exactNonce(auditAddressNonce) !== 0
    ) return false;
    return Object.freeze({
      schema: RECOVERY_V2_PREFLIGHT_RESULT_SCHEMA,
      bindingHash: context.bindingHash,
      primaryVerified: true,
      auditVerified: true,
    });
  }

  async function verifyPostFinality(context) {
    if (!postFinalityVerification) {
      postFinalityVerification = verifyCanonicalDeployment({
        context,
        primaryProvider,
        auditProvider,
        contractInterface,
        legacyInterface,
        manifest,
        artifact,
        timeoutMs: boundedTimeout,
        hashBytecode,
      }).then((result) => {
        if (result !== true) postFinalityVerification = undefined;
        return result;
      }).catch((error) => {
        // Provider outages are retried by the supervisor. Do not make the
        // first transient rejection the permanent result for every later
        // reconciliation pass.
        postFinalityVerification = undefined;
        throw error;
      });
    }
    return postFinalityVerification;
  }

  return Object.freeze({
    verifyPreBroadcast,
    verifyLegacyBinding: verifyPostFinality,
    verifyInitialCampaign: verifyPostFinality,
    async getLatestBlockNumber() {
      return boundedCall(() => primaryProvider.getBlockNumber(), boundedTimeout);
    },
    async getFinalizedBlockNumber() {
      const block = await boundedCall(() => primaryProvider.getBlock("finalized"), boundedTimeout);
      return exactBlockNumber(block?.number);
    },
  });
}

async function prepareFrozenTransaction({ wallet, initCode, timeoutMs, transactionParser }) {
  const signerAddress = exactAddress(
    await boundedCall(
      () => typeof wallet.getAddress === "function" ? wallet.getAddress() : wallet.address,
      timeoutMs,
    ),
  );
  if (signerAddress !== RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress) {
    throw runtimeFault("RECOVERY_V2_SIGNER_MISMATCH");
  }
  const expectedAddress = getCreateAddress({ from: signerAddress, nonce: RECOVERY_V2_DEPLOYMENT_NONCE });
  if (expectedAddress !== RECOVERY_V2_FROZEN_DEPLOYMENT.contractAddress) {
    throw runtimeFault("RECOVERY_V2_CREATE_ADDRESS_MISMATCH");
  }
  const transaction = frozenTransactionRequest(initCode);
  let raw;
  try {
    raw = await boundedCall(() => wallet.signTransaction(transaction), timeoutMs);
  } catch {
    throw runtimeFault("RECOVERY_V2_SIGNING_FAILED");
  }
  if (!isHexString(raw) || raw === "0x") throw runtimeFault("RECOVERY_V2_SIGNED_TRANSACTION_INVALID");
  let parsed;
  try {
    parsed = transactionParser(raw);
  } catch {
    throw runtimeFault("RECOVERY_V2_SIGNED_TRANSACTION_INVALID");
  }
  if (!signedTransactionMatches(parsed, transaction, raw)) {
    throw runtimeFault("RECOVERY_V2_SIGNED_TRANSACTION_MISMATCH");
  }
  return Object.freeze({
    transactionHash: parsed.hash.toLowerCase(),
    contractAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.contractAddress,
    initCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedInitCodeHash,
    runtimeCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedRuntimeCodeHash,
  });
}

async function verifyCanonicalDeployment({
  context,
  primaryProvider,
  auditProvider,
  contractInterface,
  legacyInterface,
  manifest,
  artifact,
  timeoutMs,
  hashBytecode,
}) {
  if (
    context?.transactionHash !== manifest.expectedTransactionHash
    || context?.contractAddress !== manifest.expectedContractAddress
  ) return false;
  const receiptBlockNumber = exactBlockNumber(context.receiptBlockNumber);
  const finalizedBlockNumber = exactBlockNumber(context.finalizedBlockNumber);
  if (finalizedBlockNumber < receiptBlockNumber + 2) return false;

  const [primary, audit] = await Promise.all([
    readCanonicalDeployment(primaryProvider, {
      contractInterface,
      legacyInterface,
      manifest,
      receiptBlockNumber,
      finalizedBlockNumber,
      timeoutMs,
      readHistoricalBalance: true,
    }),
    readCanonicalDeployment(auditProvider, {
      contractInterface,
      legacyInterface,
      manifest,
      receiptBlockNumber,
      finalizedBlockNumber,
      timeoutMs,
      // The CC3 Blockscout audit RPC rejects eth_getBalance with a historical
      // block tag. The primary RPC still enforces the historical balance
      // invariant; both RPCs independently verify every canonical deployment
      // and contract-state field below.
      readHistoricalBalance: false,
    }),
  ]);
  if (!canonicalCoreMatches(primary, audit)) return false;
  if (!networkMatches(primary.network) || !networkMatches(audit.network)) return false;
  if (!checkpointMatches(primary.checkpoint, manifest) || !checkpointMatches(audit.checkpoint, manifest)) {
    return false;
  }
  if (
    primary.receiptBlock.hash !== audit.receiptBlock.hash
    || primary.finalizedBlock.hash !== audit.finalizedBlock.hash
    || primary.receiptBlock.number !== receiptBlockNumber
    || primary.finalizedBlock.number !== finalizedBlockNumber
    || primary.receipt.blockHash !== primary.receiptBlock.hash
    || audit.receipt.blockHash !== audit.receiptBlock.hash
    || primary.transaction.blockHash !== primary.receiptBlock.hash
    || audit.transaction.blockHash !== audit.receiptBlock.hash
    || primary.transaction.blockNumber !== receiptBlockNumber
    || audit.transaction.blockNumber !== receiptBlockNumber
  ) return false;
  if (!transactionMatches(primary.transaction, manifest) || !transactionMatches(audit.transaction, manifest)) {
    return false;
  }
  if (!receiptMatches(primary.receipt, manifest, receiptBlockNumber)) return false;
  if (!receiptMatches(audit.receipt, manifest, receiptBlockNumber)) return false;
  if (!logsMatchDeployment(primary.receipt.logs, contractInterface, manifest)) return false;
  if (!logsMatchDeployment(audit.receipt.logs, contractInterface, manifest)) return false;
  if (
    exactCodeHash(hashBytecode, primary.code) !== artifact.runtimeCodeHash
    || exactCodeHash(hashBytecode, audit.code) !== artifact.runtimeCodeHash
    || primary.addressNonce !== 1
    || audit.addressNonce !== 1
  ) return false;
  if (!snapshotsMatch(primary.contract, audit.contract)) return false;
  if (!snapshotsMatch(primary.legacy, audit.legacy)) return false;
  if (!contractSnapshotMatches(primary.contract, primary.legacy, primary.receiptBlock.timestamp)) return false;
  if (!legacySnapshotMatches(primary.legacy)) return false;
  if (primary.balance < primary.contract.accountedBalance) return false;
  if (normalizeCode(primary.legacyCode) === "0x" || normalizeCode(audit.legacyCode) === "0x") return false;
  if (exactCodeHash(hashBytecode, primary.legacyCode) !== exactCodeHash(hashBytecode, audit.legacyCode)) {
    return false;
  }
  return true;
}

async function readCanonicalDeployment(provider, {
  contractInterface,
  legacyInterface,
  manifest,
  receiptBlockNumber,
  finalizedBlockNumber,
  timeoutMs,
  readHistoricalBalance,
}) {
  const [
    network,
    checkpoint,
    receipt,
    transaction,
    receiptBlock,
    finalizedBlock,
    code,
    addressNonce,
    balance,
    contract,
    legacy,
    legacyCode,
  ] = await boundedAll([
    () => provider.getNetwork(),
    () => provider.getBlock(manifest.chainCheckpoint.blockNumber),
    () => provider.getTransactionReceipt(manifest.expectedTransactionHash),
    () => provider.getTransaction(manifest.expectedTransactionHash),
    () => provider.getBlock(receiptBlockNumber),
    () => provider.getBlock(finalizedBlockNumber),
    () => provider.getCode(manifest.expectedContractAddress, receiptBlockNumber),
    () => provider.getTransactionCount(manifest.expectedContractAddress, receiptBlockNumber),
    () => readHistoricalBalance
      ? provider.getBalance(manifest.expectedContractAddress, receiptBlockNumber)
      : null,
    () => readContractSnapshot(provider, contractInterface, manifest.expectedContractAddress, receiptBlockNumber),
    () => readLegacySnapshot(provider, legacyInterface, receiptBlockNumber),
    () => provider.getCode(RECOVERY_V2_FROZEN_DEPLOYMENT.legacy.poolAddress, receiptBlockNumber),
  ], timeoutMs);
  return Object.freeze({
    network,
    checkpoint,
    receipt: normalizeReceipt(receipt),
    transaction: normalizeTransaction(transaction),
    receiptBlock: normalizeBlock(receiptBlock),
    finalizedBlock: normalizeBlock(finalizedBlock),
    code: normalizeCode(code),
    addressNonce: exactNonce(addressNonce),
    balance: balance === null ? null : exactBigInt(balance),
    contract,
    legacy,
    legacyCode: normalizeCode(legacyCode),
  });
}

async function readContractSnapshot(provider, iface, address, blockTag) {
  const names = [
    ["retryVerifier", []],
    ["predicate", []],
    ["chainInfo", []],
    ["CHAIN_INFO", []],
    ["legacyPool", []],
    ["legacySponsor", []],
    ["legacyTermsHash", []],
    ["legacyBindingHash", []],
    ["legacyStartBlock", []],
    ["legacyEndBlock", []],
    ["legacyDeadline", []],
    ["LEGACY_CAMPAIGN_NUMBER", []],
    ["SOURCE_CHAIN_KEY", []],
    ["SOURCE_CHAIN_ID", []],
    ["MAX_CAMPAIGN_DURATION", []],
    ["campaignCount", []],
    ["accountedBalance", []],
    ["getCampaign", [LEGACY_CAMPAIGN_NUMBER]],
    ["getRule", [LEGACY_CAMPAIGN_NUMBER]],
    ["remainingAccounted", [LEGACY_CAMPAIGN_NUMBER]],
    ["releasesUnlocked", []],
  ];
  const values = await Promise.all(names.map(([name, args]) => callGetter(provider, iface, address, name, args, blockTag)));
  const scalar = (index) => values[index][0];
  const campaign = values[17][0];
  const rule = values[18][0];
  return deepFreeze({
    retryVerifier: exactAddress(scalar(0)),
    predicate: exactAddress(scalar(1)),
    chainInfo: exactAddress(scalar(2)),
    chainInfoConstant: exactAddress(scalar(3)),
    legacyPool: exactAddress(scalar(4)),
    legacySponsor: exactAddress(scalar(5)),
    legacyTermsHash: exactHash(scalar(6)),
    legacyBindingHash: exactHash(scalar(7)),
    legacyStartBlock: exactBigInt(scalar(8)),
    legacyEndBlock: exactBigInt(scalar(9)),
    legacyDeadline: exactBigInt(scalar(10)),
    legacyCampaignNumber: exactBigInt(scalar(11)),
    sourceChainKey: exactBigInt(scalar(12)),
    sourceChainId: exactBigInt(scalar(13)),
    maxCampaignDuration: exactBigInt(scalar(14)),
    campaignCount: exactBigInt(scalar(15)),
    accountedBalance: exactBigInt(scalar(16)),
    campaign: normalizeCampaign(campaign),
    rule: normalizeRule(rule),
    remainingAccounted: exactBigInt(scalar(19)),
    releasesUnlocked: scalar(20) === true,
  });
}

async function readLegacySnapshot(provider, iface, blockTag) {
  const address = RECOVERY_V2_FROZEN_DEPLOYMENT.legacy.poolAddress;
  const [retryVerifier, predicate, chainInfo, campaignResult, ruleResult] = await Promise.all([
    callGetter(provider, iface, address, "retryVerifier", [], blockTag),
    callGetter(provider, iface, address, "predicate", [], blockTag),
    callGetter(provider, iface, address, "chainInfo", [], blockTag),
    callGetter(provider, iface, address, "getCampaign", [LEGACY_CAMPAIGN_NUMBER], blockTag),
    callGetter(provider, iface, address, "getRule", [LEGACY_CAMPAIGN_NUMBER], blockTag),
  ]);
  return deepFreeze({
    retryVerifier: exactAddress(retryVerifier[0]),
    predicate: exactAddress(predicate[0]),
    chainInfo: exactAddress(chainInfo[0]),
    campaign: normalizeCampaign(campaignResult[0]),
    rule: normalizeRule(ruleResult[0]),
  });
}

async function callGetter(provider, iface, address, name, args, blockTag) {
  const data = iface.encodeFunctionData(name, args);
  const result = await provider.call({ to: address, data, blockTag });
  if (!isHexString(result)) throw runtimeFault("RECOVERY_V2_GETTER_RESPONSE_INVALID");
  return iface.decodeFunctionResult(name, result);
}

function contractSnapshotMatches(snapshot, legacySnapshot, receiptTimestamp) {
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  const campaign = snapshot.campaign;
  const expectedUnlocked = BigInt(receiptTimestamp) > BigInt(frozen.legacy.deadline)
    || legacySnapshot.campaign.claimCount === legacySnapshot.campaign.maxClaims;
  const expectedRemaining = campaign.creditAmount * (campaign.maxClaims - campaign.claimCount);
  return snapshot.retryVerifier === frozen.verifierAddress
    && snapshot.predicate === frozen.predicateAddress
    && snapshot.chainInfo === frozen.chainInfoAddress
    && snapshot.chainInfoConstant === frozen.chainInfoAddress
    && snapshot.legacyPool === frozen.legacy.poolAddress
    && snapshot.legacySponsor === frozen.legacy.sponsor
    && snapshot.legacyTermsHash === frozen.legacy.termsHash
    && snapshot.legacyBindingHash === frozen.legacy.bindingHash
    && snapshot.legacyStartBlock === BigInt(frozen.legacy.rule.startBlock)
    && snapshot.legacyEndBlock === BigInt(frozen.legacy.rule.endBlock)
    && snapshot.legacyDeadline === BigInt(frozen.legacy.deadline)
    && snapshot.legacyCampaignNumber === 1n
    && snapshot.sourceChainKey === 3n
    && snapshot.sourceChainId === 1n
    && snapshot.maxCampaignDuration === 30n * 24n * 60n * 60n
    && snapshot.campaignCount >= 1n
    && snapshot.accountedBalance >= snapshot.remainingAccounted
    && campaign.sponsor === frozen.signerAddress
    && campaign.creditAmount === BigInt(frozen.initialCampaign.creditAmount)
    && campaign.maxClaims === BigInt(frozen.initialCampaign.maxClaims)
    && campaign.claimCount <= campaign.maxClaims
    && campaign.deadline === BigInt(frozen.initialCampaign.deadline)
    && campaign.fundedAmount === BigInt(frozen.value)
    && campaign.termsHash === frozen.initialCampaign.termsHash
    && campaign.remainderRecovered === false
    && snapshot.remainingAccounted === expectedRemaining
    && ruleMatches(snapshot.rule, frozen.initialCampaign.rule)
    && snapshot.releasesUnlocked === expectedUnlocked;
}

function legacySnapshotMatches(snapshot) {
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  const campaign = snapshot.campaign;
  return snapshot.retryVerifier === frozen.verifierAddress
    && snapshot.predicate === frozen.predicateAddress
    && snapshot.chainInfo === frozen.chainInfoAddress
    && campaign.sponsor === frozen.legacy.sponsor
    && campaign.creditAmount === 100_000_000_000_000_000n
    && campaign.maxClaims === 3n
    && campaign.claimCount >= 1n
    && campaign.claimCount <= campaign.maxClaims
    && campaign.deadline === BigInt(frozen.legacy.deadline)
    && campaign.fundedAmount === 300_000_000_000_000_000n
    && campaign.termsHash === frozen.legacy.termsHash
    && campaign.remainderRecovered === false
    && ruleMatches(snapshot.rule, frozen.legacy.rule);
}

function logsMatchDeployment(logs, iface, manifest) {
  if (!Array.isArray(logs) || logs.length !== 2) return false;
  if (logs.some((log) => log.address !== manifest.expectedContractAddress)) return false;
  let legacy;
  let campaign;
  try {
    legacy = iface.parseLog({ topics: logs[0].topics, data: logs[0].data });
    campaign = iface.parseLog({ topics: logs[1].topics, data: logs[1].data });
  } catch {
    return false;
  }
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  return legacy?.name === "LegacyCampaignBound"
    && exactAddress(legacy.args.legacyPool) === frozen.legacy.poolAddress
    && exactBigInt(legacy.args.legacyCampaignNumber) === 1n
    && exactAddress(legacy.args.sponsor) === frozen.signerAddress
    && exactHash(legacy.args.termsHash) === frozen.legacy.termsHash
    && exactBigInt(legacy.args.deadline) === BigInt(frozen.legacy.deadline)
    && exactBigInt(legacy.args.startBlock) === BigInt(frozen.legacy.rule.startBlock)
    && exactBigInt(legacy.args.endBlock) === BigInt(frozen.legacy.rule.endBlock)
    && campaign?.name === "CampaignCreated"
    && exactBigInt(campaign.args.campaignNumber) === 1n
    && exactAddress(campaign.args.sponsor) === frozen.signerAddress
    && exactAddress(campaign.args.feeRecipient) === frozen.initialCampaign.rule.feeRecipient
    && exactBigInt(campaign.args.creditAmount) === BigInt(frozen.initialCampaign.creditAmount)
    && exactBigInt(campaign.args.maxClaims) === BigInt(frozen.initialCampaign.maxClaims)
    && exactBigInt(campaign.args.deadline) === BigInt(frozen.initialCampaign.deadline)
    && exactBigInt(campaign.args.startBlock) === BigInt(frozen.initialCampaign.rule.startBlock)
    && exactBigInt(campaign.args.endBlock) === BigInt(frozen.initialCampaign.rule.endBlock)
    && exactHash(campaign.args.termsHash) === frozen.initialCampaign.termsHash;
}

function normalizeReceipt(receipt) {
  requirePlainObject(receipt, "RECOVERY_V2_RECEIPT_INVALID");
  return deepFreeze({
    transactionHash: exactHash(receipt.hash ?? receipt.transactionHash),
    blockNumber: exactBlockNumber(receipt.blockNumber),
    blockHash: exactHash(receipt.blockHash),
    status: Number(receipt.status),
    contractAddress: exactAddress(receipt.contractAddress),
    from: exactAddress(receipt.from),
    to: receipt.to == null ? null : exactAddress(receipt.to),
    logs: (receipt.logs ?? []).map(normalizeLog),
  });
}

function normalizeTransaction(transaction) {
  requirePlainObject(transaction, "RECOVERY_V2_TRANSACTION_INVALID");
  return deepFreeze({
    hash: exactHash(transaction.hash),
    blockNumber: exactBlockNumber(transaction.blockNumber),
    blockHash: exactHash(transaction.blockHash),
    type: Number(transaction.type),
    chainId: exactBigInt(transaction.chainId),
    nonce: exactNonce(transaction.nonce),
    from: exactAddress(transaction.from),
    to: transaction.to == null ? null : exactAddress(transaction.to),
    value: exactBigInt(transaction.value),
    data: normalizeCode(transaction.data ?? transaction.input),
    gasLimit: exactBigInt(transaction.gasLimit ?? transaction.gas),
    maxFeePerGas: exactBigInt(transaction.maxFeePerGas),
    maxPriorityFeePerGas: exactBigInt(transaction.maxPriorityFeePerGas),
    accessListLength: Array.isArray(transaction.accessList) ? transaction.accessList.length : -1,
  });
}

function normalizeLog(log) {
  requirePlainObject(log, "RECOVERY_V2_LOG_INVALID");
  if (!Array.isArray(log.topics) || !isHexString(log.data)) {
    throw runtimeFault("RECOVERY_V2_LOG_INVALID");
  }
  return deepFreeze({
    address: exactAddress(log.address),
    blockNumber: exactBlockNumber(log.blockNumber),
    blockHash: exactHash(log.blockHash),
    transactionHash: exactHash(log.transactionHash),
    topics: log.topics.map(exactHash),
    data: log.data.toLowerCase(),
  });
}

function normalizeBlock(block) {
  requirePlainObject(block, "RECOVERY_V2_BLOCK_INVALID");
  return Object.freeze({
    number: exactBlockNumber(block.number),
    hash: exactHash(block.hash),
    timestamp: exactBlockNumber(block.timestamp),
  });
}

function transactionMatches(transaction, manifest) {
  return transaction.hash === manifest.expectedTransactionHash
    && transaction.type === 2
    && transaction.chainId === BigInt(RECOVERY_V2_CHAIN_ID)
    && transaction.nonce === RECOVERY_V2_DEPLOYMENT_NONCE
    && transaction.from === manifest.signerAddress
    && transaction.to === null
    && transaction.value === BigInt(manifest.value)
    && keccak256(transaction.data) === manifest.expectedInitCodeHash
    && transaction.gasLimit === BigInt(manifest.gasLimit)
    && transaction.maxFeePerGas === BigInt(manifest.maxFeePerGas)
    && transaction.maxPriorityFeePerGas === BigInt(manifest.maxPriorityFeePerGas)
    && transaction.accessListLength === 0;
}

function receiptMatches(receipt, manifest, receiptBlockNumber) {
  return receipt.transactionHash === manifest.expectedTransactionHash
    && receipt.blockNumber === receiptBlockNumber
    && receipt.status === 1
    && receipt.contractAddress === manifest.expectedContractAddress
    && receipt.from === manifest.signerAddress
    && receipt.to === null
    && receipt.logs.every((log) => (
      log.transactionHash === manifest.expectedTransactionHash
      && log.blockNumber === receipt.blockNumber
      && log.blockHash === receipt.blockHash
    ));
}

function signedTransactionMatches(parsed, expected, raw) {
  try {
    return exactHash(parsed.hash) === keccak256(raw)
      && Number(parsed.type) === 2
      && exactBigInt(parsed.chainId) === BigInt(RECOVERY_V2_CHAIN_ID)
      && exactNonce(parsed.nonce) === RECOVERY_V2_DEPLOYMENT_NONCE
      && parsed.to === null
      && exactAddress(parsed.from) === RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress
      && exactBigInt(parsed.value) === expected.value
      && normalizeCode(parsed.data) === expected.data
      && exactBigInt(parsed.gasLimit) === expected.gasLimit
      && exactBigInt(parsed.maxFeePerGas) === expected.maxFeePerGas
      && exactBigInt(parsed.maxPriorityFeePerGas) === expected.maxPriorityFeePerGas
      && Array.isArray(parsed.accessList)
      && parsed.accessList.length === 0;
  } catch {
    return false;
  }
}

function unsignedTransactionMatches(transaction, initCode) {
  try {
    return Number(transaction.type) === 2
      && exactBigInt(transaction.chainId) === BigInt(RECOVERY_V2_CHAIN_ID)
      && exactNonce(transaction.nonce) === RECOVERY_V2_DEPLOYMENT_NONCE
      && transaction.to === null
      && exactBigInt(transaction.value) === BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.value)
      && normalizeCode(transaction.data) === initCode
      && exactBigInt(transaction.gasLimit) === BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.gasLimit)
      && exactBigInt(transaction.maxFeePerGas) === BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.maxFeePerGas)
      && exactBigInt(transaction.maxPriorityFeePerGas)
        === BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.maxPriorityFeePerGas)
      && Array.isArray(transaction.accessList)
      && transaction.accessList.length === 0;
  } catch {
    return false;
  }
}

function frozenTransactionRequest(initCode, { includeFrom = false } = {}) {
  return Object.freeze({
    type: 2,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    to: null,
    value: BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.value),
    data: initCode,
    gasLimit: BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.gasLimit),
    maxFeePerGas: BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(RECOVERY_V2_FROZEN_DEPLOYMENT.maxPriorityFeePerGas),
    accessList: Object.freeze([]),
    ...(includeFrom ? { from: RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress } : {}),
  });
}

function canonicalCoreMatches(left, right) {
  return snapshotsMatch(left.receipt, right.receipt)
    && snapshotsMatch(left.transaction, right.transaction)
    && left.code === right.code
    && left.addressNonce === right.addressNonce;
}

function snapshotsMatch(left, right) {
  return canonicalJson(jsonSafe(left)) === canonicalJson(jsonSafe(right));
}

function jsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

function normalizeCampaign(value) {
  if (!value || typeof value !== "object") throw runtimeFault("RECOVERY_V2_CAMPAIGN_INVALID");
  return deepFreeze({
    sponsor: exactAddress(value.sponsor ?? value[0]),
    creditAmount: exactBigInt(value.creditAmount ?? value[1]),
    maxClaims: exactBigInt(value.maxClaims ?? value[2]),
    claimCount: exactBigInt(value.claimCount ?? value[3]),
    deadline: exactBigInt(value.deadline ?? value[4]),
    fundedAmount: exactBigInt(value.fundedAmount ?? value[5]),
    termsHash: exactHash(value.termsHash ?? value[6]),
    remainderRecovered: (value.remainderRecovered ?? value[7]) === true,
  });
}

function normalizeRule(value) {
  if (!value || typeof value !== "object") throw runtimeFault("RECOVERY_V2_RULE_INVALID");
  return deepFreeze({
    feeRecipient: exactAddress(value.feeRecipient ?? value[0]),
    startBlock: exactBigInt(value.startBlock ?? value[1]),
    endBlock: exactBigInt(value.endBlock ?? value[2]),
    maxBlockGap: exactBigInt(value.maxBlockGap ?? value[3]),
    maxQuantity: exactBigInt(value.maxQuantity ?? value[4]),
  });
}

function ruleMatches(actual, expected) {
  return actual.feeRecipient === expected.feeRecipient
    && actual.startBlock === BigInt(expected.startBlock)
    && actual.endBlock === BigInt(expected.endBlock)
    && actual.maxBlockGap === BigInt(expected.maxBlockGap)
    && actual.maxQuantity === BigInt(expected.maxQuantity);
}

function resolveMode(env) {
  requirePlainObject(env, "RECOVERY_V2_ENVIRONMENT_INVALID");
  const value = env[RECOVERY_V2_RUNTIME_ENV.mode] ?? RECOVERY_V2_RUNTIME_MODE.DISABLED;
  if (!Object.values(RECOVERY_V2_RUNTIME_MODE).includes(value)) {
    throw runtimeFault("RECOVERY_V2_MODE_INVALID");
  }
  return value;
}

function recoveryV2PrepareArmDigest({ env, artifact }) {
  requirePlainObject(env, "RECOVERY_V2_ENVIRONMENT_INVALID");
  requireMappedArtifact(artifact);
  requirePrepareIdentity(env);
  const revision = exactEnvironmentRevision(env, RECOVERY_V2_RUNTIME_ENV.revision);
  if (env.RENDER_GIT_COMMIT !== revision) {
    throw runtimeFault("RECOVERY_V2_REVISION_MISMATCH");
  }
  return keccak256(toUtf8Bytes(canonicalJson({
    domain: "RetryCredit Recovery V2 prepare signing authorization",
    version: 1,
    revision,
    chainId: RECOVERY_V2_CHAIN_ID,
    nonce: RECOVERY_V2_DEPLOYMENT_NONCE,
    signerAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.signerAddress,
    contractAddress: RECOVERY_V2_FROZEN_DEPLOYMENT.contractAddress,
    value: RECOVERY_V2_FROZEN_DEPLOYMENT.value,
    gasLimit: RECOVERY_V2_FROZEN_DEPLOYMENT.gasLimit,
    maxFeePerGas: RECOVERY_V2_FROZEN_DEPLOYMENT.maxFeePerGas,
    maxPriorityFeePerGas: RECOVERY_V2_FROZEN_DEPLOYMENT.maxPriorityFeePerGas,
    expectedInitCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedInitCodeHash,
    expectedRuntimeCodeHash: RECOVERY_V2_FROZEN_DEPLOYMENT.expectedRuntimeCodeHash,
    artifact: {
      contractName: artifact.contractName,
      abiHash: artifact.abiHash,
      bytecodeHash: artifact.bytecodeHash,
      runtimeCodeHash: artifact.runtimeCodeHash,
    },
    render: { ...RECOVERY_V2_FROZEN_DEPLOYMENT.render, revision },
    v1Profile: { ...RECOVERY_V1_PROFILE },
  })));
}

function inactiveReadiness(mode) {
  return Object.freeze({
    ready: true,
    statusCode: 200,
    mode,
    deploymentState: mode,
    publicProfile: "v1",
  });
}

function armedReadiness(result, manifest) {
  const ready = result?.status === "finalized"
    && result?.reason === "FINALIZED_PLUS_TWO_VERIFIED"
    && result?.chainId === RECOVERY_V2_CHAIN_ID
    && result?.nonce === RECOVERY_V2_DEPLOYMENT_NONCE
    && result?.transactionHash === manifest.expectedTransactionHash
    && result?.contractAddress === manifest.expectedContractAddress;
  return Object.freeze({
    ready,
    statusCode: ready ? 200 : 503,
    mode: RECOVERY_V2_RUNTIME_MODE.ARMED,
    deploymentState: safeDeploymentStatus(result?.status),
    reason: safeReasonCode(result?.reason),
    publicProfile: "v1",
  });
}

function sanitizeLifecycleResult(result) {
  requirePlainObject(result, "RECOVERY_V2_LIFECYCLE_RESULT_INVALID");
  const allowed = [
    "status",
    "reason",
    "chainId",
    "nonce",
    "transactionHash",
    "contractAddress",
    "latestNonce",
    "pendingNonce",
    "receiptBlockNumber",
    "latestBlockNumber",
    "finalizedBlockNumber",
    "confirmations",
  ];
  const sanitized = {};
  for (const key of allowed) {
    if (result[key] !== undefined && result[key] !== null) sanitized[key] = result[key];
  }
  sanitized.status = safeDeploymentStatus(sanitized.status);
  sanitized.reason = safeReasonCode(sanitized.reason, "RECOVERY_V2_LIFECYCLE_RESULT_INVALID");
  return Object.freeze(sanitized);
}

function safeDeploymentStatus(value) {
  const allowed = new Set([
    "blocked",
    "conflict",
    "broadcast",
    "broadcast-uncertain",
    "pending",
    "mined",
    "finalized",
    "failed",
  ]);
  return allowed.has(value) ? value : "blocked";
}

function safeReasonCode(value, fallback = "RECOVERY_V2_DEPLOYMENT_NOT_VERIFIED") {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function requireArmedIdentity(env) {
  requireRenderIdentity(env, RECOVERY_V2_RUNTIME_MODE.ARMED, "RECOVERY_V2_NOT_ARMED");
}

function requirePrepareIdentity(env) {
  requireRenderIdentity(env, RECOVERY_V2_RUNTIME_MODE.PREPARE, "RECOVERY_V2_PREPARE_MODE_REQUIRED");
}

function requireRenderIdentity(env, mode, modeError) {
  if (env[RECOVERY_V2_RUNTIME_ENV.mode] !== mode) throw runtimeFault(modeError);
  const frozen = RECOVERY_V2_FROZEN_DEPLOYMENT;
  const expected = {
    RENDER: "true",
    RENDER_SERVICE_ID: frozen.render.serviceId,
    RENDER_SERVICE_NAME: frozen.render.serviceName,
    RENDER_SERVICE_TYPE: frozen.render.serviceType,
    RENDER_GIT_REPO_SLUG: frozen.render.repoSlug,
    RENDER_EXTERNAL_HOSTNAME: frozen.render.hostname,
    RENDER_GIT_BRANCH: frozen.render.branch,
    IS_PULL_REQUEST: "false",
    PUBLIC_ORIGIN: RECOVERY_V1_PROFILE.publicOrigin,
    ALLOWED_ORIGIN: RECOVERY_V1_PROFILE.allowedOrigin,
    RETRYCREDIT_PUBLIC_ENABLED: RECOVERY_V1_PROFILE.publicEnabled,
    RETRYCREDIT_RECOVERY_ENABLED: RECOVERY_V1_PROFILE.recoveryEnabled,
    RETRYCREDIT_RECOVERY_POOL_ADDRESS: RECOVERY_V1_PROFILE.poolAddress,
    RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: RECOVERY_V1_PROFILE.campaignNumber,
    RETRYCREDIT_LEGACY_WRITES_ENABLED: RECOVERY_V1_PROFILE.legacyWritesEnabled,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value) throw runtimeFault("RECOVERY_V2_RENDER_IDENTITY_MISMATCH");
  }
  if (
    typeof env.RENDER_INSTANCE_ID !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(env.RENDER_INSTANCE_ID)
  ) throw runtimeFault("RECOVERY_V2_RENDER_INSTANCE_INVALID");
}

function requireExactPrepareArm(env, expected) {
  const supplied = exactEnvironmentHash(
    env,
    RECOVERY_V2_RUNTIME_ENV.prepareArm,
    "RECOVERY_V2_PREPARE_ARM_INVALID",
  );
  if (supplied !== expected) throw runtimeFault("RECOVERY_V2_PREPARE_ARM_MISMATCH");
}

function requireExactArmShape(env) {
  exactEnvironmentHash(env, RECOVERY_V2_RUNTIME_ENV.arm, "RECOVERY_V2_ARM_INVALID");
}

function exactEnvironmentRevision(env, key) {
  const value = env[key];
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw runtimeFault("RECOVERY_V2_REVISION_INVALID");
  }
  return value;
}

function exactEnvironmentHash(env, key, code) {
  const value = env[key];
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value)) throw runtimeFault(code);
  return value;
}

function exactEnvironmentInteger(env, key, code) {
  const value = env[key];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw runtimeFault(code);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw runtimeFault(code);
  return number;
}

function decimalTransactionField(value) {
  if (value === undefined) return undefined;
  try {
    return BigInt(value).toString();
  } catch {
    return undefined;
  }
}

function createBoundedProvider(url, timeoutMs) {
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  return new JsonRpcProvider(request, RECOVERY_V2_CHAIN_ID, {
    staticNetwork: true,
    batchMaxCount: 1,
    cacheTimeout: -1,
  });
}

function resolveWallet(injectedWallet, privateKey) {
  if (injectedWallet) {
    if (typeof injectedWallet.signTransaction !== "function") {
      throw runtimeFault("RECOVERY_V2_WALLET_INVALID");
    }
    return injectedWallet;
  }
  try {
    return new Wallet(privateKey);
  } catch {
    throw runtimeFault("RECOVERY_V2_WALLET_INVALID");
  }
}

function resolveProviders(injected, providerFactory, timeoutMs) {
  let providers = injected;
  if (!providers) {
    if (typeof providerFactory !== "function") throw runtimeFault("RECOVERY_V2_PROVIDER_FACTORY_INVALID");
    providers = providerFactory({ timeoutMs });
  }
  requirePlainObject(providers, "RECOVERY_V2_PROVIDERS_INVALID");
  requireProvider(providers.primary, true);
  requireProvider(providers.audit, false);
  return providers;
}

function requireProvider(provider, canBroadcast) {
  const methods = [
    "getNetwork",
    "getBlock",
    "getBlockNumber",
    "getTransactionReceipt",
    "getTransaction",
    "getTransactionCount",
    "getCode",
    "getBalance",
    "call",
  ];
  if (canBroadcast) methods.push("estimateGas", "broadcastTransaction");
  if (!provider || methods.some((method) => typeof provider[method] !== "function")) {
    throw runtimeFault("RECOVERY_V2_PROVIDER_INVALID");
  }
}

function requireMappedArtifact(artifact) {
  requirePlainObject(artifact, "RECOVERY_V2_ARTIFACT_INVALID");
  if (
    artifact.contractName !== RECOVERY_V2_FROZEN_DEPLOYMENT.artifact.contractName
    || artifact.abiHash !== RECOVERY_V2_FROZEN_DEPLOYMENT.artifact.abiHash
    || artifact.bytecodeHash !== RECOVERY_V2_FROZEN_DEPLOYMENT.artifact.creationBytecodeHash
    || artifact.runtimeCodeHash !== RECOVERY_V2_FROZEN_DEPLOYMENT.expectedRuntimeCodeHash
    || !Array.isArray(artifact.abi)
    || !isHexString(artifact.bytecode)
    || keccak256(toUtf8Bytes(canonicalJson(artifact.abi))) !== artifact.abiHash
    || keccak256(artifact.bytecode) !== artifact.bytecodeHash
  ) throw runtimeFault("RECOVERY_V2_ARTIFACT_MAPPING_INVALID");
}

function checkpointMatches(block, manifest) {
  try {
    return exactBlockNumber(block?.number) === manifest.chainCheckpoint.blockNumber
      && exactHash(block?.hash) === manifest.chainCheckpoint.blockHash;
  } catch {
    return false;
  }
}

function networkMatches(network) {
  try {
    return Number(network?.chainId) === RECOVERY_V2_CHAIN_ID;
  } catch {
    return false;
  }
}

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw runtimeFault("RECOVERY_V2_CANONICAL_VALUE_INVALID");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw runtimeFault("RECOVERY_V2_CANONICAL_VALUE_INVALID");
}

async function boundedAll(actions, timeoutMs) {
  return Promise.all(actions.map((action) => boundedCall(action, timeoutMs)));
}

async function boundedCall(action, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(runtimeFault("RECOVERY_V2_EXTERNAL_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30_000) {
    throw runtimeFault("RECOVERY_V2_TIMEOUT_INVALID");
  }
  return value;
}

function exactCodeHash(hashBytecode, code) {
  const normalized = normalizeCode(code);
  const hash = hashBytecode(normalized);
  return exactHash(hash);
}

function normalizeCode(value) {
  if (typeof value !== "string" || !isHexString(value)) throw runtimeFault("RECOVERY_V2_CODE_INVALID");
  return value.toLowerCase();
}

function exactAddress(value) {
  try {
    return getAddress(value);
  } catch {
    throw runtimeFault("RECOVERY_V2_ADDRESS_INVALID");
  }
}

function exactHash(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw runtimeFault("RECOVERY_V2_HASH_INVALID");
  }
  return value.toLowerCase();
}

function exactNonce(value) {
  const nonce = Number(value);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw runtimeFault("RECOVERY_V2_NONCE_INVALID");
  return nonce;
}

function exactBlockNumber(value) {
  const blockNumber = Number(value);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw runtimeFault("RECOVERY_V2_BLOCK_NUMBER_INVALID");
  }
  return blockNumber;
}

function exactBigInt(value) {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    throw runtimeFault("RECOVERY_V2_INTEGER_INVALID");
  }
}

function requireBytecode(value, code) {
  if (typeof value !== "string" || !isHexString(value) || value === "0x" || value.includes("__$")) {
    throw runtimeFault(code);
  }
}

function requirePlainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeFault(code);
}

function sha256Hex(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export class RecoveryV2RuntimeFault extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryV2RuntimeFault";
    this.code = code;
  }
}

function runtimeFault(code) {
  return new RecoveryV2RuntimeFault(code);
}

// Re-exported for an offline operator tool; the controller never returns it.
export { recoveryV2DeploymentArmDigest };
