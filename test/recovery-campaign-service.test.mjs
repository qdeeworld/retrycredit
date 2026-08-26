import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Wallet,
  getAddress,
  id,
  parseEther,
} from "ethers";

import {
  RECOVERY_DISCOVERY_INDEX,
  RecoveryCampaignService,
  deriveRecoveryReplayIds,
  normalizeRecoveryBatchProof,
} from "../src/recovery-campaign-service.mjs";
import { recoveryCampaignAbi } from "../src/pool-abi.mjs";
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
  assert.equal(config.poolAddress, poolAddress);
  assert.equal(config.verifierAddress, verifierAddress);
  assert.equal(config.predicateAddress, predicateAddress);
  assert.equal(config.campaignNumber, 7);
  assert.equal(config.campaign.creditAmount, parseEther("0.01").toString());
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

test("release receipt scans reject unsafe provider ranges", () => {
  for (const configOverride of [
    { releaseLogChunkBlocks: 0 },
    { releaseLogChunkBlocks: 50_001 },
    { releaseLogChunkBlocks: 500, releaseLogLookbackBlocks: 499 },
    { releaseLogLookbackBlocks: 1_000_001 },
  ]) {
    assert.throws(
      () => serviceFixture({ configOverride }),
      (error) => error instanceof WorkerError && error.code === "INVALID_RECOVERY_CONFIGURATION",
    );
  }
});

test("a discovery miss never invokes live-pair authority", async () => {
  const fixture = serviceFixture();
  const result = await fixture.service.eligibility(outsider.address);
  assert.equal(result.status, "not-found");
  assert.equal(result.eligible, false);
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
  campaignOverride = {},
  proofResult,
  replayConsumed = false,
  verifierPredicate = predicateAddress,
  configOverride = {},
} = {}) {
  let currentNow = now;
  let pairCalls = 0;
  let proofCalls = 0;
  let staticCalls = 0;
  let releaseCalls = 0;
  let sourceBalance = 0n;
  let claimed = false;
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
    claimed = true;
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
    async getCampaign() { return { ...campaign }; },
    async getRule() { return { ...rule }; },
    async claimedByCampaign() { return claimed; },
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
  const ccProvider = {
    async getNetwork() { return { chainId: 102031n }; },
    async getCode() { return "0x6000"; },
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
        assert.deepEqual(hashes, [failedHash, successHash]);
        return builderResult;
      },
    },
    publicOrigin: "https://retrycredit.example/path",
    poolContract: pool,
    verifierContract: verifier,
    predicateContract: predicate,
    nativeVerifierContract: nativeVerifier,
    discoveryIndex,
    async pairResolver({ discovery }) {
      pairCalls += 1;
      assert.equal(discovery.wallet, source.address);
      return resolved;
    },
    now: () => currentNow,
    config: {
      releaseLogChunkBlocks: 100,
      releaseLogLookbackBlocks: 250,
      ...configOverride,
    },
  });
  return {
    service,
    setNow(value) { currentNow = value; },
    balance() { return sourceBalance; },
    get pairCalls() { return pairCalls; },
    get proofCalls() { return proofCalls; },
    get staticCalls() { return staticCalls; },
    get releaseCalls() { return releaseCalls; },
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
