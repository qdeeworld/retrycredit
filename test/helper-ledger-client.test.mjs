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
