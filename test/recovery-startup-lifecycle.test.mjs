import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WorkerError } from "../src/proof-worker.mjs";
import {
  createRecoveryStartupLifecycle,
  isRetryableRecoveryStartupError,
  RECOVERY_STARTUP_POLICY,
} from "../src/recovery-startup-lifecycle.mjs";
import { startServer } from "../src/server.mjs";

const transport = (code, fields = {}) => Object.assign(new Error("private transport detail"), { code, ...fields });
const wrapped = (cause, code = "RECOVERY_MISCONFIGURED") => new WorkerError(code, "safe readiness message", 503, cause);
const flush = async () => { for (let count = 0; count < 8; count += 1) await Promise.resolve(); };

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers,
    setTimeoutImpl(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeoutImpl(id) { timers.delete(id); },
    async tick(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

test("startup retries only explicit transport causes, never identity or configuration failures", () => {
  const transient = [
    transport("TIMEOUT"), transport("NETWORK_ERROR"),
    transport("NETWORK_ERROR", { event: "noNetwork" }),
    transport("SERVER_ERROR", { response: { statusCode: 429 } }),
    transport("SERVER_ERROR", { info: { responseStatus: "503 Service Unavailable" } }),
    new TypeError("fetch failed", { cause: transport("ECONNRESET") }),
    transport("UND_ERR_HEADERS_TIMEOUT"),
  ];
  for (const cause of transient) {
    assert.equal(isRetryableRecoveryStartupError(wrapped(cause)), true);
    assert.equal(isRetryableRecoveryStartupError(wrapped(cause, "RECOVERY_STATE_UNAVAILABLE")), true);
  }
  for (const cause of [
    new Error("wrong runtime bytecode"),
    transport("CALL_EXCEPTION"), transport("BAD_DATA"),
    transport("NETWORK_ERROR", { event: "changed" }),
    transport("SERVER_ERROR", { response: { statusCode: 401 } }),
    transport("SERVER_ERROR", { response: { statusCode: 403 } }),
    transport("SERVER_ERROR"),
    transport("INVALID_ARGUMENT", { cause: transport("TIMEOUT") }),
    new WorkerError("INVALID_RECOVERY_CONFIGURATION", "bad config", 500, transport("TIMEOUT")),
  ]) assert.equal(isRetryableRecoveryStartupError(wrapped(cause)), false);
  assert.equal(isRetryableRecoveryStartupError(wrapped()), false);
  const circular = new Error("cycle");
  circular.cause = circular;
  assert.equal(isRetryableRecoveryStartupError(circular), false);
});

test("transient startup failure retries after completion-relative backoff and becomes ready once", async () => {
  const clock = fakeClock();
  let calls = 0;
  let finishFirst;
  const lifecycle = createRecoveryStartupLifecycle({ ...clock, service: {
    async readiness() {
      calls += 1;
      if (calls === 1) return new Promise((resolve, reject) => { finishFirst = reject; });
      return { authenticated: true };
    },
  } });
  assert.equal(calls, 0);
  lifecycle.start();
  lifecycle.start();
  await flush();
  await clock.tick(10_000);
  assert.equal(calls, 1);
  finishFirst(wrapped(transport("TIMEOUT")));
  await flush();
  assert.equal(lifecycle.state, "waking");
  await clock.tick(14_999);
  assert.equal(calls, 1);
  await clock.tick(1);
  assert.equal(calls, 2);
  assert.equal(lifecycle.state, "ready");
  assert.equal(lifecycle.error, null);
  assert.equal(clock.timers.size, 0);
  lifecycle.start();
  await clock.tick(500_000);
  assert.equal(calls, 2);
});

test("five failed attempts exhaust the fixed retry budget without additional timers", async () => {
  const clock = fakeClock();
  let calls = 0;
  const failure = wrapped(transport("ECONNRESET"));
  const lifecycle = createRecoveryStartupLifecycle({ ...clock, service: {
    async readiness() { calls += 1; throw failure; },
  } });
  lifecycle.start();
  await flush();
  for (const delay of RECOVERY_STARTUP_POLICY.retryDelaysMs) await clock.tick(delay);
  assert.equal(calls, 5);
  assert.equal(lifecycle.state, "error");
  assert.equal(lifecycle.error, failure);
  assert.equal(clock.timers.size, 0);
  await clock.tick(1_000_000);
  lifecycle.start();
  assert.equal(calls, 5);
});

test("real configuration failures are terminal after the first readiness attempt", async () => {
  const clock = fakeClock();
  let calls = 0;
  const failure = wrapped(new Error("unexpected chain identity"));
  const lifecycle = createRecoveryStartupLifecycle({ ...clock, service: {
    readiness() { calls += 1; throw failure; },
  } });
  lifecycle.start();
  await flush();
  assert.equal(lifecycle.state, "error");
  assert.equal(lifecycle.error, failure);
  await clock.tick(1_000_000);
  assert.equal(calls, 1);
  assert.equal(clock.timers.size, 0);
});

test("a hung readiness attempt times out without overlapping work or accepting late completion", async () => {
  for (const lateReject of [false, true]) {
    const clock = fakeClock();
    let calls = 0;
    let resolveAttempt;
    let rejectAttempt;
    const lifecycle = createRecoveryStartupLifecycle({ ...clock, service: {
      readiness() {
        calls += 1;
        return new Promise((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; });
      },
    } });
    lifecycle.start();
    await flush();
    await clock.tick(RECOVERY_STARTUP_POLICY.attemptTimeoutMs);
    assert.equal(lifecycle.state, "error");
    assert.equal(lifecycle.error.code, "RECOVERY_STARTUP_TIMEOUT");
    if (lateReject) rejectAttempt(wrapped(transport("TIMEOUT")));
    else resolveAttempt({ authenticated: true });
    await flush();
    await clock.tick(1_000_000);
    assert.equal(calls, 1);
    assert.equal(lifecycle.state, "error");
    assert.equal(clock.timers.size, 0);
  }
});

test("stop cancels backoff and pending watchdogs and cannot resurrect readiness", async () => {
  for (const phase of ["before-start", "pending", "backoff", "ready"]) {
    const clock = fakeClock();
    let calls = 0;
    let resolvePending;
    const lifecycle = createRecoveryStartupLifecycle({ ...clock, service: {
      readiness() {
        calls += 1;
        if (phase === "backoff") throw wrapped(transport("TIMEOUT"));
        if (phase === "ready") return Promise.resolve();
        return new Promise(resolve => { resolvePending = resolve; });
      },
    } });
    if (phase !== "before-start") lifecycle.start();
    await flush();
    lifecycle.stop();
    resolvePending?.();
    await flush();
    lifecycle.start();
    await clock.tick(1_000_000);
    assert.equal(calls, phase === "before-start" ? 0 : 1);
    assert.equal(lifecycle.state, "error");
    assert.equal(lifecycle.error.code, "RECOVERY_STARTUP_STOPPED");
    assert.equal(clock.timers.size, 0);
  }
});

test("HTTP startup keeps actions closed until readiness and server close stops retries", async () => {
  const clock = fakeClock();
  let calls = 0;
  let dispatched = 0;
  const recovery = createRecoveryStartupLifecycle({ ...clock, service: {
    async readiness() { calls += 1; if (calls === 1) throw wrapped(transport("TIMEOUT")); },
    async intakeEligibility() { dispatched += 1; return { eligible: true }; },
  } });
  const server = startServer({
    port: 0, host: "127.0.0.1", recovery, legacyRetryCreditService: null,
    recoveryV2: { readiness() { return { ready: false, statusCode: 503 }; } },
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = () => fetch(`${base}/api/recovery/intake/eligibility`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  try {
    const waking = await post();
    assert.equal(waking.status, 425);
    assert.equal((await waking.json()).error.code, "RECOVERY_WAKING");
    assert.equal(dispatched, 0);
    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.equal(health.recoveryState, "waking");
    await clock.tick(15_000);
    assert.equal((await post()).status, 200);
    assert.equal(dispatched, 1);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  assert.equal(recovery.state, "error");
  assert.equal(recovery.error.code, "RECOVERY_STARTUP_STOPPED");
  assert.equal(clock.timers.size, 0);
});
