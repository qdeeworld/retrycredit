import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryV2AuditTransport } from "../src/recovery-v2-audit-transport.mjs";
const primary = "https://rpc.cc3-testnet.creditcoin.network";
const env = { RETRYCREDIT_RECOVERY_V2_AUDIT_PROVIDER: "thirdweb", THIRDWEB_RPC_CLIENT_ID: "a".repeat(32), THIRDWEB_RPC_SECRET: "test-secret_".repeat(4) };
const request = { method: "POST", body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }]) };

test("default audit transport preserves Blockscout and requires explicit Thirdweb opt-in", () => {
  assert.deepEqual(createRecoveryV2AuditTransport(), { auditUrl: "https://creditcoin-testnet.blockscout.com/api/eth-rpc" });
  assert.equal(createRecoveryV2AuditTransport({ THIRDWEB_RPC_SECRET: env.THIRDWEB_RPC_SECRET }).fetchImpl, undefined);
  assert.throws(() => createRecoveryV2AuditTransport({ RETRYCREDIT_RECOVERY_V2_AUDIT_PROVIDER: "other" }), /PROVIDER_INVALID/);
});
test("Thirdweb credentials fail closed without leaking malformed values", () => {
  for (const field of ["THIRDWEB_RPC_CLIENT_ID", "THIRDWEB_RPC_SECRET"]) {
    for (const value of [undefined, "", "secret\nheader", "https://example.org", "x".repeat(300)]) {
      assert.throws(() => createRecoveryV2AuditTransport({ ...env, [field]: value }), { message: "RECOVERY_V2_AUDIT_CREDENTIALS_INVALID" });
    }
  }
});
test("credentials bind only to the exact audit URL and redirects are forbidden", async () => {
  const calls = [];
  const transport = createRecoveryV2AuditTransport(env, async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  const signal = new AbortController().signal;
  for (const url of [primary, transport.auditUrl]) await transport.fetchImpl(url, { ...request, signal, headers: { Authorization: "unexpected", "x-secret-key": "wrong" } });
  assert.deepEqual(calls[0].options.headers, { "content-type": "application/json" });
  assert.equal(calls[1].options.headers["x-secret-key"], env.THIRDWEB_RPC_SECRET);
  for (const call of calls) {
    assert.equal(call.options.redirect, "error");
    assert.equal(call.options.credentials, "omit");
    assert.equal(call.options.signal, signal);
    assert.equal(call.options.body, request.body);
  }
  const count = calls.length;
  for (const url of [transport.auditUrl + "/", transport.auditUrl + "?x=y", transport.auditUrl.replace("thirdweb.com", "thirdweb.com.evil.test"), new URL(transport.auditUrl)]) {
    await assert.rejects(transport.fetchImpl(url, request), /AUDIT_REQUEST_FAILED/);
  }
  assert.equal(calls.length, count);
  await transport.fetchImpl(`${primary}/`, request);
  assert.deepEqual(calls.at(-1).options.headers, { "content-type": "application/json" });
});
test("audit transport refuses writes and malformed batches before network work", async () => {
  let calls = 0;
  const transport = createRecoveryV2AuditTransport(env, async () => { calls++; });
  for (const bad of [
    { ...request, method: "GET" }, { ...request, body: "bad" },
    { ...request, body: "[]" }, { ...request, body: "x".repeat(16385) },
    { ...request, body: JSON.stringify([{ jsonrpc: "2.0", method: "eth_sendRawTransaction", params: ["0x"] }]) },
    { ...request, body: JSON.stringify(Array(4).fill({ jsonrpc: "2.0", method: "eth_chainId", params: [] })) },
  ]) await assert.rejects(transport.fetchImpl(transport.auditUrl, bad), /AUDIT_REQUEST_FAILED/);
  assert.equal(calls, 0);
});
test("provider exceptions cannot disclose credentials or the authenticated URL", async () => {
  const transport = createRecoveryV2AuditTransport(env, async () => { throw new Error(env.THIRDWEB_RPC_SECRET); });
  await assert.rejects(transport.fetchImpl(transport.auditUrl, request), error => {
    assert.equal(error.message, "RECOVERY_V2_AUDIT_REQUEST_FAILED");
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify(error).includes(env.THIRDWEB_RPC_SECRET), false);
    return true;
  });
});
