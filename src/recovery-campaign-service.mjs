import {
  AbiCoder,
  Contract,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  Transaction,
  Wallet,
  ZeroAddress,
  getAddress,
  id,
  isHexString,
  keccak256,
  verifyMessage,
} from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";

import {
  recoveryCampaignAbi,
  recoveryCampaignAbiV1,
  recoveryVerifierAbi,
  nativeQueryVerifierAbi,
  seaDropPaidRetryPredicateAbi,
  selectRecoveryCampaignAbi,
} from "./pool-abi.mjs";
import { WorkerError, decodeAttestedTransaction } from "./proof-worker.mjs";
import {
  MINT_SIGNED_SELECTOR,
  SEA_DROP_MAINNET,
  decodeCanonicalSeaDropMintSigned,
  validateSeaDropRecoveryPair,
} from "./seadrop-recovery.mjs";
import { PUBLIC_CC3_RELAYER_ROLE, deriveRoleKey } from "./role-key.mjs";
import { discoverHostedWalletSeaDropPairs } from "./seadrop-wallet-discovery.mjs";
import { buildRecoveryPairDiagnostics, serializeRecoveryPairDiagnostics } from "./recovery-pair-diagnostics.mjs";
import {
  RECOVERY_CHALLENGE_LIFETIME_SECONDS,
  RECOVERY_MAXIMUM_CLOCK_SKEW_SECONDS,
  formatRecoveryChallengeMessage,
} from "./recovery-consent.mjs";
import { RECOVERY_HELPER_MODE, formatRecoveryHelperMessage } from "./recovery-helper-consent.mjs";
import { helperOperationId, normalizeLedgerPolicy } from "./helper-ledger-policy.mjs";

export const RECOVERY_RELAYER_ROLE = PUBLIC_CC3_RELAYER_ROLE;

export const RECOVERY_RUNTIME_CODE_HASHES = Object.freeze({
  v1: "0x53e65e853223190fd50695af221a8d5510aa8420621f23ed08d03016cbafdf9f",
  v2: "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07",
});

export const RECOVERY_DISCOVERY_INDEX = Object.freeze([
  Object.freeze({
    wallet: getAddress("0x61ceFF58C74dE887604E0A680bF1058a9D5b74D1"),
    failedTransactionHash: "0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff",
    successfulTransactionHash: "0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a",
  }),
  Object.freeze({
    wallet: getAddress("0x0bbc095cfc73b121b196ee63478d64d1ebbdd4aa"),
    failedTransactionHash: "0x319832afc82bdcfa345f39bf056ba515afd4c28a0da402c6500876022e0a2035",
    successfulTransactionHash: "0x7ca03f721ddaa33dfd9ec1d174cb05ac131fb012a106d4964f3bbc59fae1fb96",
  }),
  Object.freeze({
    wallet: getAddress("0x77039399801f462b4ed13444a266b16355c471bf"),
    failedTransactionHash: "0xe2c2cbf7efe65a4fcc6e79ab01e803b0f9f0dccc6d1b69467b0175a83dd2c9de",
    successfulTransactionHash: "0xa285149308c0fe1c53470bf15a1ccb135ab3c7c7ee54b339bbd8505f3a503be6",
  }),
]);

export const RECOVERY_DEFAULTS = Object.freeze({
  sourceChainKey: 3,
  sourceChainId: 1,
  settlementChainId: 102_031,
  challengeLifetimeSeconds: RECOVERY_CHALLENGE_LIFETIME_SECONDS,
  maximumClockSkewSeconds: RECOVERY_MAXIMUM_CLOCK_SKEW_SECONDS,
  proofTimeoutMs: 120_000,
  releaseGasLimit: 6_000_000n,
  releaseLogChunkBlocks: 10_000,
  releaseLogLookbackBlocks: 250_000,
  releaseLogConcurrency: 1,
  sourceLookupConcurrency: 4,
  sourceLookupQueueLimit: 16,
  sourceLookupTimeoutMs: 20_000,
  intakeTimeoutMs: 25_000,
  sourceProviderAttempts: 3,
  sourceRpcBatchMaxCount: 100,
  settlementRpcBatchMaxCount: 100,
  releaseRpcBatchMaxCount: 100,
  sourcePairCacheMaxEntries: 256,
  sourcePairCacheTtlSeconds: 10 * 60,
  sourcePairNegativeCacheTtlSeconds: 30,
  campaignStateCacheTtlSeconds: 1,
  releaseQueueLimit: 8,
  discoveryTimeoutMs: 35_000,
  discoveryCandidateLimit: 4,
  discoverySourceLookupConcurrency: 4,
});

const DEFAULT_CREDITCOIN_RPC = "https://rpc.cc3-testnet.creditcoin.network";
const DEFAULT_PROOF_BUILDER = "https://prover.cc3-testnet.creditcoin.network";
const DEFAULT_ETHEREUM_RPCS = Object.freeze([
  "https://ethereum-rpc.publicnode.com",
  "https://1rpc.io/eth",
  "https://eth.drpc.org",
]);
const CHAIN_INFO = getAddress("0x0000000000000000000000000000000000000fd3");
const NATIVE_VERIFIER = getAddress("0x0000000000000000000000000000000000000fd2");
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const RECOVERY_CONTRACT_VERSIONS = Object.freeze(new Set(["v1", "v2"]));

export class RecoveryCampaignService {
  static fromPrivateKey({
    privateKey,
    poolAddress,
    campaignNumber,
    creditcoinRpc = DEFAULT_CREDITCOIN_RPC,
    releaseReceiptRpc,
    proofBuilderUrl = DEFAULT_PROOF_BUILDER,
    ethereumRpcUrls = DEFAULT_ETHEREUM_RPCS,
    publicOrigin,
    config = {},
    ...options
  }) {
    const creditcoinRequest = new FetchRequest(creditcoinRpc);
    creditcoinRequest.timeout = 15_000;
    const settlementRpcBatchMaxCount = requireBoundedInteger(
      config.settlementRpcBatchMaxCount ?? RECOVERY_DEFAULTS.settlementRpcBatchMaxCount,
      "settlement RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const ccProvider = new JsonRpcProvider(
      creditcoinRequest,
      RECOVERY_DEFAULTS.settlementChainId,
      {
        staticNetwork: true,
        batchMaxCount: settlementRpcBatchMaxCount,
        cacheTimeout: -1,
      },
    );
    // Keep permissionless proof relay writes out of the campaign sponsor's
    // nonce domain. This role is already used as the isolated CC3 relayer by
    // the archived public pilot and is never campaign-funding authority.
    const relayerWallet = new Wallet(
      deriveRoleKey(privateKey, RECOVERY_RELAYER_ROLE),
      ccProvider,
    );
    const sourceLookupTimeoutMs = requireBoundedInteger(
      config.sourceLookupTimeoutMs ?? RECOVERY_DEFAULTS.sourceLookupTimeoutMs,
      "source lookup timeout",
      { minimum: 250, maximum: 120_000 },
    );
    const sourceProviderAttempts = requireBoundedInteger(
      config.sourceProviderAttempts ?? RECOVERY_DEFAULTS.sourceProviderAttempts,
      "source provider attempts",
      { minimum: 1, maximum: 3 },
    );
    const sourceRpcBatchMaxCount = requireBoundedInteger(
      config.sourceRpcBatchMaxCount ?? RECOVERY_DEFAULTS.sourceRpcBatchMaxCount,
      "source RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    // The outer work-pool deadline protects callers and queue capacity. Each
    // underlying HTTP request also needs a finite deadline so a dead RPC cannot
    // retain a pool slot forever after the caller has timed out.
    const sourceProviderRequestTimeoutMs = Math.max(
      250,
      Math.min(6_000, Math.floor(sourceLookupTimeoutMs / sourceProviderAttempts) - 250),
    );
    const ethereumProviders = ethereumRpcUrls.map((url) => {
      const request = new FetchRequest(url);
      request.timeout = sourceProviderRequestTimeoutMs;
      return new JsonRpcProvider(request, RECOVERY_DEFAULTS.sourceChainId, {
        staticNetwork: true,
        batchMaxCount: sourceRpcBatchMaxCount,
      });
    });
    const normalizedPool = requireNonzeroAddress(poolAddress, "recovery pool");
    const contractVersion = requireRecoveryContractVersion(config.contractVersion);
    const poolContract = new Contract(
      normalizedPool,
      selectRecoveryCampaignAbi(contractVersion),
      relayerWallet,
    );
    let releasePoolContract = poolContract;
    let releaseFallbackPoolContract = null;
    if (releaseReceiptRpc) {
      const releaseRpcBatchMaxCount = requireBoundedInteger(
        config.releaseRpcBatchMaxCount ?? RECOVERY_DEFAULTS.releaseRpcBatchMaxCount,
        "release RPC batch size",
        { minimum: 1, maximum: 100 },
      );
      const releaseRequest = new FetchRequest(releaseReceiptRpc);
      releaseRequest.timeout = 15_000;
      const releaseProvider = new JsonRpcProvider(
        releaseRequest,
        RECOVERY_DEFAULTS.settlementChainId,
        { staticNetwork: true, batchMaxCount: releaseRpcBatchMaxCount },
      );
      releasePoolContract = new Contract(
        normalizedPool,
        selectRecoveryCampaignAbi(contractVersion),
        releaseProvider,
      );
      releaseFallbackPoolContract = poolContract;
    }
    return new RecoveryCampaignService({
      poolAddress: normalizedPool,
      campaignNumber,
      ccProvider,
      relayerWallet,
      ethereumProviders,
      proofBuilder: new proofProvider.service.ProofBuilder(
        RECOVERY_DEFAULTS.sourceChainKey,
        proofBuilderUrl,
        RECOVERY_DEFAULTS.proofTimeoutMs,
      ),
      publicOrigin,
      config,
      poolContract,
      releasePoolContract,
      releaseFallbackPoolContract,
      contractFactory: (address, abi) => new Contract(address, abi, ccProvider),
      ...options,
    });
  }

  static fromReadOnly({
    relayerAddress,
    poolAddress,
    campaignNumber,
    creditcoinRpc = DEFAULT_CREDITCOIN_RPC,
    releaseReceiptRpc,
    proofBuilderUrl = DEFAULT_PROOF_BUILDER,
    ethereumRpcUrls = DEFAULT_ETHEREUM_RPCS,
    publicOrigin,
    config = {},
    ...options
  }) {
    const creditcoinRequest = new FetchRequest(creditcoinRpc);
    creditcoinRequest.timeout = 15_000;
    const settlementRpcBatchMaxCount = requireBoundedInteger(
      config.settlementRpcBatchMaxCount ?? RECOVERY_DEFAULTS.settlementRpcBatchMaxCount,
      "settlement RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const ccProvider = new JsonRpcProvider(
      creditcoinRequest,
      RECOVERY_DEFAULTS.settlementChainId,
      {
        staticNetwork: true,
        batchMaxCount: settlementRpcBatchMaxCount,
        cacheTimeout: -1,
      },
    );
    const normalizedRelayer = requireNonzeroAddress(relayerAddress, "recovery relayer");
    const relayerIdentity = Object.freeze({ address: normalizedRelayer });
    const sourceLookupTimeoutMs = requireBoundedInteger(
      config.sourceLookupTimeoutMs ?? RECOVERY_DEFAULTS.sourceLookupTimeoutMs,
      "source lookup timeout",
      { minimum: 250, maximum: 120_000 },
    );
    const sourceProviderAttempts = requireBoundedInteger(
      config.sourceProviderAttempts ?? RECOVERY_DEFAULTS.sourceProviderAttempts,
      "source provider attempts",
      { minimum: 1, maximum: 3 },
    );
    const sourceRpcBatchMaxCount = requireBoundedInteger(
      config.sourceRpcBatchMaxCount ?? RECOVERY_DEFAULTS.sourceRpcBatchMaxCount,
      "source RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const sourceProviderRequestTimeoutMs = Math.max(
      250,
      Math.min(6_000, Math.floor(sourceLookupTimeoutMs / sourceProviderAttempts) - 250),
    );
    const ethereumProviders = ethereumRpcUrls.map((url) => {
      const request = new FetchRequest(url);
      request.timeout = sourceProviderRequestTimeoutMs;
      return new JsonRpcProvider(request, RECOVERY_DEFAULTS.sourceChainId, {
        staticNetwork: true,
        batchMaxCount: sourceRpcBatchMaxCount,
      });
    });
    const normalizedPool = requireNonzeroAddress(poolAddress, "recovery pool");
    const contractVersion = requireRecoveryContractVersion(config.contractVersion);
    const poolContract = new Contract(
      normalizedPool,
      selectRecoveryCampaignAbi(contractVersion),
      ccProvider,
    );
    let releasePoolContract = poolContract;
    let releaseFallbackPoolContract = null;
    if (releaseReceiptRpc) {
      const releaseRpcBatchMaxCount = requireBoundedInteger(
        config.releaseRpcBatchMaxCount ?? RECOVERY_DEFAULTS.releaseRpcBatchMaxCount,
        "release RPC batch size",
        { minimum: 1, maximum: 100 },
      );
      const releaseRequest = new FetchRequest(releaseReceiptRpc);
      releaseRequest.timeout = 15_000;
      const releaseProvider = new JsonRpcProvider(
        releaseRequest,
        RECOVERY_DEFAULTS.settlementChainId,
        { staticNetwork: true, batchMaxCount: releaseRpcBatchMaxCount },
      );
      releasePoolContract = new Contract(
        normalizedPool,
        selectRecoveryCampaignAbi(contractVersion),
        releaseProvider,
      );
      releaseFallbackPoolContract = poolContract;
    }
    return new RecoveryCampaignService({
      poolAddress: normalizedPool,
      campaignNumber,
      ccProvider,
      relayerWallet: relayerIdentity,
      ethereumProviders,
      proofBuilder: new proofProvider.service.ProofBuilder(
        RECOVERY_DEFAULTS.sourceChainKey,
        proofBuilderUrl,
        RECOVERY_DEFAULTS.proofTimeoutMs,
      ),
      publicOrigin,
      config,
      poolContract,
      releasePoolContract,
      releaseFallbackPoolContract,
      contractFactory: (address, abi) => new Contract(address, abi, ccProvider),
      ...options,
    });
  }

  constructor({
    poolAddress,
    campaignNumber,
    ccProvider,
    relayerWallet,
    ethereumProviders = [],
    proofBuilder,
    publicOrigin,
    poolContract,
    releasePoolContract,
    releaseFallbackPoolContract,
    verifierContract,
    predicateContract,
    nativeVerifierContract,
    predecessorPoolContract,
    contractFactory = (address, abi) => new Contract(address, abi, ccProvider),
    discoveryIndex = RECOVERY_DISCOVERY_INDEX,
    walletDiscovery = discoverHostedWalletSeaDropPairs,
    pairResolver,
    beforeBroadcast = () => {},
    helperLedger = null,
    helperMaxFeeWei = null,
    helperCandidates = [],
    now = () => Math.floor(Date.now() / 1000),
    config = {},
  }) {
    this.poolAddress = requireNonzeroAddress(poolAddress, "recovery pool");
    this.campaignNumber = requirePositiveInteger(campaignNumber, "recovery campaign number");
    this.contractVersion = requireRecoveryContractVersion(config.contractVersion);
    this.ccProvider = ccProvider;
    this.relayerWallet = relayerWallet;
    this.ethereumProviders = ethereumProviders;
    this.proofBuilder = proofBuilder;
    this.publicOrigin = requireOrigin(publicOrigin);
    this.pool = poolContract ?? new Contract(
      this.poolAddress,
      selectRecoveryCampaignAbi(this.contractVersion),
      relayerWallet,
    );
    this.releasePools = Object.freeze([
      releasePoolContract ?? this.pool,
      ...(releaseFallbackPoolContract && releaseFallbackPoolContract !== releasePoolContract
        ? [releaseFallbackPoolContract]
        : []),
    ]);
    if (this.releasePools.some((pool) => requireContractAddress(pool) !== this.poolAddress)) {
      throw new WorkerError(
        "INVALID_RECOVERY_CONFIGURATION",
        "Recovery receipt readers must be bound to the configured pool.",
        500,
      );
    }
    this.verifier = verifierContract ?? null;
    this.predicate = predicateContract ?? null;
    this.nativeVerifier = nativeVerifierContract ?? null;
    this.predecessorPool = predecessorPoolContract ?? null;
    this.contractFactory = contractFactory;
    this.discoveryIndex = normalizeDiscoveryIndex(discoveryIndex);
    this.walletDiscovery = walletDiscovery;
    this.discoveryByWallet = new Map(
      this.discoveryIndex.map((entry) => [entry.wallet.toLowerCase(), entry]),
    );
    this.pairResolver = pairResolver;
    if (typeof beforeBroadcast !== "function") throw new Error("Invalid recovery broadcast guard");
    this.beforeBroadcast = beforeBroadcast;
    this.helperLedger = helperLedger;
    this.helperMaxFeeWei = null;
    this.helperPolicy = null;
    if (helperLedger) {
      if (this.contractVersion !== "v2"
        || !["reserve", "read", "readSource", "inspect", "admission", "prepareBroadcast", "complete", "failBeforeBroadcast"].every(name => typeof helperLedger[name] === "function")
        || typeof helperMaxFeeWei !== "string" || !/^[1-9][0-9]{0,77}$/.test(helperMaxFeeWei)
        || BigInt(helperMaxFeeWei) >= (1n << 256n)
        || typeof relayerWallet?.signTransaction !== "function") {
        throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", "Helper recovery requires a durable coordinator, V2 signer, and an explicit fee cap.", 500);
      }
      this.helperMaxFeeWei = BigInt(helperMaxFeeWei);
      try {
        this.helperPolicy = normalizeLedgerPolicy(helperLedger.policy);
        const scope = this.helperPolicy.identity;
        if (scope.chainId !== RECOVERY_DEFAULTS.settlementChainId
          || getAddress(scope.poolAddress) !== this.poolAddress || scope.campaignNumber !== this.campaignNumber
          || getAddress(scope.relayerAddress) !== getAddress(this.relayerWallet.address)
          || this.helperPolicy.limits.maxFeeWei !== helperMaxFeeWei) throw new Error("mismatched helper policy");
      } catch (error) {
        throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", "The helper ledger policy must match this exact pool, campaign, relayer, and fee cap.", 500, error);
      }
    }
    this.helperOperations = new Map();
    if (!Array.isArray(helperCandidates) || helperCandidates.length > 512) throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", "The helper candidate catalog must be bounded.", 500);
    this.helperCandidates = helperCandidates.map(candidate => normalizeIntakePair({
      failedTransactionHash: candidate.failedTransactionHash, successfulTransactionHash: candidate.successfulTransactionHash,
    }));
    this.helperCandidateCursor = 0;
    this.now = now;
    const mergedConfig = { ...RECOVERY_DEFAULTS, ...config };
    this.expectedRuntimeCodeHash = requireHash(
      mergedConfig.expectedRuntimeCodeHash ?? RECOVERY_RUNTIME_CODE_HASHES[this.contractVersion],
      "recovery pool runtime code hash",
    );
    this.expectedPredecessorRuntimeCodeHash = this.contractVersion === "v2"
      ? requireHash(
          mergedConfig.expectedPredecessorRuntimeCodeHash ?? RECOVERY_RUNTIME_CODE_HASHES.v1,
          "predecessor recovery pool runtime code hash",
        )
      : null;
    const releaseLogChunkBlocks = requirePositiveInteger(
      mergedConfig.releaseLogChunkBlocks,
      "release log chunk blocks",
    );
    const releaseLogLookbackBlocks = requirePositiveInteger(
      mergedConfig.releaseLogLookbackBlocks,
      "release log lookback blocks",
    );
    const releaseLogConcurrency = requireBoundedInteger(
      mergedConfig.releaseLogConcurrency,
      "release log concurrency",
      { minimum: 1, maximum: 6 },
    );
    if (
      releaseLogChunkBlocks > 50_000
      || releaseLogLookbackBlocks < releaseLogChunkBlocks
      || releaseLogLookbackBlocks > 1_000_000
    ) {
      throw new WorkerError(
        "INVALID_RECOVERY_CONFIGURATION",
        "Recovery release log bounds are invalid.",
        500,
      );
    }
    const sourceLookupConcurrency = requireBoundedInteger(
      mergedConfig.sourceLookupConcurrency,
      "source lookup concurrency",
      { minimum: 1, maximum: 32 },
    );
    const sourceLookupQueueLimit = requireBoundedInteger(
      mergedConfig.sourceLookupQueueLimit,
      "source lookup queue limit",
      { minimum: 0, maximum: 256 },
    );
    const sourceLookupTimeoutMs = requireBoundedInteger(
      mergedConfig.sourceLookupTimeoutMs,
      "source lookup timeout",
      { minimum: 250, maximum: 120_000 },
    );
    const intakeTimeoutMs = requireBoundedInteger(
      mergedConfig.intakeTimeoutMs,
      "recovery intake timeout",
      { minimum: 1_000, maximum: 120_000 },
    );
    const discoveryTimeoutMs = requireBoundedInteger(
      mergedConfig.discoveryTimeoutMs,
      "wallet discovery timeout",
      { minimum: 5_000, maximum: 60_000 },
    );
    const discoveryCandidateLimit = requireBoundedInteger(
      mergedConfig.discoveryCandidateLimit,
      "wallet discovery candidate limit",
      { minimum: 1, maximum: 8 },
    );
    const discoverySourceLookupConcurrency = requireBoundedInteger(
      mergedConfig.discoverySourceLookupConcurrency,
      "wallet discovery source concurrency",
      { minimum: 1, maximum: 4 },
    );
    const sourceProviderAttempts = requireBoundedInteger(
      mergedConfig.sourceProviderAttempts,
      "source provider attempts",
      { minimum: 1, maximum: 3 },
    );
    const sourceRpcBatchMaxCount = requireBoundedInteger(
      mergedConfig.sourceRpcBatchMaxCount,
      "source RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const settlementRpcBatchMaxCount = requireBoundedInteger(
      mergedConfig.settlementRpcBatchMaxCount,
      "settlement RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const releaseRpcBatchMaxCount = requireBoundedInteger(
      mergedConfig.releaseRpcBatchMaxCount,
      "release RPC batch size",
      { minimum: 1, maximum: 100 },
    );
    const sourcePairCacheMaxEntries = requireBoundedInteger(
      mergedConfig.sourcePairCacheMaxEntries,
      "source pair cache size",
      { minimum: 1, maximum: 4_096 },
    );
    const sourcePairCacheTtlSeconds = requireBoundedInteger(
      mergedConfig.sourcePairCacheTtlSeconds,
      "source pair cache TTL",
      { minimum: 1, maximum: 3_600 },
    );
    const sourcePairNegativeCacheTtlSeconds = requireBoundedInteger(
      mergedConfig.sourcePairNegativeCacheTtlSeconds,
      "source pair negative cache TTL",
      { minimum: 1, maximum: 300 },
    );
    const campaignStateCacheTtlSeconds = requireBoundedInteger(
      mergedConfig.campaignStateCacheTtlSeconds,
      "campaign state cache TTL",
      { minimum: 1, maximum: 10 },
    );
    const releaseQueueLimit = requireBoundedInteger(
      mergedConfig.releaseQueueLimit,
      "release queue limit",
      { minimum: 1, maximum: 64 },
    );
    this.config = {
      ...mergedConfig,
      contractVersion: this.contractVersion,
      releaseLogChunkBlocks,
      releaseLogLookbackBlocks,
      releaseLogConcurrency,
      sourceLookupConcurrency,
      sourceLookupQueueLimit,
      sourceLookupTimeoutMs,
      intakeTimeoutMs,
      discoveryTimeoutMs,
      discoveryCandidateLimit,
      discoverySourceLookupConcurrency,
      sourceProviderAttempts,
      sourceRpcBatchMaxCount,
      settlementRpcBatchMaxCount,
      releaseRpcBatchMaxCount,
      sourcePairCacheMaxEntries,
      sourcePairCacheTtlSeconds,
      sourcePairNegativeCacheTtlSeconds,
      campaignStateCacheTtlSeconds,
      releaseQueueLimit,
    };
    this.infrastructurePromise = null;
    this.sourcePairCache = new Map();
    this.sourcePairFlights = new Map();
    this.sourceLookupPool = new BoundedWorkPool({
      concurrency: sourceLookupConcurrency,
      queueLimit: sourceLookupQueueLimit,
      timeoutMs: sourceLookupTimeoutMs,
      busyError: () => new WorkerError(
        "RECOVERY_BUSY",
        "Recovery source intake is busy; retry shortly.",
        429,
      ),
      timeoutError: () => new WorkerError(
        "RECOVERY_SOURCE_TIMEOUT",
        "Ethereum source validation timed out; retry shortly.",
        503,
      ),
    });
    this.intakePool = new BoundedWorkPool({
      concurrency: sourceLookupConcurrency,
      queueLimit: sourceLookupQueueLimit,
      timeoutMs: intakeTimeoutMs,
      busyError: () => new WorkerError(
        "RECOVERY_BUSY",
        "Recovery intake is busy; retry shortly.",
        429,
      ),
      timeoutError: () => new WorkerError(
        "RECOVERY_SOURCE_TIMEOUT",
        "Recovery intake timed out; retry shortly.",
        503,
      ),
    });
    this.discoveryPool = new BoundedWorkPool({
      concurrency: 1,
      queueLimit: 4,
      timeoutMs: discoveryTimeoutMs,
      busyError: () => new WorkerError(
        "RECOVERY_BUSY",
        "Wallet discovery is busy; transaction hashes can still be entered manually.",
        429,
      ),
      timeoutError: () => new WorkerError(
        "RECOVERY_DISCOVERY_UNAVAILABLE",
        "Wallet history discovery timed out; transaction hashes can still be entered manually.",
        503,
      ),
    });
    this.discoverySourceLookupPool = new BoundedWorkPool({
      concurrency: discoverySourceLookupConcurrency,
      queueLimit: 4,
      timeoutMs: sourceLookupTimeoutMs,
      busyError: () => new WorkerError(
        "RECOVERY_BUSY",
        "Wallet discovery is busy; transaction hashes can still be entered manually.",
        429,
      ),
      timeoutError: () => new WorkerError(
        "RECOVERY_SOURCE_TIMEOUT",
        "Ethereum source validation timed out; transaction hashes can still be entered manually.",
        503,
      ),
    });
    this.campaignStateCache = null;
    this.campaignStateGeneration = 0;
    this.campaignStateFlights = { normal: null, fresh: null };
    this.campaignStateFreshQueued = null;
    this.releaseFlights = new Map();
    this.releaseQueue = Promise.resolve();
    this.releaseQueueDepth = 0;
  }

  async readiness() {
    const infrastructure = await this.#authenticateInfrastructure();
    const state = await this.#readCampaignState();
    if (this.helperLedger) this.#assertHelperCampaignPolicy(state.campaign);
    return infrastructure;
  }

  async configuration({ fresh = false } = {}) {
    const [infrastructure, state] = await Promise.all([
      this.#authenticateInfrastructure(),
      this.#campaignState({ fresh: fresh === true }),
    ]);
    const helperAvailability = this.helperLedger ? await this.#helperAvailability(state.campaign) : null;
    return {
      enabled: true,
      waking: false,
      capabilities: {
        selfServePairIntake: true,
        walletNativeDiscovery: true,
        ...(this.helperLedger ? { communityHelper: true } : {}),
      },
      ...(this.helperLedger ? { helper: {
        enabled: true,
        mode: RECOVERY_HELPER_MODE,
        recipientConsent: false,
        helperReceivesCredit: false,
        maxTransactionFeeWei: this.helperMaxFeeWei.toString(),
        ...helperAvailability,
      } } : {}),
      consent: {
        scope: "hosted-relayer",
        protocolEnforced: false,
        freshReadAdmission: "anonymous-v1",
      },
      source: {
        name: "Ethereum Mainnet",
        chainId: this.config.sourceChainId,
        chainKey: this.config.sourceChainKey,
      },
      settlement: {
        name: "Creditcoin Testnet",
        chainId: this.config.settlementChainId,
      },
      publicOrigin: this.publicOrigin,
      relayerAddress: this.relayerWallet.address,
      poolAddress: this.poolAddress,
      contractVersion: this.contractVersion,
      verifierAddress: infrastructure.verifierAddress,
      predicateAddress: infrastructure.predicateAddress,
      campaignNumber: this.campaignNumber,
      lineage: serializeConfigurationLineage(infrastructure.lineage, state.releasesUnlocked),
      campaign: serializeCampaign(state.campaign, this.now(), state.releasesUnlocked),
      rule: serializeRule(state.rule),
      capacity: serializeCapacity(state.campaign),
      featuredCase: {
        wallet: this.discoveryIndex[0].wallet,
        failedTransactionHash: this.discoveryIndex[0].failedTransactionHash,
        successfulTransactionHash: this.discoveryIndex[0].successfulTransactionHash,
      },
      discoverySize: this.discoveryIndex.length,
    };
  }

  async discover(walletValue) {
    const wallet = requireNonzeroAddress(walletValue, "wallet");
    return this.discoveryPool.run(() => this.#discoverWallet(wallet));
  }

  async #discoverWallet(wallet) {
    const state = await this.#campaignState();
    const rule = serializeRule(state.rule);
    let discovered;
    try {
      discovered = await this.walletDiscovery({ wallet, ...rule });
    } catch (error) {
      throw new WorkerError(
        "RECOVERY_DISCOVERY_UNAVAILABLE",
        "Wallet history discovery is temporarily unavailable; transaction hashes can still be entered manually.",
        503,
        error,
      );
    }

    const candidates = discovered.pairs.slice(0, this.config.discoveryCandidateLimit);
    const validations = await Promise.allSettled(candidates.map(async (pair) => {
      const context = await this.#openPairEligibilityContext(pair, {
        sourcePool: this.discoverySourceLookupPool,
      });
      return this.#publicEligibility(context);
    }));
    const matches = validations
      .filter(({ status }) => status === "fulfilled")
      .map(({ value }) => value);
    const infrastructureFailure = validations.find(
      ({ status, reason }) => status === "rejected"
        && (!(reason instanceof WorkerError) || reason.status >= 500),
    );
    if (matches.length === 0 && infrastructureFailure) {
      throw infrastructureFailure.reason;
    }
    return Object.freeze({
      wallet,
      authority: "advisory-discovery-only",
      ...(discovered.attribution ? { attribution: discovered.attribution } : {}),
      historyRowsInspected: discovered.transactions.length,
      historyTruncated: discovered.truncated,
      pagesInspected: discovered.pages,
      matches: Object.freeze(matches),
      manualFallbackRecommended: discovered.truncated || matches.length === 0,
    });
  }

  async eligibility(walletValue) {
    const wallet = requireNonzeroAddress(walletValue, "wallet");
    const discovery = this.discoveryByWallet.get(wallet.toLowerCase());
    if (!discovery) {
      return {
        eligible: false,
        status: "not-found",
        reason: "This wallet is not in the closed paid-retry discovery cohort.",
        wallet,
        campaignNumber: this.campaignNumber,
        creditAmount: null,
        pair: null,
        release: null,
        lineage: null,
      };
    }

    const context = await this.intakePool.run(
      () => this.#eligibilityContext(wallet, discovery),
    );
    // Preserve the staged legacy route's exact status vocabulary during the
    // API-first rollout. Only namespaced pair intake exposes hosted-flight state.
    return publicEligibility(context);
  }

  async intakeEligibility(request = {}) {
    const pairInput = normalizeIntakePairRequest(request);
    const context = await this.intakePool.run(
      () => this.#openPairEligibilityContext(pairInput),
    );
    return this.#publicEligibility(context);
  }

  async challenge(walletValue) {
    const wallet = requireNonzeroAddress(walletValue, "wallet");
    const discovery = this.discoveryByWallet.get(wallet.toLowerCase());
    if (!discovery) {
      throw new WorkerError(
        "RECOVERY_NOT_FOUND",
        "This wallet is not in the closed paid-retry discovery cohort.",
        404,
      );
    }
    const context = await this.intakePool.run(
      () => this.#eligibilityContext(wallet, discovery),
    );
    const eligibility = await this.#publicEligibility(context);
    if (!eligibility.eligible) throw eligibilityError(eligibility);
    this.#assertHostedAdmission(context, eligibility.hostedAdmission);
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.config.challengeLifetimeSeconds;
    const message = recoveryChallengeMessage({
      origin: this.publicOrigin,
      poolAddress: this.poolAddress,
      campaignNumber: this.campaignNumber,
      wallet: eligibility.wallet,
      failedTransactionHash: eligibility.pair.failedTransactionHash,
      successfulTransactionHash: eligibility.pair.successfulTransactionHash,
      issuedAt,
      expiresAt,
    });
    return {
      wallet: eligibility.wallet,
      message,
      issuedAt,
      expiresAt,
      campaignNumber: this.campaignNumber,
      poolAddress: this.poolAddress,
      pair: {
        failedTransactionHash: eligibility.pair.failedTransactionHash,
        successfulTransactionHash: eligibility.pair.successfulTransactionHash,
      },
      ...(this.helperLedger ? { hostedAdmission: eligibility.hostedAdmission } : {}),
    };
  }

  async intakeChallenge(request = {}) {
    const pairInput = normalizeIntakePairRequest(request);
    const context = await this.intakePool.run(
      () => this.#openPairEligibilityContext(pairInput),
    );
    const eligibility = await this.#publicEligibility(context);
    if (!eligibility.eligible) throw eligibilityError(eligibility);
    this.#assertHostedAdmission(context, eligibility.hostedAdmission);
    return {
      ...this.#challengeFor({ wallet: eligibility.wallet, discovery: context.discovery }),
      ...(this.helperLedger ? { hostedAdmission: eligibility.hostedAdmission } : {}),
    };
  }

  #requireHelper() {
    if (!this.helperLedger) throw new WorkerError("RECOVERY_HELPER_DISABLED", "Community helper requests are not enabled.", 503);
  }

  async #helperAvailability(campaign) {
    try {
      if (campaign) this.#assertHelperCampaignPolicy(campaign);
      const snapshot = await this.#ledger("inspect", {});
      return this.#availabilityFromSnapshot(snapshot);
    } catch {
      // Read-only recovery remains useful even if spending coordination is down.
      // Never imply that a new funded action is currently admitted in that state.
      return { available: false, admissionState: "unavailable" };
    }
  }

  #availabilityFromSnapshot(snapshot) {
    if (typeof snapshot.enabled !== "boolean" || !Number.isSafeInteger(snapshot.attempts)
      || !Number.isSafeInteger(snapshot.payouts) || snapshot.attempts < 0 || snapshot.payouts < 0
      || !/^(0|[1-9][0-9]*)$/.test(snapshot.reservedFeeWei)
      || !(snapshot.activeOperationId === null || isHexString(snapshot.activeOperationId, 32))) throw new Error("invalid admission snapshot");
    const limits = this.helperPolicy.limits;
    const exhausted = snapshot.attempts >= limits.maxAttempts || snapshot.payouts >= limits.maxPayouts
      || BigInt(snapshot.reservedFeeWei) + this.helperMaxFeeWei > BigInt(limits.maxTotalFeeWei);
    const admissionState = !snapshot.enabled || this.now() >= limits.expiresAt ? "paused" : exhausted ? "budget-exhausted"
      : snapshot.activeOperationId ? "busy" : "available";
    return { available: admissionState === "available", admissionState };
  }

  async #hostedAdmission(context) {
    try {
      this.#assertHelperCampaignPolicy(context.campaign);
      // No proof, reservation or receipt reconciliation occurs in this advisory read.
      // Source locks outlive a failed operation, including across different pairs.
      // One coordinator RPC reads totals and source state in one transaction;
      // independently serialized inspect/readSource responses can disagree.
      const snapshot = await this.#ledger("admission", { sourceWallet: context.wallet });
      if (!snapshot || !Object.hasOwn(snapshot, "operation")
        || getAddress(snapshot.sourceWallet) !== context.wallet) throw new Error("invalid source admission snapshot");
      const availability = this.#availabilityFromSnapshot(snapshot);
      if (snapshot.operation) {
        const operation = publicHelperOperation(snapshot.operation);
        if (operation.sourceWallet !== context.wallet) throw new Error("mismatched source admission snapshot");
        return { available: false, admissionState: "source-reserved", operation };
      }
      return { ...availability, operation: null };
    } catch {
      return { available: false, admissionState: "unavailable", operation: null };
    }
  }

  #assertHostedAdmission(context, admission) {
    if (!this.helperLedger) return;
    this.#assertHelperCampaignPolicy(context.campaign);
    if (admission?.available === true && admission.admissionState === "available" && admission.operation === null) return;
    const reasons = {
      paused: ["HELPER_LEDGER_PAUSED", "Hosted recovery is paused or its spending window has ended. No signature is needed now.", 503],
      busy: ["HELPER_LEDGER_BUSY", "Another hosted recovery is being processed. Wait for its status to resolve before signing.", 409],
      "budget-exhausted": ["HELPER_LEDGER_BUDGET_EXHAUSTED", "The bounded hosted recovery budget has been allocated. No signature is needed.", 409],
      "source-reserved": ["RECOVERY_PROCESSING", "This source wallet already has a durable recovery operation. Check its status instead of signing again.", 409],
      unavailable: ["RECOVERY_HELPER_UNAVAILABLE", "Hosted recovery availability cannot be verified. Source eligibility is unchanged; no signature is needed now.", 503],
    };
    const [code, message, status] = reasons[admission?.admissionState] ?? reasons.unavailable;
    throw new WorkerError(code, message, status);
  }

  async #ledger(method, input) {
    try { return await this.helperLedger[method](input); }
    catch (error) {
      throw new WorkerError(
        typeof error?.code === "string" && /^HELPER_[A-Z_]+$/.test(error.code) ? error.code : "RECOVERY_HELPER_UNAVAILABLE",
        "The durable recovery budget coordinator could not authorize this action. No automatic retry or new payment is started.",
        Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503,
        error,
      );
    }
  }

  async helperChallenge(request = {}) {
    this.#requireHelper();
    requireStrictObject(request, "A helper challenge requires a JSON object.");
    rejectDestinationFields(request);
    requireExactFields(request, ["requester", "pair"], "A helper challenge accepts only requester and pair.");
    const requester = requireNonzeroAddress(request.requester, "helper requester");
    const pair = normalizeIntakePair(request.pair);
    const context = await this.intakePool.run(() => this.#openPairEligibilityContext(pair));
    requireDistinctHelper(requester, context.wallet);
    if (!context.eligible) throw eligibilityError(publicEligibility(context));
    const hostedAdmission = await this.#hostedAdmission(context);
    this.#assertHostedAdmission(context, hostedAdmission);
    const sourceWallet = context.wallet;
    const operationId = this.#helperOperationId(sourceWallet, pair);
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.config.challengeLifetimeSeconds;
    return {
      mode: RECOVERY_HELPER_MODE, requester, sourceWallet, pair, operationId, issuedAt, expiresAt,
      poolAddress: this.poolAddress, campaignNumber: this.campaignNumber,
      hostedAdmission,
      message: this.#helperMessage({ requester, sourceWallet, pair, operationId, issuedAt, expiresAt }),
    };
  }

  async helperDiscover(request = {}) {
    this.#requireHelper();
    requireStrictObject(request, "Helper discovery requires an empty JSON object.");
    requireExactFields(request, [], "Helper discovery accepts no destination or candidate override.");
    return this.discoveryPool.run(() => this.#helperDiscoverCatalog());
  }

  async #helperDiscoverCatalog() {
    const totalCandidates = this.helperCandidates.length;
    const limit = Math.min(4, totalCandidates);
    let checkedCandidates = 0;
    let unavailable = false;
    for (; checkedCandidates < limit;) {
      const pair = this.helperCandidates[this.helperCandidateCursor % totalCandidates];
      this.helperCandidateCursor = (this.helperCandidateCursor + 1) % totalCandidates;
      checkedCandidates += 1;
      try {
        const context = await this.intakePool.run(() => this.#openPairEligibilityContext(pair, { freshState: true }));
        if (!context.eligible) continue;
        const match = await this.#publicEligibility(context);
        if (match.hostedAdmission.admissionState === "source-reserved") continue;
        if (match.hostedAdmission.admissionState === "unavailable") { unavailable = true; continue; }
        return { status: "found", checkedCandidates, totalCandidates, moreCandidates: totalCandidates > checkedCandidates,
          match };
      } catch (error) {
        if (!(error instanceof WorkerError) || error.status >= 500 || error.status === 429) unavailable = true;
      }
    }
    return { status: unavailable ? "unavailable" : totalCandidates <= limit ? "exhausted" : "none-in-window",
      checkedCandidates, totalCandidates, moreCandidates: totalCandidates > limit, match: null };
  }

  #helperOperationId(sourceWallet, pair) {
    return helperOperationId({ chainId: this.config.settlementChainId, poolAddress: this.poolAddress,
      campaignNumber: this.campaignNumber, relayerAddress: this.relayerWallet.address }, sourceWallet, {
        failedTransactionHash: pair.failedTransactionHash, successfulTransactionHash: pair.successfulTransactionHash,
      });
  }

  #helperMessage({ requester, sourceWallet, pair, operationId, issuedAt, expiresAt }) {
    return formatRecoveryHelperMessage({ origin: this.publicOrigin, poolAddress: this.poolAddress,
      campaignNumber: this.campaignNumber, settlementChainId: this.config.settlementChainId,
      requester, sourceWallet, ...pair, operationId, issuedAt, expiresAt });
  }

  #verifyHelperRequest(request) {
    requireStrictObject(request, "A helper release requires a JSON object.");
    rejectDestinationFields(request);
    requireExactFields(request, ["requester", "sourceWallet", "pair", "operationId", "issuedAt", "expiresAt", "signature"],
      "Helper release accepts only the exact versioned request and signature fields.");
    const requester = requireNonzeroAddress(request.requester, "helper requester");
    const sourceWallet = requireNonzeroAddress(request.sourceWallet, "derived source wallet");
    const pair = normalizeIntakePair(request.pair);
    const operationId = this.#helperOperationId(sourceWallet, pair);
    const issuedAt = requireTimestamp(request.issuedAt, "issuedAt");
    const expiresAt = requireTimestamp(request.expiresAt, "expiresAt");
    if (request.operationId !== operationId || issuedAt > this.now() + this.config.maximumClockSkewSeconds
      || expiresAt !== issuedAt + this.config.challengeLifetimeSeconds || expiresAt < this.now()) {
      throw new WorkerError("RECOVERY_CHALLENGE_INVALID", "This exact helper request is invalid or expired.", 401);
    }
    const normalized = { requester, sourceWallet, pair, operationId, issuedAt, expiresAt };
    try {
      if (!isHexString(request.signature, 65)
        || getAddress(verifyMessage(this.#helperMessage(normalized), request.signature)) !== requester) {
        throw new Error("wrong helper signer");
      }
    } catch (error) {
      throw new WorkerError("RECOVERY_SIGNATURE_INVALID", "The helper signature does not authorize this exact request.", 401, error);
    }
    return normalized;
  }

  async helperRelease(request = {}) {
    this.#requireHelper();
    // No source RPC, proof, or ledger reservation before signature authentication.
    const auth = this.#verifyHelperRequest(request);
    requireDistinctHelper(auth.requester, auth.sourceWallet);
    const context = await this.intakePool.run(() => this.#openPairEligibilityContext(auth.pair, { freshState: true }));
    if (context.wallet !== auth.sourceWallet) {
      throw new WorkerError("RECOVERY_PAIR_WALLET_MISMATCH", "The helper request's source wallet is not independently established by this pair.", 422);
    }
    requireDistinctHelper(auth.requester, context.wallet);
    const existing = await this.#ledger("read", { operationId: auth.operationId });
    if (existing?.operation) return publicHelperOperation(existing.operation);
    if (!context.eligible) throw eligibilityError(publicEligibility(context));
    this.#verifyHelperRequest(request);
    const reservation = await this.#reserveRelease(context, { requester: auth.requester, mode: RECOVERY_HELPER_MODE });
    if (reservation.created) {
      // This promise belongs to the service, not the HTTP connection. A process
      // restart retains its durable reservation and never starts it again.
      let started = false;
      const task = Promise.resolve().then(() => this.#enqueueRelease(() => {
        started = true;
        return this.#runReservedRelease(context, reservation);
      })).catch(async () => {
        if (!started) await this.#ledger("failBeforeBroadcast", { operationId: auth.operationId,
          permitToken: reservation.permitToken, reason: "prebroadcast-failed" }).catch(() => undefined);
      }).finally(() => this.helperOperations.delete(auth.operationId));
      this.helperOperations.set(auth.operationId, task);
    }
    return publicHelperOperation(reservation.operation);
  }

  async helperOperation(operationIdValue) {
    this.#requireHelper();
    const operationId = requireHash(operationIdValue, "helper operation");
    let result = await this.#ledger("read", { operationId });
    if (!result?.operation) throw new WorkerError("RECOVERY_HELPER_NOT_FOUND", "This recovery operation was not found.", 404);
    const operation = result.operation;
    // Reconciliation is GET-only on-chain and never signs, proves, broadcasts,
    // retries, or releases a reservation. It also works after a process restart.
    if (operation.state === "broadcast-prepared" && operation.transactionHash) {
      try {
        const receipt = await this.ccProvider.getTransactionReceipt(operation.transactionHash);
        if (receipt && receipt.hash?.toLowerCase() === operation.transactionHash.toLowerCase()) {
          if (Number(receipt.status) === 1) {
            const context = await this.intakePool.run(() => this.#openPairEligibilityContext(operation.pair, { freshState: true }));
            if (context.wallet !== getAddress(operation.sourceWallet) || context.status !== "claimed"
              || context.release?.transactionHash?.toLowerCase() !== operation.transactionHash.toLowerCase()) {
              throw new Error("release is not independently finalized for this source pair");
            }
            const release = parseReleaseReceipt(receipt, this.poolAddress);
            validateReleaseFields({ release, campaignNumber: this.campaignNumber, wallet: context.wallet,
              creditAmount: context.campaign.creditAmount, actionId: context.pair.actionId, relayer: this.relayerWallet.address,
              failureQueryId: context.release.failureQueryId, successQueryId: context.release.successQueryId,
              pairId: context.release.pairId });
          } else if (Number(receipt.status) !== 0) throw new Error("unknown receipt status");
          await this.#ledger("complete", { operationId, transactionHash: operation.transactionHash,
            receiptStatus: Number(receipt.status), blockNumber: Number(receipt.blockNumber) });
          result = await this.#ledger("read", { operationId });
        }
      } catch { /* Ambiguity remains durable and fail-closed; polling grants no spending. */ }
    }
    return publicHelperOperation(result.operation);
  }

  async #reserveRelease(context, { requester, mode }) {
    this.#assertHelperCampaignPolicy(context.campaign);
    return this.#ledger("reserve", {
      operationId: this.#helperOperationId(context.wallet, context.discovery), requester, mode,
      sourceWallet: context.wallet,
      pair: { failedTransactionHash: context.discovery.failedTransactionHash,
        successfulTransactionHash: context.discovery.successfulTransactionHash },
      maxFeeWei: this.helperMaxFeeWei.toString(),
    });
  }

  #assertHelperCampaignPolicy(campaign) {
    if (campaign.creditAmount.toString() !== this.helperPolicy.limits.creditWei
      || this.helperPolicy.limits.expiresAt > Number(campaign.deadline)) {
      throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", "The durable pilot budget must match the funded credit and end no later than its campaign.", 503);
    }
  }

  async #releaseWithAdmission(context, auth) {
    if (!this.helperLedger) return this.#releaseEligible(context);
    const reservation = await this.#reserveRelease(context, auth);
    if (!reservation.created) throw new WorkerError("RECOVERY_PROCESSING", "This source wallet already has a durable recovery operation; check its status before requesting again.", 409);
    return this.#runReservedRelease(context, reservation);
  }

  async #runReservedRelease(context, reservation) {
    const execution = { operationId: reservation.operation.operationId, permitToken: reservation.permitToken,
      transactionHash: null };
    try {
      const result = await this.#releaseEligible(context, execution);
      if (execution.transactionHash) {
        if (result.release?.transactionHash?.toLowerCase() !== execution.transactionHash.toLowerCase()) {
          throw new WorkerError("RECOVERY_RELEASE_UNVERIFIED", "The source recovered in another transaction; this reserved transaction remains unresolved.", 503);
        }
        await this.#ledger("complete", { operationId: execution.operationId, transactionHash: execution.transactionHash,
          receiptStatus: 1, blockNumber: result.release.blockNumber });
      } else {
        await this.#ledger("failBeforeBroadcast", { operationId: execution.operationId,
          permitToken: execution.permitToken, reason: "eligibility-changed" });
      }
      return result;
    } catch (error) {
      if (!execution.transactionHash) {
        await this.#ledger("failBeforeBroadcast", { operationId: execution.operationId,
          permitToken: execution.permitToken, reason: helperStopReason(error) }).catch(() => undefined);
      }
      throw error;
    }
  }

  async release(request = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new WorkerError(
        "RECOVERY_REQUEST_INVALID",
        "The recovery release body must be a JSON object.",
        400,
      );
    }
    if (
      Object.hasOwn(request, "destination")
      || Object.hasOwn(request, "recipient")
      || Object.hasOwn(request, "beneficiary")
      || Object.hasOwn(request, "payoutAddress")
    ) {
      throw new WorkerError(
        "RECOVERY_DESTINATION_FORBIDDEN",
        "A recovery destination cannot be supplied; the contract derives it from Ethereum.",
        400,
      );
    }
    const allowedFields = new Set(["wallet", "message", "issuedAt", "expiresAt", "signature"]);
    if (Object.keys(request).some((field) => !allowedFields.has(field))) {
      throw new WorkerError(
        "RECOVERY_REQUEST_INVALID",
        "The recovery release accepts only the server-issued consent fields and signature.",
        400,
      );
    }
    const { wallet: walletValue, message, issuedAt, expiresAt, signature } = request;
    const wallet = requireNonzeroAddress(walletValue, "wallet");
    const discovery = this.discoveryByWallet.get(wallet.toLowerCase());
    if (!discovery) {
      throw new WorkerError(
        "RECOVERY_NOT_FOUND",
        "This wallet is not in the closed paid-retry discovery cohort.",
        404,
      );
    }
    this.#verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery, requireMessage: true });
    const flightKey = this.#releaseFlightKey(wallet, discovery);
    return this.#trackReleaseFlight(flightKey, async () => {
      const context = await this.intakePool.run(async () => {
        this.#verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery, requireMessage: true });
        return this.#eligibilityContext(wallet, discovery, { freshState: true });
      });
      if (context.status === "claimed") return publicRelease(context, "claimed");
      if (!context.eligible) throw eligibilityError(publicEligibility(context));
      return this.#enqueueRelease(() => {
        this.#verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery, requireMessage: true });
        return this.#releaseWithAdmission(context, { requester: wallet, mode: "owner" });
      });
    });
  }

  async intakeRelease(request = {}) {
    const normalized = normalizeIntakeReleaseRequest(request);
    const { wallet, pairInput, issuedAt, expiresAt, signature } = normalized;
    const signedPair = { wallet, ...pairInput };

    // This is deliberately first. An invalid or pair-mutated signature must not trigger
    // Ethereum RPC, Attestcoin proof work, or relayer work.
    this.#verifyConsent({ wallet, issuedAt, expiresAt, signature, discovery: signedPair });
    const flightKey = this.#releaseFlightKey(wallet, signedPair);
    return this.#trackReleaseFlight(flightKey, async () => {
      const context = await this.intakePool.run(async () => {
        this.#verifyConsent({ wallet, issuedAt, expiresAt, signature, discovery: signedPair });
        const state = await this.#campaignState({ fresh: true });
        const lineage = await this.#walletLineage(wallet, { campaign: state.campaign });
        if (["claimed-predecessor", "claimed-sponsor"].includes(lineage.status)) {
          throw eligibilityError({
            status: "replayed",
            reason: lineage.status === "claimed-predecessor"
              ? "This source wallet already received a credit from the bound predecessor campaign."
              : "This source wallet already received a credit in this sponsor lineage.",
          });
        }
        if (lineage.status !== "claimed-current") {
          if (!state.releasesUnlocked) {
            throw eligibilityError({
              status: "continuation-waiting",
              reason: "This funded continuation waits for its bound predecessor to close or fill.",
            });
          }
          if (Boolean(state.campaign.remainderRecovered) || this.now() > Number(state.campaign.deadline)) {
            throw eligibilityError({ status: "closed", reason: "The funded recovery campaign has closed." });
          }
          if (Number(state.campaign.claimCount) >= Number(state.campaign.maxClaims)) {
            throw eligibilityError({ status: "full", reason: "The funded recovery campaign has no credits remaining." });
          }
        }
        return this.#openPairEligibilityContext(pairInput, { state });
      });
      if (context.wallet !== wallet) {
        throw new WorkerError(
          "RECOVERY_PAIR_WALLET_MISMATCH",
          "The signed wallet is not the source wallet derived from this Ethereum pair.",
          422,
        );
      }
      if (context.status === "claimed") return publicRelease(context, "claimed");
      if (!context.eligible) throw eligibilityError(publicEligibility(context));
      return this.#enqueueRelease(() => {
        this.#verifyConsent({ wallet, issuedAt, expiresAt, signature, discovery: context.discovery });
        return this.#releaseWithAdmission(context, { requester: wallet, mode: "owner" });
      });
    });
  }

  #challengeFor({ wallet, discovery }) {
    const issuedAt = this.now();
    const expiresAt = issuedAt + this.config.challengeLifetimeSeconds;
    const message = recoveryChallengeMessage({
      origin: this.publicOrigin,
      poolAddress: this.poolAddress,
      campaignNumber: this.campaignNumber,
      wallet,
      failedTransactionHash: discovery.failedTransactionHash,
      successfulTransactionHash: discovery.successfulTransactionHash,
      issuedAt,
      expiresAt,
    });
    return {
      wallet,
      message,
      issuedAt,
      expiresAt,
      campaignNumber: this.campaignNumber,
      poolAddress: this.poolAddress,
      pair: {
        failedTransactionHash: discovery.failedTransactionHash,
        successfulTransactionHash: discovery.successfulTransactionHash,
      },
    };
  }

  #releaseFlightKey(wallet, discovery) {
    return [
      this.poolAddress.toLowerCase(),
      this.campaignNumber,
      wallet.toLowerCase(),
      discovery.failedTransactionHash,
      discovery.successfulTransactionHash,
    ].join(":");
  }

  #trackReleaseFlight(flightKey, operation) {
    const existing = this.releaseFlights.get(flightKey);
    if (existing) return existing;
    let flight;
    flight = Promise.resolve()
      .then(operation)
      .finally(() => {
        if (this.releaseFlights.get(flightKey) === flight) this.releaseFlights.delete(flightKey);
      });
    this.releaseFlights.set(flightKey, flight);
    return flight;
  }

  async #publicEligibility(context) {
    const eligibility = publicEligibility(context);
    if (this.helperLedger) {
      return { ...eligibility, hostedAdmission: await this.#hostedAdmission(context) };
    }
    if (
      eligibility.status === "eligible"
      && this.releaseFlights.has(this.#releaseFlightKey(context.wallet, context.discovery))
    ) {
      return {
        ...eligibility,
        eligible: false,
        status: "processing",
        reason: "A signed release for this exact pair is already being processed.",
      };
    }
    return eligibility;
  }

  #enqueueRelease(operation) {
    if (this.releaseQueueDepth >= this.config.releaseQueueLimit) {
      throw new WorkerError(
        "RECOVERY_BUSY",
        "Recovery release capacity is busy; retry shortly.",
        429,
      );
    }
    this.releaseQueueDepth += 1;
    const queued = this.releaseQueue.then(operation, operation);
    this.releaseQueue = queued.catch(() => undefined);
    return queued.finally(() => {
      this.releaseQueueDepth -= 1;
    });
  }

  async #authenticateInfrastructure() {
    if (this.infrastructurePromise) return this.infrastructurePromise;
    this.infrastructurePromise = this.#authenticateInfrastructureOnce().catch((error) => {
      this.infrastructurePromise = null;
      throw error;
    });
    return this.infrastructurePromise;
  }

  async #authenticateInfrastructureOnce() {
    try {
      if (this.ccProvider?.getNetwork) {
        const network = await this.ccProvider.getNetwork();
        if (Number(network.chainId) !== this.config.settlementChainId) {
          throw new Error(`unexpected Creditcoin chain ${network.chainId}`);
        }
      }
      if (!this.ccProvider || typeof this.ccProvider.getCode !== "function") {
        throw new Error("recovery provider cannot authenticate runtime code");
      }
      const poolCode = await this.ccProvider.getCode(this.poolAddress);
      if (
        typeof poolCode !== "string"
        || poolCode === "0x"
        || keccak256(poolCode) !== this.expectedRuntimeCodeHash
      ) {
        throw new Error("recovery pool runtime code does not match the configured contract version");
      }
      if (requireContractAddress(this.pool) !== this.poolAddress) {
        throw new Error("recovery pool runner is bound to a different address");
      }

      const [verifierValue, predicateValue, chainInfoValue, sourceChainKey, sourceChainId] =
        await Promise.all([
          this.pool.retryVerifier(),
          this.pool.predicate(),
          this.pool.chainInfo(),
          this.pool.SOURCE_CHAIN_KEY(),
          this.pool.SOURCE_CHAIN_ID(),
        ]);
      const verifierAddress = requireNonzeroAddress(verifierValue, "recovery verifier");
      const predicateAddress = requireNonzeroAddress(predicateValue, "recovery predicate");
      if (requireAddress(chainInfoValue, "chain-info precompile") !== CHAIN_INFO) {
        throw new Error("recovery pool is not bound to the native chain-info precompile");
      }
      if (
        Number(sourceChainKey) !== this.config.sourceChainKey
        || Number(sourceChainId) !== this.config.sourceChainId
      ) {
        throw new Error("recovery pool source identity is not Ethereum-mainnet chain key 3");
      }

      this.verifier ??= this.contractFactory(verifierAddress, recoveryVerifierAbi);
      this.predicate ??= this.contractFactory(predicateAddress, seaDropPaidRetryPredicateAbi);
      this.nativeVerifier ??= this.contractFactory(NATIVE_VERIFIER, nativeQueryVerifierAbi);
      if (requireContractAddress(this.verifier) !== verifierAddress) {
        throw new Error("recovery verifier runner is bound to a different address");
      }
      if (requireContractAddress(this.predicate) !== predicateAddress) {
        throw new Error("recovery predicate runner is bound to a different address");
      }
      if (requireContractAddress(this.nativeVerifier) !== NATIVE_VERIFIER) {
        throw new Error("native verifier runner is bound to a different address");
      }

      const [
        verifierPredicate,
        nativeVerifier,
        verifierChainKey,
        verifierChainId,
        predicateChainId,
        seaDrop,
        selector,
        maximumGap,
      ] = await boundedParallel([
        () => this.verifier.predicate(),
        () => this.verifier.verifier(),
        () => this.verifier.SOURCE_CHAIN_KEY(),
        () => this.verifier.SOURCE_CHAIN_ID(),
        () => this.predicate.ETHEREUM_CHAIN_ID(),
        () => this.predicate.SEADROP(),
        () => this.predicate.MINT_SIGNED_SELECTOR(),
        () => this.predicate.MAX_ATTESTCOIN_BATCH_BLOCK_GAP(),
      ]);
      if (requireAddress(verifierPredicate, "verifier predicate") !== predicateAddress) {
        throw new Error("pool and verifier predicate bindings differ");
      }
      if (requireAddress(nativeVerifier, "native verifier") !== NATIVE_VERIFIER) {
        throw new Error("recovery verifier is not bound to Attestcoin's native verifier");
      }
      if (
        Number(verifierChainKey) !== this.config.sourceChainKey
        || Number(verifierChainId) !== this.config.sourceChainId
        || Number(predicateChainId) !== this.config.sourceChainId
      ) {
        throw new Error("verifier or predicate source identity differs from the pool");
      }
      if (requireAddress(seaDrop, "SeaDrop target") !== SEA_DROP_MAINNET) {
        throw new Error("recovery predicate is not bound to canonical Ethereum SeaDrop");
      }
      if (String(selector).toLowerCase() !== MINT_SIGNED_SELECTOR.toLowerCase()) {
        throw new Error("recovery predicate is not bound to mintSigned");
      }
      if (Number(maximumGap) !== 1_000) {
        throw new Error("recovery predicate has an unexpected maximum batch gap");
      }

      const lineage = await this.#authenticateLineage();
      return Object.freeze({ verifierAddress, predicateAddress, lineage });
    } catch (error) {
      if (error instanceof WorkerError && error.code === "RECOVERY_MISCONFIGURED") throw error;
      throw new WorkerError(
        "RECOVERY_MISCONFIGURED",
        "The recovery campaign bindings could not be authenticated.",
        503,
        error,
      );
    }
  }

  async #authenticateLineage() {
    if (this.contractVersion === "v1") {
      return Object.freeze({ scope: "campaign", predecessor: null });
    }

    const [
      poolValue,
      campaignNumberValue,
      sponsorValue,
      termsHashValue,
      bindingHashValue,
      startBlockValue,
      endBlockValue,
      deadlineValue,
    ] = await boundedParallel([
      () => this.pool.legacyPool(),
      () => this.pool.LEGACY_CAMPAIGN_NUMBER(),
      () => this.pool.legacySponsor(),
      () => this.pool.legacyTermsHash(),
      () => this.pool.legacyBindingHash(),
      () => this.pool.legacyStartBlock(),
      () => this.pool.legacyEndBlock(),
      () => this.pool.legacyDeadline(),
    ]);
    const poolAddress = requireNonzeroAddress(poolValue, "predecessor recovery pool");
    const campaignNumber = requirePositiveInteger(
      campaignNumberValue,
      "predecessor recovery campaign number",
    );
    const sponsor = requireNonzeroAddress(sponsorValue, "predecessor recovery sponsor");
    const termsHash = requireNonzeroHash(termsHashValue, "predecessor recovery terms hash");
    requireNonzeroHash(bindingHashValue, "predecessor recovery binding hash");
    const startBlock = requireSafeUint(startBlockValue, "predecessor start block");
    const endBlock = requireSafeUint(endBlockValue, "predecessor end block");
    const deadline = requireSafeUint(deadlineValue, "predecessor deadline");
    if (
      campaignNumber !== 1
      || poolAddress === this.poolAddress
      || startBlock >= endBlock
      || deadline === 0
    ) {
      throw new Error("recovery V2 predecessor lineage is invalid");
    }
    const predecessorCode = await this.ccProvider.getCode(poolAddress);
    if (
      typeof predecessorCode !== "string"
      || predecessorCode === "0x"
      || keccak256(predecessorCode) !== this.expectedPredecessorRuntimeCodeHash
    ) {
      throw new Error("predecessor recovery pool runtime code is not the authenticated V1 release");
    }

    this.predecessorPool ??= this.contractFactory(poolAddress, recoveryCampaignAbiV1);
    if (requireContractAddress(this.predecessorPool) !== poolAddress) {
      throw new Error("predecessor recovery runner is bound to a different address");
    }
    return Object.freeze({
      scope: "sponsor",
      predecessor: Object.freeze({
        poolAddress,
        campaignNumber,
        sponsor,
        termsHash,
        deadline,
        startBlock,
        endBlock,
      }),
    });
  }

  async #campaignState({ fresh = false } = {}) {
    await this.#authenticateInfrastructure();
    if (fresh) return this.#freshCampaignState();
    const cached = this.campaignStateCache;
    if (cached && cached.expiresAt > this.now()) return cached.state;
    const generation = this.campaignStateGeneration;
    const freshFlight = this.campaignStateFlights.fresh;
    if (freshFlight?.generation === generation) return freshFlight.promise;
    const normalFlight = this.campaignStateFlights.normal;
    if (normalFlight?.generation === generation) return normalFlight.promise;
    return this.#startCampaignStateFlight("normal", generation);
  }

  #freshCampaignState() {
    const queued = this.campaignStateFreshQueued;
    if (queued && !queued.started) return queued.promise;

    const active = this.campaignStateFlights.fresh;
    if (!active) return this.#startCampaignStateFlight("fresh");

    const entry = { started: false, promise: null };
    entry.promise = active.promise
      .catch(() => undefined)
      .then(() => {
        entry.started = true;
        if (this.campaignStateFreshQueued === entry) this.campaignStateFreshQueued = null;
        return this.#startCampaignStateFlight("fresh");
      });
    this.campaignStateFreshQueued = entry;
    return entry.promise;
  }

  #startCampaignStateFlight(kind, requestedGeneration) {
    const generation = kind === "fresh"
      ? this.campaignStateGeneration + 1
      : requestedGeneration;
    if (kind === "fresh") {
      // Every active freshness barrier begins after its caller requested one.
      // A burst may join only the single not-yet-started trailing read. The
      // generation prevents older normal or fresh flights from restoring a
      // stale snapshot to the shared cache after this read begins.
      this.campaignStateGeneration = generation;
      this.campaignStateCache = null;
    }

    const entry = { generation, promise: null };
    entry.promise = this.#readCampaignState()
      .then((state) => {
        if (this.campaignStateGeneration === generation) {
          this.campaignStateCache = {
            state,
            expiresAt: this.now() + this.config.campaignStateCacheTtlSeconds,
          };
        }
        return state;
      })
      .finally(() => {
        if (this.campaignStateFlights[kind] === entry) this.campaignStateFlights[kind] = null;
      });
    this.campaignStateFlights[kind] = entry;
    return entry.promise;
  }

  async #readCampaignState() {
    try {
      const [campaign, rule, releasesUnlockedValue] = await Promise.all([
        this.pool.getCampaign(this.campaignNumber),
        this.pool.getRule(this.campaignNumber),
        this.contractVersion === "v2" ? this.pool.releasesUnlocked() : true,
      ]);
      validateCampaign(campaign);
      validateRule(rule);
      validateConfiguredLineage(
        (await this.#authenticateInfrastructure()).lineage,
        campaign,
        rule,
      );
      if (typeof releasesUnlockedValue !== "boolean") {
        throw new Error("recovery release gate did not return a boolean");
      }
      return { campaign, rule, releasesUnlocked: releasesUnlockedValue };
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_STATE_UNAVAILABLE",
        "The funded recovery campaign is temporarily unavailable.",
        503,
        error,
      );
    }
  }

  async #eligibilityContext(wallet, discovery, { state, freshState = false } = {}) {
    const { campaign, rule, releasesUnlocked } = state
      ?? await this.#campaignState({ fresh: freshState });
    const pair = await this.#resolvePair(discovery, rule, { expectedWallet: wallet, campaign });
    const lineage = await this.#walletLineage(wallet, { campaign });
    const blocked = lineageBlockedContext({
      campaignNumber: this.campaignNumber,
      discovery,
      wallet,
      campaign,
      rule,
      pair,
      releasesUnlocked,
      lineage,
    });
    if (blocked) return blocked;
    return this.#eligibilityFromResolved({
      wallet,
      discovery,
      campaign,
      rule,
      pair,
      releasesUnlocked,
      lineage,
    });
  }

  async #openPairEligibilityContext(pairInput, { state, freshState = false, sourcePool } = {}) {
    const { campaign, rule, releasesUnlocked } = state
      ?? await this.#campaignState({ fresh: freshState });
    const pair = await this.#resolvePair(pairInput, rule, { workPool: sourcePool, campaign });
    const wallet = requireNonzeroAddress(pair.claimant, "pair source wallet");
    const discovery = Object.freeze({ wallet, ...pairInput });
    const lineage = await this.#walletLineage(wallet, { campaign });
    const blocked = lineageBlockedContext({
      campaignNumber: this.campaignNumber,
      discovery,
      wallet,
      campaign,
      rule,
      pair,
      releasesUnlocked,
      lineage,
    });
    if (blocked) return blocked;
    return this.#eligibilityFromResolved({
      wallet,
      discovery,
      campaign,
      rule,
      pair,
      releasesUnlocked,
      lineage,
    });
  }

  async #eligibilityFromResolved({
    wallet,
    discovery,
    campaign,
    rule,
    pair,
    releasesUnlocked,
    lineage,
  }) {
    const base = { campaignNumber: this.campaignNumber, discovery, lineage };
    const claimed = lineage.status === "claimed-current";

    if (Boolean(claimed)) {
      const releases = await this.#releaseEvents(wallet);
      const campaignReleases = releases.filter(
        (release) => release.campaignNumber === this.campaignNumber,
      );
      const currentRelease = campaignReleases.find(
        (release) => release.campaignNumber === this.campaignNumber
          && release.actionId === pair.actionId,
      );
      if (!currentRelease) {
        if (campaignReleases.length > 0) {
          throw new WorkerError(
            "RECOVERY_ALREADY_CLAIMED",
            "This source wallet already used its one campaign credit with a different qualified pair.",
            409,
          );
        }
        throw new WorkerError(
          "RECOVERY_STATE_INCONSISTENT",
          "The campaign claim is recorded but its release receipt is unavailable.",
          503,
        );
      }
      const [failureConsumed, successConsumed, pairConsumed] = await Promise.all([
        this.pool.consumedQueries(this.campaignNumber, currentRelease.failureQueryId),
        this.pool.consumedQueries(this.campaignNumber, currentRelease.successQueryId),
        this.pool.consumedPairs(this.campaignNumber, currentRelease.pairId),
      ]);
      const sponsorReplayState = this.contractVersion === "v2"
        ? await Promise.all([
            this.pool.claimedBySponsor(campaign.sponsor, wallet),
            this.pool.consumedQueriesBySponsor(campaign.sponsor, currentRelease.failureQueryId),
            this.pool.consumedQueriesBySponsor(campaign.sponsor, currentRelease.successQueryId),
            this.pool.consumedPairsBySponsor(campaign.sponsor, currentRelease.pairId),
          ])
        : [true, true, true, true];
      if (
        currentRelease.beneficiary !== wallet
        || currentRelease.creditAmount !== campaign.creditAmount.toString()
        || !failureConsumed
        || !successConsumed
        || !pairConsumed
        || sponsorReplayState.some((value) => value !== true)
      ) {
        throw new WorkerError(
          "RECOVERY_STATE_INCONSISTENT",
          "The recorded release does not match the campaign amount, beneficiary, and replay state.",
          503,
        );
      }
      return {
        ...base,
        eligible: false,
        status: "claimed",
        reason: "This campaign credit has already reached the source wallet.",
        wallet,
        campaign,
        rule,
        pair,
        release: currentRelease,
      };
    }
    if (Boolean(campaign.remainderRecovered) || this.now() > Number(campaign.deadline)) {
      return {
        ...base,
        eligible: false,
        status: "closed",
        reason: "The funded recovery campaign has closed.",
        wallet,
        campaign,
        rule,
        pair,
        release: null,
      };
    }
    if (Number(campaign.claimCount) >= Number(campaign.maxClaims)) {
      return {
        ...base,
        eligible: false,
        status: "full",
        reason: "The funded recovery campaign has no credits remaining.",
        wallet,
        campaign,
        rule,
        pair,
        release: null,
      };
    }
    return {
      ...base,
      eligible: true,
      status: "eligible",
      reason: "This source wallet has one live-qualified paid retry in the funded campaign.",
      wallet,
      campaign,
      rule,
      pair,
      release: null,
    };
  }

  async #walletLineage(wallet, { campaign: campaignValue } = {}) {
    try {
      const infrastructure = await this.#authenticateInfrastructure();
      const campaign = campaignValue ?? (await this.#campaignState()).campaign;
      const currentClaimed = requireBooleanState(
        await this.pool.claimedByCampaign(this.campaignNumber, wallet),
        "current campaign claim",
      );
      if (currentClaimed) {
        return Object.freeze({ scope: infrastructure.lineage.scope, status: "claimed-current" });
      }
      if (this.contractVersion === "v1") {
        return Object.freeze({ scope: "campaign", status: "unused" });
      }

      const predecessor = infrastructure.lineage.predecessor;
      const [predecessorClaimedValue, sponsorClaimedValue] = await Promise.all([
        this.predecessorPool.claimedByCampaign(predecessor.campaignNumber, wallet),
        this.pool.claimedBySponsor(campaign.sponsor, wallet),
      ]);
      if (requireBooleanState(predecessorClaimedValue, "predecessor campaign claim")) {
        return Object.freeze({ scope: "sponsor", status: "claimed-predecessor" });
      }
      if (requireBooleanState(sponsorClaimedValue, "sponsor lineage claim")) {
        return Object.freeze({ scope: "sponsor", status: "claimed-sponsor" });
      }
      return Object.freeze({ scope: "sponsor", status: "unused" });
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_STATE_UNAVAILABLE",
        "Recovery lineage state is temporarily unavailable.",
        503,
        error,
      );
    }
  }

  async #resolvePair(pairInput, rule, { expectedWallet = null, workPool = this.sourceLookupPool, campaign } = {}) {
    const identity = Object.freeze({
      failedTransactionHash: requireHash(pairInput.failedTransactionHash, "failed transaction hash"),
      successfulTransactionHash: requireHash(pairInput.successfulTransactionHash, "successful transaction hash"),
    });
    const resolverDiscovery = pairInput.wallet
      ? Object.freeze({ wallet: requireNonzeroAddress(pairInput.wallet, "source wallet"), ...identity })
      : identity;
    const cacheKey = this.#sourcePairCacheKey(identity, rule);
    let summary = this.#readSourcePairCache(cacheKey);
    if (!summary) {
      let flight = this.sourcePairFlights.get(cacheKey);
      if (!flight) {
        flight = workPool.run(async () => {
          try {
            const resolved = this.pairResolver
              ? await this.pairResolver({ discovery: resolverDiscovery, rule: serializeRule(rule) })
              : await resolvePairFromEthereum({
                  discovery: resolverDiscovery,
                  rule,
                  ethereumProviders: this.ethereumProviders,
                  maximumProviderAttempts: this.config.sourceProviderAttempts,
                  diagnosticCampaign: {
                    poolAddress: this.poolAddress,
                    campaignNumber: this.campaignNumber,
                    termsHash: campaign?.termsHash,
                    creditAmount: campaign?.creditAmount?.toString(),
                    deadline: Number(campaign?.deadline),
                  },
                  now: () => this.now() * 1_000,
                });
            validateResolvedPair(resolved, identity, rule);
            this.#writeSourcePairCache(cacheKey, { value: resolved }, this.config.sourcePairCacheTtlSeconds);
            return resolved;
          } catch (error) {
            const handled = error instanceof WorkerError
              ? error
              : new WorkerError(
                  "RECOVERY_PAIR_INVALID",
                  "Live Ethereum facts do not qualify this source pair for the funded rule.",
                  422,
                  error,
                );
            if (handled.code === "RECOVERY_PAIR_INVALID") {
              this.#writeSourcePairCache(
                cacheKey,
                { error: {
                  code: handled.code, message: handled.message, status: handled.status,
                  diagnostics: serializeRecoveryPairDiagnostics(handled.diagnostics),
                } },
                this.config.sourcePairNegativeCacheTtlSeconds,
              );
            }
            throw handled;
          }
        }).finally(() => {
          if (this.sourcePairFlights.get(cacheKey) === flight) this.sourcePairFlights.delete(cacheKey);
        });
        this.sourcePairFlights.set(cacheKey, flight);
      }
      summary = await flight;
    }
    if (expectedWallet && requireAddress(summary.claimant, "pair source wallet") !== expectedWallet) {
      throw new WorkerError(
        "RECOVERY_PAIR_INVALID",
        "Live Ethereum facts do not bind this pair to the requested source wallet.",
        422,
      );
    }
    return summary;
  }

  #sourcePairCacheKey(pairInput, rule) {
    return JSON.stringify([
      this.poolAddress.toLowerCase(),
      this.campaignNumber,
      pairInput.failedTransactionHash,
      pairInput.successfulTransactionHash,
      requireAddress(rule.feeRecipient, "campaign fee recipient").toLowerCase(),
      Number(rule.startBlock),
      Number(rule.endBlock),
      Number(rule.maxBlockGap),
      Number(rule.maxQuantity),
    ]);
  }

  #readSourcePairCache(key) {
    const cached = this.sourcePairCache.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= this.now()) {
      this.sourcePairCache.delete(key);
      return null;
    }
    this.sourcePairCache.delete(key);
    this.sourcePairCache.set(key, cached);
    if (cached.error) {
      const error = new WorkerError(cached.error.code, cached.error.message, cached.error.status);
      const diagnostics = serializeRecoveryPairDiagnostics(cached.error.diagnostics);
      if (diagnostics) error.diagnostics = diagnostics;
      throw error;
    }
    return cached.value;
  }

  #writeSourcePairCache(key, payload, ttlSeconds) {
    this.sourcePairCache.delete(key);
    while (this.sourcePairCache.size >= this.config.sourcePairCacheMaxEntries) {
      const oldest = this.sourcePairCache.keys().next().value;
      this.sourcePairCache.delete(oldest);
    }
    this.sourcePairCache.set(key, { ...payload, expiresAt: this.now() + ttlSeconds });
  }

  async #releaseEvents(wallet) {
    let lastError = null;
    for (const pool of this.releasePools) {
      try {
        const events = await this.#releaseEventsFrom(pool, wallet);
        if (events.length > 0) return events;
      } catch (error) {
        lastError = error;
      }
    }
    if (!lastError) return [];
    if (lastError instanceof WorkerError) throw lastError;
    throw new WorkerError(
      "RECOVERY_STATE_UNAVAILABLE",
      "Recovery release receipts are temporarily unavailable.",
      503,
      lastError,
    );
  }

  async #releaseEventsFrom(pool, wallet) {
    try {
      const filter = pool.filters.CreditReleased(this.campaignNumber, wallet);
      const provider = pool === this.pool ? this.ccProvider : pool.runner?.provider ?? pool.runner;
      if (!provider?.getBlockNumber) throw new Error("recovery receipt reader has no provider");
      const latestBlock = requireSafeUint(
        await provider.getBlockNumber(),
        "latest Creditcoin block number",
      );
      const floor = Math.max(0, latestBlock - this.config.releaseLogLookbackBlocks + 1);
      let toBlock = latestBlock;
      const windows = [];
      while (toBlock >= floor) {
        const fromBlock = Math.max(floor, toBlock - this.config.releaseLogChunkBlocks + 1);
        windows.push([fromBlock, toBlock]);
        if (fromBlock === floor) break;
        toBlock = fromBlock - 1;
      }
      for (let index = 0; index < windows.length; index += this.config.releaseLogConcurrency) {
        const results = await Promise.all(
          windows.slice(index, index + this.config.releaseLogConcurrency)
            .map(([fromBlock, throughBlock]) => pool.queryFilter(filter, fromBlock, throughBlock)),
        );
        for (const events of results) {
          if (events.length > 0) {
            return events.map((event) => serializeReleaseEvent(event, this.poolAddress));
          }
        }
      }
      return [];
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_STATE_UNAVAILABLE",
        "Recovery release receipts are temporarily unavailable.",
        503,
        error,
      );
    }
  }

  #verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery, requireMessage = false }) {
    const issued = requireTimestamp(issuedAt, "issuedAt");
    const expires = requireTimestamp(expiresAt, "expiresAt");
    const now = this.now();
    if (issued > now + this.config.maximumClockSkewSeconds) {
      throw new WorkerError("RECOVERY_CHALLENGE_INVALID", "The recovery challenge is not active yet.", 401);
    }
    if (expires !== issued + this.config.challengeLifetimeSeconds || expires < now) {
      throw new WorkerError("RECOVERY_CHALLENGE_EXPIRED", "The recovery challenge expired; sign a fresh one.", 401);
    }
    const expected = recoveryChallengeMessage({
      origin: this.publicOrigin,
      poolAddress: this.poolAddress,
      campaignNumber: this.campaignNumber,
      wallet,
      failedTransactionHash: discovery.failedTransactionHash,
      successfulTransactionHash: discovery.successfulTransactionHash,
      issuedAt: issued,
      expiresAt: expires,
    });
    if ((requireMessage && typeof message !== "string") || (message !== undefined && message !== expected)) {
      throw new WorkerError(
        "RECOVERY_CHALLENGE_INVALID",
        "The signed recovery consent does not match this origin, campaign, pool, wallet, and pair.",
        401,
      );
    }
    if (typeof signature !== "string" || !isHexString(signature, 65)) {
      throw new WorkerError("RECOVERY_SIGNATURE_INVALID", "A 65-byte wallet signature is required.", 401);
    }
    let signer;
    try {
      signer = verifyMessage(expected, signature);
    } catch (error) {
      throw new WorkerError("RECOVERY_SIGNATURE_INVALID", "The recovery consent signature is invalid.", 401, error);
    }
    if (getAddress(signer) !== wallet) {
      throw new WorkerError(
        "RECOVERY_SIGNATURE_INVALID",
        "The recovery consent was signed by a different source wallet.",
        401,
      );
    }
  }

  async #releaseEligible(context, execution = null) {
    const current = await this.#eligibilityContext(
      context.wallet,
      context.discovery,
      { freshState: true },
    );
    if (current.status === "claimed") return publicRelease(current, "claimed");
    if (!current.eligible) throw eligibilityError(publicEligibility(current));
    context = current;

    let proof;
    try {
      const result = await this.proofBuilder.getBatchProof([
        context.pair.failed.transactionHash,
        context.pair.successful.transactionHash,
      ]);
      if (!result?.success || !result.data) throw new Error("batch proof builder did not return proof data");
      proof = normalizeRecoveryBatchProof(result.data, context.pair);
    } catch (error) {
      if (error instanceof WorkerError && error.status !== 425) throw error;
      throw new WorkerError(
        "RECOVERY_ATTESTATION_PENDING",
        "Attestcoin has not made this exact pair available for release yet.",
        425,
        error,
      );
    }

    let replayIds;
    try {
      const indexes = await Promise.all(
        proof.contractProof.merkleProofs.map((merkleProof) =>
          this.nativeVerifier.calculateTxIndex(merkleProof)),
      );
      if (indexes.some((value, index) => Number(value) !== proof.evidence.transactionIndexes[index])) {
        throw new Error("native transaction indexes differ from the pair-local proof map");
      }
      replayIds = deriveRecoveryReplayIds({
        pair: context.pair,
        sourceBlocks: proof.contractProof.sourceBlocks,
        transactionIndexes: indexes,
      });
      const [failureConsumed, successConsumed, pairConsumed] = await Promise.all([
        this.pool.consumedQueries(this.campaignNumber, replayIds.failureQueryId),
        this.pool.consumedQueries(this.campaignNumber, replayIds.successQueryId),
        this.pool.consumedPairs(this.campaignNumber, replayIds.pairId),
      ]);
      let lineageReplayConsumed = false;
      if (this.contractVersion === "v2") {
        const infrastructure = await this.#authenticateInfrastructure();
        const predecessor = infrastructure.lineage.predecessor;
        const lineageReplayState = await Promise.all([
          this.predecessorPool.consumedQueries(predecessor.campaignNumber, replayIds.failureQueryId),
          this.predecessorPool.consumedQueries(predecessor.campaignNumber, replayIds.successQueryId),
          this.predecessorPool.consumedPairs(predecessor.campaignNumber, replayIds.pairId),
          this.pool.consumedQueriesBySponsor(context.campaign.sponsor, replayIds.failureQueryId),
          this.pool.consumedQueriesBySponsor(context.campaign.sponsor, replayIds.successQueryId),
          this.pool.consumedPairsBySponsor(context.campaign.sponsor, replayIds.pairId),
        ]);
        lineageReplayConsumed = lineageReplayState.some((value) => value === true);
        if (lineageReplayState.some((value) => typeof value !== "boolean")) {
          throw new Error("recovery lineage replay state did not return booleans");
        }
      }
      if (failureConsumed || successConsumed || pairConsumed || lineageReplayConsumed) {
        const raced = await this.#eligibilityContext(
          context.wallet,
          context.discovery,
          { freshState: true },
        );
        if (raced.status === "claimed") return publicRelease(raced, "claimed");
        if (!raced.eligible) throw eligibilityError(publicEligibility(raced));
        throw new WorkerError(
          "RECOVERY_REPLAYED",
          this.contractVersion === "v2"
            ? "This exact recovery proof was already consumed in the bound predecessor or sponsor lineage."
            : "This exact recovery proof was already consumed by this campaign.",
          409,
        );
      }
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_PROOF_INVALID",
        "The native verifier could not bind exact transaction indexes to this recovery.",
        502,
        error,
      );
    }

    try {
      await this.pool.releaseCredit.staticCall(
        this.campaignNumber,
        proof.contractProof,
        { from: this.relayerWallet.address, gasLimit: this.config.releaseGasLimit },
      );
    } catch (error) {
      const raced = await this.#eligibilityContext(
        context.wallet,
        context.discovery,
        { freshState: true },
      );
      if (raced.status === "claimed") return publicRelease(raced, "claimed");
      if (!raced.eligible) throw eligibilityError(publicEligibility(raced));
      throw new WorkerError(
        "RECOVERY_SIMULATION_REJECTED",
        "The immutable campaign contract rejected this release.",
        422,
        error,
      );
    }

    const [beforeBalance, beforeCampaign] = await Promise.all([
      this.ccProvider.getBalance(context.wallet),
      this.pool.getCampaign(this.campaignNumber),
    ]);
    let receipt;
    // Recheck after queueing, proof construction, simulation and balance reads.
    // Keep this outside the ambiguous-broadcast recovery catch: nothing was sent.
    this.beforeBroadcast();
    try {
      const transaction = execution
        ? await this.#broadcastReserved(proof, execution)
        : await this.pool.releaseCredit(
          this.campaignNumber,
          proof.contractProof,
          { gasLimit: this.config.releaseGasLimit },
        );
      receipt = await transaction.wait();
      if (!receipt || Number(receipt.status) !== 1) throw new Error("release transaction failed");
      this.campaignStateGeneration += 1;
      this.campaignStateCache = null;
    } catch (error) {
      if (execution && !execution.transactionHash && error instanceof WorkerError) throw error;
      const raced = await this.#eligibilityContext(
        context.wallet,
        context.discovery,
        { freshState: true },
      );
      if (raced.status === "claimed") return publicRelease(raced, "claimed");
      if (!raced.eligible) throw eligibilityError(publicEligibility(raced));
      throw new WorkerError(
        "RECOVERY_RELEASE_FAILED",
        "The recovery release could not be finalized.",
        503,
        error,
      );
    }

    const release = parseReleaseReceipt(receipt, this.poolAddress);
    validateReleaseFields({
      release,
      campaignNumber: this.campaignNumber,
      wallet: context.wallet,
      creditAmount: context.campaign.creditAmount,
      actionId: context.pair.actionId,
      relayer: this.relayerWallet.address,
      failureQueryId: replayIds.failureQueryId,
      successQueryId: replayIds.successQueryId,
      pairId: replayIds.pairId,
    });
    const [afterBalance, afterCampaign, claimed, failureConsumed, successConsumed, pairConsumed] =
      await Promise.all([
        this.ccProvider.getBalance(context.wallet),
        this.pool.getCampaign(this.campaignNumber),
        this.pool.claimedByCampaign(this.campaignNumber, context.wallet),
        this.pool.consumedQueries(this.campaignNumber, release.failureQueryId),
        this.pool.consumedQueries(this.campaignNumber, release.successQueryId),
        this.pool.consumedPairs(this.campaignNumber, release.pairId),
      ]);
    const sponsorReplayFinalized = this.contractVersion === "v2"
      ? await Promise.all([
          this.pool.claimedBySponsor(context.campaign.sponsor, context.wallet),
          this.pool.consumedQueriesBySponsor(context.campaign.sponsor, release.failureQueryId),
          this.pool.consumedQueriesBySponsor(context.campaign.sponsor, release.successQueryId),
          this.pool.consumedPairsBySponsor(context.campaign.sponsor, release.pairId),
        ])
      : [true, true, true, true];
    const expectedCredit = BigInt(context.campaign.creditAmount);
    if (BigInt(afterBalance) - BigInt(beforeBalance) !== expectedCredit) {
      throw new WorkerError(
        "RECOVERY_RELEASE_UNVERIFIED",
        "The source-wallet balance did not increase by the exact fixed credit.",
        503,
      );
    }
    if (
      !claimed
      || !failureConsumed
      || !successConsumed
      || !pairConsumed
      || sponsorReplayFinalized.some((value) => value !== true)
      || Number(afterCampaign.claimCount) !== Number(beforeCampaign.claimCount) + 1
      || Number(release.claimCount) !== Number(afterCampaign.claimCount)
    ) {
      throw new WorkerError(
        "RECOVERY_RELEASE_UNVERIFIED",
        "The campaign release or replay state did not finalize exactly.",
        503,
      );
    }
    return publicRelease({ ...context, release }, "released");
  }

  async #broadcastReserved(proof, execution) {
    const [network, feeData, latestNonce, pendingNonce] = await Promise.all([
      this.ccProvider.getNetwork(), this.ccProvider.getFeeData(),
      this.ccProvider.getTransactionCount(this.relayerWallet.address, "latest"),
      this.ccProvider.getTransactionCount(this.relayerWallet.address, "pending"),
    ]);
    if (Number(network.chainId) !== this.config.settlementChainId || latestNonce !== pendingNonce
      || !Number.isSafeInteger(pendingNonce) || pendingNonce < 0) {
      throw new WorkerError("RECOVERY_HELPER_NONCE_BUSY", "The relayer has an unresolved transaction; this recovery was not sent.", 503);
    }
    const gasPrice = feeData.gasPrice;
    if (typeof gasPrice !== "bigint" || gasPrice <= 0n) {
      throw new WorkerError("RECOVERY_HELPER_FEE_CAP", "A safe explicit transaction fee is unavailable.", 503);
    }
    const data = new Interface(selectRecoveryCampaignAbi(this.contractVersion)).encodeFunctionData("releaseCredit", [
      this.campaignNumber, proof.contractProof,
    ]);
    const estimate = await this.ccProvider.estimateGas({ from: this.relayerWallet.address, to: this.poolAddress,
      data, value: 0n, gasPrice, nonce: pendingNonce });
    const gasLimit = (BigInt(estimate) * 120n + 99n) / 100n + 25_000n;
    if (gasLimit > BigInt(this.config.releaseGasLimit) || gasLimit * gasPrice > this.helperMaxFeeWei) {
      throw new WorkerError("RECOVERY_HELPER_FEE_CAP", "This transaction exceeds the fixed sponsor fee cap; it was not sent.", 503);
    }
    const rawTransaction = await this.relayerWallet.signTransaction({
      type: 0, chainId: this.config.settlementChainId, to: this.poolAddress,
      data, value: 0n, gasLimit, gasPrice, nonce: pendingNonce,
    });
    const signed = Transaction.from(rawTransaction);
    if (signed.type !== 0 || signed.chainId !== BigInt(this.config.settlementChainId)
      || signed.from !== getAddress(this.relayerWallet.address) || signed.to !== this.poolAddress
      || signed.data !== data || signed.value !== 0n || signed.nonce !== pendingNonce
      || signed.gasLimit !== gasLimit || signed.gasPrice !== gasPrice) {
      throw new WorkerError("RECOVERY_RELEASE_UNVERIFIED", "The signed transaction differs from the exact budgeted recovery.", 503);
    }
    // Set before awaiting persistence: a lost coordinator acknowledgment must
    // never be treated as permission to clear or retry this operation.
    execution.transactionHash = keccak256(rawTransaction);
    const prepared = await this.#ledger("prepareBroadcast", { ...execution, nonce: pendingNonce,
      maxFeeWei: this.helperMaxFeeWei.toString() });
    if (prepared.broadcastPermit !== true) throw new WorkerError("RECOVERY_PROCESSING", "This operation has no fresh one-shot broadcast permit.", 409);
    this.beforeBroadcast();
    const transaction = await this.ccProvider.broadcastTransaction(rawTransaction);
    if (transaction.hash?.toLowerCase() !== execution.transactionHash.toLowerCase()) {
      throw new WorkerError("RECOVERY_RELEASE_UNVERIFIED", "The broadcast response did not match the reserved transaction.", 503);
    }
    return transaction;
  }
}

function helperStopReason(error) {
  if (error?.code === "RECOVERY_ATTESTATION_PENDING") return "proof-unavailable";
  if (error?.code === "RECOVERY_PROOF_INVALID") return "proof-invalid";
  if (error?.code === "RECOVERY_SIMULATION_REJECTED") return "simulation-rejected";
  if (error?.code === "RECOVERY_HELPER_FEE_CAP") return "fee-cap";
  return "prebroadcast-failed";
}

function requireDistinctHelper(requester, sourceWallet) {
  if (requester === sourceWallet) {
    throw new WorkerError("RECOVERY_HELPER_USE_OWNER_FLOW", "This wallet is the credit recipient. Use the owner recovery path instead of a helper request.", 409);
  }
}

function publicHelperOperation(operation) {
  return {
    operationId: operation.operationId,
    state: operation.state,
    mode: operation.mode,
    requester: getAddress(operation.requester),
    sourceWallet: getAddress(operation.sourceWallet),
    pair: { failedTransactionHash: operation.pair.failedTransactionHash,
      successfulTransactionHash: operation.pair.successfulTransactionHash },
    transactionHash: operation.transactionHash ?? null,
    blockNumber: operation.blockNumber ?? null,
    reason: operation.reason ?? null,
    recipientConsent: operation.mode === "owner",
    helperReceivesCredit: false,
  };
}

export function recoveryChallengeMessage({
  origin,
  poolAddress,
  campaignNumber,
  wallet,
  failedTransactionHash,
  successfulTransactionHash,
  issuedAt,
  expiresAt,
}) {
  return formatRecoveryChallengeMessage({
    origin: requireOrigin(origin),
    settlementChainId: RECOVERY_DEFAULTS.settlementChainId,
    poolAddress: requireNonzeroAddress(poolAddress, "recovery pool"),
    campaignNumber: requirePositiveInteger(campaignNumber, "recovery campaign number"),
    wallet: requireNonzeroAddress(wallet, "wallet"),
    failedTransactionHash: requireHash(failedTransactionHash, "failed transaction hash"),
    successfulTransactionHash: requireHash(successfulTransactionHash, "successful transaction hash"),
    issuedAt: requireTimestamp(issuedAt, "issuedAt"),
    expiresAt: requireTimestamp(expiresAt, "expiresAt"),
  });
}

function normalizeIntakePairRequest(request) {
  requireStrictObject(request, "The open-pair intake body must be a JSON object.");
  rejectDestinationFields(request);
  requireExactFields(request, ["pair"], "Open-pair eligibility and challenge accept only the pair field.");
  return normalizeIntakePair(request.pair);
}

function normalizeIntakeReleaseRequest(request) {
  requireStrictObject(request, "The open-pair release body must be a JSON object.");
  rejectDestinationFields(request);
  requireExactFields(
    request,
    ["wallet", "pair", "issuedAt", "expiresAt", "signature"],
    "Open-pair release accepts only the exact pair and hosted-relayer consent fields.",
  );
  return Object.freeze({
    wallet: requireNonzeroAddress(request.wallet, "wallet"),
    pairInput: normalizeIntakePair(request.pair),
    issuedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    signature: request.signature,
  });
}

function normalizeIntakePair(pair) {
  requireStrictObject(pair, "The open-pair intake requires a pair object.");
  rejectDestinationFields(pair);
  requireExactFields(
    pair,
    ["failedTransactionHash", "successfulTransactionHash"],
    "The pair must contain only failedTransactionHash and successfulTransactionHash.",
  );
  let failedTransactionHash;
  let successfulTransactionHash;
  try {
    failedTransactionHash = requireHash(pair.failedTransactionHash, "failed transaction hash");
    successfulTransactionHash = requireHash(pair.successfulTransactionHash, "successful transaction hash");
  } catch (error) {
    throw new WorkerError(
      "RECOVERY_REQUEST_INVALID",
      "Both recovery transaction hashes must be exact 32-byte values.",
      400,
      error,
    );
  }
  if (failedTransactionHash === successfulTransactionHash) {
    throw new WorkerError(
      "RECOVERY_PAIR_INVALID",
      "Failure and completion must be two different Ethereum transactions.",
      422,
    );
  }
  return Object.freeze({ failedTransactionHash, successfulTransactionHash });
}

function requireStrictObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerError("RECOVERY_REQUEST_INVALID", message, 400);
  }
}

function requireExactFields(value, fields, message) {
  const allowed = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((field) => !allowed.has(field))) {
    throw new WorkerError("RECOVERY_REQUEST_INVALID", message, 400);
  }
}

function rejectDestinationFields(value) {
  const forbidden = ["destination", "recipient", "beneficiary", "payoutAddress"];
  if (forbidden.some((field) => Object.hasOwn(value, field))) {
    throw new WorkerError(
      "RECOVERY_DESTINATION_FORBIDDEN",
      "A recovery destination cannot be supplied; the contract derives it from Ethereum.",
      400,
    );
  }
}

export function normalizeRecoveryBatchProof(proof, pair) {
  try {
    if (!proof || Number(proof.chainKey) !== RECOVERY_DEFAULTS.sourceChainKey) {
      throw new Error("batch proof is not for Ethereum-mainnet chain key 3");
    }
    const fromHeader = requireSafeUint(proof.fromHeader, "fromHeader");
    const toHeader = requireSafeUint(proof.toHeader, "toHeader");
    if (fromHeader > toHeader || toHeader - fromHeader > 1_000) {
      throw new Error("batch proof has an invalid shared block range");
    }
    if (!(proof.merkleProofs instanceof Map)) throw new Error("batch merkle proofs must be a Map");
    const expected = new Map([
      [requireHash(pair.failed.transactionHash, "failed transaction hash"), pair.failed],
      [requireHash(pair.successful.transactionHash, "successful transaction hash"), pair.successful],
    ]);
    const found = new Map();
    for (const [sourceBlockValue, perBlock] of proof.merkleProofs.entries()) {
      const sourceBlock = requireSafeUint(sourceBlockValue, "source block");
      if (sourceBlock < fromHeader || sourceBlock > toHeader || !(perBlock instanceof Map)) {
        throw new Error("batch contains an invalid per-block proof map");
      }
      for (const [transactionIndexValue, entry] of perBlock.entries()) {
        const transactionIndex = requireSafeUint(transactionIndexValue, "transaction index");
        const transactionHash = requireHash(entry?.txHash, "proof transaction hash");
        const expectedEntry = expected.get(transactionHash);
        if (!expectedEntry || found.has(transactionHash)) {
          throw new Error("batch contains an unexpected or duplicate transaction");
        }
        if (sourceBlock !== Number(expectedEntry.blockNumber)) {
          throw new Error("proof source block differs from live Ethereum");
        }
        validateMerkleProof(entry.merkleProof);
        if (!isHexString(entry.txBytes) || entry.txBytes === "0x") {
          throw new Error("proof encoded transaction is empty");
        }
        const metadata = decodeAttestedTransaction(entry.txBytes);
        const successful = transactionHash === pair.successful.transactionHash;
        if (
          Number(metadata.transactionType) !== 2
          || requireAddress(metadata.sender, "attested sender") !== pair.claimant
          || requireAddress(metadata.target, "attested target") !== SEA_DROP_MAINNET
          || Number(metadata.nonce) !== Number(expectedEntry.nonce)
          || Number(metadata.receiptStatus) !== (successful ? 1 : 0)
          || metadata.selector.toLowerCase() !== MINT_SIGNED_SELECTOR.toLowerCase()
          || String(metadata.value) !== String(pair.valueWei)
          || (!successful && Number(metadata.logCount) !== 0)
        ) {
          throw new Error("attested transaction envelope differs from the live-qualified pair");
        }
        found.set(transactionHash, {
          sourceBlock,
          transactionIndex,
          encodedTransaction: entry.txBytes,
          merkleProof: entry.merkleProof,
        });
      }
    }
    if (found.size !== 2 || [...expected.keys()].some((hash) => !found.has(hash))) {
      throw new Error("batch must contain exactly the requested pair");
    }
    validateContinuityProof(proof.continuityProof);
    const entries = [found.get(pair.failed.transactionHash), found.get(pair.successful.transactionHash)];
    if (entries[1].sourceBlock <= entries[0].sourceBlock) {
      throw new Error("batch proof order is not failure then success");
    }
    return {
      contractProof: {
        sourceBlocks: entries.map((entry) => entry.sourceBlock),
        encodedTransactions: entries.map((entry) => entry.encodedTransaction),
        merkleProofs: entries.map((entry) => entry.merkleProof),
        lowerEndpointDigest: proof.continuityProof.lowerEndpointDigest,
        continuityRoots: proof.continuityProof.roots,
      },
      evidence: {
        sourceChainKey: RECOVERY_DEFAULTS.sourceChainKey,
        fromBlock: fromHeader,
        toBlock: toHeader,
        transactionIndexes: entries.map((entry) => entry.transactionIndex),
        merkleSiblingCounts: entries.map((entry) => entry.merkleProof.siblings.length),
        continuityRootCount: proof.continuityProof.roots.length,
      },
    };
  } catch (error) {
    if (error instanceof WorkerError && error.code === "RECOVERY_PROOF_INVALID") throw error;
    throw new WorkerError(
      "RECOVERY_PROOF_INVALID",
      "The pair-local Attestcoin batch does not match the live-qualified recovery.",
      502,
      error,
    );
  }
}

export function deriveRecoveryReplayIds({ pair, sourceBlocks, transactionIndexes }) {
  if (!Array.isArray(sourceBlocks) || !Array.isArray(transactionIndexes) || sourceBlocks.length !== 2 || transactionIndexes.length !== 2) {
    throw new WorkerError("RECOVERY_PROOF_INVALID", "A recovery replay identity requires exactly two source positions.", 502);
  }
  const coder = AbiCoder.defaultAbiCoder();
  const queryIds = sourceBlocks.map((sourceBlock, index) => keccak256(coder.encode(
    ["uint64", "uint64", "uint64"],
    [RECOVERY_DEFAULTS.sourceChainKey, requireSafeUint(sourceBlock, "source block"), requireSafeUint(transactionIndexes[index], "transaction index")],
  )));
  return {
    failureQueryId: queryIds[0],
    successQueryId: queryIds[1],
    pairId: keccak256(coder.encode(
      ["bytes32", "uint64", "uint64", "bytes32", "bytes32", "bytes32"],
      [
        id("RETRYCREDIT_SEADROP_RETRY_PAIR_V1"),
        RECOVERY_DEFAULTS.sourceChainKey,
        RECOVERY_DEFAULTS.sourceChainId,
        pair.actionId,
        queryIds[0],
        queryIds[1],
      ],
    )),
  };
}

async function resolvePairFromEthereum({
  discovery,
  rule,
  ethereumProviders,
  maximumProviderAttempts = RECOVERY_DEFAULTS.sourceProviderAttempts,
  diagnosticCampaign,
  now = Date.now,
}) {
  if (!Array.isArray(ethereumProviders) || ethereumProviders.length === 0) {
    throw new WorkerError(
      "RECOVERY_SOURCE_UNAVAILABLE",
      "No Ethereum mainnet provider is configured for recovery validation.",
      503,
    );
  }
  let responsiveProvider = false;
  let incompleteProvider = false;
  let semanticFailure = null;
  let diagnostics = null;
  for (const provider of ethereumProviders.slice(0, maximumProviderAttempts)) {
    try {
      if (provider.getNetwork) {
        const network = await provider.getNetwork();
        if (Number(network.chainId) !== RECOVERY_DEFAULTS.sourceChainId) continue;
      }
      const [failedTransaction, failedReceipt, successfulTransaction, successfulReceipt] =
        await Promise.all([
          provider.getTransaction(discovery.failedTransactionHash),
          provider.getTransactionReceipt(discovery.failedTransactionHash),
          provider.getTransaction(discovery.successfulTransactionHash),
          provider.getTransactionReceipt(discovery.successfulTransactionHash),
        ]);
      const returnedFacts = [failedTransaction, failedReceipt, successfulTransaction, successfulReceipt];
      if (returnedFacts.some(fact => !fact)) {
        // Hosted RPCs can return mined transactions while their receipt backend
        // is unavailable. Missing receipts are not evidence of ineligibility.
        if (Boolean(failedTransaction) !== Boolean(failedReceipt)
          || Boolean(successfulTransaction) !== Boolean(successfulReceipt)) incompleteProvider = true;
        else responsiveProvider = true;
        continue;
      }
      responsiveProvider = true;
      const facts = { failedTransaction, failedReceipt, successfulTransaction, successfulReceipt };
      try {
        if (Number(failedTransaction.type) !== 2 || Number(successfulTransaction.type) !== 2) {
          throw new Error("the funded predicate accepts only EIP-1559 type-2 source transactions");
        }
        const decoded = decodeCanonicalSeaDropMintSigned(
          failedTransaction.data ?? failedTransaction.input,
        );
        const resolved = validateSeaDropRecoveryPair({
          ...facts,
          profile: {
            sourceChainId: RECOVERY_DEFAULTS.sourceChainId,
            seaDrop: SEA_DROP_MAINNET,
            nftContract: decoded.nftContract,
            feeRecipient: decoded.feeRecipient,
            minterIfNotPayer: decoded.minterIfNotPayer,
            quantity: decoded.quantity,
            valueWei: failedTransaction.value,
            mintParams: decoded.mintParams,
            maxBlockGap: Number(rule.maxBlockGap),
            requirePaid: true,
            calldataSuffix: decoded.calldataSuffix,
          },
        });
        validateResolvedPair(resolved, discovery, rule);
        return resolved;
      } catch (error) {
        semanticFailure = error;
        diagnostics = buildRecoveryPairDiagnostics({
          facts,
          pair: discovery,
          rule,
          campaign: diagnosticCampaign,
          now,
        });
        // A complete but stale or inconsistent RPC response is not authoritative;
        // try another configured provider before returning a cached semantic miss.
      }
    } catch {
      // A cohort row never becomes authoritative merely because one RPC fails; try the next RPC.
    }
  }
  if (semanticFailure || (responsiveProvider && !incompleteProvider)) {
    const error = new WorkerError(
      "RECOVERY_PAIR_INVALID",
      "Both exact Ethereum transactions and receipts must form the funded retry rule.",
      422,
      semanticFailure,
    );
    if (diagnostics) error.diagnostics = diagnostics;
    throw error;
  }
  throw new WorkerError(
    "RECOVERY_SOURCE_UNAVAILABLE",
    "Live Ethereum facts for this recovery are temporarily unavailable.",
    503,
  );
}

function validateResolvedPair(pair, discovery, rule) {
  if (!pair || typeof pair !== "object") throw new Error("pair validation returned no summary");
  const claimant = requireAddress(pair.claimant, "pair source wallet");
  if (discovery.wallet && claimant !== requireAddress(discovery.wallet, "requested source wallet")) {
    throw new Error("live pair source wallet differs from discovery");
  }
  if (
    requireHash(pair.failed?.transactionHash, "failed transaction hash")
      !== discovery.failedTransactionHash
    || requireHash(pair.successful?.transactionHash, "successful transaction hash")
      !== discovery.successfulTransactionHash
  ) {
    throw new Error("live pair hashes differ from discovery");
  }
  if (!pair.paid || BigInt(pair.valueWei) <= 0n || BigInt(pair.mintPriceWei) <= 0n) {
    throw new Error("campaign accepts only paid SeaDrop retries");
  }
  if (
    requireAddress(pair.feeRecipient, "pair fee recipient")
      !== requireAddress(rule.feeRecipient, "campaign fee recipient")
    || Number(pair.failed.blockNumber) < Number(rule.startBlock)
    || Number(pair.successful.blockNumber) > Number(rule.endBlock)
    || Number(pair.blockGap) > Number(rule.maxBlockGap)
    || Number(pair.quantity) > Number(rule.maxQuantity)
  ) {
    throw new Error("live pair does not satisfy the immutable campaign rule");
  }
  if (!isHexString(pair.actionId, 32) || pair.actionId === ZERO_BYTES32) {
    throw new Error("pair validation did not derive the contract action ID");
  }
}

function publicEligibility(context) {
  return {
    eligible: context.eligible,
    status: context.status,
    reason: context.reason,
    wallet: context.wallet,
    campaignNumber: context.campaignNumber,
    creditAmount: context.campaign?.creditAmount?.toString() ?? context.creditAmount ?? null,
    pair: context.pair ? serializePair(context.pair) : null,
    release: context.release ?? null,
    lineage: serializeEligibilityLineage(context.lineage),
  };
}

function publicRelease(context, status) {
  return {
    status,
    wallet: context.wallet,
    campaignNumber: context.campaignNumber,
    creditAmount: context.campaign.creditAmount.toString(),
    pair: serializePair(context.pair),
    release: context.release,
    lineage: serializeEligibilityLineage({
      scope: context.lineage.scope,
      status: "claimed-current",
    }),
  };
}

function serializePair(pair) {
  return {
    failedTransactionHash: pair.failed.transactionHash,
    successfulTransactionHash: pair.successful.transactionHash,
    sourceChainId: Number(pair.sourceChainId),
    sourceChainKey: RECOVERY_DEFAULTS.sourceChainKey,
    nftContract: pair.nftContract,
    quantity: String(pair.quantity),
    mintPriceWei: String(pair.mintPriceWei),
    valueWei: String(pair.valueWei),
    failed: {
      blockNumber: Number(pair.failed.blockNumber),
      nonce: Number(pair.failed.nonce),
    },
    successful: {
      blockNumber: Number(pair.successful.blockNumber),
      nonce: Number(pair.successful.nonce),
      mintedTokenIds: [...pair.successful.mintedTokenIds],
    },
  };
}

function serializeCampaign(campaign, now, releasesUnlocked = true) {
  const deadline = Number(campaign.deadline);
  const maxClaims = Number(campaign.maxClaims);
  const claimCount = Number(campaign.claimCount);
  const releaseState = Boolean(campaign.remainderRecovered) || now > deadline
    ? "closed"
    : claimCount >= maxClaims
      ? "full"
      : releasesUnlocked
        ? "release-unlocked"
        : "continuation-waiting";
  return {
    sponsor: getAddress(campaign.sponsor),
    creditAmount: campaign.creditAmount.toString(),
    maxClaims,
    claimCount,
    remainingClaims: Math.max(0, maxClaims - claimCount),
    deadline,
    fundedAmount: campaign.fundedAmount.toString(),
    termsHash: String(campaign.termsHash).toLowerCase(),
    releaseState,
    open: releaseState === "release-unlocked",
  };
}

function serializeConfigurationLineage(lineage, releasesUnlocked) {
  return {
    scope: lineage.scope,
    releasesUnlocked,
    predecessor: lineage.predecessor ? { ...lineage.predecessor } : null,
  };
}

function serializeEligibilityLineage(lineage) {
  if (
    !lineage
    || !["campaign", "sponsor"].includes(lineage.scope)
    || !["unused", "claimed-current", "claimed-predecessor", "claimed-sponsor"]
      .includes(lineage.status)
  ) {
    throw new WorkerError(
      "RECOVERY_STATE_INCONSISTENT",
      "Recovery eligibility lineage is unavailable.",
      503,
    );
  }
  return { scope: lineage.scope, status: lineage.status };
}

function lineageBlockedContext({
  campaignNumber,
  discovery,
  wallet,
  campaign,
  rule,
  pair = null,
  releasesUnlocked,
  lineage,
}) {
  const base = {
    campaignNumber,
    discovery,
    wallet,
    campaign,
    rule,
    pair,
    release: null,
    lineage,
  };
  if (lineage.status === "claimed-predecessor") {
    return {
      ...base,
      eligible: false,
      status: "claimed",
      reason: "This source wallet already received a credit from the bound predecessor campaign.",
    };
  }
  if (lineage.status === "claimed-sponsor") {
    return {
      ...base,
      eligible: false,
      status: "claimed",
      reason: "This source wallet already received a credit in this sponsor lineage.",
    };
  }
  if (!releasesUnlocked && lineage.status !== "claimed-current") {
    return {
      ...base,
      eligible: false,
      status: "continuation-waiting",
      reason: "This funded continuation waits for its bound predecessor to close or fill.",
    };
  }
  return null;
}

function serializeRule(rule) {
  return {
    feeRecipient: getAddress(rule.feeRecipient),
    startBlock: Number(rule.startBlock),
    endBlock: Number(rule.endBlock),
    maxBlockGap: Number(rule.maxBlockGap),
    maxQuantity: Number(rule.maxQuantity),
  };
}

function serializeCapacity(campaign) {
  const total = Number(campaign.maxClaims);
  const claimed = Number(campaign.claimCount);
  return { total, claimed, remaining: Math.max(0, total - claimed) };
}

function serializeReleaseEvent(event, expectedPool) {
  if (requireAddress(event.address, "release emitter") !== expectedPool || !event.args) {
    throw new WorkerError(
      "RECOVERY_STATE_INCONSISTENT",
      "A recovery release receipt was not emitted by the configured pool.",
      503,
    );
  }
  return {
    transactionHash: requireHash(
      event.transactionHash ?? event.log?.transactionHash,
      "release transaction hash",
    ),
    blockNumber: requireSafeUint(event.blockNumber ?? event.log?.blockNumber, "release block number"),
    campaignNumber: Number(event.args.campaignNumber),
    beneficiary: getAddress(event.args.beneficiary),
    actionId: requireHash(event.args.actionId, "release action ID"),
    creditAmount: event.args.creditAmount.toString(),
    failureQueryId: requireHash(event.args.failureQueryId, "failure query ID"),
    successQueryId: requireHash(event.args.successQueryId, "success query ID"),
    pairId: requireHash(event.args.pairId, "release pair ID"),
    relayer: getAddress(event.args.relayer),
    claimCount: Number(event.args.claimCount),
  };
}

function parseReleaseReceipt(receipt, poolAddress) {
  const iface = new Interface(recoveryCampaignAbi);
  const events = [];
  for (const log of receipt.logs ?? []) {
    if (requireAddress(log.address, "receipt log emitter") !== poolAddress) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "CreditReleased") {
        events.push(serializeReleaseEvent({
          address: log.address,
          transactionHash: receipt.hash ?? receipt.transactionHash,
          blockNumber: receipt.blockNumber,
          args: parsed.args,
        }, poolAddress));
      }
    } catch {
      // Other exact-pool events do not satisfy the required release receipt.
    }
  }
  if (events.length !== 1) {
    throw new WorkerError(
      "RECOVERY_RELEASE_UNVERIFIED",
      "The configured pool did not emit exactly one recovery release.",
      503,
    );
  }
  return events[0];
}

function validateReleaseFields({
  release,
  campaignNumber,
  wallet,
  creditAmount,
  actionId,
  relayer,
  failureQueryId,
  successQueryId,
  pairId,
}) {
  if (
    release.campaignNumber !== campaignNumber
    || release.beneficiary !== wallet
    || release.creditAmount !== creditAmount.toString()
    || release.actionId !== actionId
    || release.relayer !== getAddress(relayer)
    || release.failureQueryId !== failureQueryId
    || release.successQueryId !== successQueryId
    || release.pairId !== pairId
    || release.failureQueryId === release.successQueryId
  ) {
    throw new WorkerError(
      "RECOVERY_RELEASE_UNVERIFIED",
      "The release receipt does not match the campaign, pair, recipient, amount, and relayer.",
      503,
    );
  }
}

function eligibilityError(eligibility) {
  const codes = {
    "not-found": ["RECOVERY_NOT_FOUND", 404],
    claimed: ["RECOVERY_ALREADY_CLAIMED", 409],
    processing: ["RECOVERY_RELEASE_PENDING", 425],
    "continuation-waiting": ["RECOVERY_CONTINUATION_WAITING", 425],
    closed: ["RECOVERY_CLOSED", 409],
    full: ["RECOVERY_FULL", 409],
    replayed: ["RECOVERY_REPLAYED", 409],
  };
  const [code, status] = codes[eligibility.status] ?? ["RECOVERY_NOT_ELIGIBLE", 422];
  return new WorkerError(code, eligibility.reason, status);
}

function validateConfiguredLineage(lineage, campaign, rule) {
  if (lineage.scope === "campaign") {
    if (lineage.predecessor !== null) throw new Error("V1 recovery cannot expose a predecessor");
    return;
  }
  const predecessor = lineage.predecessor;
  if (
    lineage.scope !== "sponsor"
    || !predecessor
    || predecessor.sponsor !== getAddress(campaign.sponsor)
    || predecessor.deadline >= Number(campaign.deadline)
    || predecessor.startBlock < Number(rule.startBlock)
    || predecessor.endBlock > Number(rule.endBlock)
  ) {
    throw new Error("configured campaign does not match its V2 predecessor lineage");
  }
}

function validateCampaign(campaign) {
  const creditAmount = BigInt(campaign.creditAmount);
  const maxClaims = Number(campaign.maxClaims);
  const claimCount = Number(campaign.claimCount);
  if (
    getAddress(campaign.sponsor) === ZeroAddress
    || creditAmount <= 0n
    || !Number.isSafeInteger(maxClaims)
    || maxClaims <= 0
    || !Number.isSafeInteger(claimCount)
    || claimCount < 0
    || claimCount > maxClaims
    || BigInt(campaign.fundedAmount) !== creditAmount * BigInt(maxClaims)
    || !isHexString(campaign.termsHash, 32)
    || campaign.termsHash === ZERO_BYTES32
  ) {
    throw new Error("campaign state is not a complete immutable fixed-credit campaign");
  }
}

function validateRule(rule) {
  if (
    getAddress(rule.feeRecipient) === ZeroAddress
    || Number(rule.startBlock) >= Number(rule.endBlock)
    || Number(rule.maxBlockGap) <= 0
    || Number(rule.maxBlockGap) > 1_000
    || Number(rule.maxQuantity) <= 0
  ) {
    throw new Error("campaign rule is invalid");
  }
}

function normalizeDiscoveryIndex(index) {
  if (!Array.isArray(index) || index.length !== 3) {
    throw new Error("the recovery discovery index must contain exactly three paid source wallets");
  }
  const wallets = new Set();
  const hashes = new Set();
  return Object.freeze(index.map((entry) => {
    const normalized = Object.freeze({
      wallet: requireNonzeroAddress(entry.wallet, "discovery wallet"),
      failedTransactionHash: requireHash(entry.failedTransactionHash, "failed transaction hash"),
      successfulTransactionHash: requireHash(entry.successfulTransactionHash, "successful transaction hash"),
    });
    const walletKey = normalized.wallet.toLowerCase();
    if (wallets.has(walletKey)) throw new Error("discovery wallets must be unique");
    if (
      normalized.failedTransactionHash === normalized.successfulTransactionHash
      || hashes.has(normalized.failedTransactionHash)
      || hashes.has(normalized.successfulTransactionHash)
    ) {
      throw new Error("discovery transaction hashes must be unique ordered pairs");
    }
    wallets.add(walletKey);
    hashes.add(normalized.failedTransactionHash);
    hashes.add(normalized.successfulTransactionHash);
    return normalized;
  }));
}

function validateMerkleProof(proof) {
  if (!proof || !isHexString(proof.root, 32) || !Array.isArray(proof.siblings)) {
    throw new Error("invalid transaction merkle proof");
  }
  for (const sibling of proof.siblings) {
    if (!isHexString(sibling.hash, 32) || typeof sibling.isLeft !== "boolean") {
      throw new Error("invalid transaction merkle sibling");
    }
  }
}

function validateContinuityProof(proof) {
  if (!proof || !isHexString(proof.lowerEndpointDigest, 32) || !Array.isArray(proof.roots)) {
    throw new Error("invalid continuity proof");
  }
  if (proof.roots.some((root) => !isHexString(root, 32))) {
    throw new Error("invalid continuity proof root");
  }
}

function requireContractAddress(contract) {
  return requireAddress(contract?.target ?? contract?.address, "contract runner");
}

function requireAddress(value, label) {
  try {
    return getAddress(value);
  } catch (error) {
    throw new Error(`${label} is not a valid address`, { cause: error });
  }
}

function requireNonzeroAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch (error) {
    throw new WorkerError("INVALID_ADDRESS", `Invalid ${label}.`, 400, error);
  }
  if (address === ZeroAddress) throw new WorkerError("INVALID_ADDRESS", `${label} must be nonzero.`, 400);
  return address;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new Error(`${label} must be 32 bytes`);
  }
  return value.toLowerCase();
}

function requireNonzeroHash(value, label) {
  const hash = requireHash(value, label);
  if (hash === ZERO_BYTES32) throw new Error(`${label} must be nonzero`);
  return hash;
}

function requireBooleanState(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requireRecoveryContractVersion(value = "v1") {
  if (typeof value !== "string" || !RECOVERY_CONTRACT_VERSIONS.has(value)) {
    throw new WorkerError(
      "INVALID_RECOVERY_CONFIGURATION",
      "Recovery contractVersion must be exactly v1 or v2.",
      500,
    );
  }
  return value;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", `${label} must be a positive integer.`, 500);
  }
  return parsed;
}

function requireBoundedInteger(value, label, { minimum, maximum }) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new WorkerError(
      "INVALID_RECOVERY_CONFIGURATION",
      `${label} must be an integer from ${minimum} through ${maximum}.`,
      500,
    );
  }
  return parsed;
}

function requireSafeUint(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a safe uint`);
  return parsed;
}

async function boundedParallel(tasks, concurrency = 4) {
  const values = [];
  for (let index = 0; index < tasks.length; index += concurrency) {
    values.push(...await Promise.all(tasks.slice(index, index + concurrency).map((task) => task())));
  }
  return values;
}

function requireTimestamp(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkerError("RECOVERY_CHALLENGE_INVALID", `${label} must be a positive Unix timestamp.`, 401);
  }
  return parsed;
}

function requireOrigin(value) {
  try {
    return new URL(value).origin;
  } catch (error) {
    throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", "The public recovery origin is invalid.", 500, error);
  }
}

class BoundedWorkPool {
  constructor({ concurrency, queueLimit, timeoutMs, busyError, timeoutError }) {
    this.concurrency = concurrency;
    this.queueLimit = queueLimit;
    this.timeoutMs = timeoutMs;
    this.busyError = busyError;
    this.timeoutError = timeoutError;
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      if (this.active >= this.concurrency && this.queue.length >= this.queueLimit) {
        reject(this.busyError());
        return;
      }
      const entry = {
        task,
        resolve,
        reject,
        callerSettled: false,
        started: false,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        if (entry.callerSettled) return;
        entry.callerSettled = true;
        if (!entry.started) {
          const queuedIndex = this.queue.indexOf(entry);
          if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        }
        entry.reject(this.timeoutError());
      }, this.timeoutMs);
      if (this.active < this.concurrency) {
        this.#start(entry);
        return;
      }
      this.queue.push(entry);
    });
  }

  #start(entry) {
    if (entry.callerSettled) {
      clearTimeout(entry.timer);
      return;
    }
    entry.started = true;
    this.active += 1;

    Promise.resolve()
      .then(entry.task)
      .then(
        (value) => {
          if (entry.callerSettled) return;
          entry.callerSettled = true;
          entry.resolve(value);
        },
        (error) => {
          if (entry.callerSettled) return;
          entry.callerSettled = true;
          entry.reject(error);
        },
      )
      .finally(() => {
        clearTimeout(entry.timer);
        this.active -= 1;
        let next = this.queue.shift();
        while (next?.callerSettled) next = this.queue.shift();
        if (next) this.#start(next);
      });
  }
}
