import test from "node:test";
import assert from "node:assert/strict";
import { createRecoveryV2LiveObserver } from "../src/recovery-v2-live-observer.mjs";

const revision = "a".repeat(40);
const env = {
  RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE: "observation-only",
  RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
  RETRYCREDIT_RECOVERY_ENABLED: "true",
  RETRYCREDIT_RECOVERY_POOL_ADDRESS: "0x3eee179edd6fe6e40d7d23f0110ea639f2da82b8",
  RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "1",
  RENDER_GIT_COMMIT: revision,
  RETRYCREDIT_DEMO_PRIVATE_KEY: "must-not-reach-observer",
};
function success() {
  return { status: 200, body: { ok: true, network: 102031, revision, recoveryV2: {
    mode: "observation-only", state: "observed", observers: 2,
    reason: "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO",
  } } };
}
function harness(observe = async () => success()) {
  let timestamp = 100_000;
  let callback;
  let calls = 0;
  const observer = createRecoveryV2LiveObserver({ env,
    observe: async (input, options) => {
      calls++;
      assert.deepEqual(Object.keys(input).sort(), ["CREDITCOIN_LOG_RPC", "CREDITCOIN_RPC", "RETRYCREDIT_DEPLOYMENT_REVISION"]);
      assert.deepEqual(options, { timeoutMs: 25_000 });
      return observe(input);
    }, now: () => timestamp,
    setTimer(fn, delay) { assert.equal(delay, 15_000); callback = fn; return 1; },
    clearTimer() { callback = null; },
  });
  return { observer, time: (t) => timestamp = t, calls: () => calls,
    async tick() { callback(); await new Promise(setImmediate); } };
}
test("live observer is inert, single-flight, secretless, and read-only", async () => {
  const h = harness();
  assert.equal(h.calls(), 0);
  assert.equal(h.observer.readiness().ready, false);
  await Promise.all([h.observer.start(), h.observer.start()]);
  assert.equal(h.calls(), 1);
  for (let i = 0; i < 100; i++) assert.equal(h.observer.readiness().ready, true);
  assert.equal(h.calls(), 1);
  assert.equal(h.observer.readiness().publicProfile, "v2");
  h.observer.stop();
  assert.equal(h.observer.readiness().ready, false);
  await h.observer.start();
  assert.equal(h.calls(), 1);
});
test("failed refresh never serves an old successful observation", async () => {
  let fail = false;
  const h = harness(async () => { if (fail) throw Error("offline"); return success(); });
  await h.observer.start();
  fail = true;
  await h.tick();
  assert.equal(h.observer.readiness().ready, false);
  fail = false;
  await h.tick();
  assert.equal(h.observer.readiness().ready, true);
});
test("expired samples and clock reversal fail closed", async () => {
  const h = harness(); await h.observer.start();
  h.time(145_000); assert.equal(h.observer.readiness().ready, false);
  h.time(99_999); assert.equal(h.observer.readiness().ready, false);
  h.time(NaN); assert.equal(h.observer.readiness().ready, false);
});
test("a slow refresh fits the unchanged freshness limit without overlapping RPC work", async () => {
  let release;
  let pending = false;
  const h = harness(() => pending ? new Promise(resolve => { release = resolve; }) : success());
  await h.observer.start();
  pending = true;
  h.time(115_000);
  await h.tick();
  assert.equal(h.calls(), 2);
  h.time(139_999);
  assert.equal(h.observer.readiness().ready, true);
  const joined = h.observer.start();
  assert.equal(h.calls(), 2);
  release(success());
  h.time(140_000);
  await joined;
  assert.equal(h.observer.readiness().ready, true);
  h.time(185_000);
  assert.equal(h.observer.readiness().ready, false);
  h.observer.stop();
});
test("a stalled refresh cannot extend the previous success freshness", async () => {
  let release;
  let pending = false;
  const h = harness(() => pending ? new Promise(resolve => { release = resolve; }) : success());
  await h.observer.start();
  pending = true;
  h.time(115_000);
  await h.tick();
  const joined = h.observer.start();
  h.time(145_000);
  assert.equal(h.observer.readiness().ready, false);
  release({ status: 503 });
  await joined;
  assert.equal(h.observer.readiness().ready, false);
  h.observer.stop();
});
test("partial, wrong-revision, wrong-chain, or single-observer results fail closed", async () => {
  for (const modify of [
    r => r.status = 503, r => r.body.ok = false, r => r.body.revision = "b".repeat(40),
    r => r.body.network = 1, r => r.body.recoveryV2.observers = 1,
    r => r.body.recoveryV2.state = "pending", r => r.body.recoveryV2.reason = "UNKNOWN",
  ]) {
    const h = harness(async () => { const r = success(); modify(r); return r; });
    await h.observer.start(); assert.equal(h.observer.readiness().ready, false);
  }
});
test("stop during an observation cannot resurrect readiness", async () => {
  let resolve;
  const h = harness(() => new Promise(r => resolve = r));
  const started = h.observer.start(); await new Promise(setImmediate);
  h.observer.stop(); resolve(success()); await started;
  assert.equal(h.observer.readiness().ready, false);
});
test("activation requires exact explicit profile and does not accept deployment modes", () => {
  for (const [key, value] of [
    ["RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE", "armed"],
    ["RETRYCREDIT_RECOVERY_CONTRACT_VERSION", "v1"],
    ["RETRYCREDIT_RECOVERY_ENABLED", "false"],
    ["RETRYCREDIT_RECOVERY_POOL_ADDRESS", "0x" + "1".repeat(40)],
    ["RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER", "2"], ["RENDER_GIT_COMMIT", ""],
  ]) assert.throws(() => createRecoveryV2LiveObserver({ env: { ...env, [key]: value } }), /PROFILE_INVALID/);
});
