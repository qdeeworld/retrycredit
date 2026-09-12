import assert from "node:assert/strict";
import test from "node:test";

import { ethers } from "ethers";

import {
  MINT_SIGNED_SELECTOR,
  OPEN_SEA_CALLDATA_SUFFIX,
  OPEN_SEA_FEE_RECIPIENT,
  SEA_DROP_INTERFACE,
  SEA_DROP_MAINNET,
  SeaDropRecoveryError,
  decodeCanonicalSeaDropMintSigned,
  inspectSeaDropRecoveryPair,
  normalizeSeaDropRecoveryProfile,
  validateSeaDropRecoveryPair,
} from "../src/seadrop-recovery.mjs";
import { buildRecoveryPairDiagnostics, serializeRecoveryPairDiagnostics } from "../src/recovery-pair-diagnostics.mjs";

const ERC721_INTERFACE = new ethers.Interface([
  "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
]);

const NFT = ethers.getAddress("0x39dc450bc38e173b02f9141317af581502fc12a2");
const CLAIMANT = ethers.getAddress("0x61ceFF58C74dE887604E0A680bF1058a9D5b74D1");
const OTHER = ethers.getAddress("0x1111111111111111111111111111111111111111");
const PAID_MINT_PARAMS = Object.freeze({
  mintPrice: 2_500_000_000_000_000n,
  maxTotalMintableByWallet: 2n,
  startTime: 1_787_690_824n,
  endTime: 1_787_694_424n,
  dropStageIndex: 2n,
  maxTokenSupplyForStage: 250n,
  feeBps: 1_000n,
  restrictFeeRecipients: true,
});

test("decodes only canonical SeaDrop mintSigned calldata", () => {
  const fixture = makeFixture();
  const decoded = decodeCanonicalSeaDropMintSigned(fixture.failedTransaction.data);

  assert.equal(MINT_SIGNED_SELECTOR, "0x4b61cd6f");
  assert.equal(decoded.nftContract, NFT);
  assert.equal(decoded.feeRecipient, OPEN_SEA_FEE_RECIPIENT);
  assert.equal(decoded.quantity, 2n);
  assert.equal(decoded.mintParams.mintPrice, 2_500_000_000_000_000n);
  assert.equal(decoded.mintParams.restrictFeeRecipients, true);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.mintParams), true);

  assert.throws(
    () => decodeCanonicalSeaDropMintSigned(`0xdeadbeef${fixture.failedTransaction.data.slice(10)}`),
    errorWithCode("INVALID_SELECTOR"),
  );
  assert.throws(
    () => decodeCanonicalSeaDropMintSigned(`${fixture.failedTransaction.data}00`),
    errorWithCode("NON_CANONICAL_CALLDATA"),
  );

  const attributed = withOpenSeaSuffix(fixture.failedTransaction.data);
  assert.equal(
    decodeCanonicalSeaDropMintSigned(attributed).calldataSuffix,
    OPEN_SEA_CALLDATA_SUFFIX,
  );
  assert.throws(
    () => decodeCanonicalSeaDropMintSigned(`${attributed.slice(0, -8)}deadbeef`),
    errorWithCode("NON_CANONICAL_CALLDATA"),
  );
});

test("validates an exact paid recovery and derives the payout-safe semantic summary", () => {
  const fixture = makeFixture();
  const summary = validateSeaDropRecoveryPair(fixture);

  assert.deepEqual(
    {
      kind: summary.kind,
      sourceChainId: summary.sourceChainId,
      claimant: summary.claimant,
      payer: summary.payer,
      recipient: summary.recipient,
      paid: summary.paid,
      quantity: summary.quantity,
      valueWei: summary.valueWei,
      blockGap: summary.blockGap,
      nonceGap: summary.nonceGap,
      authorizationRefreshed: summary.authorizationRefreshed,
      mintedTokenIds: summary.successful.mintedTokenIds,
    },
    {
      kind: "seadrop-mint-signed-recovery",
      sourceChainId: 1,
      claimant: CLAIMANT,
      payer: CLAIMANT,
      recipient: CLAIMANT,
      paid: true,
      quantity: "2",
      valueWei: "5000000000000000",
      blockGap: 2,
      nonceGap: 1,
      authorizationRefreshed: true,
      mintedTokenIds: ["56", "57"],
    },
  );
  assert.match(summary.stableActionDigest, /^0x[0-9a-f]{64}$/);
  assert.match(summary.sourcePairDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(summary), true);
});

test("accepts identical salt and signature because refreshed authorization is not semantic identity", () => {
  const fixture = makeFixture({ sameAuthorization: true });
  const summary = validateSeaDropRecoveryPair(fixture);
  assert.equal(summary.authorizationRefreshed, false);
});

test("supports an explicitly profiled free recovery without weakening paid campaigns", () => {
  const fixture = makeFixture({
    quantity: 1n,
    valueWei: 0n,
    mintParams: {
      ...PAID_MINT_PARAMS,
      mintPrice: 0n,
      maxTotalMintableByWallet: 1n,
      maxTokenSupplyForStage: 3_000n,
    },
    requirePaid: false,
    tokenIds: [516n],
  });
  assert.equal(validateSeaDropRecoveryPair(fixture).paid, false);

  fixture.profile.requirePaid = true;
  assert.throws(
    () => validateSeaDropRecoveryPair(fixture),
    errorWithCode("INVALID_PROFILE"),
  );
});

test("rejects transaction, order, receipt, and stable-action false positives", async (context) => {
  const cases = [
    ["non-type-2 failure", (value) => { value.failedTransaction.type = 0; }],
    ["non-type-2 success", (value) => { value.successfulTransaction.type = 1; }],
    ["different sender", (value) => {
      value.successfulTransaction.from = OTHER;
      value.successfulReceipt.from = OTHER;
    }],
    ["different target", (value) => {
      value.successfulTransaction.to = OTHER;
      value.successfulReceipt.to = OTHER;
    }],
    ["non-consecutive nonce", (value) => { value.successfulTransaction.nonce += 1; }],
    ["reversed block order", (value) => {
      value.successfulTransaction.blockNumber = value.failedTransaction.blockNumber;
      value.successfulReceipt.blockNumber = value.failedReceipt.blockNumber;
    }],
    ["excessive block gap", (value) => {
      value.successfulTransaction.blockNumber += 5;
      value.successfulReceipt.blockNumber += 5;
    }],
    ["failure succeeded", (value) => { value.failedReceipt.status = 1; }],
    ["success failed", (value) => { value.successfulReceipt.status = 0; }],
    ["failure emitted logs", (value) => {
      value.failedReceipt.logs.push({
        address: NFT,
        topics: [`0x${"99".repeat(32)}`],
        data: "0x",
      });
    }],
    ["stable value changed", (value) => { value.successfulTransaction.value += 1n; }],
    ["stable quantity changed", (value) => {
      value.successfulTransaction.data = encodeMint({
        quantity: 1n,
        mintParams: value.profile.mintParams,
        salt: 2n,
        signatureByte: "22",
      });
    }],
    ["stable fee recipient changed", (value) => {
      value.successfulTransaction.data = encodeMint({
        feeRecipient: OTHER,
        quantity: value.profile.quantity,
        mintParams: value.profile.mintParams,
        salt: 2n,
        signatureByte: "22",
      });
    }],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const fixture = makeFixture();
      mutate(fixture);
      assert.throws(() => validateSeaDropRecoveryPair(fixture), SeaDropRecoveryError);
    });
  }
});

test("rejects missing, forged, duplicated, or misordered successful outcomes", async (context) => {
  const cases = [
    ["missing SeaDropMint", (value) => { value.successfulReceipt.logs.pop(); }],
    ["duplicate SeaDropMint", (value) => {
      value.successfulReceipt.logs.push(value.successfulReceipt.logs.at(-1));
    }],
    ["missing transfer", (value) => { value.successfulReceipt.logs.shift(); }],
    ["extra transfer", (value) => {
      value.successfulReceipt.logs.unshift(transferLog(CLAIMANT, 58n));
    }],
    ["wrong transfer recipient", (value) => {
      value.successfulReceipt.logs[0] = transferLog(OTHER, 56n);
    }],
    ["transfer after SeaDropMint", (value) => {
      value.successfulReceipt.logs.push(value.successfulReceipt.logs.shift());
    }],
    ["wrong SeaDrop payer", (value) => {
      value.successfulReceipt.logs[value.successfulReceipt.logs.length - 1] = seaDropMintLog({
        payer: OTHER,
      });
    }],
    ["wrong event quantity", (value) => {
      value.successfulReceipt.logs[value.successfulReceipt.logs.length - 1] = seaDropMintLog({
        quantity: 1n,
      });
    }],
    ["wrong event price", (value) => {
      value.successfulReceipt.logs[value.successfulReceipt.logs.length - 1] = seaDropMintLog({
        mintPrice: 1n,
      });
    }],
    ["extra event topic", (value) => {
      value.successfulReceipt.logs.at(-1).topics.push(`0x${"33".repeat(32)}`);
    }],
    ["nonempty ERC-721 event data", (value) => {
      value.successfulReceipt.logs[0].data = `0x${"00".repeat(32)}`;
    }],
  ];

  for (const [name, mutate] of cases) {
    await context.test(name, () => {
      const fixture = makeFixture();
      mutate(fixture);
      assert.throws(() => validateSeaDropRecoveryPair(fixture), errorWithCode("INVALID_SUCCESS"));
    });
  }
});

test("requires a complete exact campaign profile", () => {
  const fixture = makeFixture();
  assert.deepEqual(
    normalizeSeaDropRecoveryProfile(fixture.profile),
    normalizeSeaDropRecoveryProfile(fixture.profile),
  );

  const wrongFee = { ...fixture.profile, feeRecipient: OTHER };
  assert.throws(
    () => validateSeaDropRecoveryPair({ ...fixture, profile: wrongFee }),
    errorWithCode("SEMANTIC_MISMATCH"),
  );
  assert.throws(
    () => normalizeSeaDropRecoveryProfile({ ...fixture.profile, requirePaid: undefined }),
    errorWithCode("INVALID_PROFILE"),
  );
  assert.throws(
    () => normalizeSeaDropRecoveryProfile({ ...fixture.profile, minterIfNotPayer: OTHER }),
    errorWithCode("INVALID_PROFILE"),
  );
  assert.throws(
    () => normalizeSeaDropRecoveryProfile({
      ...fixture.profile,
      mintParams: { ...fixture.profile.mintParams, restrictFeeRecipients: false },
    }),
    errorWithCode("INVALID_PROFILE"),
  );
});

test("advisory checks reuse the valid mint boundary without creating an eligibility or proof result", () => {
  const fixture = makeFixture();
  const options = diagnosticOptions(fixture);
  const inspection = inspectSeaDropRecoveryPair({ ...fixture, pair: options.pair, rule: options.rule });
  assert.equal(inspection.checks.length, 13);
  assert(inspection.checks.every(check => check.status === "pass"));
  assert.equal(buildRecoveryPairDiagnostics(options), null, "a rejection report requires a failed check");
  assert.equal(validateSeaDropRecoveryPair(fixture).claimant, CLAIMANT);
});

test("advisory reports distinguish supported mismatches using the same public source facts", async (t) => {
  const cases = [
    ["source-network", fixture => { fixture.failedTransaction.chainId = 11155111n; }],
    ["transaction-type", fixture => { fixture.failedTransaction.type = 0; }],
    ["action-family", fixture => { fixture.failedTransaction.data = "0xdeadbeef"; }],
    ["same-wallet", fixture => { fixture.successfulTransaction.from = OTHER; fixture.successfulReceipt.from = OTHER; }],
    ["receipt-status", fixture => { fixture.failedReceipt.status = 1; }],
    ["nonce-order", fixture => { fixture.successfulTransaction.nonce += 1; }],
    ["block-gap", fixture => { fixture.successfulTransaction.blockNumber = 108; fixture.successfulReceipt.blockNumber = 108; }],
    ["campaign-window", (_fixture, options) => { options.rule.endBlock = 101; }],
    ["paid-mint", fixture => { fixture.failedTransaction.value = 0n; }],
    ["mint-identity", fixture => { fixture.successfulTransaction.value += 1n; }],
    ["mint-outcome", fixture => { fixture.successfulReceipt.logs.pop(); }],
    ["campaign-fee-recipient", (_fixture, options) => { options.rule.feeRecipient = OTHER; }],
    ["campaign-quantity", (_fixture, options) => { options.rule.maxQuantity = 1; }],
  ];
  for (const [expected, mutate] of cases) await t.test(expected, () => {
    const fixture = makeFixture();
    const options = diagnosticOptions(fixture);
    mutate(fixture, options);
    const report = buildRecoveryPairDiagnostics(options);
    assert(report);
    assert.equal(report.checks.find(check => check.id === expected).status, "fail");
    assert.equal(report.authority, "advisory-source-check");
    assert.equal(report.attestationVerified, false);
    assert.equal(report.campaign.termsHash, ethers.id("diagnostic-campaign"));
    assert.equal(report.campaign.creditAmount, "100000000000000000");
    assert.deepEqual(report.facts.failed, { blockNumber: 100, nonce: 15, status: fixture.failedReceipt.status });
    assert.equal("eligible" in report, false);
    assert.equal(Object.isFrozen(report.checks[0]), true);
    if (expected === "action-family") {
      assert.equal(report.checks.find(check => check.id === "mint-outcome").status, "not-checked");
    }
    if (!expected.startsWith("campaign-")) assert.throws(() => validateSeaDropRecoveryPair(fixture));
  });
});

test("missing, inconsistent, or unbound source facts never produce an advisory rejection report", () => {
  for (const mutate of [
    options => { options.facts.failedReceipt = null; },
    options => { options.facts.failedReceipt.hash = options.pair.successfulTransactionHash; },
    options => { options.facts.successfulReceipt.from = OTHER; },
    options => { options.facts.successfulReceipt.logs = null; },
    options => { options.facts.failedTransaction.blockHash = ethers.id("fork-a"); options.facts.failedReceipt.blockHash = ethers.id("fork-b"); },
    options => { options.pair.failedTransactionHash = ethers.id("different-request"); },
  ]) {
    const options = diagnosticOptions(makeFixture());
    options.rule.endBlock = 101;
    mutate(options);
    assert.equal(buildRecoveryPairDiagnostics(options), null);
  }
});

test("a reversed pair cannot hide either transaction's out-of-window block", () => {
  for (const [failedBlock, successfulBlock] of [[111, 102], [100, 89]]) {
    const fixture = makeFixture();
    fixture.failedTransaction.blockNumber = fixture.failedReceipt.blockNumber = failedBlock;
    fixture.successfulTransaction.blockNumber = fixture.successfulReceipt.blockNumber = successfulBlock;
    const report = buildRecoveryPairDiagnostics(diagnosticOptions(fixture));
    assert.equal(report.checks.find(check => check.id === "block-gap").status, "fail");
    assert.equal(report.checks.find(check => check.id === "campaign-window").status, "fail");
    assert.throws(() => validateSeaDropRecoveryPair(fixture));
  }
});

test("incomplete or malformed provider calldata never becomes an advisory action rejection", async (t) => {
  for (const transactionName of ["failedTransaction", "successfulTransaction"]) {
    for (const [label, value] of [["missing", undefined], ["null", null], ["non-string", 123], ["non-hex", "0xzz"], ["odd-length", "0x1"]]) {
      await t.test(`${transactionName} ${label}`, () => {
        const options = diagnosticOptions(makeFixture());
        options.rule.endBlock = 101;
        if (value === undefined) delete options.facts[transactionName].data;
        else options.facts[transactionName].data = value;
        assert.equal(buildRecoveryPairDiagnostics(options), null);
      });
    }
  }
});

test("explicit empty calldata is a semantic mismatch and complete input aliases remain supported", () => {
  for (const transactionName of ["failedTransaction", "successfulTransaction"]) {
    const options = diagnosticOptions(makeFixture());
    options.facts[transactionName].data = "0x";
    const report = buildRecoveryPairDiagnostics(options);
    assert.equal(report.checks.find(check => check.id === "action-family").status, "fail");

    const inputOptions = diagnosticOptions(makeFixture());
    inputOptions.rule.endBlock = 101;
    inputOptions.facts[transactionName].input = inputOptions.facts[transactionName].data;
    delete inputOptions.facts[transactionName].data;
    const inputReport = buildRecoveryPairDiagnostics(inputOptions);
    assert.equal(inputReport.checks.find(check => check.id === "action-family").status, "pass");
    assert.equal(inputReport.checks.find(check => check.id === "campaign-window").status, "fail");
  }
});

test("diagnostic clock failures are contained in the formatter and never replace resolver errors", () => {
  for (const now of [() => { throw new Error("SECRET_CLOCK_FAILURE"); }, () => NaN]) {
    const options = diagnosticOptions(makeFixture());
    options.rule.endBlock = 101;
    delete options.checkedAt;
    options.now = now;
    assert.equal(buildRecoveryPairDiagnostics(options), null);
  }
});

test("diagnostic serialization keeps fixed text and strips causes, provider data, and unknown fields", () => {
  const options = diagnosticOptions(makeFixture());
  options.rule.endBlock = 101;
  const report = buildRecoveryPairDiagnostics(options);
  const injected = {
    ...report,
    summary: "SECRET_PROVIDER_RESPONSE",
    rawTransaction: "SECRET_RAW_TRANSACTION",
    cause: { message: "SECRET_PROVIDER_CAUSE" },
    checks: report.checks.map(check => ({ ...check, label: "SECRET_LABEL", message: "SECRET_MESSAGE", secret: "SECRET_CHECK" })),
    campaign: { ...report.campaign, privateKey: "SECRET_KEY" },
    facts: { ...report.facts, failed: { ...report.facts.failed, raw: "SECRET_FACT" } },
  };
  assert.deepEqual(serializeRecoveryPairDiagnostics(injected), report);
  assert.doesNotMatch(JSON.stringify(serializeRecoveryPairDiagnostics(injected)), /SECRET|privateKey|rawTransaction/);
  for (const update of [
    { attestationVerified: true },
    { authority: "native-proof" },
    { checkedAt: "invalid" },
    { checks: report.checks.map(check => ({ ...check, status: "verified" })) },
    { checks: report.checks.map(check => ({ ...check, status: "pass" })) },
    { campaign: { ...report.campaign, termsHash: `0x${"0".repeat(64)}` } },
  ]) assert.equal(serializeRecoveryPairDiagnostics({ ...report, ...update }), null);
});

function diagnosticOptions(facts) {
  return {
    facts,
    pair: { failedTransactionHash: facts.failedTransaction.hash, successfulTransactionHash: facts.successfulTransaction.hash },
    rule: { startBlock: 90, endBlock: 110, maxBlockGap: 5, maxQuantity: 2, feeRecipient: OPEN_SEA_FEE_RECIPIENT },
    campaign: { poolAddress: OTHER, campaignNumber: 1, termsHash: ethers.id("diagnostic-campaign"), creditAmount: "100000000000000000", deadline: 2000000000 },
    checkedAt: "2026-09-12T08:00:00.000Z",
  };
}

function makeFixture({
  quantity = 2n,
  valueWei = quantity * PAID_MINT_PARAMS.mintPrice,
  mintParams = PAID_MINT_PARAMS,
  requirePaid = true,
  sameAuthorization = false,
  tokenIds = [56n, 57n],
  calldataSuffix = "0x",
} = {}) {
  const failedHash = `0x${"11".repeat(32)}`;
  const successHash = `0x${"22".repeat(32)}`;
  const common = {
    chainId: 1n,
    type: 2,
    from: CLAIMANT,
    to: SEA_DROP_MAINNET,
    value: valueWei,
  };
  const failedTransaction = {
    ...common,
    hash: failedHash,
    nonce: 15,
    blockNumber: 100,
    data: encodeMint({ quantity, mintParams, salt: 1n, signatureByte: "11", calldataSuffix }),
  };
  const successfulTransaction = {
    ...common,
    hash: successHash,
    nonce: 16,
    blockNumber: 102,
    data: encodeMint({
      quantity,
      mintParams,
      salt: sameAuthorization ? 1n : 2n,
      signatureByte: sameAuthorization ? "11" : "22",
      calldataSuffix,
    }),
  };
  const failedReceipt = receiptFor(failedTransaction, 0, []);
  const successfulReceipt = receiptFor(successfulTransaction, 1, [
    ...tokenIds.map((tokenId) => transferLog(CLAIMANT, tokenId)),
    seaDropMintLog({ quantity, mintPrice: mintParams.mintPrice }),
  ]);
  const profile = {
    sourceChainId: 1,
    seaDrop: SEA_DROP_MAINNET,
    nftContract: NFT,
    feeRecipient: OPEN_SEA_FEE_RECIPIENT,
    minterIfNotPayer: ethers.ZeroAddress,
    quantity,
    valueWei,
    mintParams: { ...mintParams },
    maxBlockGap: 5,
    requirePaid,
    calldataSuffix,
  };
  return {
    failedTransaction,
    failedReceipt,
    successfulTransaction,
    successfulReceipt,
    profile,
  };
}

function encodeMint({
  nftContract = NFT,
  feeRecipient = OPEN_SEA_FEE_RECIPIENT,
  quantity,
  mintParams,
  salt,
  signatureByte,
  calldataSuffix = "0x",
}) {
  const calldata = SEA_DROP_INTERFACE.encodeFunctionData("mintSigned", [
    nftContract,
    feeRecipient,
    ethers.ZeroAddress,
    quantity,
    mintParams,
    salt,
    `0x${signatureByte.repeat(65)}`,
  ]);
  return calldataSuffix === "0x" ? calldata : withOpenSeaSuffix(calldata);
}

function withOpenSeaSuffix(calldata) {
  return `${calldata}${OPEN_SEA_CALLDATA_SUFFIX.slice(2)}`;
}

function receiptFor(transaction, status, logs) {
  return {
    hash: transaction.hash,
    from: transaction.from,
    to: transaction.to,
    blockNumber: transaction.blockNumber,
    status,
    logs,
  };
}

function transferLog(to, tokenId) {
  return {
    address: NFT,
    ...ERC721_INTERFACE.encodeEventLog("Transfer", [ethers.ZeroAddress, to, tokenId]),
  };
}

function seaDropMintLog({
  nftContract = NFT,
  minter = CLAIMANT,
  feeRecipient = OPEN_SEA_FEE_RECIPIENT,
  payer = CLAIMANT,
  quantity = 2n,
  mintPrice = PAID_MINT_PARAMS.mintPrice,
  feeBps = PAID_MINT_PARAMS.feeBps,
  dropStageIndex = PAID_MINT_PARAMS.dropStageIndex,
} = {}) {
  return {
    address: SEA_DROP_MAINNET,
    ...SEA_DROP_INTERFACE.encodeEventLog("SeaDropMint", [
      nftContract,
      minter,
      feeRecipient,
      payer,
      quantity,
      mintPrice,
      feeBps,
      dropStageIndex,
    ]),
  };
}

function errorWithCode(code) {
  return (error) => error instanceof SeaDropRecoveryError && error.code === code;
}
