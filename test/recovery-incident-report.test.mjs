import assert from "node:assert/strict";
import test from "node:test";
import { recoveryIncidentExport, validateRecoveryIncidentReport } from "../web/src/recovery-incident-report.mjs";
import { serializeRecoveryPairDiagnostics } from "../src/recovery-pair-report.mjs";

const PAIR = Object.freeze({
  failedTransactionHash: `0x${"ab".repeat(32)}`,
  successfulTransactionHash: `0x${"cd".repeat(32)}`,
});
const POOL = "0x1111111111111111111111111111111111111111";
const OTHER_POOL = "0x2222222222222222222222222222222222222222";
const TERMS_HASH = `0x${"ef".repeat(32)}`;
const CHECK_IDS = ["source-network", "transaction-type", "action-family", "same-wallet", "receipt-status", "nonce-order", "block-gap", "campaign-window", "paid-mint", "mint-identity", "mint-outcome", "campaign-fee-recipient", "campaign-quantity"];

test("incident reports are accepted only against the exact current pair and campaign terms", () => {
  const value = reportFixture();
  const report = validateRecoveryIncidentReport(value, PAIR, configFixture());
  assert.deepEqual(report, serializeRecoveryPairDiagnostics(value));
  assert.equal(report.attestationVerified, false);
  assert.equal(report.authority, "advisory-source-check");
  assert.deepEqual(validateRecoveryIncidentReport(value, {
    failedTransactionHash: `https://etherscan.io/tx/${PAIR.failedTransactionHash.toUpperCase().replace("0X", "0x")}`,
    successfulTransactionHash: PAIR.successfulTransactionHash,
  }, configFixture()), report);
});

test("a report for a changed pair, pool, campaign, or immutable term cannot be displayed", async t => {
  const mutations = [
    ["failed transaction", value => { value.pair.failedTransactionHash = `0x${"aa".repeat(32)}`; }],
    ["successful transaction", value => { value.pair.successfulTransactionHash = `0x${"bb".repeat(32)}`; }],
    ["reversed pair", value => { value.pair = { failedTransactionHash: PAIR.successfulTransactionHash, successfulTransactionHash: PAIR.failedTransactionHash }; }],
    ["pool", value => { value.campaign.poolAddress = OTHER_POOL; }],
    ["campaign", value => { value.campaign.campaignNumber = 2; }],
    ["terms hash", value => { value.campaign.termsHash = `0x${"aa".repeat(32)}`; }],
    ["start block", value => { value.campaign.startBlock += 1; }],
    ["end block", value => { value.campaign.endBlock += 1; }],
    ["block gap", value => { value.campaign.maxBlockGap += 1; }],
    ["quantity", value => { value.campaign.maxQuantity += 1; }],
    ["credit amount", value => { value.campaign.creditAmount = "200000000000000000"; }],
    ["deadline", value => { value.campaign.deadline += 1; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, () => {
    const value = reportFixture();
    mutate(value);
    assert.equal(validateRecoveryIncidentReport(value, PAIR, configFixture()), null);
  });
  assert.equal(validateRecoveryIncidentReport(reportFixture(), { ...PAIR, failedTransactionHash: "not-a-hash" }, configFixture()), null);
  assert.equal(validateRecoveryIncidentReport(reportFixture(), PAIR, null), null);
});

test("malformed and promoted reports cannot cross the display or export boundary", () => {
  for (const mutate of [
    value => { value.schema = "retrycredit.native-proof/1"; },
    value => { value.authority = "attestcoin"; },
    value => { value.attestationVerified = true; },
    value => { value.sourceChainId = 11155111; },
    value => { value.checkedAt = "invalid"; },
    value => { value.checks[0].id = "unknown-check"; },
    value => { value.checks[0].status = "verified"; },
    value => { value.checks.pop(); },
    value => { value.checks = value.checks.map(check => ({ ...check, status: "pass" })); },
    value => { value.facts.failed.status = 2; },
  ]) {
    const value = reportFixture();
    mutate(value);
    assert.equal(validateRecoveryIncidentReport(value, PAIR, configFixture()), null);
    assert.equal(recoveryIncidentExport(value), null);
  }
});

test("export retains the advisory boundary and whitelists public facts away from signatures and errors", () => {
  const value = reportFixture();
  Object.assign(value, {
    signature: "CANARY_SIGNATURE",
    issuedAt: 123,
    expiresAt: 456,
    rawTransaction: "CANARY_TRANSACTION",
    proof: "CANARY_PROOF",
    error: { message: "CANARY_ERROR" },
    cause: { message: "CANARY_CAUSE" },
    summary: "CANARY_SUMMARY",
    transactions: { failed: "https://untrusted.example/CANARY_URL" },
  });
  value.campaign.signature = "CANARY_CAMPAIGN_SIGNATURE";
  value.facts.failed.privateKey = "CANARY_PRIVATE_KEY";
  value.checks = value.checks.map(check => ({ ...check, message: "CANARY_MESSAGE", label: "CANARY_LABEL", signature: "CANARY_CHECK_SIGNATURE" }));
  const output = recoveryIncidentExport(value);
  assert.equal(typeof output, "string");
  assert.doesNotMatch(output, /CANARY|privateKey|rawTransaction|untrusted\.example/);
  const exported = JSON.parse(output);
  assert.equal(exported.schema, "retrycredit.pair-diagnostics/1");
  assert.equal(exported.authority, "advisory-source-check");
  assert.equal(exported.attestationVerified, false);
  assert.deepEqual(exported.pair, PAIR);
  assert.equal(exported.campaign.poolAddress, POOL);
  assert.equal(exported.campaign.termsHash, TERMS_HASH);
  assert.deepEqual(Object.keys(exported.facts.failed).sort(), ["blockNumber", "nonce", "status"]);
  assert.match(exported.exportNotice, /not an Attestcoin attestation/);
  assert.deepEqual(exported.transactions, {
    failed: `https://etherscan.io/tx/${PAIR.failedTransactionHash}`,
    successful: `https://etherscan.io/tx/${PAIR.successfulTransactionHash}`,
  });
  assert.equal("signature" in exported, false);
  assert.equal("error" in exported, false);
  assert.equal("eligible" in exported, false);
  assert.equal("proof" in exported, false);
});

function configFixture() {
  return {
    poolAddress: POOL,
    campaignNumber: 1,
    campaign: { termsHash: TERMS_HASH, creditAmount: "100000000000000000", deadline: 2000000000 },
    rule: { startBlock: 90, endBlock: 101, maxBlockGap: 5, maxQuantity: 2 },
  };
}

function reportFixture() {
  const config = configFixture();
  return {
    schema: "retrycredit.pair-diagnostics/1",
    authority: "advisory-source-check",
    attestationVerified: false,
    sourceChainId: 1,
    checkedAt: "2026-09-12T08:00:00.000Z",
    pair: { ...PAIR },
    campaign: { poolAddress: POOL, campaignNumber: 1, ...config.campaign, ...config.rule },
    facts: { failed: { blockNumber: 100, nonce: 1, status: 0 }, successful: { blockNumber: 102, nonce: 2, status: 1 } },
    checks: CHECK_IDS.map(id => ({ id, status: id === "campaign-window" ? "fail" : "pass" })),
  };
}
