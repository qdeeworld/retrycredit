import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Wallet,
  Transaction,
  ZeroAddress,
  getAddress,
  id,
  keccak256,
  parseEther,
} from "ethers";

import {
  RECOVERY_DISCOVERY_INDEX,
  RECOVERY_RELAYER_ROLE,
  RECOVERY_RUNTIME_CODE_HASHES,
  RecoveryCampaignService,
  deriveRecoveryReplayIds,
  normalizeRecoveryBatchProof,
  recoveryChallengeMessage,
} from "../src/recovery-campaign-service.mjs";
import { deriveRoleKey } from "../src/role-key.mjs";
import {
  recoveryCampaignAbi,
  recoveryCampaignAbiV1,
  recoveryCampaignAbiV2,
  selectRecoveryCampaignAbi,
} from "../src/pool-abi.mjs";
import { MINT_SIGNED_SELECTOR, SEA_DROP_MAINNET, SEA_DROP_INTERFACE } from "../src/seadrop-recovery.mjs";
import { WorkerError } from "../src/proof-worker.mjs";
import { isRetryableRecoveryStartupError } from "../src/recovery-startup-lifecycle.mjs";
import { formatRecoveryHelperMessage } from "../src/recovery-helper-consent.mjs";

const source = new Wallet(`0x${"a1".repeat(32)}`);
const secondSource = new Wallet(`0x${"a2".repeat(32)}`);
const thirdSource = new Wallet(`0x${"a3".repeat(32)}`);
const outsider = new Wallet(`0x${"a4".repeat(32)}`);
const relayer = new Wallet(`0x${"b1".repeat(32)}`);
const poolAddress = getAddress("0x1111111111111111111111111111111111111111");
const verifierAddress = getAddress("0x2222222222222222222222222222222222222222");
const predicateAddress = getAddress("0x3333333333333333333333333333333333333333");
const predecessorPoolAddress = getAddress("0x5555555555555555555555555555555555555555");
const feeRecipient = getAddress("0x0000a26b00c1F0DF003000390027140000fAa719");
const failedHash = `0x${"41".repeat(32)}`;
const successHash = `0x${"42".repeat(32)}`;
const actionId = `0x${"43".repeat(32)}`;
const replayIds = deriveRecoveryReplayIds({
  pair: { actionId },
  sourceBlocks: [100, 102],
  transactionIndexes: [3, 5],
});
const { failureQueryId, successQueryId, pairId: contractPairId } = replayIds;
const now = 2_000_000_000;
const predecessorTermsHash = id("predecessor-campaign-terms");
const predecessorBindingHash = id("predecessor-binding");
const interface_ = new Interface(recoveryCampaignAbi);

const discoveryIndex = Object.freeze([
  Object.freeze({ wallet: source.address, failedTransactionHash: failedHash, successfulTransactionHash: successHash }),
  Object.freeze({
    wallet: secondSource.address,
    failedTransactionHash: `0x${"51".repeat(32)}`,
    successfulTransactionHash: `0x${"52".repeat(32)}`,
  }),
  Object.freeze({
    wallet: thirdSource.address,
    failedTransactionHash: `0x${"61".repeat(32)}`,
    successfulTransactionHash: `0x${"62".repeat(32)}`,
  }),
]);

test("production discovery is a closed three-wallet index with the researched exact pairs", () => {
  assert.deepEqual(
    RECOVERY_DISCOVERY_INDEX.map(({ wallet, failedTransactionHash, successfulTransactionHash }) => ({
      wallet,
      failedTransactionHash,
      successfulTransactionHash,
    })),
    [
      {
        wallet: getAddress("0x61ceFF58C74dE887604E0A680bF1058a9D5b74D1"),
        failedTransactionHash: "0xed178b60188933f758d9ab42275929be0fbed986662a1c90a1a40c829f88d3ff",
        successfulTransactionHash: "0x8dbb2cae48049b6ce4f0d469c7719f4f20a444e2465886a3ed7dcab41b25ec3a",
      },
      {
        wallet: getAddress("0x0bbc095cfc73b121b196ee63478d64d1ebbdd4aa"),
        failedTransactionHash: "0x319832afc82bdcfa345f39bf056ba515afd4c28a0da402c6500876022e0a2035",
        successfulTransactionHash: "0x7ca03f721ddaa33dfd9ec1d174cb05ac131fb012a106d4964f3bbc59fae1fb96",
      },
      {
        wallet: getAddress("0x77039399801f462b4ed13444a266b16355c471bf"),
        failedTransactionHash: "0xe2c2cbf7efe65a4fcc6e79ab01e803b0f9f0dccc6d1b69467b0175a83dd2c9de",
        successfulTransactionHash: "0xa285149308c0fe1c53470bf15a1ccb135ab3c7c7ee54b339bbd8505f3a503be6",
      },
    ],
  );
});

test("configuration authenticates every binding and serializes campaign capacity safely", async () => {
  const fixture = serviceFixture();
  const config = await fixture.service.configuration();

  assert.equal(config.enabled, true);
  assert.deepEqual(config.capabilities, { selfServePairIntake: true, walletNativeDiscovery: true });
  assert.deepEqual(config.consent, {
    scope: "hosted-relayer",
    protocolEnforced: false,
    freshReadAdmission: "anonymous-v1",
  });
  assert.equal(config.poolAddress, poolAddress);
  assert.equal(config.verifierAddress, verifierAddress);
  assert.equal(config.predicateAddress, predicateAddress);
  assert.equal(config.publicOrigin, "https://retrycredit.example");
  assert.equal(config.relayerAddress, relayer.address);
  assert.equal(config.campaignNumber, 7);
  assert.equal(config.contractVersion, "v1");
  assert.deepEqual(config.lineage, {
    scope: "campaign",
    releasesUnlocked: true,
    predecessor: null,
  });
  assert.equal(config.campaign.creditAmount, parseEther("0.01").toString());
  assert.equal(config.campaign.releaseState, "release-unlocked");
  assert.deepEqual(config.capacity, { total: 3, claimed: 0, remaining: 3 });
  assert.deepEqual(config.rule, {
    feeRecipient,
    startBlock: 90,
    endBlock: 110,
    maxBlockGap: 10,
    maxQuantity: 2,
  });
  assert.equal(config.source.chainKey, 3);
  assert.equal(config.source.chainId, 1);
  assert.equal(config.settlement.chainId, 102031);
});

test("wallet-native discovery revalidates advisory hashes through live pair authority", async () => {
  let discoveryCalls = 0;
  const fixture = serviceFixture({
    walletDiscovery: async (input) => {
      discoveryCalls += 1;
      assert.equal(input.wallet, source.address);
      assert.equal(input.startBlock, 90);
      assert.equal(input.endBlock, 110);
      return {
        transactions: Array.from({ length: 12 }, () => ({})),
        truncated: false,
        pages: 1,
        attribution: {
          label: "Powered by Routescan.io APIs",
          url: "https://routescan.io/",
        },
        pairs: [{
          wallet: source.address,
          failedTransactionHash: failedHash,
          successfulTransactionHash: successHash,
        }],
      };
    },
  });
  const result = await fixture.service.discover(source.address);
  assert.equal(discoveryCalls, 1);
  assert.equal(fixture.pairCalls, 1);
  assert.equal(result.authority, "advisory-discovery-only");
  assert.equal(result.historyRowsInspected, 12);
  assert.equal(result.historyTruncated, false);
  assert.equal(result.manualFallbackRecommended, false);
  assert.deepEqual(result.attribution, {
    label: "Powered by Routescan.io APIs",
    url: "https://routescan.io/",
  });
  assert.deepEqual(result.matches.map(({ eligible, status }) => ({ eligible, status })), [
    { eligible: true, status: "eligible" },
  ]);
});

test("the Cloudflare discovery profile caps two sequential candidates at twenty source RPC calls", async () => {
  let calls = 0;
  let active = 0;
  let maximumActive = 0;
  const measured = async (value) => {
    calls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await nextTurn();
    active -= 1;
    return value;
  };
  const ethereumProviders = Array.from({ length: 3 }, () => ({
    getNetwork: () => measured({ chainId: 1n }),
    getTransaction: () => measured(null),
    getTransactionReceipt: () => measured(null),
  }));
  const secondPair = pairIdentity(`0x${"81".repeat(32)}`, `0x${"82".repeat(32)}`);
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders,
    walletDiscovery: async () => ({
      transactions: [],
      truncated: true,
      pages: 12,
      pairs: [pairIdentity(), secondPair],
    }),
    configOverride: {
      discoveryCandidateLimit: 2,
      discoverySourceLookupConcurrency: 1,
      sourceProviderAttempts: 2,
    },
  });

  const result = await fixture.service.discover(source.address);
  assert.deepEqual(result.matches, []);
  assert.equal(Object.hasOwn(result, "attribution"), false);
  assert.equal(calls, 20);
  assert.ok(maximumActive <= 4);
});

test("wallet discovery provider failures expose only the manual-entry fallback", async () => {
  const fixture = serviceFixture({
    walletDiscovery: async () => {
      throw new Error("provider secret at https://internal.example/token");
    },
  });
  await assert.rejects(
    fixture.service.discover(source.address),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_DISCOVERY_UNAVAILABLE"
      && error.status === 503
      && error.message === "Wallet history discovery is temporarily unavailable; transaction hashes can still be entered manually."
      && !error.message.includes("internal.example"),
  );
});

test("recovery ABI selection is explicit and defaults existing callers to V1", () => {
  assert.equal(selectRecoveryCampaignAbi(), recoveryCampaignAbiV1);
  assert.equal(selectRecoveryCampaignAbi("v1"), recoveryCampaignAbiV1);
  assert.equal(selectRecoveryCampaignAbi("v2"), recoveryCampaignAbiV2);
  assert.equal(new Interface(recoveryCampaignAbiV1).hasFunction("legacyPool"), false);
  assert.equal(new Interface(recoveryCampaignAbiV2).hasFunction("legacyPool"), true);
  assert.throws(
    () => selectRecoveryCampaignAbi("2"),
    /Unsupported recovery contract version/,
  );
  assert.throws(
    () => serviceFixture({ configOverride: { contractVersion: "2" } }),
    (error) => error instanceof WorkerError
      && error.code === "INVALID_RECOVERY_CONFIGURATION",
  );
});

test("contract versions are pinned to distinct exact runtime bytecode", async () => {
  assert.match(RECOVERY_RUNTIME_CODE_HASHES.v1, /^0x[0-9a-f]{64}$/);
  assert.match(RECOVERY_RUNTIME_CODE_HASHES.v2, /^0x[0-9a-f]{64}$/);
  assert.notEqual(RECOVERY_RUNTIME_CODE_HASHES.v1, RECOVERY_RUNTIME_CODE_HASHES.v2);

  const fixture = serviceFixture({
    configOverride: {
      contractVersion: "v2",
      expectedRuntimeCodeHash: keccak256("0x6001"),
    },
  });
  await assert.rejects(
    fixture.service.readiness(),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_MISCONFIGURED",
  );
});

test("V2 fails closed on malformed predecessor identity and release-gate state", async (t) => {
  const ZERO_HASH = `0x${"00".repeat(32)}`;
  const scenarios = [
    ["legacy campaign", { campaignNumber: 2n }, "RECOVERY_MISCONFIGURED"],
    ["self predecessor", { poolAddress }, "RECOVERY_MISCONFIGURED"],
    ["zero sponsor", { sponsor: ZeroAddress }, "RECOVERY_MISCONFIGURED"],
    ["zero terms", { termsHash: ZERO_HASH }, "RECOVERY_MISCONFIGURED"],
    ["zero binding", { bindingHash: ZERO_HASH }, "RECOVERY_MISCONFIGURED"],
    ["empty source window", { startBlock: 105n, endBlock: 105n }, "RECOVERY_MISCONFIGURED"],
    ["zero deadline", { deadline: 0n }, "RECOVERY_MISCONFIGURED"],
    ["missing predecessor code", { predecessorCode: "0x" }, "RECOVERY_MISCONFIGURED"],
    ["wrong predecessor runtime", { predecessorCode: "0x6001" }, "RECOVERY_MISCONFIGURED"],
    ["wrong predecessor runner", { runnerAddress: outsider.address }, "RECOVERY_MISCONFIGURED"],
    ["non-boolean release gate", { releasesUnlocked: "true" }, "RECOVERY_STATE_UNAVAILABLE"],
  ];

  for (const [name, lineageOverride, code] of scenarios) {
    await t.test(name, async () => {
      const fixture = serviceFixture({
        configOverride: { contractVersion: "v2" },
        lineageOverride,
      });
      await assert.rejects(
        fixture.service.readiness(),
        (error) => error instanceof WorkerError && error.code === code,
      );
    });
  }
});

test("configured V2 exposes exact predecessor lineage while pair checks remain available", async () => {
  const fixture = serviceFixture({
    configOverride: { contractVersion: "v2" },
    releasesUnlocked: false,
  });
  const config = await fixture.service.configuration();

  assert.equal(config.contractVersion, "v2");
  assert.deepEqual(config.lineage, {
    scope: "sponsor",
    releasesUnlocked: false,
    predecessor: {
      poolAddress: predecessorPoolAddress,
      campaignNumber: 1,
      sponsor: relayer.address,
      termsHash: predecessorTermsHash.toLowerCase(),
      deadline: now + 1_800,
      startBlock: 95,
      endBlock: 105,
    },
  });
  assert.equal(config.campaign.releaseState, "continuation-waiting");
  assert.equal(config.campaign.open, false);

  const eligibility = await fixture.service.eligibility(source.address);
  assert.equal(eligibility.status, "continuation-waiting");
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.pair.failedTransactionHash, failedHash);
  assert.deepEqual(eligibility.lineage, { scope: "sponsor", status: "unused" });
  assert.equal(fixture.pairCalls, 1);
  await assert.rejects(
    fixture.service.challenge(source.address),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_CONTINUATION_WAITING"
      && error.status === 425,
  );
  assert.equal(fixture.pairCalls, 1);
});

test("configured V2 unlock and exact predecessor/sponsor claims are explicit", async (t) => {
  await t.test("release-unlocked", async () => {
    const fixture = serviceFixture({
      configOverride: { contractVersion: "v2" },
      releasesUnlocked: true,
    });
    const config = await fixture.service.configuration();
    assert.equal(config.lineage.releasesUnlocked, true);
    assert.equal(config.campaign.releaseState, "release-unlocked");
    const eligibility = await fixture.service.eligibility(source.address);
    assert.equal(eligibility.status, "eligible");
    assert.deepEqual(eligibility.lineage, { scope: "sponsor", status: "unused" });
    assert.equal(fixture.pairCalls, 1);
  });

  for (const scenario of [
    { name: "claimed-predecessor", predecessorClaimed: true },
    { name: "claimed-sponsor", sponsorClaimed: true },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = serviceFixture({
        configOverride: { contractVersion: "v2" },
        releasesUnlocked: true,
        predecessorClaimed: scenario.predecessorClaimed,
        sponsorClaimed: scenario.sponsorClaimed,
      });
      const eligibility = await fixture.service.eligibility(source.address);
      assert.equal(eligibility.status, "claimed");
      assert.equal(eligibility.eligible, false);
      assert.deepEqual(eligibility.lineage, {
        scope: "sponsor",
        status: scenario.name,
      });
      assert.equal(fixture.pairCalls, 1);
    });
  }
});

test("a V2 release finalizes both campaign and sponsor-lineage replay state", async () => {
  const fixture = serviceFixture({
    configOverride: { contractVersion: "v2" },
    releasesUnlocked: true,
  });
  const challenge = await fixture.service.challenge(source.address);
  const result = await fixture.service.release(await signedRequest(challenge, source));
  assert.equal(result.status, "released");
  assert.deepEqual(result.lineage, { scope: "sponsor", status: "claimed-current" });
  assert.equal(fixture.releaseCalls, 1);

  const claimed = await fixture.service.eligibility(source.address);
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.lineage, { scope: "sponsor", status: "claimed-current" });
  assert.equal(claimed.release.transactionHash, result.release.transactionHash);
});

test("V2 predecessor and sponsor replay markers stop release before simulation", async (t) => {
  for (const scenario of [
    { name: "predecessor replay", predecessorReplayConsumed: true },
    { name: "sponsor replay", sponsorReplayConsumed: true },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = serviceFixture({
        configOverride: { contractVersion: "v2" },
        releasesUnlocked: true,
        ...scenario,
      });
      const challenge = await fixture.service.challenge(source.address);
      await assert.rejects(
        fixture.service.release(await signedRequest(challenge, source)),
        (error) => error instanceof WorkerError
          && error.code === "RECOVERY_REPLAYED"
          && /predecessor or sponsor lineage/.test(error.message),
      );
      assert.equal(fixture.staticCalls, 0);
      assert.equal(fixture.releaseCalls, 0);
    });
  }
});

test("release receipt scans reject unsafe provider ranges", () => {
  for (const configOverride of [
    { releaseLogChunkBlocks: 0 },
    { releaseLogChunkBlocks: 50_001 },
    { releaseLogChunkBlocks: 500, releaseLogLookbackBlocks: 499 },
    { releaseLogLookbackBlocks: 1_000_001 },
    { releaseLogConcurrency: 0 },
    { releaseLogConcurrency: 7 },
    { sourceLookupConcurrency: 0 },
    { sourceLookupQueueLimit: 257 },
    { sourceLookupTimeoutMs: 121_000 },
    { intakeTimeoutMs: 999 },
    { intakeTimeoutMs: 120_001 },
    { sourceProviderAttempts: 4 },
    { sourceRpcBatchMaxCount: 0 },
    { sourceRpcBatchMaxCount: 101 },
    { settlementRpcBatchMaxCount: 0 },
    { settlementRpcBatchMaxCount: 101 },
    { releaseRpcBatchMaxCount: 0 },
    { releaseRpcBatchMaxCount: 101 },
    { sourcePairCacheMaxEntries: 0 },
    { sourcePairCacheTtlSeconds: 3_601 },
    { sourcePairNegativeCacheTtlSeconds: 301 },
    { campaignStateCacheTtlSeconds: 0 },
    { campaignStateCacheTtlSeconds: 11 },
    { releaseQueueLimit: 0 },
    { discoverySourceLookupConcurrency: 0 },
    { discoverySourceLookupConcurrency: 5 },
  ]) {
    assert.throws(
      () => serviceFixture({ configOverride }),
      (error) => error instanceof WorkerError && error.code === "INVALID_RECOVERY_CONFIGURATION",
    );
  }
});

test("the production factory gives every Ethereum RPC request a finite deadline inside the source budget", () => {
  const service = RecoveryCampaignService.fromPrivateKey({
    privateKey: relayer.privateKey,
    poolAddress,
    campaignNumber: 7,
    creditcoinRpc: "https://creditcoin.example",
    proofBuilderUrl: "https://proof-builder.example",
    ethereumRpcUrls: ["https://ethereum-one.example", "https://ethereum-two.example"],
    publicOrigin: "https://retrycredit.example",
  });

  assert.equal(service.ethereumProviders.length, 2);
  assert.equal(
    service.relayerWallet.address,
    new Wallet(deriveRoleKey(relayer.privateKey, RECOVERY_RELAYER_ROLE)).address,
  );
  assert.notEqual(service.relayerWallet.address, relayer.address);
  assert.equal(service.ccProvider._getOption("cacheTimeout"), -1);
  for (const provider of service.ethereumProviders) {
    assert.equal(provider._getConnection().timeout, 6_000);
    assert.ok(provider._getConnection().timeout * 3 < 20_000);
  }
});

test("the read-only factory authenticates the public relayer identity without constructing a signer", () => {
  const service = RecoveryCampaignService.fromReadOnly({
    relayerAddress: relayer.address,
    poolAddress,
    campaignNumber: 7,
    creditcoinRpc: "https://creditcoin.example",
    proofBuilderUrl: "https://proof-builder.example",
    ethereumRpcUrls: ["https://ethereum-one.example"],
    publicOrigin: "https://retrycredit.example",
  });

  assert.equal(service.relayerWallet.address, relayer.address);
  assert.equal(service.relayerWallet.signingKey, undefined);
  assert.equal(service.relayerWallet.sendTransaction, undefined);
  assert.equal(service.pool.runner, service.ccProvider);
  assert.equal(service.ccProvider._getOption("cacheTimeout"), -1);
});

test("a discovery miss never invokes live-pair authority", async () => {
  const fixture = serviceFixture();
  const result = await fixture.service.eligibility(outsider.address);
  assert.equal(result.status, "not-found");
  assert.equal(result.eligible, false);
  assert.equal(result.lineage, null);
  assert.equal(fixture.pairCalls, 0);
});

test("a discovery row cannot override a conflicting live source wallet", async () => {
  const fixture = serviceFixture({
    pairOverride: { claimant: outsider.address },
  });
  await assert.rejects(
    fixture.service.eligibility(source.address),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_PAIR_INVALID"
      && error.status === 422,
  );
  assert.equal(fixture.pairCalls, 1);
});

test("eligibility exposes one exact pair and never accepts a payout destination", async () => {
  const fixture = serviceFixture();
  const eligibility = await fixture.service.eligibility(source.address);
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.wallet, source.address);
  assert.equal(eligibility.pair.failedTransactionHash, failedHash);
  assert.equal(eligibility.pair.successfulTransactionHash, successHash);
  assert.equal(eligibility.pair.valueWei, "5000000000000000");
  assert.deepEqual(eligibility.lineage, { scope: "campaign", status: "unused" });
  assert.equal("destination" in eligibility, false);

  await assert.rejects(
    fixture.service.release({ wallet: source.address, destination: outsider.address }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_DESTINATION_FORBIDDEN",
  );
  assert.equal(fixture.proofCalls, 0);
});

test("the stateless challenge binds origin, pool, campaign, wallet, pair, and a short exact lifetime", async () => {
  const fixture = serviceFixture();
  const challenge = await fixture.service.challenge(source.address);
  assert.equal(challenge.issuedAt, now);
  assert.equal(challenge.expiresAt, now + 300);
  assert.match(challenge.message, /Origin: https:\/\/retrycredit\.example/);
  assert.match(challenge.message, new RegExp(poolAddress));
  assert.match(challenge.message, /Campaign: 7/);
  assert.match(challenge.message, new RegExp(source.address));
  assert.match(challenge.message, new RegExp(failedHash));
  assert.match(challenge.message, new RegExp(successHash));
  assert.match(challenge.message, /no destination can be substituted/i);
});

test("open-pair intake derives a non-indexed claimant and releases to that exact source wallet", async () => {
  const openPair = pairIdentity(`0x${"91".repeat(32)}`, `0x${"92".repeat(32)}`);
  assert.equal(RECOVERY_DISCOVERY_INDEX.some(
    (entry) => entry.failedTransactionHash === openPair.failedTransactionHash,
  ), false);
  const resolved = summaryForPair(openPair);
  const fixture = serviceFixture({
    pairOverride: {
      failed: resolved.failed,
      successful: resolved.successful,
    },
  });

  const eligibility = await fixture.service.intakeEligibility({ pair: openPair });
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.wallet, source.address);
  assert.deepEqual(
    {
      failedTransactionHash: eligibility.pair.failedTransactionHash,
      successfulTransactionHash: eligibility.pair.successfulTransactionHash,
    },
    openPair,
  );

  const challenge = await fixture.service.intakeChallenge({ pair: openPair });
  assert.equal(challenge.wallet, source.address);
  assert.deepEqual(challenge.pair, openPair);
  const request = await signedIntakeRequest(challenge, source);
  const released = await fixture.service.intakeRelease(request);
  assert.equal(released.status, "released");
  assert.equal(released.wallet, source.address);
  assert.equal(released.release.beneficiary, source.address);
  assert.equal(fixture.releaseCalls, 1);

  const repeated = await fixture.service.intakeRelease(request);
  assert.equal(repeated.status, "claimed");
  assert.equal(repeated.release.transactionHash, released.release.transactionHash);
  assert.equal(fixture.proofCalls, 1);
});

test("open-pair intake rejects malformed, same, swapped, destination, and extra fields", async () => {
  const malformed = serviceFixture();
  for (const request of [
    {},
    { pair: { failedTransactionHash: "0x01", successfulTransactionHash: successHash } },
    { pair: { failedTransactionHash: failedHash, successfulTransactionHash: successHash }, wallet: source.address },
    { pair: { failedTransactionHash: failedHash, successfulTransactionHash: successHash, note: "extra" } },
  ]) {
    await assert.rejects(
      malformed.service.intakeEligibility(request),
      (error) => error instanceof WorkerError && error.code === "RECOVERY_REQUEST_INVALID",
    );
  }
  await assert.rejects(
    malformed.service.intakeEligibility({
      pair: { failedTransactionHash: failedHash, successfulTransactionHash: failedHash },
    }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_PAIR_INVALID",
  );
  await assert.rejects(
    malformed.service.intakeEligibility({
      pair: { failedTransactionHash: failedHash, successfulTransactionHash: successHash, beneficiary: outsider.address },
    }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_DESTINATION_FORBIDDEN",
  );
  assert.equal(malformed.pairCalls, 0);

  const swapped = serviceFixture();
  await assert.rejects(
    swapped.service.intakeEligibility({
      pair: { failedTransactionHash: successHash, successfulTransactionHash: failedHash },
    }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_PAIR_INVALID",
  );
  assert.equal(swapped.pairCalls, 1);
});

test("open-pair release authenticates exact consent before any live pair or proof work", async () => {
  const fixture = serviceFixture();
  const challenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const pairCallsAfterChallenge = fixture.pairCalls;

  await assert.rejects(
    fixture.service.intakeRelease(await signedIntakeRequest(challenge, outsider)),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_SIGNATURE_INVALID",
  );

  const mutated = await signedIntakeRequest(challenge, source);
  mutated.pair = {
    ...mutated.pair,
    successfulTransactionHash: `0x${"99".repeat(32)}`,
  };
  await assert.rejects(
    fixture.service.intakeRelease(mutated),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_SIGNATURE_INVALID",
  );
  assert.equal(fixture.pairCalls, pairCallsAfterChallenge);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

test("a valid signature from a wallet not derived by the pair reaches bounded source validation but never proof", async () => {
  const fixture = serviceFixture();
  const request = await rawSignedIntakeRequest({ wallet: outsider, pair: pairIdentity() });
  await assert.rejects(
    fixture.service.intakeRelease(request),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_PAIR_WALLET_MISMATCH",
  );
  assert.equal(fixture.pairCalls, 1);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

test("open-pair lookups deduplicate, cache, expire, and cap queued source work", async () => {
  const lookup = deferred();
  const fixture = serviceFixture({
    pairResolverOverride: async () => {
      await lookup.promise;
      return pairSummary();
    },
  });
  const first = fixture.service.intakeEligibility({ pair: pairIdentity() });
  const second = fixture.service.intakeEligibility({ pair: pairIdentity() });
  await nextTurn();
  assert.equal(fixture.pairCalls, 1);
  lookup.resolve();
  await Promise.all([first, second]);
  await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(fixture.pairCalls, 1);
  fixture.setNow(now + 601);
  await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(fixture.pairCalls, 2);

  const pending = [];
  const bounded = serviceFixture({
    pairResolverOverride: async ({ discovery }) => {
      const gate = deferred();
      pending.push(gate);
      await gate.promise;
      return summaryForPair(discovery);
    },
    configOverride: {
      sourceLookupConcurrency: 1,
      sourceLookupQueueLimit: 1,
      sourceLookupTimeoutMs: 1_000,
    },
  });
  const pairs = ["a1", "b1", "c1"].map((prefix, index) => pairIdentity(
    `0x${prefix.repeat(32)}`,
    `0x${(`${String.fromCharCode(100 + index)}1`).repeat(32)}`,
  ));
  const active = bounded.service.intakeEligibility({ pair: pairs[0] });
  await nextTurn();
  const queued = bounded.service.intakeEligibility({ pair: pairs[1] });
  await nextTurn();
  await assert.rejects(
    bounded.service.intakeEligibility({ pair: pairs[2] }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_BUSY" && error.status === 429,
  );
  pending[0].resolve();
  await active;
  while (pending.length < 2) await nextTurn();
  pending[1].resolve();
  await queued;
});

test("open-pair source lookup timeouts are bounded", async () => {
  const never = deferred();
  const fixture = serviceFixture({
    pairResolverOverride: () => never.promise,
    configOverride: { sourceLookupTimeoutMs: 250 },
  });
  await assert.rejects(
    fixture.service.intakeEligibility({ pair: pairIdentity() }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_SOURCE_TIMEOUT"
      && error.status === 503,
  );
  assert.equal(fixture.pairCalls, 1);
});

test("the whole public intake pipeline is bounded and campaign reads are single-flight", async () => {
  const campaignGate = deferred();
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      await campaignGate.promise;
      return { ...campaign };
    },
    pairResolverOverride: ({ discovery }) => summaryForPair(discovery),
    configOverride: {
      sourceLookupConcurrency: 1,
      sourceLookupQueueLimit: 1,
      intakeTimeoutMs: 5_000,
    },
  });
  const pairs = ["71", "72", "73"].map((prefix, index) => pairIdentity(
    `0x${prefix.repeat(32)}`,
    `0x${String(81 + index).repeat(32)}`,
  ));

  const first = fixture.service.intakeEligibility({ pair: pairs[0] });
  await nextTurn();
  const second = fixture.service.intakeEligibility({ pair: pairs[1] });
  await nextTurn();
  await assert.rejects(
    fixture.service.intakeEligibility({ pair: pairs[2] }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_BUSY" && error.status === 429,
  );
  assert.equal(fixture.campaignReads, 1);
  assert.equal(fixture.ruleReads, 1);

  campaignGate.resolve();
  await Promise.all([first, second]);
  assert.equal(fixture.campaignReads, 1);
  assert.equal(fixture.ruleReads, 1);
});

test("open-pair source resolution attempts at most three configured providers", async () => {
  let providerAttempts = 0;
  const ethereumProviders = Array.from({ length: 5 }, () => ({
    async getNetwork() {
      providerAttempts += 1;
      return { chainId: 1n };
    },
    async getTransaction() { throw new Error("provider unavailable"); },
    async getTransactionReceipt() { throw new Error("provider unavailable"); },
  }));
  const fixture = serviceFixture({ useEthereumResolver: true, ethereumProviders });
  await assert.rejects(
    fixture.service.intakeEligibility({ pair: pairIdentity() }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_SOURCE_UNAVAILABLE"
      && error.status === 503,
  );
  assert.equal(providerAttempts, 3);
});

test("a responsive Ethereum provider with missing hashes returns pair-invalid, not infrastructure unavailable", async () => {
  const ethereumProvider = {
    async getNetwork() { return { chainId: 1n }; },
    async getTransaction() { return null; },
    async getTransactionReceipt() { return null; },
  };
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [ethereumProvider],
  });
  await assert.rejects(
    fixture.service.intakeEligibility({ pair: pairIdentity() }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_PAIR_INVALID"
      && error.status === 422,
  );
});

test("open-pair source resolution retries another provider after a complete semantic mismatch", async () => {
  let networkChecks = 0;
  const ethereumProviders = [
    {
      async getNetwork() {
        networkChecks += 1;
        return { chainId: 1n };
      },
      async getTransaction() { return { type: 0 }; },
      async getTransactionReceipt() { return {}; },
    },
    {
      async getNetwork() {
        networkChecks += 1;
        return { chainId: 1n };
      },
      async getTransaction() { throw new Error("provider unavailable"); },
      async getTransactionReceipt() { throw new Error("provider unavailable"); },
    },
  ];
  const fixture = serviceFixture({ useEthereumResolver: true, ethereumProviders });
  await assert.rejects(
    fixture.service.intakeEligibility({ pair: pairIdentity() }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_PAIR_INVALID"
      && error.status === 422,
  );
  assert.equal(networkChecks, 2);
});

test("missing receipts for returned transactions are retryable and never negatively cached", async () => {
  let receiptAvailable = false;
  let reads = 0;
  const ethereumProvider = {
    async getNetwork() { return { chainId: 1n }; },
    async getTransaction() { reads++; return { type: 0 }; },
    async getTransactionReceipt() { return receiptAvailable ? {} : null; },
  };
  const fixture = serviceFixture({ useEthereumResolver: true, ethereumProviders: [ethereumProvider] });
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), { code: "RECOVERY_SOURCE_UNAVAILABLE", status: 503 });
  receiptAvailable = true;
  // Complete type-0 facts still fail the actual predicate. They must be reread,
  // not hidden by a cached semantic verdict from the incomplete first response.
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), { code: "RECOVERY_PAIR_INVALID", status: 422 });
  assert.equal(reads, 4);
});

test("one entirely absent hash stays pair-invalid and negatively cached", async () => {
  let reads = 0;
  const fixture = serviceFixture({ useEthereumResolver: true, ethereumProviders: [{
    async getNetwork() { return { chainId: 1n }; },
    async getTransaction(hash) { reads++; return hash === failedHash ? { type: 2 } : null; },
    async getTransactionReceipt(hash) { return hash === failedHash ? {} : null; },
  }] });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), { code: "RECOVERY_PAIR_INVALID", status: 422 });
  }
  assert.equal(reads, 2);
});

test("discovery cannot report an empty match when a candidate has unavailable receipts", async () => {
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [{
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction() { return { type: 2 }; },
      async getTransactionReceipt() { return null; },
    }, {
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction() { return null; },
      async getTransactionReceipt() { return null; },
    }],
    walletDiscovery: async () => ({ transactions: [], pages: 1, truncated: false, pairs: [pairIdentity()] }),
  });
  await assert.rejects(fixture.service.discover(source.address), { code: "RECOVERY_SOURCE_UNAVAILABLE", status: 503 });
});

test("outside-window diagnostics preserve authoritative rejection and the original cached check time", async () => {
  const facts = diagnosticSourceFacts();
  let sourceReads = 0;
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ruleReaderOverride: ({ rule }) => ({ ...rule, endBlock: 101n }),
    ethereumProviders: [{
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction(hash) { sourceReads++; return hash === failedHash ? facts.failedTransaction : facts.successfulTransaction; },
      async getTransactionReceipt(hash) { sourceReads++; return hash === failedHash ? facts.failedReceipt : facts.successfulReceipt; },
    }],
  });
  let first;
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.equal(error.code, "RECOVERY_PAIR_INVALID");
    assert.equal(error.status, 422);
    first = error.diagnostics;
    assert(first);
    assert.deepEqual(first.pair, pairIdentity());
    assert.equal(first.campaign.poolAddress, poolAddress);
    assert.equal(first.campaign.campaignNumber, 7);
    assert.equal(first.campaign.termsHash, id("campaign-terms"));
    assert.equal(first.checks.find(check => check.id === "campaign-window").status, "fail");
    assert.equal(first.checks.find(check => check.id === "mint-outcome").status, "pass");
    return true;
  });
  fixture.setNow(now + 1);
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.deepEqual(error.diagnostics, first);
    return error.code === "RECOVERY_PAIR_INVALID" && error.status === 422;
  });
  assert.equal(sourceReads, 4);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.staticCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

test("an unavailable receipt has no diagnostics and a recovered provider is reread", async () => {
  const facts = diagnosticSourceFacts();
  facts.failedTransaction.type = 0;
  let available = false;
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [{
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction(hash) { return hash === failedHash ? facts.failedTransaction : facts.successfulTransaction; },
      async getTransactionReceipt(hash) { return available ? (hash === failedHash ? facts.failedReceipt : facts.successfulReceipt) : null; },
    }],
  });
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.equal(error.diagnostics, undefined);
    return error.code === "RECOVERY_SOURCE_UNAVAILABLE" && error.status === 503;
  });
  available = true;
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.equal(error.diagnostics.checks.find(check => check.id === "transaction-type").status, "fail");
    return error.code === "RECOVERY_PAIR_INVALID" && error.status === 422;
  });
});

test("successful authoritative fallback discards the earlier provider's mismatch diagnostics", async () => {
  const facts = diagnosticSourceFacts();
  const stale = { ...facts, failedTransaction: { ...facts.failedTransaction, type: 0 } };
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [stale, facts].map(value => ({
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction(hash) { return hash === failedHash ? value.failedTransaction : value.successfulTransaction; },
      async getTransactionReceipt(hash) { return hash === failedHash ? value.failedReceipt : value.successfulReceipt; },
    })),
  });
  const result = await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(result.eligible, true);
  assert.equal(result.diagnostics, undefined);
  assert.equal(fixture.proofCalls, 0);
});

test("a clock failure during diagnostic formatting preserves the authoritative semantic 422", async () => {
  const facts = diagnosticSourceFacts();
  facts.failedTransaction.type = 0;
  let clockFault = false;
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [{
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction(hash) { return hash === failedHash ? facts.failedTransaction : facts.successfulTransaction; },
      async getTransactionReceipt(hash) {
        clockFault = true;
        return hash === failedHash ? facts.failedReceipt : facts.successfulReceipt;
      },
    }],
  });
  fixture.service.now = () => {
    if (clockFault) { clockFault = false; throw new Error("SECRET_CLOCK_FAILURE"); }
    return now;
  };
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.equal(error.diagnostics, undefined);
    assert.doesNotMatch(error.message, /SECRET/);
    return error.code === "RECOVERY_PAIR_INVALID" && error.status === 422;
  });
});

test("incoherent complete provider data keeps its existing error without inventing diagnostic facts", async () => {
  const facts = diagnosticSourceFacts();
  facts.failedReceipt.hash = successHash;
  const fixture = serviceFixture({
    useEthereumResolver: true,
    ethereumProviders: [{
      async getNetwork() { return { chainId: 1n }; },
      async getTransaction(hash) { return hash === failedHash ? facts.failedTransaction : facts.successfulTransaction; },
      async getTransactionReceipt(hash) { return hash === failedHash ? facts.failedReceipt : facts.successfulReceipt; },
    }],
  });
  await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
    assert.equal(error.diagnostics, undefined);
    return error.code === "RECOVERY_PAIR_INVALID" && error.status === 422;
  });
});

test("missing or malformed calldata retains the existing 422 without live or cached diagnostics", async (t) => {
  for (const transactionName of ["failedTransaction", "successfulTransaction"]) {
    for (const [label, data] of [["missing", undefined], ["null", null], ["malformed", "0xzz"]]) {
      await t.test(`${transactionName} ${label}`, async () => {
        const facts = diagnosticSourceFacts();
        facts[transactionName].data = data;
        let sourceReads = 0;
        const fixture = serviceFixture({
          useEthereumResolver: true,
          ethereumProviders: [{
            async getNetwork() { return { chainId: 1n }; },
            async getTransaction(hash) { sourceReads++; return hash === failedHash ? facts.failedTransaction : facts.successfulTransaction; },
            async getTransactionReceipt(hash) { sourceReads++; return hash === failedHash ? facts.failedReceipt : facts.successfulReceipt; },
          }],
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(fixture.service.intakeEligibility({ pair: pairIdentity() }), error => {
            assert.equal(error.diagnostics, undefined);
            return error.code === "RECOVERY_PAIR_INVALID" && error.status === 422;
          });
        }
        assert.equal(sourceReads, 4);
        assert.equal(fixture.proofCalls, 0);
        assert.equal(fixture.staticCalls, 0);
        assert.equal(fixture.releaseCalls, 0);
      });
    }
  }
});

test("open-pair release queue rejects overflow before a second proof starts", async () => {
  const proofGate = deferred();
  const secondPair = pairIdentity(`0x${"a9".repeat(32)}`, `0x${"b9".repeat(32)}`);
  const fixture = serviceFixture({
    pairResolverOverride: ({ discovery }) => summaryForPair(discovery),
    proofBuilderOverride: async ({ resolved }) => {
      await proofGate.promise;
      return { success: true, data: batchProofFixture(resolved) };
    },
    configOverride: { releaseQueueLimit: 1 },
  });
  const firstChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const secondChallenge = await fixture.service.intakeChallenge({ pair: secondPair });
  const firstRelease = fixture.service.intakeRelease(await signedIntakeRequest(firstChallenge, source));
  await waitFor(() => fixture.proofCalls === 1);
  await assert.rejects(
    fixture.service.intakeRelease(await signedIntakeRequest(secondChallenge, source)),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_BUSY" && error.status === 429,
  );
  assert.equal(fixture.proofCalls, 1);
  proofGate.resolve();
  await firstRelease;
  assert.equal(fixture.releaseCalls, 1);
});

test("a signed release is publicly reconcilable as processing until it settles", async () => {
  const proofGate = deferred();
  const fixture = serviceFixture({
    proofBuilderOverride: async ({ resolved }) => {
      await proofGate.promise;
      return { success: true, data: batchProofFixture(resolved) };
    },
  });
  const challenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const release = fixture.service.intakeRelease(await signedIntakeRequest(challenge, source));
  await waitFor(() => fixture.proofCalls === 1);

  const status = await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(status.status, "processing");
  assert.equal(status.eligible, false);
  assert.equal(status.release, null);
  const legacyStatus = await fixture.service.eligibility(source.address);
  assert.equal(legacyStatus.status, "eligible");
  assert.equal(legacyStatus.eligible, true);
  await assert.rejects(
    fixture.service.intakeChallenge({ pair: pairIdentity() }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_RELEASE_PENDING"
      && error.status === 425,
  );

  proofGate.resolve();
  assert.equal((await release).status, "released");
  const claimed = await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(claimed.status, "claimed");
  assert.deepEqual(claimed.lineage, { scope: "campaign", status: "claimed-current" });
});

test("a claimed wallet's different pair is rejected without attaching the prior receipt", async () => {
  const otherPair = pairIdentity(`0x${"e9".repeat(32)}`, `0x${"f9".repeat(32)}`);
  const fixture = serviceFixture({
    pairResolverOverride: ({ discovery }) => {
      const summary = summaryForPair(discovery);
      return discovery.failedTransactionHash === otherPair.failedTransactionHash
        ? { ...summary, actionId: id("different-qualified-action") }
        : summary;
    },
  });
  const firstChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  await fixture.service.intakeRelease(await signedIntakeRequest(firstChallenge, source));
  const proofCalls = fixture.proofCalls;

  await assert.rejects(
    fixture.service.intakeEligibility({ pair: otherPair }),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_ALREADY_CLAIMED"
      && error.status === 409,
  );
  assert.equal(fixture.proofCalls, proofCalls);
  assert.equal(fixture.releaseCalls, 1);
});

test("a queued open-pair release rechecks capacity and claim state before proof", async () => {
  const proofGate = deferred();
  const secondPair = pairIdentity(`0x${"c9".repeat(32)}`, `0x${"d9".repeat(32)}`);
  const fixture = serviceFixture({
    pairResolverOverride: ({ discovery }) => summaryForPair(discovery),
    campaignOverride: {
      maxClaims: 1n,
      fundedAmount: parseEther("0.01"),
    },
    proofBuilderOverride: async ({ resolved }) => {
      await proofGate.promise;
      return { success: true, data: batchProofFixture(resolved) };
    },
    configOverride: { releaseQueueLimit: 2 },
  });
  const firstChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const secondChallenge = await fixture.service.intakeChallenge({ pair: secondPair });
  const firstRelease = fixture.service.intakeRelease(await signedIntakeRequest(firstChallenge, source));
  await waitFor(() => fixture.proofCalls === 1);
  const queuedRelease = fixture.service.intakeRelease(await signedIntakeRequest(secondChallenge, source));
  await nextTurn();
  assert.equal(fixture.proofCalls, 1);
  proofGate.resolve();
  const [first, second] = await Promise.all([firstRelease, queuedRelease]);
  assert.equal(first.status, "released");
  assert.equal(second.status, "claimed");
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.releaseCalls, 1);
});

test("a distinct queued claimant sees a freshly filled campaign before a second proof", async () => {
  const proofGate = deferred();
  const secondPair = pairIdentity(`0x${"ca".repeat(32)}`, `0x${"cb".repeat(32)}`);
  const fixture = serviceFixture({
    pairResolverOverride: ({ discovery }) => {
      const summary = summaryForPair(discovery);
      if (discovery.failedTransactionHash !== secondPair.failedTransactionHash) return summary;
      return {
        ...summary,
        claimant: secondSource.address,
        payer: secondSource.address,
        recipient: secondSource.address,
        actionId: id("second-claimant-qualified-action"),
      };
    },
    campaignOverride: {
      maxClaims: 1n,
      fundedAmount: parseEther("0.01"),
    },
    proofBuilderOverride: async ({ resolved }) => {
      await proofGate.promise;
      return { success: true, data: batchProofFixture(resolved) };
    },
    configOverride: { releaseQueueLimit: 2 },
  });
  const firstChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const secondChallenge = await fixture.service.intakeChallenge({ pair: secondPair });
  const firstRelease = fixture.service.intakeRelease(await signedIntakeRequest(firstChallenge, source));
  await waitFor(() => fixture.proofCalls === 1);
  const secondRelease = fixture.service.intakeRelease(
    await signedIntakeRequest(secondChallenge, secondSource),
  );
  await nextTurn();
  assert.equal(fixture.proofCalls, 1);

  proofGate.resolve();
  assert.equal((await firstRelease).status, "released");
  await assert.rejects(
    secondRelease,
    (error) => error instanceof WorkerError && error.code === "RECOVERY_FULL" && error.status === 409,
  );
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.releaseCalls, 1);
});

test("fresh release reads never join or recache an older normal campaign-state flight", async () => {
  const staleReadStarted = deferred();
  const staleReadGate = deferred();
  let blockNextCampaignRead = false;
  const secondPair = pairIdentity(`0x${"da".repeat(32)}`, `0x${"db".repeat(32)}`);
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      const snapshot = { ...campaign };
      if (blockNextCampaignRead) {
        blockNextCampaignRead = false;
        staleReadStarted.resolve();
        await staleReadGate.promise;
      }
      return snapshot;
    },
    pairResolverOverride: ({ discovery }) => {
      const summary = summaryForPair(discovery);
      if (discovery.failedTransactionHash !== secondPair.failedTransactionHash) return summary;
      return {
        ...summary,
        claimant: secondSource.address,
        payer: secondSource.address,
        recipient: secondSource.address,
        actionId: id("generation-race-second-action"),
      };
    },
    campaignOverride: {
      maxClaims: 1n,
      fundedAmount: parseEther("0.01"),
    },
  });
  const firstChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  const secondChallenge = await fixture.service.intakeChallenge({ pair: secondPair });

  fixture.setNow(now + 2);
  blockNextCampaignRead = true;
  const staleConfiguration = fixture.service.configuration();
  await staleReadStarted.promise;

  const first = await fixture.service.intakeRelease(await signedIntakeRequest(firstChallenge, source));
  assert.equal(first.status, "released");
  await assert.rejects(
    fixture.service.intakeRelease(await signedIntakeRequest(secondChallenge, secondSource)),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_FULL" && error.status === 409,
  );
  assert.equal(fixture.proofCalls, 1);

  staleReadGate.resolve();
  assert.equal((await staleConfiguration).capacity.remaining, 1);
  const current = await fixture.service.configuration();
  assert.deepEqual(current.capacity, { total: 1, claimed: 1, remaining: 0 });
  assert.equal(current.campaign.open, false);
});

test("fresh configuration bypasses cached campaign truth", async () => {
  const fixture = serviceFixture();
  const initial = await fixture.service.configuration();
  assert.deepEqual(initial.capacity, { total: 3, claimed: 0, remaining: 3 });
  assert.equal(fixture.campaignReads, 1);

  fixture.setCampaign({ claimCount: 1n });
  const cached = await fixture.service.configuration();
  assert.deepEqual(cached.capacity, { total: 3, claimed: 0, remaining: 3 });
  assert.equal(fixture.campaignReads, 1);

  const fresh = await fixture.service.configuration({ fresh: true });
  assert.deepEqual(fresh.capacity, { total: 3, claimed: 1, remaining: 2 });
  assert.equal(fixture.campaignReads, 2);
});

test("a fresh configuration request queues a new read behind an older fresh flight", async () => {
  const olderReadStarted = deferred();
  const olderReadGate = deferred();
  let readNumber = 0;
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      readNumber += 1;
      const snapshot = { ...campaign };
      if (readNumber === 1) {
        olderReadStarted.resolve();
        await olderReadGate.promise;
      }
      return snapshot;
    },
  });

  const olderFresh = fixture.service.configuration({ fresh: true });
  await olderReadStarted.promise;
  fixture.setCampaign({ claimCount: 1n });
  const postBarrierFresh = fixture.service.configuration({ fresh: true });

  await nextTurn();
  assert.equal(fixture.campaignReads, 1);
  olderReadGate.resolve();
  assert.deepEqual((await olderFresh).capacity, { total: 3, claimed: 0, remaining: 3 });
  assert.deepEqual((await postBarrierFresh).capacity, { total: 3, claimed: 1, remaining: 2 });
  assert.deepEqual((await fixture.service.configuration()).capacity, { total: 3, claimed: 1, remaining: 2 });
});

test("a burst of fresh configuration requests creates only one trailing chain read", async () => {
  const firstReadStarted = deferred();
  const firstReadGate = deferred();
  const trailingReadStarted = deferred();
  const trailingReadGate = deferred();
  let readNumber = 0;
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      readNumber += 1;
      const snapshot = { ...campaign };
      if (readNumber === 1) {
        firstReadStarted.resolve();
        await firstReadGate.promise;
      } else if (readNumber === 2) {
        trailingReadStarted.resolve();
        await trailingReadGate.promise;
      }
      return snapshot;
    },
  });

  const first = fixture.service.configuration({ fresh: true });
  await firstReadStarted.promise;
  const burst = Array.from({ length: 100 }, () => fixture.service.configuration({ fresh: true }));
  await nextTurn();
  assert.equal(fixture.campaignReads, 1);

  firstReadGate.resolve();
  await first;
  await trailingReadStarted.promise;
  assert.equal(fixture.campaignReads, 2);
  trailingReadGate.resolve();
  await Promise.all(burst);
  assert.equal(fixture.campaignReads, 2);
});

test("a fresh caller arriving after the trailing read starts gets the next read", async () => {
  const starts = Array.from({ length: 3 }, () => deferred());
  const gates = Array.from({ length: 3 }, () => deferred());
  let readNumber = 0;
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      const index = readNumber;
      readNumber += 1;
      const snapshot = { ...campaign };
      starts[index]?.resolve();
      if (gates[index]) await gates[index].promise;
      return snapshot;
    },
  });

  const first = fixture.service.configuration({ fresh: true });
  await starts[0].promise;
  const trailing = fixture.service.configuration({ fresh: true });
  gates[0].resolve();
  await first;
  await starts[1].promise;

  const afterStart = fixture.service.configuration({ fresh: true });
  await nextTurn();
  assert.equal(fixture.campaignReads, 2);
  gates[1].resolve();
  await trailing;
  await starts[2].promise;
  assert.equal(fixture.campaignReads, 3);
  gates[2].resolve();
  await afterStart;
});

test("a failed active fresh read still promotes its trailing freshness barrier", async () => {
  const failedReadStarted = deferred();
  const failedReadGate = deferred();
  let readNumber = 0;
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      readNumber += 1;
      if (readNumber === 1) {
        failedReadStarted.resolve();
        await failedReadGate.promise;
        throw new Error("stale provider failed");
      }
      return { ...campaign };
    },
  });

  const failed = fixture.service.configuration({ fresh: true });
  await failedReadStarted.promise;
  fixture.setCampaign({ claimCount: 1n });
  const promoted = fixture.service.configuration({ fresh: true });
  failedReadGate.resolve();

  await assert.rejects(
    failed,
    (error) => error instanceof WorkerError && error.code === "RECOVERY_STATE_UNAVAILABLE",
  );
  assert.deepEqual((await promoted).capacity, { total: 3, claimed: 1, remaining: 2 });
  assert.equal(fixture.campaignReads, 2);
});

test("an older normal flight cannot overwrite a newer fresh configuration cache", async () => {
  const olderReadStarted = deferred();
  const olderReadGate = deferred();
  let readNumber = 0;
  const fixture = serviceFixture({
    campaignReaderOverride: async ({ campaign }) => {
      readNumber += 1;
      const snapshot = { ...campaign };
      if (readNumber === 1) {
        olderReadStarted.resolve();
        await olderReadGate.promise;
      }
      return snapshot;
    },
  });

  const olderNormal = fixture.service.configuration();
  await olderReadStarted.promise;
  fixture.setCampaign({ claimCount: 1n });
  const fresh = await fixture.service.configuration({ fresh: true });
  assert.deepEqual(fresh.capacity, { total: 3, claimed: 1, remaining: 2 });

  olderReadGate.resolve();
  assert.deepEqual((await olderNormal).capacity, { total: 3, claimed: 0, remaining: 3 });
  assert.deepEqual((await fixture.service.configuration()).capacity, { total: 3, claimed: 1, remaining: 2 });
  assert.equal(fixture.campaignReads, 2);
});

test("open-pair release rejects closed and full campaigns before source or proof work", async (t) => {
  for (const scenario of [
    { name: "closed", campaignOverride: { deadline: now - 1 }, code: "RECOVERY_CLOSED" },
    { name: "full", campaignOverride: { claimCount: 3n }, code: "RECOVERY_FULL" },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = serviceFixture({ campaignOverride: scenario.campaignOverride });
      const request = await rawSignedIntakeRequest({ wallet: source, pair: pairIdentity() });
      await assert.rejects(
        fixture.service.intakeRelease(request),
        (error) => error instanceof WorkerError && error.code === scenario.code,
      );
      assert.equal(fixture.pairCalls, 0);
      assert.equal(fixture.proofCalls, 0);
      assert.equal(fixture.releaseCalls, 0);
    });
  }
});

test("release refuses a different signer, an altered consent message, and an expired consent", async () => {
  const fixture = serviceFixture();
  const challenge = await fixture.service.challenge(source.address);
  await assert.rejects(
    fixture.service.release(await signedRequest(challenge, outsider)),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_SIGNATURE_INVALID",
  );
  await assert.rejects(
    fixture.service.release({
      ...await signedRequest(challenge, source),
      message: `${challenge.message}\nDestination: ${outsider.address}`,
      signature: await source.signMessage(`${challenge.message}\nDestination: ${outsider.address}`),
    }),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_CHALLENGE_INVALID",
  );
  fixture.setNow(challenge.expiresAt + 1);
  await assert.rejects(
    fixture.service.release(await signedRequest(challenge, source)),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_CHALLENGE_EXPIRED",
  );
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

test("verification lost during proof building prevents broadcast on both release routes", async () => {
  for (const intake of [false, true]) {
    let verified = true;
    const fixture = serviceFixture({
      beforeBroadcast() {
        if (!verified) throw new WorkerError("RECOVERY_V2_NOT_VERIFIED", "verification unavailable", 503);
      },
      proofBuilderOverride: async ({ resolved }) => {
        verified = false;
        return { success: true, data: batchProofFixture(resolved) };
      },
    });
    const challenge = intake
      ? await fixture.service.intakeChallenge({ pair: pairIdentity() })
      : await fixture.service.challenge(source.address);
    const request = intake ? await signedIntakeRequest(challenge, source) : await signedRequest(challenge, source);
    await assert.rejects(intake ? fixture.service.intakeRelease(request) : fixture.service.release(request),
      error => error.code === "RECOVERY_V2_NOT_VERIFIED" && error.status === 503);
    assert.equal(fixture.proofCalls, 1);
    assert.equal(fixture.staticCalls, 1);
    assert.equal(fixture.releaseCalls, 0);
  }
});

test("one authorized pair-local proof releases the exact credit and a retry is idempotent", async () => {
  const fixture = serviceFixture();
  const challenge = await fixture.service.challenge(source.address);
  const request = await signedRequest(challenge, source);
  const released = await fixture.service.release(request);

  assert.equal(released.status, "released");
  assert.equal(released.wallet, source.address);
  assert.equal(released.release.actionId, actionId);
  assert.equal(released.release.failureQueryId, failureQueryId);
  assert.equal(released.release.successQueryId, successQueryId);
  assert.equal(released.release.pairId, contractPairId);
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.staticCalls, 1);
  assert.equal(fixture.releaseCalls, 1);
  assert.equal(fixture.balance(), parseEther("0.01"));

  const again = await fixture.service.release(request);
  assert.equal(again.status, "claimed");
  assert.equal(again.release.transactionHash, released.release.transactionHash);
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.releaseCalls, 1);
  assert.deepEqual(fixture.logQueries, [[601, 700], [501, 600], [451, 500]]);
});

test("Attestcoin builder lag is retryable HTTP-425 domain state", async () => {
  const fixture = serviceFixture({ proofResult: { success: false, error: "not attested" } });
  const challenge = await fixture.service.challenge(source.address);
  await assert.rejects(
    fixture.service.release(await signedRequest(challenge, source)),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_ATTESTATION_PENDING"
      && error.status === 425,
  );
  assert.equal(fixture.releaseCalls, 0);
});

test("closed and full campaign states are explicit and never build proofs", async (t) => {
  for (const scenario of [
    { name: "closed", options: { campaignOverride: { deadline: now - 1 } }, expected: "closed" },
    { name: "full", options: { campaignOverride: { claimCount: 3n } }, expected: "full" },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = serviceFixture(scenario.options);
      const result = await fixture.service.eligibility(source.address);
      assert.equal(result.status, scenario.expected);
      assert.equal(result.eligible, false);
      assert.equal(fixture.proofCalls, 0);
    });
  }
});

test("campaign-scoped consumed query or pair state rejects replay before simulation", async () => {
  const fixture = serviceFixture({ replayConsumed: true });
  const challenge = await fixture.service.challenge(source.address);
  await assert.rejects(
    fixture.service.release(await signedRequest(challenge, source)),
    (error) => error instanceof WorkerError
      && error.code === "RECOVERY_REPLAYED"
      && error.status === 409,
  );
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.staticCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

test("readiness rejects a verifier that is not bound to the configured predicate", async () => {
  const fixture = serviceFixture({ verifierPredicate: outsider.address });
  await assert.rejects(
    fixture.service.readiness(),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_MISCONFIGURED",
  );
});

test("same-instance V2 readiness recovers transport failures without retaining a rejected authentication", async (t) => {
  for (const phase of ["runtime", "partial-bindings", "campaign"]) {
    await t.test(phase, async () => {
      let campaignCalls = 0;
      const failure = Object.assign(new Error("temporary RPC interruption"), { code: "TIMEOUT" });
      const fixture = serviceFixture({
        configOverride: { contractVersion: "v2" },
        campaignReaderOverride: phase === "campaign" ? ({ campaign }) => {
          if (++campaignCalls === 1) throw failure;
          return { ...campaign };
        } : undefined,
      });
      if (phase !== "campaign") {
        const object = phase === "runtime" ? fixture.service.ccProvider : fixture.service.verifier;
        const method = phase === "runtime" ? "getCode" : "predicate";
        const original = object[method].bind(object);
        let calls = 0;
        object[method] = (...args) => {
          if (++calls === 1) return Promise.reject(failure);
          return original(...args);
        };
      }
      await assert.rejects(fixture.service.readiness(), isRetryableRecoveryStartupError);
      const ready = await fixture.service.readiness();
      assert.equal(ready.verifierAddress, verifierAddress);
      const config = await fixture.service.configuration();
      assert.equal(config.contractVersion, "v2");
      assert.equal(config.enabled, true);
      assert.equal(fixture.proofCalls, 0);
      assert.equal(fixture.staticCalls, 0);
      assert.equal(fixture.releaseCalls, 0);
    });
  }
});

test("batch normalization rejects unexpected hashes and keeps the exact two-entry contract shape", () => {
  const pair = pairSummary();
  const proof = batchProofFixture(pair);
  const normalized = normalizeRecoveryBatchProof(proof, pair);
  assert.deepEqual(normalized.contractProof.sourceBlocks, [100, 102]);
  assert.equal(normalized.contractProof.encodedTransactions.length, 2);
  assert.equal(normalized.contractProof.merkleProofs.length, 2);
  assert.deepEqual(normalized.evidence.transactionIndexes, [3, 5]);

  const malformed = batchProofFixture(pair);
  malformed.merkleProofs.get(100).get(3).txHash = `0x${"ff".repeat(32)}`;
  assert.throws(
    () => normalizeRecoveryBatchProof(malformed, pair),
    (error) => error instanceof WorkerError && error.code === "RECOVERY_PROOF_INVALID",
  );
});

test("helper mode is disabled unless the explicit durable budget and V2 signer are configured", async () => {
  const fixture = serviceFixture();
  await assert.rejects(fixture.service.helperChallenge({}), { code: "RECOVERY_HELPER_DISABLED" });
  for (const options of [{}, { helperMaxFeeWei: "0" }, { helperMaxFeeWei: "2000000000000000", configOverride: { contractVersion: "v1" } }]) {
    assert.throws(() => serviceFixture({ helperLedger: fakeHelperLedger(), ...options }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  }
});

test("helper consent separates requester from source and binds an identity shared across helpers", async () => {
  const fixture = helperFixture();
  const first = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const second = await fixture.service.helperChallenge({ requester: secondSource.address, pair: pairIdentity() });
  assert.equal(first.sourceWallet, source.address);
  assert.equal(first.requester, outsider.address);
  assert.equal(first.operationId, second.operationId);
  assert.notEqual(first.message, second.message);
  assert.match(first.message, /not the source owner's consent/);
  assert.match(first.message, /helper receives no credit/);
  const config = await fixture.service.configuration();
  assert.equal(config.helper.enabled, true);
  assert.equal(config.helper.recipientConsent, false);
});

test("the derived source wallet must use owner consent, not a contradictory helper challenge", async () => {
  const fixture = helperFixture();
  await assert.rejects(fixture.service.helperChallenge({ requester: source.address.toLowerCase(), pair: pairIdentity() }),
    { code: "RECOVERY_HELPER_USE_OWNER_FLOW", status: 409 });
  assert.equal(fixture.pairCalls, 1);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
  assert.equal(fixture.ledger.rows.size, 0);
  const ownerChallenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  assert.equal(ownerChallenge.wallet, source.address);
  assert.match(ownerChallenge.message, /RetryCredit recovery consent/);
});

test("a correctly signed same-wallet helper request is refused before source, ledger or proof work", async () => {
  const fixture = helperFixture();
  const original = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const ownerAsHelper = { ...original, requester: source.address };
  ownerAsHelper.message = formatRecoveryHelperMessage({ ...ownerAsHelper,
    ...ownerAsHelper.pair, origin: "https://retrycredit.example" });
  const request = await signedHelperRequest(ownerAsHelper, source);
  const pairCalls = fixture.pairCalls;
  fixture.ledger.read = async () => { assert.fail("same-wallet helper must not read or reserve ledger state"); };
  fixture.ledger.reserve = async () => { assert.fail("same-wallet helper must not reserve spending"); };
  await assert.rejects(fixture.service.helperRelease(request), { code: "RECOVERY_HELPER_USE_OWNER_FLOW", status: 409 });
  assert.equal(fixture.pairCalls, pairCalls);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
  assert.equal(fixture.ledger.rows.size, 0);
  await assert.rejects(fixture.service.helperRelease({ ...request, signature: await outsider.signMessage(ownerAsHelper.message) }),
    { code: "RECOVERY_SIGNATURE_INVALID", status: 401 });
});

test("helper policy is bound to the exact writer identity and funded credit before admission", async () => {
  for (const changed of [
    { chainId: 1 }, { poolAddress: outsider.address }, { campaignNumber: 8 }, { relayerAddress: outsider.address },
  ]) {
    const ledger = fakeHelperLedger();
    Object.assign(ledger.policy.identity, changed);
    assert.throws(() => helperFixture({ helperLedger: ledger }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  }
  const ledger = fakeHelperLedger();
  ledger.policy.limits.creditWei = "1";
  const fixture = helperFixture({ helperLedger: ledger });
  const challenge = await helperFixture().service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  await assert.rejects(fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  await assert.rejects(fixture.service.intakeChallenge({ pair: pairIdentity() }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  await assert.rejects(fixture.service.challenge(source.address), { code: "INVALID_RECOVERY_CONFIGURATION" });
  assert.equal((await fixture.service.intakeEligibility({ pair: pairIdentity() })).hostedAdmission.admissionState, "unavailable");
  await assert.rejects(fixture.service.helperRelease(await signedHelperRequest(challenge, outsider)), { code: "INVALID_RECOVERY_CONFIGURATION" });
  assert.equal(fixture.proofCalls, 0);
  assert.equal(ledger.rows.size, 0);
  const lateLedger = fakeHelperLedger();
  lateLedger.policy.limits.expiresAt = now + 3601;
  const lateFixture = helperFixture({ helperLedger: lateLedger });
  await assert.rejects(lateFixture.service.readiness(), { code: "INVALID_RECOVERY_CONFIGURATION" });
  await assert.rejects(lateFixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  await assert.rejects(lateFixture.service.intakeChallenge({ pair: pairIdentity() }), { code: "INVALID_RECOVERY_CONFIGURATION" });
  await assert.rejects(lateFixture.service.challenge(source.address), { code: "INVALID_RECOVERY_CONFIGURATION" });
  assert.equal((await lateFixture.service.configuration()).helper.admissionState, "unavailable");
  await assert.rejects(lateFixture.service.helperRelease(await signedHelperRequest(challenge, outsider)), { code: "INVALID_RECOVERY_CONFIGURATION" });
  assert.equal(lateFixture.proofCalls, 0);
});

test("helper availability follows the durable budget without taking read-only recovery offline", async () => {
  const fixture = helperFixture();
  assert.equal((await fixture.service.configuration()).helper.admissionState, "available");
  for (const [expected, patch] of [
    ["paused", { enabled: false }],
    ["busy", { activeOperationId: `0x${"aa".repeat(32)}` }],
    ["budget-exhausted", { payouts: 9 }],
  ]) {
    fixture.ledger.inspect = async () => ({ enabled: true, attempts: 0, payouts: 0,
      reservedFeeWei: "0", activeOperationId: null, ...patch });
    const config = await fixture.service.configuration();
    assert.equal(config.enabled, true);
    assert.equal(config.helper.enabled, true);
    assert.equal(config.helper.available, false);
    assert.equal(config.helper.admissionState, expected);
  }
  fixture.ledger.inspect = async () => { throw new Error("private coordinator outage"); };
  const config = await fixture.service.configuration();
  assert.equal(config.enabled, true);
  assert.equal(config.helper.admissionState, "unavailable");
  assert.equal((await fixture.service.intakeEligibility({ pair: pairIdentity() })).eligible, true);
  assert.equal(fixture.proofCalls, 0);
});

test("owner and helper challenges expose fresh hosted admission without changing helper-disabled responses", async () => {
  const fixture = helperFixture();
  const available = { available: true, admissionState: "available", operation: null };
  assert.deepEqual((await fixture.service.intakeEligibility({ pair: pairIdentity() })).hostedAdmission, available);
  assert.deepEqual((await fixture.service.challenge(source.address)).hostedAdmission, available);
  assert.deepEqual((await fixture.service.intakeChallenge({ pair: pairIdentity() })).hostedAdmission, available);
  assert.deepEqual((await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() })).hostedAdmission, available);
  const legacy = serviceFixture();
  for (const result of [await legacy.service.intakeEligibility({ pair: pairIdentity() }),
    await legacy.service.challenge(source.address), await legacy.service.intakeChallenge({ pair: pairIdentity() })]) {
    assert.equal(Object.hasOwn(result, "hostedAdmission"), false);
  }
  assert.equal(fixture.ledger.rows.size, 0);
  assert.equal(fixture.proofCalls, 0);
});

test("fresh hosted admission blocks futile owner and helper signatures while preserving qualified discovery", async () => {
  for (const [state, code, mutate] of [
    ["paused", "HELPER_LEDGER_PAUSED", ledger => { ledger.inspect = async () => ({ ...admissionSnapshot(), enabled: false }); }],
    ["busy", "HELPER_LEDGER_BUSY", ledger => { ledger.inspect = async () => ({ ...admissionSnapshot(), activeOperationId: `0x${"aa".repeat(32)}` }); }],
    ["budget-exhausted", "HELPER_LEDGER_BUDGET_EXHAUSTED", ledger => { ledger.inspect = async () => ({ ...admissionSnapshot(), attempts: 12 }); }],
    ["budget-exhausted", "HELPER_LEDGER_BUDGET_EXHAUSTED", ledger => { ledger.inspect = async () => ({ ...admissionSnapshot(), payouts: 9 }); }],
    ["budget-exhausted", "HELPER_LEDGER_BUDGET_EXHAUSTED", ledger => { ledger.inspect = async () => ({ ...admissionSnapshot(), reservedFeeWei: "18000000000000000" }); }],
    ["unavailable", "RECOVERY_HELPER_UNAVAILABLE", ledger => { ledger.inspect = async () => { throw new Error("private outage"); }; }],
    ["unavailable", "RECOVERY_HELPER_UNAVAILABLE", ledger => { ledger.readSource = async () => { throw new Error("source read outage"); }; }],
    ["paused", "HELPER_LEDGER_PAUSED", (_ledger, fixture) => { fixture.setNow(now + 1_800); }],
  ]) {
    const ledger = fakeHelperLedger();
    ledger.policy.limits.expiresAt = now + 1_800;
    const fixture = helperFixture({ helperLedger: ledger, helperCandidates: [pairIdentity()],
      walletDiscovery: async () => ({ transactions: [], pages: 1, truncated: false, pairs: [pairIdentity()] }) });
    // An earlier configuration response cannot authorize a later signature.
    assert.equal((await fixture.service.configuration()).helper.available, true);
    ledger.reserve = async () => { assert.fail("advisory reads must not reserve"); };
    mutate(ledger, fixture);
    const eligibility = await fixture.service.intakeEligibility({ pair: pairIdentity() });
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.status, "eligible");
    assert.deepEqual(eligibility.hostedAdmission, { available: false, admissionState: state, operation: null });
    const discovery = await fixture.service.discover(source.address);
    assert.equal(discovery.matches[0].eligible, true);
    assert.deepEqual(discovery.matches[0].hostedAdmission, eligibility.hostedAdmission);
    for (const challenge of [() => fixture.service.challenge(source.address),
      () => fixture.service.intakeChallenge({ pair: pairIdentity() }),
      () => fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() })]) {
      await assert.rejects(challenge(), { code });
    }
    assert.equal(fixture.proofCalls, 0);
    assert.equal(fixture.releaseCalls, 0);
    assert.equal(ledger.rows.size, 0);
  }
});

test("a stopped source operation on a different pair blocks fresh signatures but not source eligibility", async () => {
  const fixture = helperFixture({ walletDiscovery: async () => ({ transactions: [], pages: 1, truncated: false, pairs: [pairIdentity()] }) });
  const original = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const alternatePair = pairIdentity(`0x${"77".repeat(32)}`, `0x${"78".repeat(32)}`);
  const operation = { ...original, operationId: `0x${"79".repeat(32)}`, pair: alternatePair,
    state: "stopped", reason: "proof-unavailable", permitToken: "private-test-permit", signature: "private-test-signature" };
  fixture.ledger.rows.set(operation.operationId, operation);
  fixture.ledger.reserve = async () => { assert.fail("source-status reads must not reserve"); };
  const result = await fixture.service.intakeEligibility({ pair: pairIdentity() });
  assert.equal(result.eligible, true);
  assert.equal(result.hostedAdmission.admissionState, "source-reserved");
  assert.equal(result.hostedAdmission.available, false);
  assert.deepEqual(result.hostedAdmission.operation.pair, alternatePair);
  assert.equal(result.hostedAdmission.operation.mode, "community-helper-v1");
  assert.equal(result.hostedAdmission.operation.requester, outsider.address);
  assert.equal(result.hostedAdmission.operation.sourceWallet, source.address);
  assert.equal(JSON.stringify(result).includes("private-test"), false);
  assert.deepEqual((await fixture.service.discover(source.address)).matches[0].hostedAdmission, result.hostedAdmission);
  for (const challenge of [() => fixture.service.challenge(source.address),
    () => fixture.service.intakeChallenge({ pair: pairIdentity() }),
    () => fixture.service.helperChallenge({ requester: secondSource.address, pair: pairIdentity() })]) {
    await assert.rejects(challenge(), { code: "RECOVERY_PROCESSING" });
  }
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.releaseCalls, 0);
});

function admissionSnapshot() {
  return { enabled: true, attempts: 0, payouts: 0, reservedFeeWei: "0", activeOperationId: null };
}

test("helper signatures reject tampering and old owner signatures before live or proof work", async () => {
  const fixture = helperFixture();
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const request = await signedHelperRequest(challenge, outsider);
  const pairsBefore = fixture.pairCalls;
  for (const bad of [
    { ...request, requester: secondSource.address },
    { ...request, sourceWallet: outsider.address },
    { ...request, operationId: `0x${"99".repeat(32)}` },
    { ...request, expiresAt: request.expiresAt + 1 },
    { ...request, pair: pairIdentity(successHash, failedHash) },
    { ...request, recipient: outsider.address },
    { ...request, signature: await outsider.signMessage("RetryCredit recovery consent") },
  ]) await assert.rejects(fixture.service.helperRelease(bad));
  assert.equal(fixture.pairCalls, pairsBefore);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.ledger.rows.size, 0);
});

test("even a valid helper signature cannot substitute the independently derived source", async () => {
  const fixture = helperFixture();
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const { helperOperationId } = await import("../src/helper-ledger-policy.mjs");
  const changed = { ...challenge, sourceWallet: secondSource.address };
  changed.operationId = helperOperationId({ chainId: 102031, poolAddress, campaignNumber: 7, relayerAddress: relayer.address }, changed.sourceWallet, changed.pair);
  changed.message = formatRecoveryHelperMessage({ ...changed, origin: "https://retrycredit.example", ...changed.pair });
  await assert.rejects(fixture.service.helperRelease(await signedHelperRequest(changed, outsider)), { code: "RECOVERY_PAIR_WALLET_MISMATCH" });
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.ledger.rows.size, 0);
});

test("helper returns durable status while proof runs, and only the source receives the fixed credit", async () => {
  let unblock;
  const fixture = helperFixture({ proofBuilderOverride: async ({ resolved }) => {
    await new Promise(resolve => { unblock = resolve; });
    return { success: true, data: batchProofFixture(resolved) };
  } });
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  // Both helpers can obtain advisory consent before either reserves the source.
  const second = await fixture.service.helperChallenge({ requester: secondSource.address, pair: pairIdentity() });
  const result = await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
  assert.equal(result.state, "admitted");
  while (!unblock) await nextTurn();
  assert.equal((await fixture.service.helperOperation(result.operationId)).state, "admitted");
  await assert.rejects(fixture.service.helperChallenge({ requester: secondSource.address, pair: pairIdentity() }), { code: "RECOVERY_PROCESSING" });
  const duplicate = await fixture.service.helperRelease(await signedHelperRequest(second, secondSource));
  assert.equal(duplicate.operationId, result.operationId);
  assert.equal(fixture.proofCalls, 1);
  unblock();
  await fixture.service.helperOperations.get(result.operationId);
  const settled = await fixture.service.helperOperation(result.operationId);
  assert.equal(settled.state, "settled");
  assert.equal(settled.sourceWallet, source.address);
  assert.equal(settled.helperReceivesCredit, false);
  assert.equal(fixture.balance(), parseEther("0.01"));
  assert.equal(fixture.releaseCalls, 1);
  assert.equal(fixture.ledger.prepares, 1);
  assert.equal(JSON.stringify(settled).includes("permitToken"), false);
  assert.equal(JSON.stringify(settled).includes("signature"), false);
});

test("owner consent semantics remain unchanged but paid execution shares helper admission", async () => {
  const fixture = helperFixture();
  const challenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
  assert.match(challenge.message, /RetryCredit recovery consent/);
  assert.doesNotMatch(challenge.message, /community helper/);
  const result = await fixture.service.intakeRelease(await signedIntakeRequest(challenge, source));
  assert.equal(result.status, "released");
  assert.equal([...fixture.ledger.rows.values()][0].mode, "owner");
  assert.equal(fixture.ledger.prepares, 1);
});

test("durable coordinator rejection stops both owner and helper before proof work", async () => {
  for (const owner of [false, true]) {
    const ledger = fakeHelperLedger({ reserveError: Object.assign(new Error("secret"), { code: "HELPER_LEDGER_BUDGET_EXHAUSTED", status: 429 }) });
    const fixture = helperFixture({ helperLedger: ledger });
    if (owner) {
      const challenge = await fixture.service.intakeChallenge({ pair: pairIdentity() });
      await assert.rejects(fixture.service.intakeRelease(await signedIntakeRequest(challenge, source)), { code: "HELPER_LEDGER_BUDGET_EXHAUSTED" });
    } else {
      const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
      await assert.rejects(fixture.service.helperRelease(await signedHelperRequest(challenge, outsider)), { code: "HELPER_LEDGER_BUDGET_EXHAUSTED" });
    }
    assert.equal(fixture.proofCalls, 0);
    assert.equal(fixture.releaseCalls, 0);
  }
});

test("proof and fee failures consume their admission without sending or retrying", async () => {
  for (const options of [
    { proofResult: { success: false } },
    { ccProviderOverride: { async getFeeData() { return { gasPrice: 1_000_000_000_000n }; } } },
    { ccProviderOverride: { async getTransactionCount(_address, tag) { return tag === "pending" ? 11 : 10; } } },
  ]) {
    const fixture = helperFixture(options);
    const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
    const request = await signedHelperRequest(challenge, outsider);
    const operation = await fixture.service.helperRelease(request);
    await fixture.service.helperOperations.get(operation.operationId);
    assert.equal((await fixture.service.helperOperation(operation.operationId)).state, "stopped");
    await fixture.service.helperRelease(request);
    assert.equal(fixture.proofCalls, 1);
    assert.equal(fixture.releaseCalls, 0);
    assert.equal(fixture.ledger.prepares, 0);
  }
});

test("lost preparation acknowledgment and ambiguous broadcast never release the durable lock or resend", async () => {
  for (const stage of ["prepare", "broadcast"]) {
    const fixture = helperFixture({
      helperLedger: fakeHelperLedger({ losePrepareAck: stage === "prepare" }),
      ccProviderOverride: stage === "broadcast" ? { async broadcastTransaction() { throw new Error("unknown response"); } } : {},
    });
    const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
    const request = await signedHelperRequest(challenge, outsider);
    const result = await fixture.service.helperRelease(request);
    await fixture.service.helperOperations.get(result.operationId);
    const status = await fixture.service.helperOperation(result.operationId);
    assert.equal(status.state, "broadcast-prepared");
    assert.match(status.transactionHash, /^0x[0-9a-f]{64}$/);
    await fixture.service.helperRelease(request);
    assert.equal(fixture.proofCalls, 1);
    assert.equal(fixture.releaseCalls, 0);
    assert.equal(fixture.ledger.prepares, 1);
  }
});

test("helper status reconciles a mined receipt after a lost completion response without new work", async () => {
  const fixture = helperFixture({ helperLedger: fakeHelperLedger({ loseCompleteOnce: true }) });
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const operation = await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
  await fixture.service.helperOperations.get(operation.operationId);
  assert.equal(fixture.ledger.rows.get(operation.operationId).state, "broadcast-prepared");
  fixture.service.helperOperations.clear();
  assert.equal((await fixture.service.helperOperation(operation.operationId)).state, "settled");
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.releaseCalls, 1);
});

test("helper broadcast guard stays authoritative after proof and after durable transaction preparation", async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    const fixture = helperFixture({ beforeBroadcast() {
      if (++calls === failAt) throw new WorkerError("RECOVERY_VERIFICATION_REQUIRED", "Verification unavailable", 503);
    } });
    const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
    const operation = await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
    await fixture.service.helperOperations.get(operation.operationId);
    const status = await fixture.service.helperOperation(operation.operationId);
    assert.equal(status.state, failAt === 1 ? "stopped" : "broadcast-prepared");
    assert.equal(fixture.releaseCalls, 0);
  }
});

test("helper restart receipt reconciliation refuses a success without the exact pool release", async () => {
  const fixture = helperFixture({ ccProviderOverride: { async broadcastTransaction() { throw new Error("ambiguous"); } } });
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const operation = await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
  await fixture.service.helperOperations.get(operation.operationId);
  const saved = fixture.ledger.rows.get(operation.operationId);
  fixture.service.ccProvider.getTransactionReceipt = async () => ({ hash: saved.transactionHash, status: 1, blockNumber: 501, logs: [] });
  const result = await fixture.service.helperOperation(operation.operationId);
  assert.equal(result.state, "broadcast-prepared");
  assert.equal(fixture.proofCalls, 1);
  assert.equal(fixture.releaseCalls, 0);
});

test("a confirmed reverted helper transaction stays consumed and releases no credit", async () => {
  const fixture = helperFixture({ ccProviderOverride: { async broadcastTransaction() { throw new Error("ambiguous"); } } });
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  const operation = await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
  await fixture.service.helperOperations.get(operation.operationId);
  const saved = fixture.ledger.rows.get(operation.operationId);
  fixture.service.ccProvider.getTransactionReceipt = async () => ({ hash: saved.transactionHash, status: 0, blockNumber: 501, logs: [] });
  assert.equal((await fixture.service.helperOperation(operation.operationId)).state, "reverted");
  assert.equal(fixture.balance(), 0n);
  await fixture.service.helperRelease(await signedHelperRequest(challenge, outsider));
  assert.equal(fixture.proofCalls, 1);
});

test("bounded helper discovery derives a source without wallet, proof, or spending admission", async () => {
  const fixture = helperFixture({ helperCandidates: [pairIdentity()] });
  const result = await fixture.service.helperDiscover({});
  assert.equal(result.status, "found");
  assert.equal(result.match.wallet, source.address);
  assert.equal(result.checkedCandidates, 1);
  assert.equal(fixture.proofCalls, 0);
  assert.equal(fixture.ledger.rows.size, 0);
  await assert.rejects(fixture.service.helperDiscover({ recipient: outsider.address }), { code: "RECOVERY_REQUEST_INVALID" });
});

test("helper discovery bounds a pass to four candidates and distinguishes partial from exhaustion", async () => {
  const candidates = Array.from({ length: 6 }, (_, index) => pairIdentity(`0x${String(80 + index).repeat(32)}`, `0x${String(90 + index).repeat(32)}`));
  const fixture = helperFixture({ helperCandidates: candidates, pairResolverOverride: () => {
    throw new WorkerError("RECOVERY_PAIR_INVALID", "No match", 422);
  } });
  const result = await fixture.service.helperDiscover({});
  assert.equal(result.status, "none-in-window");
  assert.equal(result.checkedCandidates, 4);
  assert.equal(result.moreCandidates, true);
  assert.equal(fixture.pairCalls, 4);
  assert.equal(fixture.proofCalls, 0);
  const empty = helperFixture({ helperCandidates: [] });
  assert.equal((await empty.service.helperDiscover({})).status, "exhausted");
});

test("helper discovery skips a source reserved under a different pair", async () => {
  const fixture = helperFixture({ helperCandidates: [pairIdentity()] });
  const challenge = await fixture.service.helperChallenge({ requester: outsider.address, pair: pairIdentity() });
  fixture.ledger.rows.set("unrelated-pair-id", { ...challenge, pair: pairIdentity(`0x${"77".repeat(32)}`, `0x${"78".repeat(32)}`), state: "stopped" });
  const result = await fixture.service.helperDiscover({});
  assert.equal(result.status, "exhausted");
  assert.equal(result.match, null);
  assert.equal(fixture.proofCalls, 0);
});

function helperFixture(options = {}) {
  const ledger = options.helperLedger ?? fakeHelperLedger();
  const fixture = serviceFixture({ helperMaxFeeWei: "2000000000000000", ...options,
    helperLedger: ledger, configOverride: { contractVersion: "v2", ...options.configOverride } });
  return { ...fixture, ledger, get proofCalls() { return fixture.proofCalls; },
    get pairCalls() { return fixture.pairCalls; }, get releaseCalls() { return fixture.releaseCalls; } };
}

async function signedHelperRequest(challenge, signer) {
  const { requester, sourceWallet, pair, operationId, issuedAt, expiresAt } = challenge;
  return { requester, sourceWallet, pair, operationId, issuedAt, expiresAt, signature: await signer.signMessage(challenge.message) };
}

function fakeHelperLedger({ reserveError, losePrepareAck = false, loseCompleteOnce = false } = {}) {
  const rows = new Map();
  let prepares = 0;
  return {
    policy: {
      identity: { chainId: 102031, poolAddress, campaignNumber: 7, relayerAddress: relayer.address },
      limits: { maxAttempts: 12, maxPayouts: 9, maxTotalFeeWei: "18000000000000000",
        maxFeeWei: "2000000000000000", creditWei: parseEther("0.01").toString(), expiresAt: now + 3600 },
    },
    rows, get prepares() { return prepares; },
    async inspect() { return { enabled: true, attempts: rows.size, payouts: rows.size,
      reservedFeeWei: (BigInt(rows.size) * 2000000000000000n).toString(),
      activeOperationId: [...rows.values()].find(row => ["admitted", "broadcast-prepared"].includes(row.state))?.operationId ?? null }; },
    async read({ operationId }) { return { operation: rows.has(operationId) ? { ...rows.get(operationId) } : null }; },
    async readSource({ sourceWallet }) { return { operation: [...rows.values()].find(row => row.sourceWallet.toLowerCase() === sourceWallet.toLowerCase()) ?? null }; },
    async reserve(input) {
      if (reserveError) throw reserveError;
      if (rows.has(input.operationId)) return { created: false, operation: { ...rows.get(input.operationId) } };
      if ([...rows.values()].some(row => row.sourceWallet === input.sourceWallet || ["admitted", "broadcast-prepared"].includes(row.state))) {
        throw Object.assign(new Error("busy"), { code: "HELPER_LEDGER_BUSY", status: 409 });
      }
      const operation = { ...input, state: "admitted" };
      rows.set(input.operationId, operation);
      return { created: true, permitToken: "private-test-permit", operation: { ...operation } };
    },
    async prepareBroadcast({ operationId, transactionHash, nonce }) {
      prepares += 1;
      const row = rows.get(operationId);
      if (row.state !== "admitted") return { broadcastPermit: false };
      Object.assign(row, { state: "broadcast-prepared", transactionHash, nonce });
      if (losePrepareAck) throw new Error("lost acknowledgment");
      return { broadcastPermit: true, operation: { ...row } };
    },
    async failBeforeBroadcast({ operationId, reason }) {
      const row = rows.get(operationId);
      assert.equal(row.state, "admitted");
      Object.assign(row, { state: "stopped", reason });
      return { operation: { ...row } };
    },
    async complete(input) {
      assert.deepEqual(Object.keys(input).sort(), ["blockNumber", "operationId", "receiptStatus", "transactionHash"]);
      if (loseCompleteOnce) { loseCompleteOnce = false; throw new Error("lost completion"); }
      const row = rows.get(input.operationId);
      assert.equal(row.transactionHash, input.transactionHash);
      Object.assign(row, { state: input.receiptStatus === 1 ? "settled" : "reverted", blockNumber: input.blockNumber });
      return { operation: { ...row } };
    },
  };
}

function diagnosticSourceFacts() {
  const nft = outsider.address;
  const mintParams = [7n, 2n, 1000n, 2000n, 1n, 100n, 1000n, true];
  const calldata = salt => SEA_DROP_INTERFACE.encodeFunctionData("mintSigned", [
    nft, feeRecipient, ZeroAddress, 2n, mintParams, salt, `0x${"11".repeat(65)}`,
  ]);
  const common = { chainId: 1n, type: 2, from: source.address, to: SEA_DROP_MAINNET, value: 14n };
  const failedTransaction = { ...common, hash: failedHash, blockNumber: 100, nonce: 15, data: calldata(1n) };
  const successfulTransaction = { ...common, hash: successHash, blockNumber: 102, nonce: 16, data: calldata(2n) };
  const transfer = new Interface(["event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)"]);
  const logs = [1n, 2n].map(tokenId => ({ address: nft, ...transfer.encodeEventLog("Transfer", [ZeroAddress, source.address, tokenId]) }));
  logs.push({ address: SEA_DROP_MAINNET, ...SEA_DROP_INTERFACE.encodeEventLog("SeaDropMint", [nft, source.address, feeRecipient, source.address, 2n, 7n, 1000n, 1n]) });
  const receipt = (tx, status, receiptLogs) => ({ hash: tx.hash, from: tx.from, to: tx.to, blockNumber: tx.blockNumber, status, logs: receiptLogs });
  return { failedTransaction, successfulTransaction, failedReceipt: receipt(failedTransaction, 0, []), successfulReceipt: receipt(successfulTransaction, 1, logs) };
}

function serviceFixture({
  beforeBroadcast,
  helperLedger,
  helperMaxFeeWei,
  helperCandidates,
  ccProviderOverride = {},
  pairOverride = {},
  pairResolverOverride,
  campaignOverride = {},
  proofResult,
  proofBuilderOverride,
  ethereumProviders = [],
  useEthereumResolver = false,
  replayConsumed = false,
  predecessorReplayConsumed = false,
  sponsorReplayConsumed = false,
  verifierPredicate = predicateAddress,
  campaignReaderOverride,
  ruleReaderOverride,
  claimedReaderOverride,
  releasesUnlocked = true,
  predecessorClaimed = false,
  sponsorClaimed = false,
  lineageOverride = {},
  configOverride = {},
  walletDiscovery,
} = {}) {
  let currentNow = now;
  let pairCalls = 0;
  let proofCalls = 0;
  let staticCalls = 0;
  let releaseCalls = 0;
  let sourceBalance = 0n;
  let campaignReads = 0;
  let ruleReads = 0;
  let claimedReads = 0;
  const claimedWallets = new Set();
  const logQueries = [];
  const consumedQueries = new Set();
  const consumedPairs = new Set();
  if (replayConsumed) consumedPairs.add(contractPairId);
  const releases = [];
  let broadcastHash = null;
  let latestReceipt = null;
  const campaign = {
    sponsor: relayer.address,
    creditAmount: parseEther("0.01"),
    maxClaims: 3n,
    claimCount: 0n,
    deadline: BigInt(now + 3_600),
    fundedAmount: parseEther("0.03"),
    termsHash: id("campaign-terms"),
    remainderRecovered: false,
    ...campaignOverride,
  };
  const rule = {
    feeRecipient,
    startBlock: 90n,
    endBlock: 110n,
    maxBlockGap: 10n,
    maxQuantity: 2n,
  };
  const releaseCredit = async () => {
    releaseCalls += 1;
    claimedWallets.add(source.address.toLowerCase());
    campaign.claimCount += 1n;
    sourceBalance += campaign.creditAmount;
    consumedQueries.add(failureQueryId);
    consumedQueries.add(successQueryId);
    consumedPairs.add(contractPairId);
    const transactionHash = broadcastHash ?? `0x${"71".repeat(32)}`;
    const blockNumber = 500;
    const encoded = interface_.encodeEventLog(interface_.getEvent("CreditReleased"), [
      7n,
      source.address,
      actionId,
      campaign.creditAmount,
      failureQueryId,
      successQueryId,
      contractPairId,
      relayer.address,
      campaign.claimCount,
    ]);
    const log = { address: poolAddress, topics: encoded.topics, data: encoded.data };
    const parsed = interface_.parseLog(log);
    releases.push({ address: poolAddress, transactionHash, blockNumber, args: parsed.args });
    return {
      hash: transactionHash,
      async wait() {
        latestReceipt = { status: 1, hash: transactionHash, blockNumber, logs: [log] };
        return latestReceipt;
      },
    };
  };
  releaseCredit.staticCall = async () => { staticCalls += 1; };
  const pool = {
    target: poolAddress,
    filters: { CreditReleased: () => ({}) },
    async retryVerifier() { return verifierAddress; },
    async predicate() { return predicateAddress; },
    async chainInfo() { return "0x0000000000000000000000000000000000000fd3"; },
    async SOURCE_CHAIN_KEY() { return 3n; },
    async SOURCE_CHAIN_ID() { return 1n; },
    async LEGACY_CAMPAIGN_NUMBER() { return lineageOverride.campaignNumber ?? 1n; },
    async legacyPool() { return lineageOverride.poolAddress ?? predecessorPoolAddress; },
    async legacySponsor() { return lineageOverride.sponsor ?? relayer.address; },
    async legacyTermsHash() { return lineageOverride.termsHash ?? predecessorTermsHash; },
    async legacyBindingHash() { return lineageOverride.bindingHash ?? predecessorBindingHash; },
    async legacyStartBlock() { return lineageOverride.startBlock ?? 95n; },
    async legacyEndBlock() { return lineageOverride.endBlock ?? 105n; },
    async legacyDeadline() { return lineageOverride.deadline ?? BigInt(now + 1_800); },
    async releasesUnlocked() { return lineageOverride.releasesUnlocked ?? releasesUnlocked; },
    async getCampaign() {
      campaignReads += 1;
      if (campaignReaderOverride) return campaignReaderOverride({ campaign, rule });
      return { ...campaign };
    },
    async getRule() {
      ruleReads += 1;
      if (ruleReaderOverride) return ruleReaderOverride({ campaign, rule });
      return { ...rule };
    },
    async claimedByCampaign(_campaignNumber, wallet) {
      claimedReads += 1;
      if (claimedReaderOverride) return claimedReaderOverride({ wallet, claimedWallets });
      return claimedWallets.has(getAddress(wallet).toLowerCase());
    },
    async claimedBySponsor(sponsor, wallet) {
      assert.equal(getAddress(sponsor), getAddress(campaign.sponsor));
      return (sponsorClaimed || claimedWallets.has(getAddress(wallet).toLowerCase()))
        && getAddress(wallet) === source.address;
    },
    async consumedQueriesBySponsor(sponsor, queryId) {
      assert.equal(getAddress(sponsor), getAddress(campaign.sponsor));
      return sponsorReplayConsumed || consumedQueries.has(String(queryId).toLowerCase());
    },
    async consumedPairsBySponsor(sponsor, pairId) {
      assert.equal(getAddress(sponsor), getAddress(campaign.sponsor));
      return sponsorReplayConsumed || consumedPairs.has(String(pairId).toLowerCase());
    },
    async queryFilter(_filter, fromBlock, toBlock) {
      logQueries.push([fromBlock, toBlock]);
      return releases.filter(
        (release) => release.blockNumber >= fromBlock && release.blockNumber <= toBlock,
      );
    },
    async consumedQueries(campaignNumber, queryId) {
      assert.equal(Number(campaignNumber), 7);
      return consumedQueries.has(String(queryId).toLowerCase());
    },
    async consumedPairs(campaignNumber, pairId) {
      assert.equal(Number(campaignNumber), 7);
      return consumedPairs.has(String(pairId).toLowerCase());
    },
    releaseCredit,
  };
  const verifier = {
    target: verifierAddress,
    async predicate() { return verifierPredicate; },
    async verifier() { return "0x0000000000000000000000000000000000000fd2"; },
    async SOURCE_CHAIN_KEY() { return 3n; },
    async SOURCE_CHAIN_ID() { return 1n; },
  };
  const predicate = {
    target: predicateAddress,
    async ETHEREUM_CHAIN_ID() { return 1n; },
    async SEADROP() { return SEA_DROP_MAINNET; },
    async MINT_SIGNED_SELECTOR() { return MINT_SIGNED_SELECTOR; },
    async MAX_ATTESTCOIN_BATCH_BLOCK_GAP() { return 1_000n; },
  };
  const nativeVerifier = {
    target: "0x0000000000000000000000000000000000000fd2",
    async calculateTxIndex(merkleProof) {
      return merkleProof.root === `0x${"83".repeat(32)}` ? 3n : 5n;
    },
  };
  const predecessorPool = {
    target: lineageOverride.runnerAddress ?? predecessorPoolAddress,
    async claimedByCampaign(campaignNumber, wallet) {
      assert.equal(Number(campaignNumber), 1);
      return predecessorClaimed && getAddress(wallet) === source.address;
    },
    async consumedQueries(campaignNumber) {
      assert.equal(Number(campaignNumber), 1);
      return predecessorReplayConsumed;
    },
    async consumedPairs(campaignNumber) {
      assert.equal(Number(campaignNumber), 1);
      return predecessorReplayConsumed;
    },
  };
  const ccProvider = {
    async getNetwork() { return { chainId: 102031n }; },
    async getCode(address) {
      return getAddress(address) === poolAddress
        ? "0x6000"
        : lineageOverride.predecessorCode ?? "0x6000";
    },
    async getBalance() { return sourceBalance; },
    async getBlockNumber() { return 700; },
    async getFeeData() { return { gasPrice: 1_000_000_000n }; },
    async getTransactionCount() { return 10; },
    async estimateGas() { return 500_000n; },
    async broadcastTransaction(raw) {
      const transaction = Transaction.from(raw);
      assert.equal(transaction.from, relayer.address);
      assert.equal(transaction.to, poolAddress);
      assert.equal(transaction.chainId, 102031n);
      assert.equal(transaction.value, 0n);
      assert.equal(transaction.type, 0);
      assert.equal(transaction.nonce, 10);
      assert.ok(transaction.gasLimit * transaction.gasPrice <= BigInt(helperMaxFeeWei));
      broadcastHash = transaction.hash;
      return releaseCredit();
    },
    async getTransactionReceipt(hash) { return latestReceipt?.hash === hash ? latestReceipt : null; },
    ...ccProviderOverride,
  };
  const resolved = pairSummary(pairOverride);
  const builderResult = proofResult ?? { success: true, data: batchProofFixture(resolved) };
  const service = new RecoveryCampaignService({
    beforeBroadcast,
    helperLedger,
    helperMaxFeeWei,
    helperCandidates,
    poolAddress,
    campaignNumber: 7,
    ccProvider,
    relayerWallet: relayer,
    proofBuilder: {
      async getBatchProof(hashes) {
        proofCalls += 1;
        assert.deepEqual(hashes, [resolved.failed.transactionHash, resolved.successful.transactionHash]);
        if (proofBuilderOverride) return proofBuilderOverride({ hashes, resolved });
        return builderResult;
      },
    },
    publicOrigin: "https://retrycredit.example/path",
    poolContract: pool,
    verifierContract: verifier,
    predicateContract: predicate,
    nativeVerifierContract: nativeVerifier,
    predecessorPoolContract: predecessorPool,
    discoveryIndex,
    walletDiscovery,
    ethereumProviders,
    ...(!useEthereumResolver ? {
      async pairResolver(input) {
        pairCalls += 1;
        if (pairResolverOverride) return pairResolverOverride(input);
        if (input.discovery.wallet) assert.equal(input.discovery.wallet, source.address);
        return resolved;
      },
    } : {}),
    now: () => currentNow,
    config: {
      expectedRuntimeCodeHash: keccak256("0x6000"),
      expectedPredecessorRuntimeCodeHash: keccak256("0x6000"),
      releaseLogChunkBlocks: 100,
      releaseLogLookbackBlocks: 250,
      ...configOverride,
    },
  });
  return {
    service,
    setNow(value) { currentNow = value; },
    setCampaign(value) { Object.assign(campaign, value); },
    balance() { return sourceBalance; },
    get pairCalls() { return pairCalls; },
    get proofCalls() { return proofCalls; },
    get staticCalls() { return staticCalls; },
    get releaseCalls() { return releaseCalls; },
    get campaignReads() { return campaignReads; },
    get ruleReads() { return ruleReads; },
    get claimedReads() { return claimedReads; },
    get logQueries() { return logQueries.slice(); },
  };
}

async function signedRequest(challenge, signer) {
  return {
    wallet: challenge.wallet,
    message: challenge.message,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature: await signer.signMessage(challenge.message),
  };
}

async function signedIntakeRequest(challenge, signer, overrides = {}) {
  return {
    wallet: challenge.wallet,
    pair: { ...challenge.pair },
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature: await signer.signMessage(challenge.message),
    ...overrides,
  };
}

function pairIdentity(failedTransactionHash = failedHash, successfulTransactionHash = successHash) {
  return { failedTransactionHash, successfulTransactionHash };
}

async function rawSignedIntakeRequest({ wallet, pair, issuedAt = now, expiresAt = issuedAt + 300 }) {
  const message = recoveryChallengeMessage({
    origin: "https://retrycredit.example",
    poolAddress,
    campaignNumber: 7,
    wallet: wallet.address,
    failedTransactionHash: pair.failedTransactionHash,
    successfulTransactionHash: pair.successfulTransactionHash,
    issuedAt,
    expiresAt,
  });
  return {
    wallet: wallet.address,
    pair: { ...pair },
    issuedAt,
    expiresAt,
    signature: await wallet.signMessage(message),
  };
}

function summaryForPair(pair) {
  const base = pairSummary();
  return pairSummary({
    failed: { ...base.failed, transactionHash: pair.failedTransactionHash },
    successful: { ...base.successful, transactionHash: pair.successfulTransactionHash },
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("condition did not become true");
}

function pairSummary(overrides = {}) {
  return {
    kind: "seadrop-mint-signed-recovery",
    sourceChainId: 1,
    claimant: source.address,
    payer: source.address,
    recipient: source.address,
    seaDrop: SEA_DROP_MAINNET,
    nftContract: getAddress("0x4444444444444444444444444444444444444444"),
    feeRecipient,
    quantity: "2",
    mintPriceWei: "2500000000000000",
    valueWei: "5000000000000000",
    paid: true,
    blockGap: 2,
    nonceGap: 1,
    actionId,
    failed: { transactionHash: failedHash, blockNumber: 100, nonce: 7, status: 0, logCount: 0 },
    successful: {
      transactionHash: successHash,
      blockNumber: 102,
      nonce: 8,
      status: 1,
      mintedTokenIds: ["8", "9"],
    },
    ...overrides,
  };
}

function batchProofFixture(pair) {
  return {
    chainKey: 3,
    fromHeader: 100,
    toHeader: 102,
    continuityProof: {
      lowerEndpointDigest: `0x${"81".repeat(32)}`,
      roots: [`0x${"82".repeat(32)}`],
    },
    merkleProofs: new Map([
      [100, new Map([[3, {
        txHash: pair.failed.transactionHash,
        txBytes: encodedTransaction({ sender: pair.claimant, nonce: pair.failed.nonce, status: 0, value: pair.valueWei }),
        merkleProof: { root: `0x${"83".repeat(32)}`, siblings: [{ hash: `0x${"84".repeat(32)}`, isLeft: true }] },
      }]])],
      [102, new Map([[5, {
        txHash: pair.successful.transactionHash,
        txBytes: encodedTransaction({ sender: pair.claimant, nonce: pair.successful.nonce, status: 1, value: pair.valueWei }),
        merkleProof: { root: `0x${"85".repeat(32)}`, siblings: [{ hash: `0x${"86".repeat(32)}`, isLeft: false }] },
      }]])],
    ]),
  };
}

function encodedTransaction({ sender, nonce, status, value }) {
  const coder = AbiCoder.defaultAbiCoder();
  const common = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [nonce, 200_000, sender, false, SEA_DROP_MAINNET, value, `${MINT_SIGNED_SELECTOR}${"00".repeat(32)}`],
  );
  const receipt = coder.encode(
    ["uint8", "uint64", "tuple(address address_,bytes32[] topics,bytes data)[]", "bytes"],
    [status, 100_000, [], "0x"],
  );
  return coder.encode(["uint8", "bytes[]"], [2, [common, "0x", receipt]]);
}
