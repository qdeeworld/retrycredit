import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Wallet,
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
import { MINT_SIGNED_SELECTOR, SEA_DROP_MAINNET } from "../src/seadrop-recovery.mjs";
import { WorkerError } from "../src/proof-worker.mjs";

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
  assert.deepEqual(config.consent, { scope: "hosted-relayer", protocolEnforced: false });
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
  assert.deepEqual(result.matches.map(({ eligible, status }) => ({ eligible, status })), [
    { eligible: true, status: "eligible" },
  ]);
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
    { sourceLookupConcurrency: 0 },
    { sourceLookupQueueLimit: 257 },
    { sourceLookupTimeoutMs: 121_000 },
    { intakeTimeoutMs: 999 },
    { intakeTimeoutMs: 120_001 },
    { sourceProviderAttempts: 4 },
    { sourcePairCacheMaxEntries: 0 },
    { sourcePairCacheTtlSeconds: 3_601 },
    { sourcePairNegativeCacheTtlSeconds: 301 },
    { campaignStateCacheTtlSeconds: 0 },
    { campaignStateCacheTtlSeconds: 11 },
    { releaseQueueLimit: 0 },
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
  for (const provider of service.ethereumProviders) {
    assert.equal(provider._getConnection().timeout, 6_000);
    assert.ok(provider._getConnection().timeout * 3 < 20_000);
  }
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

function serviceFixture({
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
    const transactionHash = `0x${"71".repeat(32)}`;
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
      async wait() {
        return { status: 1, hash: transactionHash, blockNumber, logs: [log] };
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
  };
  const resolved = pairSummary(pairOverride);
  const builderResult = proofResult ?? { success: true, data: batchProofFixture(resolved) };
  const service = new RecoveryCampaignService({
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
