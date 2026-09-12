import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/helper-ledger-worker.mjs";
import { createHelperLedgerClient } from "../src/helper-ledger-client.mjs";
import { helperLedgerAtom, helperOperationId } from "../src/helper-ledger-policy.mjs";

const POLICY = JSON.parse(env.HELPER_LEDGER_POLICY);
const request = (input = {}, policy = POLICY) => ({ ...policy, input });
const hash = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const address = (value) => `0x${value.toString(16).padStart(40, "0")}`;
function reservation(index = 1, mode = "community-helper-v1") {
  const sourceWallet = address(index);
  const pair = { failedTransactionHash: hash(index * 2), successfulTransactionHash: hash(index * 2 + 1) };
  return {
    operationId: helperOperationId(POLICY.identity, sourceWallet, pair), mode,
    requester: mode === "owner" ? sourceWallet : address(999), sourceWallet, pair,
    maxFeeWei: POLICY.limits.maxFeeWei,
  };
}
function prepared(admission, index = 1) {
  return { operationId: admission.operation.operationId, permitToken: admission.permitToken,
    transactionHash: hash(1000 + index), nonce: index, maxFeeWei: POLICY.limits.maxFeeWei };
}
const stubFor = (name) => {
  const raw = env.HELPER_LEDGER.getByName(name);
  return new Proxy({ raw }, {
    get(target, method) {
      if (method === "raw") return target.raw;
      return async (input) => {
        const response = await raw.dispatch(method, input);
        if (!response.ok) throw Object.assign(new Error(response.code), { code: response.code, status: response.status });
        return response.result;
      };
    },
  });
};
const stopped = (admission) => ({ operationId: admission.operation.operationId,
  permitToken: admission.permitToken, reason: "proof-unavailable" });

describe("restart-safe helper spending in real workerd SQLite Durable Objects", () => {
  it("converges 100 helpers on one source/pair without sharing the private permit", async () => {
    const stubs = Array.from({ length: 100 }, () => stubFor("same-operation"));
    const results = await Promise.all(stubs.map((stub, index) => stub.reserve(request({
      ...reservation(), requester: address(index + 100),
    }))));
    expect(results.filter((value) => value.created)).toHaveLength(1);
    expect(results.filter((value) => value.permitToken)).toHaveLength(1);
    expect(await stubs[0].inspect(request())).toMatchObject({ attempts: 1, payouts: 1, reservedFeeWei: POLICY.limits.maxFeeWei });
    expect(JSON.stringify(await stubs[0].read(request({ operationId: reservation().operationId })))).not.toContain("permit");
  });

  it("serializes distinct source operations including the original owner flow", async () => {
    const stub = stubFor("nonce-domain");
    const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => stub.reserve(request(reservation(index + 1, index % 2 ? "owner" : "community-helper-v1")))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(39);
    const winner = results.find((result) => result.status === "fulfilled").value;
    await stub.failBeforeBroadcast(request(stopped(winner)));
    const owner = await stub.reserve(request(reservation(60, "owner")));
    expect(owner.created).toBe(true);
    expect(await stub.inspect(request())).toMatchObject({ attempts: 2, payouts: 2, reservedFeeWei: "4000000000000000" });
  });

  it("preserves a lost reserve acknowledgment and source lock after actual eviction", async () => {
    let stub = stubFor("lost-reserve-ack");
    await stub.reserve(request(reservation())); // Acknowledgment deliberately discarded.
    await evictDurableObject(stub.raw);
    stub = stubFor("lost-reserve-ack");
    expect(await stub.reserve(request(reservation()))).toMatchObject({ created: false, operation: { state: "admitted" } });
    await expect(stub.reserve(request(reservation(2)))).rejects.toThrow("HELPER_LEDGER_BUSY");
    const sameSource = reservation(2);
    sameSource.sourceWallet = reservation().sourceWallet;
    sameSource.operationId = helperOperationId(POLICY.identity, sameSource.sourceWallet, sameSource.pair);
    await expect(stub.reserve(request(sameSource))).rejects.toThrow("HELPER_LEDGER_SOURCE_RESERVED");
  });

  it("allows privileged pre-broadcast abandonment without refund, refill, or stale permit reuse", async () => {
    const stub = stubFor("abandon-before-work");
    const admission = await stub.reserve(request(reservation()));
    await stub.abandonBeforeBroadcast(request({ operationId: admission.operation.operationId }));
    await expect(stub.prepareBroadcast(request(prepared(admission)))).rejects.toThrow("HELPER_LEDGER_STATE_CONFLICT");
    expect(await stub.reserve(request(reservation()))).toMatchObject({ created: false, operation: { state: "stopped" } });
    expect((await stub.reserve(request(reservation(2)))).created).toBe(true);
    expect(await stub.inspect(request())).toMatchObject({ attempts: 2, payouts: 2 });
  });

  it("atomically decides abandonment versus broadcast permit, never both", async () => {
    const stub = stubFor("abandon-race");
    const admission = await stub.reserve(request(reservation()));
    const results = await Promise.allSettled([
      stub.prepareBroadcast(request(prepared(admission))),
      stub.abandonBeforeBroadcast(request({ operationId: admission.operation.operationId })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const { operation } = await stub.read(request({ operationId: admission.operation.operationId }));
    expect(["broadcast-prepared", "stopped"]).toContain(operation.state);
  });

  it("persists the exact nonce/hash before granting precisely one broadcast permission", async () => {
    const stub = stubFor("one-broadcast");
    const admission = await stub.reserve(request(reservation()));
    const payload = prepared(admission);
    const results = await Promise.all(Array.from({ length: 40 }, () => stub.prepareBroadcast(request(payload))));
    expect(results.filter((value) => value.broadcastPermit)).toHaveLength(1);
    await evictDurableObject(stub.raw);
    const restored = stubFor("one-broadcast");
    expect(await restored.prepareBroadcast(request(payload))).toMatchObject({ broadcastPermit: false,
      operation: { transactionHash: payload.transactionHash, nonce: payload.nonce, state: "broadcast-prepared" } });
    await expect(restored.failBeforeBroadcast(request(stopped(admission)))).rejects.toThrow("HELPER_LEDGER_STATE_CONFLICT");
    await expect(restored.abandonBeforeBroadcast(request({ operationId: payload.operationId }))).rejects.toThrow("HELPER_LEDGER_STATE_CONFLICT");
    await expect(restored.reserve(request(reservation(2)))).rejects.toThrow("HELPER_LEDGER_BUSY");
  });

  it("does not replace an ambiguous transaction, even with the original capability", async () => {
    const stub = stubFor("ambiguous-broadcast");
    const admission = await stub.reserve(request(reservation()));
    const input = prepared(admission);
    await stub.prepareBroadcast(request(input));
    await expect(stub.prepareBroadcast(request({ ...input, transactionHash: hash(9000) }))).rejects.toThrow("HELPER_LEDGER_STATE_CONFLICT");
    await expect(stub.complete(request({ operationId: input.operationId, transactionHash: hash(9000), receiptStatus: 1, blockNumber: 500 }))).rejects.toThrow("HELPER_LEDGER_STATE_CONFLICT");
  });

  it("reconciles an exact known receipt after restart without recovering a private permit", async () => {
    let stub = stubFor("receipt-after-restart");
    const admission = await stub.reserve(request(reservation()));
    const input = prepared(admission);
    await stub.prepareBroadcast(request(input));
    await evictDurableObject(stub.raw);
    stub = stubFor("receipt-after-restart");
    const result = await stub.complete(request({ operationId: input.operationId, transactionHash: input.transactionHash, receiptStatus: 1, blockNumber: 500 }));
    expect(result.operation.state).toBe("settled");
    expect((await stub.reserve(request(reservation(2)))).created).toBe(true);
    expect(await stub.inspect(request())).toMatchObject({ attempts: 2, reservedFeeWei: "4000000000000000" });
  });

  it("retains reverted spend and prohibits reuse of that nonce", async () => {
    const stub = stubFor("reverted-nonce");
    const admission = await stub.reserve(request(reservation()));
    const input = prepared(admission);
    await stub.prepareBroadcast(request(input));
    await stub.complete(request({ operationId: input.operationId, transactionHash: input.transactionHash, receiptStatus: 0, blockNumber: 500 }));
    const next = await stub.reserve(request(reservation(2)));
    await expect(stub.prepareBroadcast(request({ ...prepared(next, 2), nonce: input.nonce }))).rejects.toThrow("HELPER_LEDGER_NONCE_RESERVED");
    expect(await stub.inspect(request())).toMatchObject({ attempts: 2, reservedFeeWei: "4000000000000000" });
  });

  it("rejects a stale previously unseen lower nonce before saving a transaction hash", async () => {
    const stub = stubFor("stale-lower-nonce");
    const admission = await stub.reserve(request(reservation()));
    const first = { ...prepared(admission), nonce: 10 };
    await stub.prepareBroadcast(request(first));
    await stub.complete(request({ operationId: first.operationId, transactionHash: first.transactionHash, receiptStatus: 1, blockNumber: 500 }));
    const next = await stub.reserve(request(reservation(2)));
    await expect(stub.prepareBroadcast(request({ ...prepared(next, 2), nonce: 9 }))).rejects.toThrow("HELPER_LEDGER_NONCE_RESERVED");
    expect(await stub.read(request({ operationId: next.operation.operationId }))).toMatchObject({ operation: { state: "admitted", transactionHash: null } });
    expect(await stub.prepareBroadcast(request({ ...prepared(next, 2), nonce: 11 }))).toHaveProperty("broadcastPermit", true);
  });

  it("never refunds failed proofs, allowing no retry loop to refill the pilot budget", async () => {
    const stub = stubFor("permanent-budget");
    for (let index = 1; index <= 3; index++) {
      const admission = await stub.reserve(request(reservation(index, index === 2 ? "owner" : "community-helper-v1")));
      await stub.failBeforeBroadcast(request(stopped(admission)));
    }
    await evictDurableObject(stub.raw);
    await expect(stubFor("permanent-budget").reserve(request(reservation(4)))).rejects.toThrow("HELPER_LEDGER_BUDGET_EXHAUSTED");
    expect(await stubFor("permanent-budget").inspect(request())).toMatchObject({ attempts: 3, payouts: 3, reservedFeeWei: "6000000000000000" });
  });

  it("rejects a budget, expiry, relayer, or deployment policy change instead of resetting state", async () => {
    const stub = stubFor("policy-rotation");
    await stub.reserve(request(reservation()));
    for (const policy of [
      { ...POLICY, limits: { ...POLICY.limits, maxAttempts: 4 } },
      { ...POLICY, limits: { ...POLICY.limits, expiresAt: POLICY.limits.expiresAt + 1 } },
      { ...POLICY, identity: { ...POLICY.identity, relayerAddress: address(900) } },
    ]) await expect(stub.inspect(request({}, policy))).rejects.toThrow("HELPER_LEDGER_POLICY_CHANGED");
    await runInDurableObject(stub.raw, (_instance, state) => {
      state.storage.sql.exec("UPDATE helper_policy SET policy_json=?", JSON.stringify({ ...POLICY, limits: { ...POLICY.limits, maxAttempts: 4 } }));
    });
    await evictDurableObject(stub.raw);
    await expect(stubFor("policy-rotation").inspect(request())).rejects.toThrow("HELPER_LEDGER_POLICY_CHANGED");
  });

  it("keeps the same campaign atom and rejects an actual signer configuration rotation", async () => {
    const rotated = { ...POLICY, identity: { ...POLICY.identity, relayerAddress: address(987) } };
    expect(helperLedgerAtom(rotated.identity)).toBe(helperLedgerAtom(POLICY.identity));
    const stub = stubFor("actual-signer-rotation");
    await stub.reserve(request(reservation()));
    await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_POLICY = JSON.stringify(rotated); });
    try {
      await expect(stub.reserve(request(reservation(2), rotated))).rejects.toThrow("HELPER_LEDGER_POLICY_CHANGED");
    } finally {
      await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_POLICY = JSON.stringify(POLICY); });
    }
    expect(await stub.inspect(request())).toMatchObject({ attempts: 1 });
  });

  it("disabling admissions still permits reads and exact receipt reconciliation", async () => {
    const stub = stubFor("kill-switch");
    const admission = await stub.reserve(request(reservation()));
    const input = prepared(admission);
    await stub.prepareBroadcast(request(input));
    await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_ENABLED = "false"; });
    try {
      expect(await stub.inspect(request())).toMatchObject({ enabled: false });
      await expect(stub.reserve(request(reservation(2)))).rejects.toThrow("HELPER_LEDGER_DISABLED");
      await expect(stub.prepareBroadcast(request(input))).rejects.toThrow("HELPER_LEDGER_DISABLED");
      expect(await stub.complete(request({ operationId: input.operationId, transactionHash: input.transactionHash,
        receiptStatus: 1, blockNumber: 550 }))).toHaveProperty("operation.state", "settled");
    } finally {
      await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_ENABLED = "true"; });
    }
  });

  it("an expired configured pilot cannot admit proof work or initialize spending", async () => {
    const stub = stubFor("expiry");
    const expired = { ...POLICY, limits: { ...POLICY.limits, expiresAt: 1 } };
    await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_POLICY = JSON.stringify(expired); });
    try {
      await expect(stub.reserve(request(reservation(), expired))).rejects.toThrow("HELPER_LEDGER_EXPIRED");
      expect(await stub.inspect(request({}, expired))).toMatchObject({ enabled: false, attempts: 0 });
    } finally {
      await runInDurableObject(stub.raw, (instance) => { instance.env.HELPER_LEDGER_POLICY = JSON.stringify(POLICY); });
    }
  });

  it("refuses wrong fees and private permits without changing allocation state", async () => {
    const stub = stubFor("fee-and-permit");
    await expect(stub.reserve(request({ ...reservation(), maxFeeWei: "3000000000000000" }))).rejects.toThrow("HELPER_LEDGER_FEE_CAP");
    expect(await stub.inspect(request())).toMatchObject({ attempts: 0 });
    const admission = await stub.reserve(request(reservation()));
    await expect(stub.prepareBroadcast(request({ ...prepared(admission), permitToken: "1".repeat(72) }))).rejects.toThrow("HELPER_LEDGER_PERMIT_INVALID");
    await expect(stub.prepareBroadcast(request({ ...prepared(admission), maxFeeWei: "1000000000000000" }))).rejects.toThrow("HELPER_LEDGER_FEE_CAP");
    expect(await stub.read(request({ operationId: admission.operation.operationId }))).toHaveProperty("operation.state", "admitted");
  });

  it("source lookup exposes an alternate-pair exclusion without exposing the permit", async () => {
    const stub = stubFor("source-read");
    const admission = await stub.reserve(request(reservation()));
    await stub.failBeforeBroadcast(request(stopped(admission)));
    const result = await stub.readSource(request({ sourceWallet: reservation().sourceWallet }));
    expect(result.operation.operationId).toBe(reservation().operationId);
    expect(result.operation.state).toBe("stopped");
    expect(JSON.stringify(result)).not.toContain("permit");
    expect(await stub.readSource(request({ sourceWallet: address(888) }))).toEqual({ operation: null });
  });

  it("fails closed after persisted counter or active-operation corruption", async () => {
    for (const mutation of ["UPDATE helper_policy SET attempts=0", "UPDATE helper_policy SET active_operation=NULL", "DELETE FROM helper_policy", "UPDATE helper_operations SET transaction_hash='corrupt'"]) {
      const stub = stubFor(`corrupt-${mutation}`);
      await stub.reserve(request(reservation()));
      await runInDurableObject(stub.raw, (_instance, state) => { state.storage.sql.exec(mutation); });
      await evictDurableObject(stub.raw);
      await expect(stubFor(`corrupt-${mutation}`).inspect(request())).rejects.toThrow("HELPER_LEDGER_STATE_INVALID");
    }
  });

  it("rejects an operation keyed by helper or an owner pretending to own its source", async () => {
    const stub = stubFor("canonical-identity");
    await expect(stub.reserve(request({ ...reservation(), operationId: hash(888) }))).rejects.toThrow("HELPER_LEDGER_INPUT_INVALID");
    await expect(stub.reserve(request({ ...reservation(), mode: "owner" }))).rejects.toThrow("HELPER_LEDGER_INPUT_INVALID");
    expect(helperLedgerAtom(POLICY.identity)).not.toContain("revision");
  });

  it("rejects a same-wallet helper role before allocation while admitting that wallet as owner", async () => {
    const stub = stubFor("same-wallet-helper-role");
    const owner = reservation(1, "owner");
    await expect(stub.reserve(request({ ...owner, mode: "community-helper-v1" }))).rejects.toThrow("HELPER_LEDGER_INPUT_INVALID");
    expect(await stub.inspect(request())).toMatchObject({ attempts: 0, payouts: 0, reservedFeeWei: "0", activeOperationId: null });
    expect(await stub.reserve(request(owner))).toMatchObject({ created: true, operation: { mode: "owner" } });
  });

  it("rejects unauthorized, oversized, malformed, or surplus fields through the HTTP boundary", async () => {
    const call = (body, authorization = `Bearer ${env.HELPER_LEDGER_TOKEN}`) => worker.fetch(new Request("https://ledger.example/v1/reserve", {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body,
    }), env);
    expect((await call(JSON.stringify(request(reservation())), "Bearer wrong")).status).toBe(401);
    expect((await call(" ".repeat(9000))).status).toBe(400);
    expect((await call("{")).status).toBe(400);
    expect((await call(JSON.stringify(request({ ...reservation(), signature: "must-not-store" })))).status).toBe(400);
    expect((await worker.fetch(new Request("https://ledger.example/v1/reserve"), env)).status).toBe(404);
  });

  it("uses the production client and HTTP Worker-to-DO RPC without exposing permits on reads", async () => {
    const client = createHelperLedgerClient({ url: "https://ledger.example", token: env.HELPER_LEDGER_TOKEN, ...POLICY,
      fetchImpl: (url, init) => worker.fetch(new Request(url, init), env) });
    const admission = await client.reserve(reservation());
    expect(admission.created).toBe(true);
    const copy = await client.reserve(reservation());
    expect(copy.created).toBe(false);
    expect(copy.permitToken).toBeUndefined();
    expect(await client.read({ operationId: reservation().operationId })).toHaveProperty("operation.state", "admitted");
    await client.abandonBeforeBroadcast({ operationId: reservation().operationId });
    await expect(client.prepareBroadcast(prepared(admission))).rejects.toHaveProperty("code", "HELPER_LEDGER_STATE_CONFLICT");
  });
});
