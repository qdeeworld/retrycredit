import assert from "node:assert/strict";
import test from "node:test";

import { Interface } from "ethers";

import {
  assertCreditReleasedEvent,
  classifyResumeCampaignState,
  extractRevertData,
  linkBytecode,
  normalizePairBatchProof,
  normalizeResumeState,
  parseRunnerCommand,
  requireEvent,
  resolveRunnerConfig,
  sanitizeEvidence,
  serializeRule,
  stringifyEvidence,
} from "../scripts/retrycredit-recovery-campaign-runner.mjs";

const FAILED_HASH = `0x${"11".repeat(32)}`;
const SUCCESS_HASH = `0x${"22".repeat(32)}`;
const EXPECTED_PAIR = Object.freeze({
  chainKey: 3,
  failed: Object.freeze({ transactionHash: FAILED_HASH, blockNumber: 100 }),
  successful: Object.freeze({ transactionHash: SUCCESS_HASH, blockNumber: 102 }),
});

test("links every declared Solidity library slot and rejects unsafe references", () => {
  const placeholder = `0x${"00".repeat(64)}`;
  const references = {
    "contracts/Decoder.sol": {
      EvmV1Decoder: [
        { start: 3, length: 20 },
        { start: 30, length: 20 },
      ],
    },
  };
  const address = "0x1234567890abcdef1234567890abcdef12345678";
  const linked = linkBytecode(placeholder, references, { EvmV1Decoder: address });
  assert.equal(linked.slice(2 + 3 * 2, 2 + 3 * 2 + 40), address.slice(2));
  assert.equal(linked.slice(2 + 30 * 2, 2 + 30 * 2 + 40), address.slice(2));
  assert.throws(
    () => linkBytecode(placeholder, references, {}),
    /missing deployed library/,
  );
  assert.throws(
    () => linkBytecode(placeholder, {
      A: { EvmV1Decoder: [{ start: 60, length: 20 }] },
    }, { EvmV1Decoder: address }),
    /out of bounds/,
  );
  assert.throws(
    () => linkBytecode(placeholder, {
      A: { EvmV1Decoder: [{ start: 3, length: 19 }] },
    }, { EvmV1Decoder: address }),
    /unsupported/,
  );
});

test("normalizes a pair-local Attestcoin batch into exact failure-success contract order", () => {
  const normalized = normalizePairBatchProof(batchFixture(), EXPECTED_PAIR);
  assert.equal(normalized.chainKey, 3);
  assert.deepEqual(normalized.transactionHashes, [FAILED_HASH, SUCCESS_HASH]);
  assert.deepEqual(normalized.sourceBlocks, [100, 102]);
  assert.deepEqual(normalized.transactionIndexes, [7, 2]);
  assert.deepEqual(normalized.encodedTransactions, ["0x1234", "0xabcd"]);
  assert.equal(normalized.merkleProofs[0].root, `0x${"33".repeat(32)}`);
  assert.equal(normalized.merkleProofs[1].siblings[0].isLeft, false);
  assert.equal(normalized.lowerEndpointDigest, `0x${"77".repeat(32)}`);
  assert.deepEqual(normalized.continuityRoots, [
    `0x${"88".repeat(32)}`,
    `0x${"99".repeat(32)}`,
  ]);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.merkleProofs[0].siblings), true);
});

test("rejects proof batches that drift from the exact hashes, blocks, range, or order", () => {
  const wrongChain = batchFixture();
  wrongChain.chainKey = 4;
  assert.throws(() => normalizePairBatchProof(wrongChain, EXPECTED_PAIR), /unexpected source chain key/);

  const wrongBlock = batchFixture();
  const successEntry = wrongBlock.merkleProofs.get(102);
  wrongBlock.merkleProofs.delete(102);
  wrongBlock.merkleProofs.set(103, successEntry);
  assert.throws(() => normalizePairBatchProof(wrongBlock, EXPECTED_PAIR), /source block did not match/);

  const unexpectedHash = batchFixture();
  unexpectedHash.merkleProofs.get(100).get(7).txHash = `0x${"aa".repeat(32)}`;
  assert.throws(() => normalizePairBatchProof(unexpectedHash, EXPECTED_PAIR), /unexpected transaction/);

  const missingCoverage = batchFixture();
  missingCoverage.toHeader = 101;
  assert.throws(() => normalizePairBatchProof(missingCoverage, EXPECTED_PAIR), /does not cover/);

  const duplicate = batchFixture();
  duplicate.merkleProofs.get(100).set(9, {
    ...duplicate.merkleProofs.get(100).get(7),
  });
  assert.throws(() => normalizePairBatchProof(duplicate, EXPECTED_PAIR), /duplicate transaction/);
});

test("requires exactly one named event from the bound campaign emitter", () => {
  const campaignAddress = "0x1111111111111111111111111111111111111111";
  const spoofAddress = "0x2222222222222222222222222222222222222222";
  const contractInterface = new Interface([
    "event CreditReleased(uint256 indexed campaignNumber,address indexed beneficiary,bytes32 indexed actionId,uint256 creditAmount,bytes32 failureQueryId,bytes32 successQueryId,bytes32 pairId,address relayer,uint32 claimCount)",
  ]);
  const encoded = contractInterface.encodeEventLog(
    contractInterface.getEvent("CreditReleased"),
    [
      1n,
      "0x3333333333333333333333333333333333333333",
      `0x${"44".repeat(32)}`,
      100n,
      `0x${"55".repeat(32)}`,
      `0x${"66".repeat(32)}`,
      `0x${"77".repeat(32)}`,
      "0x8888888888888888888888888888888888888888",
      1,
    ],
  );
  const real = { address: campaignAddress, topics: encoded.topics, data: encoded.data };
  const spoof = { ...real, address: spoofAddress };
  const event = requireEvent(
    contractInterface,
    { logs: [spoof, real] },
    "CreditReleased",
    campaignAddress,
  );
  assert.equal(event.campaignNumber, 1n);
  assert.throws(
    () => requireEvent(contractInterface, { logs: [spoof] }, "CreditReleased", campaignAddress),
    /exactly one CreditReleased/,
  );
  assert.throws(
    () => requireEvent(contractInterface, { logs: [real, real] }, "CreditReleased", campaignAddress),
    /exactly one CreditReleased/,
  );
});

test("validates every existing release event field against the proof identity", () => {
  const operator = "0x8888888888888888888888888888888888888888";
  const expected = {
    beneficiary: "0x3333333333333333333333333333333333333333",
    actionId: `0x${"44".repeat(32)}`,
    failureQueryId: `0x${"55".repeat(32)}`,
    successQueryId: `0x${"66".repeat(32)}`,
    pairId: `0x${"77".repeat(32)}`,
  };
  const event = {
    campaignNumber: 1n,
    beneficiary: expected.beneficiary,
    actionId: expected.actionId,
    creditAmount: 100_000_000_000_000_000n,
    failureQueryId: expected.failureQueryId,
    successQueryId: expected.successQueryId,
    pairId: expected.pairId,
    relayer: operator,
    claimCount: 1n,
  };
  assert.doesNotThrow(() => assertCreditReleasedEvent({
    event,
    campaignNumber: 1n,
    operator,
    expected,
  }));

  for (const [field, value] of [
    ["campaignNumber", 2n],
    ["beneficiary", "0x9999999999999999999999999999999999999999"],
    ["actionId", `0x${"aa".repeat(32)}`],
    ["creditAmount", 1n],
    ["failureQueryId", `0x${"aa".repeat(32)}`],
    ["successQueryId", `0x${"aa".repeat(32)}`],
    ["pairId", `0x${"aa".repeat(32)}`],
    ["relayer", "0x9999999999999999999999999999999999999999"],
    ["claimCount", 2n],
  ]) {
    assert.throws(
      () => assertCreditReleasedEvent({
        event: { ...event, [field]: value },
        campaignNumber: 1n,
        operator,
        expected,
      }),
      /did not match/,
    );
  }
});

test("serializes the exact campaign rule without bigint precision loss", () => {
  assert.deepEqual(serializeRule({
    feeRecipient: "0x0000a26b00c1f0df003000390027140000faa719",
    startBlock: 25_805_168n,
    endBlock: 25_835_360n,
    maxBlockGap: 5n,
    maxQuantity: 2n,
  }), {
    feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
    startBlock: 25_805_168,
    endBlock: 25_835_360,
    maxBlockGap: 5,
    maxQuantity: 2,
  });

  const resultInterface = new Interface([
    "function getRule(uint256) view returns ((address feeRecipient,uint64 startBlock,uint64 endBlock,uint32 maxBlockGap,uint8 maxQuantity))",
  ]);
  const encoded = resultInterface.encodeFunctionResult("getRule", [[
    "0x0000a26b00c1f0df003000390027140000faa719",
    25_805_168n,
    25_835_360n,
    5n,
    2n,
  ]]);
  const tuple = resultInterface.decodeFunctionResult("getRule", encoded)[0];
  assert.equal(Array.isArray(tuple), true);
  assert.deepEqual(serializeRule(tuple), {
    feeRecipient: "0x0000a26b00c1F0DF003000390027140000fAa719",
    startBlock: 25_805_168,
    endBlock: 25_835_360,
    maxBlockGap: 5,
    maxQuantity: 2,
  });
  assert.throws(() => serializeRule({}), /fee recipient/);
});

test("requires an explicit run or resume command and resolves mode-specific config", () => {
  assert.equal(parseRunnerCommand(["run"]), "run");
  assert.equal(parseRunnerCommand(["resume"]), "resume");
  assert.throws(() => parseRunnerCommand([]), /<run\|resume>/);
  assert.throws(() => parseRunnerCommand(["run", "resume"]), /<run\|resume>/);
  assert.throws(() => parseRunnerCommand(["deploy"]), /<run\|resume>/);

  const privateKey = `0x${"12".repeat(32)}`;
  const run = resolveRunnerConfig("run", { SPIKE_PRIVATE_KEY: privateKey });
  assert.equal(run.command, "run");
  assert.equal(run.resumeStatePath, null);
  assert.match(run.cc3Rpc, /^https:\/\//);
  assert.match(run.proofBuilderUrl, /^https:\/\//);

  assert.throws(
    () => resolveRunnerConfig("resume", { SPIKE_PRIVATE_KEY: privateKey }),
    /RECOVERY_RESUME_STATE_PATH/,
  );
  const resume = resolveRunnerConfig("resume", {
    SPIKE_PRIVATE_KEY: privateKey,
    RECOVERY_RESUME_STATE_PATH: "fixtures/recovery-resume.json",
    CREDITCOIN_RPC: "https://cc3.example.invalid",
    CREDITCOIN_PROOF_BUILDER_URL: "https://proof.example.invalid",
  });
  assert.equal(resume.command, "resume");
  assert.equal(resume.resumeStatePath.endsWith("/fixtures/recovery-resume.json"), true);
  assert.equal(resume.cc3Rpc, "https://cc3.example.invalid");
  assert.equal(resume.proofBuilderUrl, "https://proof.example.invalid");
});

test("normalizes only an exact failed lifecycle resume state", () => {
  const fixture = resumeStateFixture();
  const normalized = normalizeResumeState(fixture);
  assert.equal(normalized.operator, "0x1111111111111111111111111111111111111111");
  assert.equal(normalized.campaign.number, 1);
  assert.equal(normalized.campaign.creditAmount, 100_000_000_000_000_000n);
  assert.equal(normalized.campaign.fundedAmount, 300_000_000_000_000_000n);
  assert.equal(normalized.deployments.campaign.address, "0x5555555555555555555555555555555555555555");
  assert.equal(Object.isFrozen(normalized), true);
  const mutableTransactions = { ...normalized.transactions };
  assert.doesNotThrow(() => {
    mutableTransactions.release = `0x${"77".repeat(32)}`;
  });

  const retryResume = structuredClone(fixture);
  retryResume.mode = "bounded-resume-only";
  assert.equal(normalizeResumeState(retryResume).campaign.number, 1);

  const wrongSchema = structuredClone(fixture);
  wrongSchema.schemaVersion = "retrycredit.unknown.v1";
  assert.throws(() => normalizeResumeState(wrongSchema), /schema version/);

  const wrongChain = structuredClone(fixture);
  wrongChain.partial.networks.destinationChainId = 1;
  assert.throws(() => normalizeResumeState(wrongChain), /network identity/);

  const wrongRule = structuredClone(fixture);
  wrongRule.partial.rule.maxBlockGap = 6;
  assert.throws(() => normalizeResumeState(wrongRule), /bounded campaign rule/);

  const wrongFunding = structuredClone(fixture);
  wrongFunding.partial.campaign.fundedAmount = "299999999999999999";
  assert.throws(() => normalizeResumeState(wrongFunding), /funding or duration/);

  const missingDeployment = structuredClone(fixture);
  delete missingDeployment.partial.deployments.verifier;
  assert.throws(() => normalizeResumeState(missingDeployment), /verifier deployment/);

  const duplicateAddress = structuredClone(fixture);
  duplicateAddress.partial.deployments.campaign.address =
    duplicateAddress.partial.deployments.verifier.address;
  assert.throws(() => normalizeResumeState(duplicateAddress), /must be distinct/);

  const duplicateTransaction = structuredClone(fixture);
  duplicateTransaction.partial.deployments.campaign.transactionHash =
    duplicateTransaction.partial.deployments.verifier.transactionHash;
  assert.throws(() => normalizeResumeState(duplicateTransaction), /transactions must be distinct/);

  const mismatchedCreation = structuredClone(fixture);
  mismatchedCreation.partial.transactions.campaignCreation = `0x${"99".repeat(32)}`;
  assert.throws(() => normalizeResumeState(mismatchedCreation), /transaction hashes differ/);

  const successful = structuredClone(fixture);
  successful.passed = true;
  assert.throws(() => normalizeResumeState(successful), /failed bounded/);

  const unsafeNumericFunding = structuredClone(fixture);
  unsafeNumericFunding.partial.campaign.fundedAmount = 300_000_000_000_000_000;
  assert.throws(() => normalizeResumeState(unsafeNumericFunding), /unsigned integer/);
});

test("classifies only untouched state or one exact landed release for resume", () => {
  const untouched = resumeCampaignStateFixture();
  assert.equal(classifyResumeCampaignState(untouched), "untouched");

  const landed = resumeCampaignStateFixture({ released: true });
  assert.equal(classifyResumeCampaignState(landed), "existing-release");

  const partialBurn = resumeCampaignStateFixture();
  partialBurn.failureQueryConsumed = true;
  assert.throws(() => classifyResumeCampaignState(partialBurn), /neither untouched nor one exact/);

  const wrongReleasedBalance = resumeCampaignStateFixture({ released: true });
  wrongReleasedBalance.contractBalance += 1n;
  assert.throws(
    () => classifyResumeCampaignState(wrongReleasedBalance),
    /neither untouched nor one exact/,
  );

  const secondClaim = resumeCampaignStateFixture({ released: true });
  secondClaim.campaign.claimCount = 2n;
  assert.throws(() => classifyResumeCampaignState(secondClaim), /neither untouched nor one exact/);

  const invalidBoolean = resumeCampaignStateFixture();
  invalidBoolean.claimed = 0;
  assert.throws(() => classifyResumeCampaignState(invalidBoolean), /claimed must be boolean/);
});

test("extracts nested revert data without depending on a provider error shape", () => {
  const data = "0xabcdef12";
  assert.equal(extractRevertData({ data }), data);
  assert.equal(extractRevertData({ info: { error: { data: { result: data } } } }), data);
  assert.equal(extractRevertData({ error: { data: { data } } }), data);
  assert.equal(extractRevertData(new Error("no data")), null);
});

test("sanitizes secrets, RPC URLs, and private paths while preserving public hashes", () => {
  const privateKey = `0x${"ab".repeat(32)}`;
  const transactionHash = `0x${"cd".repeat(32)}`;
  const value = sanitizeEvidence({
    transactionHash,
    privateKey,
    rpcUrl: "https://rpc.example.invalid/key/abc",
    error: `failed at /Users/example/Projects/retrycredit/private.json using ${privateKey}`,
    amount: 100n,
  }, [privateKey]);
  assert.equal(value.transactionHash, transactionHash);
  assert.equal(value.privateKey, "[redacted]");
  assert.equal(value.rpcUrl, "[redacted]");
  assert.equal(value.amount, "100");
  assert.doesNotMatch(value.error, /qdee|retrycredit|ab{8}/i);
});

test("stringifies evidence canonically with no secret, URL, or private path leakage", () => {
  const privateKey = `0x${"ef".repeat(32)}`;
  const output = stringifyEvidence({
    z: 2n,
    a: {
      url: "https://prover.example.invalid",
      path: "/tmp/private/evidence.json",
      secret: privateKey,
    },
  }, [privateKey]);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.indexOf('"a"'), output.indexOf("{" ) + 4);
  assert.doesNotMatch(output, /https:\/\/|\/tmp\/|efefef|private\/evidence/);
  assert.match(output, /\"z\": \"2\"/);
  assert.deepEqual(JSON.parse(output), {
    a: { path: "[redacted-path]", secret: "[redacted]", url: "[redacted]" },
    z: "2",
  });
});

function batchFixture() {
  return {
    chainKey: 3,
    fromHeader: 99,
    toHeader: 103,
    merkleProofs: new Map([
      [102, new Map([[2, {
        txHash: SUCCESS_HASH.toUpperCase().replace("0X", "0x"),
        txBytes: "0xABCD",
        merkleProof: {
          root: `0x${"55".repeat(32)}`,
          siblings: [{ hash: `0x${"66".repeat(32)}`, isLeft: false }],
        },
      }]])],
      [100, new Map([[7, {
        txHash: FAILED_HASH,
        txBytes: "0x1234",
        merkleProof: {
          root: `0x${"33".repeat(32)}`,
          siblings: [{ hash: `0x${"44".repeat(32)}`, isLeft: true }],
        },
      }]])],
    ]),
    continuityProof: {
      lowerEndpointDigest: `0x${"77".repeat(32)}`,
      roots: [`0x${"88".repeat(32)}`, `0x${"99".repeat(32)}`],
    },
  };
}

function resumeStateFixture() {
  const deployment = (addressByte, hashByte, blockNumber, runtimeByte) => ({
    address: `0x${addressByte.repeat(40)}`,
    transactionHash: `0x${hashByte.repeat(64)}`,
    blockNumber,
    runtimeCodeHash: `0x${runtimeByte.repeat(64)}`,
  });
  const campaignCreation = `0x${"55".repeat(32)}`;
  return {
    schemaVersion: "retrycredit.recovery-campaign-evidence.v1",
    mode: "bounded-all-in-one",
    passed: false,
    stage: "simulate-release",
    partial: {
      networks: {
        destinationChainId: 102_031,
        sourceChainId: 1,
        sourceChainKey: 3,
      },
      operator: "0x1111111111111111111111111111111111111111",
      deployments: {
        decoder: deployment("2", "1", 101, "a"),
        predicate: deployment("3", "2", 102, "b"),
        verifier: deployment("4", "3", 103, "c"),
        campaign: deployment("5", "4", 104, "d"),
      },
      transactions: { campaignCreation },
      rule: {
        feeRecipient: "0x0000a26b00c1f0df003000390027140000faa719",
        startBlock: 25_805_168,
        endBlock: 25_835_360,
        maxBlockGap: 5,
        maxQuantity: 2,
      },
      campaign: {
        number: "1",
        creationTransactionHash: campaignCreation,
        creationBlockNumber: 105,
        deadline: 1_900_000_000,
        durationSeconds: 1_209_600,
        creditAmount: "100000000000000000",
        maxClaims: "3",
        fundedAmount: "300000000000000000",
        termsHash: `0x${"66".repeat(32)}`,
        initialAccountedBalance: "300000000000000000",
      },
    },
  };
}

function resumeCampaignStateFixture({ released = false } = {}) {
  const remaining = released ? 200_000_000_000_000_000n : 300_000_000_000_000_000n;
  return {
    campaign: { claimCount: released ? 1n : 0n },
    accountedBalance: remaining,
    remainingAccounted: remaining,
    contractBalance: remaining,
    claimed: released,
    failureQueryConsumed: released,
    successQueryConsumed: released,
    pairConsumed: released,
  };
}
