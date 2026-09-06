import assert from "node:assert/strict";
import test from "node:test";
import { requestRecoveryAccounts } from "../web/src/recovery-wallet-connection.mjs";

test("wallet connection asks only for accounts and preserves rejection", async () => {
  const calls = [];
  const provider = { request: async request => { calls.push(request); return ["0x1111111111111111111111111111111111111111"]; } };
  assert.equal((await requestRecoveryAccounts(provider)).length, 1);
  assert.deepEqual(calls, [{ method: "eth_requestAccounts" }]);
  const rejected = Object.assign(new Error("Declined"), { code: 4001 });
  await assert.rejects(requestRecoveryAccounts({ request: async () => { throw rejected; } }), error => error === rejected);
});

test("unanswered wallet connection times out without accepting a late account or duplicating the prompt", async () => {
  let finish;
  let calls = 0;
  const provider = { request: () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
  let accepted = false;
  const first = requestRecoveryAccounts(provider, { timeoutMs: 5 }).then(value => { accepted = true; return value; });
  await assert.rejects(first, { code: "RECOVERY_WALLET_CONNECTION_TIMEOUT" });
  await assert.rejects(requestRecoveryAccounts(provider), { code: -32002 });
  assert.equal(calls, 1);
  finish(["0x1111111111111111111111111111111111111111"]);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(accepted, false);
  provider.request = async () => [];
  assert.deepEqual(await requestRecoveryAccounts(provider), []);
});

test("a late wallet rejection is handled and invalid connection inputs fail closed", async () => {
  let fail;
  const provider = { request: () => new Promise((_, reject) => { fail = reject; }) };
  await assert.rejects(requestRecoveryAccounts(provider, { timeoutMs: 5 }), { code: "RECOVERY_WALLET_CONNECTION_TIMEOUT" });
  fail(Object.assign(new Error("Closed"), { code: 4001 }));
  await Promise.resolve();
  await assert.rejects(requestRecoveryAccounts(null), /wallet/);
  await assert.rejects(requestRecoveryAccounts(provider, { timeoutMs: NaN }), /timeout/);
});
