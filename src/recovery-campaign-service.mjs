import {
  AbiCoder,
  Contract,
  Interface,
  JsonRpcProvider,
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
  recoveryVerifierAbi,
  nativeQueryVerifierAbi,
  seaDropPaidRetryPredicateAbi,
} from "./pool-abi.mjs";
import { WorkerError, decodeAttestedTransaction } from "./proof-worker.mjs";
import {
  MINT_SIGNED_SELECTOR,
  SEA_DROP_MAINNET,
  decodeCanonicalSeaDropMintSigned,
  validateSeaDropRecoveryPair,
} from "./seadrop-recovery.mjs";

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
  challengeLifetimeSeconds: 5 * 60,
  maximumClockSkewSeconds: 30,
  proofTimeoutMs: 120_000,
  releaseGasLimit: 6_000_000n,
  releaseLogChunkBlocks: 10_000,
  releaseLogLookbackBlocks: 250_000,
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

export class RecoveryCampaignService {
  static fromPrivateKey({
    privateKey,
    poolAddress,
    campaignNumber,
    creditcoinRpc = DEFAULT_CREDITCOIN_RPC,
    proofBuilderUrl = DEFAULT_PROOF_BUILDER,
    ethereumRpcUrls = DEFAULT_ETHEREUM_RPCS,
    publicOrigin,
    ...options
  }) {
    const ccProvider = new JsonRpcProvider(
      creditcoinRpc,
      RECOVERY_DEFAULTS.settlementChainId,
      { staticNetwork: true },
    );
    const relayerWallet = new Wallet(privateKey, ccProvider);
    const ethereumProviders = ethereumRpcUrls.map(
      (url) => new JsonRpcProvider(url, RECOVERY_DEFAULTS.sourceChainId, { staticNetwork: true }),
    );
    const normalizedPool = requireNonzeroAddress(poolAddress, "recovery pool");
    const poolContract = new Contract(normalizedPool, recoveryCampaignAbi, relayerWallet);
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
      poolContract,
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
    verifierContract,
    predicateContract,
    nativeVerifierContract,
    contractFactory = (address, abi) => new Contract(address, abi, ccProvider),
    discoveryIndex = RECOVERY_DISCOVERY_INDEX,
    pairResolver,
    now = () => Math.floor(Date.now() / 1000),
    config = {},
  }) {
    this.poolAddress = requireNonzeroAddress(poolAddress, "recovery pool");
    this.campaignNumber = requirePositiveInteger(campaignNumber, "recovery campaign number");
    this.ccProvider = ccProvider;
    this.relayerWallet = relayerWallet;
    this.ethereumProviders = ethereumProviders;
    this.proofBuilder = proofBuilder;
    this.publicOrigin = requireOrigin(publicOrigin);
    this.pool = poolContract ?? new Contract(this.poolAddress, recoveryCampaignAbi, relayerWallet);
    this.verifier = verifierContract ?? null;
    this.predicate = predicateContract ?? null;
    this.nativeVerifier = nativeVerifierContract ?? null;
    this.contractFactory = contractFactory;
    this.discoveryIndex = normalizeDiscoveryIndex(discoveryIndex);
    this.discoveryByWallet = new Map(
      this.discoveryIndex.map((entry) => [entry.wallet.toLowerCase(), entry]),
    );
    this.pairResolver = pairResolver;
    this.now = now;
    const mergedConfig = { ...RECOVERY_DEFAULTS, ...config };
    const releaseLogChunkBlocks = requirePositiveInteger(
      mergedConfig.releaseLogChunkBlocks,
      "release log chunk blocks",
    );
    const releaseLogLookbackBlocks = requirePositiveInteger(
      mergedConfig.releaseLogLookbackBlocks,
      "release log lookback blocks",
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
    this.config = { ...mergedConfig, releaseLogChunkBlocks, releaseLogLookbackBlocks };
    this.infrastructurePromise = null;
    this.releaseFlights = new Map();
    this.releaseQueue = Promise.resolve();
  }

  async readiness() {
    const infrastructure = await this.#authenticateInfrastructure();
    await this.#readCampaignState();
    return infrastructure;
  }

  async configuration() {
    const [infrastructure, state] = await Promise.all([
      this.#authenticateInfrastructure(),
      this.#campaignState(),
    ]);
    return {
      enabled: true,
      waking: false,
      source: {
        name: "Ethereum Mainnet",
        chainId: this.config.sourceChainId,
        chainKey: this.config.sourceChainKey,
      },
      settlement: {
        name: "Creditcoin Testnet",
        chainId: this.config.settlementChainId,
      },
      poolAddress: this.poolAddress,
      verifierAddress: infrastructure.verifierAddress,
      predicateAddress: infrastructure.predicateAddress,
      campaignNumber: this.campaignNumber,
      campaign: serializeCampaign(state.campaign, this.now()),
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
      };
    }

    const context = await this.#eligibilityContext(wallet, discovery);
    return publicEligibility(context);
  }

  async challenge(walletValue) {
    const eligibility = await this.eligibility(walletValue);
    if (!eligibility.eligible) throw eligibilityError(eligibility);
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
    };
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
    const context = await this.#eligibilityContext(wallet, discovery);
    this.#verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery });
    if (context.status === "claimed") return publicRelease(context, "claimed");
    if (!context.eligible) throw eligibilityError(publicEligibility(context));

    const flightKey = wallet.toLowerCase();
    const existingFlight = this.releaseFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    const flight = this.#enqueueRelease(() => this.#releaseEligible(context)).finally(() => {
      if (this.releaseFlights.get(flightKey) === flight) this.releaseFlights.delete(flightKey);
    });
    this.releaseFlights.set(flightKey, flight);
    return flight;
  }

  #enqueueRelease(operation) {
    const queued = this.releaseQueue.then(operation, operation);
    this.releaseQueue = queued.catch(() => undefined);
    return queued;
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
      if (this.ccProvider?.getCode) {
        const poolCode = await this.ccProvider.getCode(this.poolAddress);
        if (!poolCode || poolCode === "0x") throw new Error("recovery pool has no deployed code");
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
      ] = await Promise.all([
        this.verifier.predicate(),
        this.verifier.verifier(),
        this.verifier.SOURCE_CHAIN_KEY(),
        this.verifier.SOURCE_CHAIN_ID(),
        this.predicate.ETHEREUM_CHAIN_ID(),
        this.predicate.SEADROP(),
        this.predicate.MINT_SIGNED_SELECTOR(),
        this.predicate.MAX_ATTESTCOIN_BATCH_BLOCK_GAP(),
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

      return Object.freeze({ verifierAddress, predicateAddress });
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_MISCONFIGURED",
        "The recovery campaign bindings could not be authenticated.",
        503,
        error,
      );
    }
  }

  async #campaignState() {
    await this.#authenticateInfrastructure();
    return this.#readCampaignState();
  }

  async #readCampaignState() {
    try {
      const [campaign, rule] = await Promise.all([
        this.pool.getCampaign(this.campaignNumber),
        this.pool.getRule(this.campaignNumber),
      ]);
      validateCampaign(campaign);
      validateRule(rule);
      return { campaign, rule };
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

  async #eligibilityContext(wallet, discovery) {
    const base = { campaignNumber: this.campaignNumber, discovery };
    const { campaign, rule } = await this.#campaignState();
    const pair = await this.#resolvePair(discovery, rule);
    const claimed = await this.pool.claimedByCampaign(this.campaignNumber, wallet);

    if (Boolean(claimed)) {
      const releases = await this.#releaseEvents(wallet);
      const currentRelease = releases.find(
        (release) => release.campaignNumber === this.campaignNumber
          && release.actionId === pair.actionId,
      );
      if (!currentRelease) {
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
      if (
        currentRelease.beneficiary !== wallet
        || currentRelease.creditAmount !== campaign.creditAmount.toString()
        || !failureConsumed
        || !successConsumed
        || !pairConsumed
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

  async #resolvePair(discovery, rule) {
    let summary;
    try {
      summary = this.pairResolver
        ? await this.pairResolver({ discovery, rule: serializeRule(rule) })
        : await resolvePairFromEthereum({
            discovery,
            rule,
            ethereumProviders: this.ethereumProviders,
          });
      validateResolvedPair(summary, discovery, rule);
      return summary;
    } catch (error) {
      if (error instanceof WorkerError) throw error;
      throw new WorkerError(
        "RECOVERY_PAIR_INVALID",
        "Live Ethereum facts do not qualify this discovery pair for the funded rule.",
        422,
        error,
      );
    }
  }

  async #releaseEvents(wallet) {
    try {
      const filter = this.pool.filters.CreditReleased(this.campaignNumber, wallet);
      const latestBlock = requireSafeUint(
        await this.ccProvider.getBlockNumber(),
        "latest Creditcoin block number",
      );
      const floor = Math.max(0, latestBlock - this.config.releaseLogLookbackBlocks + 1);
      let toBlock = latestBlock;

      while (toBlock >= floor) {
        const fromBlock = Math.max(floor, toBlock - this.config.releaseLogChunkBlocks + 1);
        const events = await this.pool.queryFilter(filter, fromBlock, toBlock);
        if (events.length > 0) {
          return events.map((event) => serializeReleaseEvent(event, this.poolAddress));
        }
        if (fromBlock === floor) break;
        toBlock = fromBlock - 1;
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

  #verifyConsent({ wallet, message, issuedAt, expiresAt, signature, discovery }) {
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
    if (message !== expected) {
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

  async #releaseEligible(context) {
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
      if (failureConsumed || successConsumed || pairConsumed) {
        const raced = await this.#eligibilityContext(context.wallet, context.discovery);
        if (raced.status === "claimed") return publicRelease(raced, "claimed");
        throw new WorkerError(
          "RECOVERY_REPLAYED",
          "This exact recovery proof was already consumed by this campaign.",
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
      const raced = await this.#eligibilityContext(context.wallet, context.discovery);
      if (raced.status === "claimed") return publicRelease(raced, "claimed");
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
    try {
      const transaction = await this.pool.releaseCredit(
        this.campaignNumber,
        proof.contractProof,
        { gasLimit: this.config.releaseGasLimit },
      );
      receipt = await transaction.wait();
      if (!receipt || Number(receipt.status) !== 1) throw new Error("release transaction failed");
    } catch (error) {
      const raced = await this.#eligibilityContext(context.wallet, context.discovery);
      if (raced.status === "claimed") return publicRelease(raced, "claimed");
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
  return [
    "RetryCredit recovery consent",
    `Origin: ${requireOrigin(origin)}`,
    `Settlement: Creditcoin Testnet (${RECOVERY_DEFAULTS.settlementChainId})`,
    `Recovery pool: ${requireNonzeroAddress(poolAddress, "recovery pool")}`,
    `Campaign: ${requirePositiveInteger(campaignNumber, "recovery campaign number")}`,
    `Source wallet and credit recipient: ${requireNonzeroAddress(wallet, "wallet")}`,
    `Failed Ethereum transaction: ${requireHash(failedTransactionHash, "failed transaction hash")}`,
    `Successful Ethereum transaction: ${requireHash(successfulTransactionHash, "successful transaction hash")}`,
    `Issued at: ${requireTimestamp(issuedAt, "issuedAt")}`,
    `Expires at: ${requireTimestamp(expiresAt, "expiresAt")}`,
    "Authorize proof and relayer submission for this exact pair. The campaign contract derives the credit recipient from Ethereum; no destination can be substituted.",
  ].join("\n");
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

async function resolvePairFromEthereum({ discovery, rule, ethereumProviders }) {
  if (!Array.isArray(ethereumProviders) || ethereumProviders.length === 0) {
    throw new WorkerError(
      "RECOVERY_SOURCE_UNAVAILABLE",
      "No Ethereum mainnet provider is configured for recovery validation.",
      503,
    );
  }
  let facts;
  for (const provider of ethereumProviders) {
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
      if (failedTransaction && failedReceipt && successfulTransaction && successfulReceipt) {
        facts = { failedTransaction, failedReceipt, successfulTransaction, successfulReceipt };
        break;
      }
    } catch {
      // A cohort row never becomes authoritative merely because one RPC fails; try the next RPC.
    }
  }
  if (!facts) {
    throw new WorkerError(
      "RECOVERY_SOURCE_UNAVAILABLE",
      "Live Ethereum facts for this recovery are temporarily unavailable.",
      503,
    );
  }
  if (Number(facts.failedTransaction.type) !== 2 || Number(facts.successfulTransaction.type) !== 2) {
    throw new Error("the funded predicate accepts only EIP-1559 type-2 source transactions");
  }
  const decoded = decodeCanonicalSeaDropMintSigned(
    facts.failedTransaction.data ?? facts.failedTransaction.input,
  );
  return validateSeaDropRecoveryPair({
    ...facts,
    profile: {
      sourceChainId: RECOVERY_DEFAULTS.sourceChainId,
      seaDrop: SEA_DROP_MAINNET,
      nftContract: decoded.nftContract,
      feeRecipient: decoded.feeRecipient,
      minterIfNotPayer: decoded.minterIfNotPayer,
      quantity: decoded.quantity,
      valueWei: facts.failedTransaction.value,
      mintParams: decoded.mintParams,
      maxBlockGap: Number(rule.maxBlockGap),
      requirePaid: true,
      calldataSuffix: decoded.calldataSuffix,
    },
  });
}

function validateResolvedPair(pair, discovery, rule) {
  if (!pair || typeof pair !== "object") throw new Error("pair validation returned no summary");
  if (requireAddress(pair.claimant, "pair source wallet") !== discovery.wallet) {
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

function serializeCampaign(campaign, now) {
  const deadline = Number(campaign.deadline);
  const maxClaims = Number(campaign.maxClaims);
  const claimCount = Number(campaign.claimCount);
  return {
    sponsor: getAddress(campaign.sponsor),
    creditAmount: campaign.creditAmount.toString(),
    maxClaims,
    claimCount,
    remainingClaims: Math.max(0, maxClaims - claimCount),
    deadline,
    fundedAmount: campaign.fundedAmount.toString(),
    termsHash: String(campaign.termsHash).toLowerCase(),
    open: !campaign.remainderRecovered && now <= deadline && claimCount < maxClaims,
  };
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
    closed: ["RECOVERY_CLOSED", 409],
    full: ["RECOVERY_FULL", 409],
    replayed: ["RECOVERY_REPLAYED", 409],
  };
  const [code, status] = codes[eligibility.status] ?? ["RECOVERY_NOT_ELIGIBLE", 422];
  return new WorkerError(code, eligibility.reason, status);
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

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WorkerError("INVALID_RECOVERY_CONFIGURATION", `${label} must be a positive integer.`, 500);
  }
  return parsed;
}

function requireSafeUint(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a safe uint`);
  return parsed;
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
