import assert from "node:assert/strict";
import test from "node:test";
import { createHelperLedgerClient } from "../src/helper-ledger-client.mjs";
import { helperLedgerAtom, helperOperationId, normalizeLedgerLimits, normalizeLedgerReservation } from "../src/helper-ledger-policy.mjs";

const identity = { chainId: 102031, poolAddress: `0x${"aa".repeat(20)}`, campaignNumber: 1, relayerAddress: `0x${"bb".repeat(20)}` };
const limits = { maxAttempts: 9, maxPayouts: 9, maxTotalFeeWei: "18000000000000000", maxFeeWei: "2000000000000000", creditWei: "100000000000000000", expiresAt: 2_000_000_000 };
const options = { url: "https://ledger.example", token: "fixture-test-only-not-a-production-token", identity, limits };

test("helper ledger client exposes immutable nonsecret binding policy", () => {
  const client = createHelperLedgerClient(options);
  assert.deepEqual(client.policy, { identity, limits });
  assert.equal(Object.isFrozen(client.policy), true);
  assert.equal(Object.isFrozen(client.policy.identity), true);
  assert.equal(Object.isFrozen(client.policy.limits), true);
  assert.equal(JSON.stringify(client).includes(options.token), false);
});

test("helper ledger client refuses insecure or credential-bearing URL configuration", () => {
  for (const url of ["http://ledger.example", "https://user:pass@ledger.example", "https://ledger.example/path", "https://ledger.example/?secret=1", "https://ledger.example/#anything"]) {
    assert.throws(() => createHelperLedgerClient({ ...options, url }), { code: "HELPER_LEDGER_CONFIG_INVALID" });
  }
  for (const token of ["", "short", "a".repeat(513), "a".repeat(32) + "\n"]) {
    assert.throws(() => createHelperLedgerClient({ ...options, token }), { code: "HELPER_LEDGER_CONFIG_INVALID" });
  }
});

test("helper ledger transport never automatically retries an ambiguous reserve acknowledgment", async () => {
  let calls = 0;
  const client = createHelperLedgerClient({ ...options, fetchImpl: async () => {
    calls++; throw new Error("opaque upstream network failure");
  } });
  await assert.rejects(client.reserve({ operationId: `0x${"11".repeat(32)}` }), { code: "HELPER_LEDGER_UNAVAILABLE", status: 503 });
  assert.equal(calls, 1);
});

test("helper ledger transport uses manual redirects without forwarding credentials", async () => {
  let calls = 0;
  const client = createHelperLedgerClient({ ...options, fetchImpl: async (_url, init) => {
    calls++;
    assert.equal(init.redirect, "manual");
    return new Response("redirect", { status: 302, headers: { location: "https://unrelated.example" } });
  } });
  await assert.rejects(client.inspect(), { code: "HELPER_LEDGER_UNAVAILABLE" });
  assert.equal(calls, 1);
});

test("helper ledger transport bounds response memory and redacts upstream bodies", async () => {
  for (const response of [new Response("x".repeat(17_000)), new Response("provider-secret-error", { status: 500 }), Response.json({ ok: false, code: "provider-secret-error" }, { status: 500 })]) {
    const client = createHelperLedgerClient({ ...options, fetchImpl: async () => response });
    await assert.rejects(client.inspect(), (error) => error.code === "HELPER_LEDGER_UNAVAILABLE" && !error.message.includes("provider-secret"));
  }
});

test("helper ledger timeout aborts the request and does not grant work", async () => {
  let aborted = false;
  const client = createHelperLedgerClient({ ...options, timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }) });
  await assert.rejects(client.reserve({}), { code: "HELPER_LEDGER_UNAVAILABLE" });
  assert.equal(aborted, true);
});

test("helper budget validation rejects unsafe counts, amounts, and silently additional policy fields", () => {
  for (const update of [
    { maxAttempts: 0 }, { maxPayouts: 33 }, { maxAttempts: 1.5 }, { maxTotalFeeWei: "0" },
    { maxTotalFeeWei: "100" }, { maxFeeWei: "1e16" }, { maxFeeWei: "01" },
    { creditWei: ((1n << 256n) + 1n).toString() }, { expiresAt: -1 }, { epoch: "reset" },
  ]) assert.throws(() => normalizeLedgerLimits({ ...limits, ...update }), { code: "HELPER_LEDGER_INPUT_INVALID" });
});

test("helper operation and atom identity remain independent of requester, code revision, and budget", () => {
  const source = `0x${"cc".repeat(20)}`;
  const pair = { failedTransactionHash: `0x${"11".repeat(32)}`, successfulTransactionHash: `0x${"22".repeat(32)}` };
  assert.match(helperOperationId(identity, source, pair), /^0x[0-9a-f]{64}$/);
  assert.equal(helperLedgerAtom(identity), `retrycredit-spending:102031:${identity.poolAddress}:1`);
  assert.equal(helperLedgerAtom(identity), helperLedgerAtom({ ...identity, relayerAddress: `0x${"ee".repeat(20)}` }));
  assert.notEqual(helperOperationId(identity, source, pair), helperOperationId(identity, `0x${"dd".repeat(20)}`, pair));
  assert.notEqual(helperOperationId(identity, source, pair), helperOperationId({ ...identity, campaignNumber: 2 }, source, pair));
});

test("helper ledger client refuses malformed or mismatched reserve grants", async () => {
  for (const result of [null, {}, { created: true }, { created: true, permitToken: "bad", operation: {} }]) {
    const client = createHelperLedgerClient({ ...options, fetchImpl: async () => Response.json({ ok: true, result }) });
    await assert.rejects(client.reserve({ operationId: `0x${"11".repeat(32)}` }), { code: "HELPER_LEDGER_UNAVAILABLE" });
  }
});

test("durable policy separates helper and beneficiary while preserving the owner route", () => {
  const sourceWallet = `0x${"cc".repeat(20)}`;
  const pair = { failedTransactionHash: `0x${"11".repeat(32)}`, successfulTransactionHash: `0x${"22".repeat(32)}` };
  const operation = { operationId: helperOperationId(identity, sourceWallet, pair),
    mode: "community-helper-v1", requester: sourceWallet.toUpperCase().replace("0X", "0x"),
    sourceWallet, pair, maxFeeWei: limits.maxFeeWei };
  assert.throws(() => normalizeLedgerReservation(identity, operation), { code: "HELPER_LEDGER_INPUT_INVALID" });
  assert.equal(normalizeLedgerReservation(identity, { ...operation, mode: "owner" }).requester, sourceWallet);
  assert.equal(normalizeLedgerReservation(identity, { ...operation, requester: identity.relayerAddress }).mode, "community-helper-v1");
});

const admissionSource = `0x${"cc".repeat(20)}`;
const admissionPair = { failedTransactionHash: `0x${"11".repeat(32)}`, successfulTransactionHash: `0x${"22".repeat(32)}` };

function admissionOperation({ state = "admitted", mode = "community-helper-v1", pair = admissionPair } = {}) {
  const broadcast = ["broadcast-prepared", "settled", "reverted"].includes(state);
  const terminalReceipt = ["settled", "reverted"].includes(state);
  return {
    operationId: helperOperationId(identity, admissionSource, pair), mode,
    requester: mode === "owner" ? admissionSource : identity.relayerAddress,
    sourceWallet: admissionSource, pair, state, maxFeeWei: limits.maxFeeWei, creditWei: limits.creditWei,
    transactionHash: broadcast ? `0x${"ab".repeat(32)}` : null, nonce: broadcast ? 4 : null,
    receiptStatus: terminalReceipt ? (state === "settled" ? 1 : 0) : null,
    blockNumber: terminalReceipt ? 1_234 : null, reason: state === "stopped" ? "proof-invalid" : null,
    createdAt: 1_800_000_000, updatedAt: 1_800_000_001,
  };
}

function admissionSnapshot(operation = null, update = {}) {
  const attempts = operation ? 1 : 0;
  return {
    identity: { ...identity }, limits: { ...limits }, enabled: true, attempts, payouts: attempts,
    reservedFeeWei: (BigInt(attempts) * BigInt(limits.maxFeeWei)).toString(),
    activeOperationId: operation && ["admitted", "broadcast-prepared"].includes(operation.state) ? operation.operationId : null,
    sourceWallet: admissionSource, operation, ...update,
  };
}

test("atomic admission is one source-bound read with no reservation or permit", async () => {
  const result = admissionSnapshot();
  const calls = [];
  const client = createHelperLedgerClient({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return Response.json({ ok: true, result });
  } });
  assert.deepEqual(await client.admission({ sourceWallet: admissionSource.toUpperCase().replace("0X", "0x") }), result);
  assert.deepEqual(calls, [{ url: "https://ledger.example/v1/admission", method: "POST",
    body: { identity, limits, input: { sourceWallet: admissionSource } } }]);
  assert.equal("permitToken" in result, false);
  assert.equal("broadcastPermit" in result, false);
});

test("atomic admission rejects invalid or surplus input before any transport", async () => {
  let calls = 0;
  const client = createHelperLedgerClient({ ...options, fetchImpl: async () => { calls++; throw Error(); } });
  for (const input of [undefined, null, [], {}, { sourceWallet: "invalid" },
    { sourceWallet: `0x${"00".repeat(20)}` }, { sourceWallet: admissionSource, permitToken: "private" }]) {
    await assert.rejects(client.admission(input), { code: "HELPER_LEDGER_INPUT_INVALID", status: 400 });
  }
  assert.equal(calls, 0);
});

test("atomic admission preserves each valid source state and its actual owner or helper identity", async (t) => {
  const anotherActiveId = `0x${"ef".repeat(32)}`;
  const alternatePair = { ...admissionPair, successfulTransactionHash: `0x${"33".repeat(32)}` };
  const cases = [
    ["empty enabled", admissionSnapshot()],
    ["empty paused", admissionSnapshot(null, { enabled: false })],
    ["another source is active", admissionSnapshot(null, { attempts: 1, payouts: 1,
      reservedFeeWei: limits.maxFeeWei, activeOperationId: anotherActiveId })],
    ...["admitted", "broadcast-prepared", "settled", "reverted", "stopped"].flatMap((state) =>
      ["owner", "community-helper-v1"].map((mode) => [`${mode} ${state}`, admissionSnapshot(admissionOperation({ state, mode }))])),
    ["terminal alternate pair with another source active", admissionSnapshot(admissionOperation({ state: "stopped", pair: alternatePair }), {
      attempts: 2, payouts: 2, reservedFeeWei: (2n * BigInt(limits.maxFeeWei)).toString(), activeOperationId: anotherActiveId,
    })],
  ];
  for (const [name, result] of cases) await t.test(name, async () => {
    const client = createHelperLedgerClient({ ...options, fetchImpl: async () => Response.json({ ok: true, result }) });
    assert.deepEqual(await client.admission({ sourceWallet: admissionSource }), result);
  });
});

test("atomic admission rejects individually shaped but jointly impossible counters and operation state", async (t) => {
  const active = admissionOperation();
  const terminal = admissionOperation({ state: "stopped" });
  const cases = [
    ["active operation without active ID", admissionSnapshot(active, { activeOperationId: null })],
    ["active operation with different active ID", admissionSnapshot(active, { activeOperationId: `0x${"ef".repeat(32)}` })],
    ["terminal operation marked active", admissionSnapshot(terminal, { activeOperationId: terminal.operationId })],
    ["terminal source and another active source with only one allocation", admissionSnapshot(terminal, { activeOperationId: `0x${"ef".repeat(32)}` })],
    ["active source without any allocation", admissionSnapshot(active, { attempts: 0, payouts: 0, reservedFeeWei: "0" })],
    ["terminal source without any allocation", admissionSnapshot(terminal, { attempts: 0, payouts: 0, reservedFeeWei: "0" })],
    ["other active source without any allocation", admissionSnapshot(null, { activeOperationId: active.operationId })],
    ["payout count differs from attempts", admissionSnapshot(active, { payouts: 0 })],
    ["reserved fees differ from allocations", admissionSnapshot(active, { reservedFeeWei: "0" })],
    ["attempt limit exceeded", admissionSnapshot(null, { attempts: 10, payouts: 10, reservedFeeWei: "20000000000000000" })],
    ["enabled is not boolean", admissionSnapshot(null, { enabled: "true" })],
    ["source binding changed", admissionSnapshot(active, { sourceWallet: identity.relayerAddress })],
    ["returned source binding is not canonical", admissionSnapshot(null, { sourceWallet: admissionSource.toUpperCase().replace("0X", "0x") })],
    ["operation belongs to another source", admissionSnapshot({ ...active, sourceWallet: identity.relayerAddress })],
    ["policy identity changed", admissionSnapshot(null, { identity: { ...identity, campaignNumber: 2 } })],
    ["policy limits changed", admissionSnapshot(null, { limits: { ...limits, maxAttempts: 8 } })],
    ["operation missing", (({ operation, ...rest }) => rest)(admissionSnapshot())],
    ["active ID missing", (({ activeOperationId, ...rest }) => rest)(admissionSnapshot())],
  ];
  for (const [name, result] of cases) await t.test(name, async () => {
    const client = createHelperLedgerClient({ ...options, fetchImpl: async () => Response.json({ ok: true, result }) });
    await assert.rejects(client.admission({ sourceWallet: admissionSource }), { code: "HELPER_LEDGER_UNAVAILABLE", status: 503 });
  });
});

test("atomic admission rejects malformed operations and private or surplus response fields", async (t) => {
  const valid = admissionSnapshot(admissionOperation());
  const patches = [
    ["result permit", (result) => { result.permitToken = "private-permit"; }],
    ["result broadcast grant", (result) => { result.broadcastPermit = true; }],
    ["identity secret", (result) => { result.identity.token = "private-token"; }],
    ["limits reset field", (result) => { result.limits.epoch = "private-epoch"; }],
    ["operation raw transaction", (result) => { result.operation.rawTransaction = "private-raw"; }],
    ["operation signature", (result) => { result.operation.signature = "private-signature"; }],
    ["operation permit", (result) => { result.operation.permitToken = "private-permit"; }],
    ["pair extra destination", (result) => { result.operation.pair.destination = identity.poolAddress; }],
    ["operation ID changed", (result) => { result.operation.operationId = `0x${"ef".repeat(32)}`; result.activeOperationId = result.operation.operationId; }],
    ["noncanonical operation ID", (result) => { result.operation.operationId = result.operation.operationId.toUpperCase().replace("0X", "0x"); }],
    ["noncanonical requester", (result) => { result.operation.requester = result.operation.requester.toUpperCase().replace("0X", "0x"); }],
    ["noncanonical pair hash", (result) => {
      result.operation.pair.failedTransactionHash = `0x${"ab".repeat(32)}`;
      result.operation.operationId = helperOperationId(identity, admissionSource, result.operation.pair);
      result.activeOperationId = result.operation.operationId;
      result.operation.pair.failedTransactionHash = result.operation.pair.failedTransactionHash.toUpperCase().replace("0X", "0x");
    }],
    ["noncanonical transaction hash", (result) => {
      result.operation = admissionOperation({ state: "broadcast-prepared" });
      result.operation.transactionHash = result.operation.transactionHash.toUpperCase().replace("0X", "0x");
    }],
    ["helper is source", (result) => { result.operation.requester = admissionSource; }],
    ["owner is not source", (result) => { result.operation.mode = "owner"; }],
    ["admitted operation has transaction", (result) => { result.operation.transactionHash = `0x${"ab".repeat(32)}`; }],
    ["admitted operation has receipt", (result) => { result.operation.receiptStatus = 1; }],
    ["admitted operation has stop reason", (result) => { result.operation.reason = "proof-invalid"; }],
    ["updated before created", (result) => { result.operation.updatedAt = result.operation.createdAt - 1; }],
    ["credit amount changed", (result) => { result.operation.creditWei = "1"; }],
  ];
  for (const [name, patch] of patches) await t.test(name, async () => {
    const result = structuredClone(valid);
    patch(result);
    const client = createHelperLedgerClient({ ...options, fetchImpl: async () => Response.json({ ok: true, result }) });
    await assert.rejects(client.admission({ sourceWallet: admissionSource }), (error) =>
      error.code === "HELPER_LEDGER_UNAVAILABLE" && error.status === 503 && !error.message.includes("private"));
  });
});

test("atomic admission preserves transport failure as unavailable without retrying another read or granting work", async () => {
  const calls = [];
  const client = createHelperLedgerClient({ ...options, fetchImpl: async (url) => { calls.push(url); throw Error("private-upstream"); } });
  await assert.rejects(client.admission({ sourceWallet: admissionSource }), { code: "HELPER_LEDGER_UNAVAILABLE", status: 503 });
  assert.deepEqual(calls, ["https://ledger.example/v1/admission"]);
});

test("inspect and readSource retain their original public shapes", async () => {
  const full = admissionSnapshot(admissionOperation({ state: "settled", mode: "owner" }));
  const { sourceWallet, operation, ...inspect } = full;
  const calls = [];
  const client = createHelperLedgerClient({ ...options, fetchImpl: async (url) => {
    calls.push(url);
    return Response.json({ ok: true, result: url.endsWith("/inspect") ? inspect : { operation } });
  } });
  assert.deepEqual(await client.inspect(), inspect);
  assert.deepEqual(await client.readSource({ sourceWallet }), { operation });
  assert.deepEqual(calls, ["https://ledger.example/v1/inspect", "https://ledger.example/v1/read-source"]);
});
