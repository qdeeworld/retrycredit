import assert from "node:assert/strict";
import test from "node:test";
import { createRecoverySourceProvider } from "../src/recovery-source-provider.mjs";
const env = { RETRYCREDIT_RECOVERY_ETHEREUM_PROVIDER: "thirdweb", THIRDWEB_RPC_CLIENT_ID: "a".repeat(32), THIRDWEB_RPC_SECRET: "source-secret_".repeat(4) };
const payload = { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [`0x${"1".repeat(64)}`] };
function responseFor(init, { chain = "0x1", result = null } = {}) {
  return { ok: true, json: async () => JSON.parse(init.body).map(item => ({ jsonrpc: "2.0", id: item.id, result: item.method === "eth_chainId" ? chain : result })) };
}

test("authenticated source transport is opt-in and rejects conflicting or malformed configuration", () => {
  assert.equal(createRecoverySourceProvider(), null);
  assert.equal(createRecoverySourceProvider({ THIRDWEB_RPC_SECRET: env.THIRDWEB_RPC_SECRET }), null);
  assert.throws(() => createRecoverySourceProvider({ ...env, RETRYCREDIT_RECOVERY_ETHEREUM_PROVIDER: "other" }), /PROVIDER_INVALID/);
  assert.throws(() => createRecoverySourceProvider({ ...env, ETHEREUM_RPC_URLS: "https://example.org" }), /CONFLICT/);
  for (const field of ["THIRDWEB_RPC_CLIENT_ID", "THIRDWEB_RPC_SECRET"]) {
    for (const value of [undefined, "", "bad\nheader", "https://example.org", "x".repeat(300)]) {
      assert.throws(() => createRecoverySourceProvider({ ...env, [field]: value }), { message: "RECOVERY_SOURCE_CREDENTIALS_INVALID" });
    }
  }
});

test("source credentials bind to Ethereum only and every batch checks the actual chain", async () => {
  const calls = [];
  const provider = createRecoverySourceProvider(env, { fetchImpl: async (url, init) => { calls.push({ url, init }); return responseFor(init); } });
  assert.deepEqual(await provider._send(payload), [{ jsonrpc: "2.0", id: 1, result: null }]);
  assert.equal(calls[0].url, `https://1.rpc.thirdweb.com/${env.THIRDWEB_RPC_CLIENT_ID}`);
  assert.deepEqual(calls[0].init.headers, { "content-type": "application/json", "x-secret-key": env.THIRDWEB_RPC_SECRET });
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.credentials, "omit");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(JSON.parse(calls[0].init.body).at(-1).method, "eth_chainId");
  provider.destroy();
});

test("source transport refuses signing, broadcasting, oversized payloads and invalid batches before network work", async () => {
  let calls = 0;
  const provider = createRecoverySourceProvider(env, { fetchImpl: async () => { calls++; throw new Error(); } });
  for (const input of [[], Array(5).fill(payload), { ...payload, method: "eth_sendRawTransaction" }, { ...payload, method: "personal_sign" }, { ...payload, method: "eth_accounts" }, { ...payload, params: ["x".repeat(17000)] }, { ...payload, id: "wrong" }]) {
    await assert.rejects(provider._send(input), { message: "RECOVERY_SOURCE_RPC_FAILED" });
  }
  assert.equal(calls, 0);
  provider.destroy();
});

test("source transport rejects wrong-chain, duplicate, missing and error responses without leaking their contents", async () => {
  for (const transform of [
    () => { throw new Error(env.THIRDWEB_RPC_SECRET); },
    (_values, init) => responseFor(init, { chain: "0x66" }).json(),
    values => values.slice(0, 1),
    values => [values[0], values[0]],
    values => values.map(value => value.id === 1 ? { ...value, error: { message: env.THIRDWEB_RPC_SECRET } } : value),
  ]) {
    const provider = createRecoverySourceProvider(env, { fetchImpl: async (_url, init) => ({ ok: true, json: async () => transform(await responseFor(init).json(), init) }) });
    await assert.rejects(provider._send(payload), error => error.message === "RECOVERY_SOURCE_RPC_FAILED" && error.cause === undefined);
    provider.destroy();
  }
});

test("the ordinary ethers provider interface uses the same read-only transport", async () => {
  const provider = createRecoverySourceProvider(env, { fetchImpl: async (_url, init) => responseFor(init) });
  assert.equal((await provider.getNetwork()).chainId, 1n);
  assert.equal(await provider.getTransactionReceipt(payload.params[0]), null);
  await assert.rejects(provider.send("eth_sendRawTransaction", ["0x"]), /RECOVERY_SOURCE_RPC_FAILED/);
  provider.destroy();
});
