import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecoveryV2DeploymentSupervisor,
} from "../src/recovery-v2-deployment-supervisor.mjs";

const fingerprints = Object.freeze({
  transactionHash: `0x${"11".repeat(32)}`,
  contractAddress: "0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8",
  initCodeHash: "0xd069ba5cc3a80251a47b9915c9692e97d9a61d72e903bf590c28a42d4a2b33a6",
  runtimeCodeHash: "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07",
});

test("construction is inert and armed readiness is synchronously 503", () => {
  let factoryCalls = 0;
  let timerCalls = 0;
  const supervisor = createRecoveryV2DeploymentSupervisor({
    env: modeEnvironment("armed"),
    controllerFactory: async () => { factoryCalls += 1; return armedController([]); },
    setTimer() { timerCalls += 1; return 1; },
    clearTimer() {},
  });

  const first = supervisor.readiness();
  const second = supervisor.readiness();
  assert.deepEqual(first, {
    ready: false,
    statusCode: 503,
    mode: "armed",
    deploymentState: "not-started",
    publicProfile: "v1",
    reason: "RECOVERY_V2_DEPLOYMENT_NOT_VERIFIED",
  });
  assert.deepEqual(second, first);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(factoryCalls, 0);
  assert.equal(timerCalls, 0);
});

test("disabled mode is healthy and never calls prepare or run", async () => {
  let prepareCalls = 0;
  let runCalls = 0;
  let readinessCalls = 0;
  const controller = {
    mode: "disabled",
    readiness() { readinessCalls += 1; return { ready: true }; },
    async prepare() { prepareCalls += 1; throw new Error("must not prepare"); },
    async run() { runCalls += 1; throw new Error("must not run"); },
  };
  const supervisor = createRecoveryV2DeploymentSupervisor({ controller });
  assert.equal(supervisor.readiness().statusCode, 200);
  const first = supervisor.start();
  const second = supervisor.start();
  assert.equal(first, second);
  await first;
  assert.equal(supervisor.readiness().ready, true);
  assert.equal(supervisor.readiness().deploymentState, "disabled");
  assert.equal(prepareCalls, 0);
  assert.equal(runCalls, 0);
  assert.equal(readinessCalls, 0);
});

test("prepare runs exactly once and exposes only the four public fingerprints while V1 stays healthy", async () => {
  let prepareCalls = 0;
  let runCalls = 0;
  const controller = {
    mode: "prepare",
    readiness() { return { ready: true }; },
    async prepare() { prepareCalls += 1; return { ...fingerprints }; },
    async run() { runCalls += 1; throw new Error("prepare cannot run"); },
  };
  const supervisor = createRecoveryV2DeploymentSupervisor({ controller });
  assert.equal(supervisor.readiness().statusCode, 503);
  await Promise.all([supervisor.start(), supervisor.start(), supervisor.start()]);
  const ready = supervisor.readiness();
  assert.equal(prepareCalls, 1);
  assert.equal(runCalls, 0);
  assert.deepEqual(ready, {
    ready: true,
    statusCode: 200,
    mode: "prepare",
    deploymentState: "prepared",
    publicProfile: "v1",
    prepared: fingerprints,
  });
  assert.deepEqual(Object.keys(ready.prepared).sort(), [
    "contractAddress",
    "initCodeHash",
    "runtimeCodeHash",
    "transactionHash",
  ]);
});

test("prepare errors and extra fields remain deployment-unready and redact secrets", async () => {
  const secret = "0xfeed-private-key-rpc-secret";
  const throwing = createRecoveryV2DeploymentSupervisor({
    controller: {
      mode: "prepare",
      readiness() { return { ready: true }; },
      async prepare() { throw new Error(secret); },
    },
  });
  await throwing.start();
  assert.deepEqual(throwing.readiness(), {
    ready: false,
    statusCode: 503,
    mode: "prepare",
    deploymentState: "prepare-failed",
    publicProfile: "v1",
    reason: "RECOVERY_V2_PREPARE_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(throwing.readiness()), /feed|private|rpc-secret/i);

  const extra = createRecoveryV2DeploymentSupervisor({
    controller: {
      mode: "prepare",
      readiness() { return { ready: true }; },
      async prepare() { return { ...fingerprints, rawTransaction: secret }; },
    },
  });
  await extra.start();
  assert.equal(extra.readiness().ready, false);
  assert.equal(extra.readiness().statusCode, 503);
  assert.equal(extra.readiness().deploymentState, "prepare-failed");
  assert.equal("prepared" in extra.readiness(), false);
  assert.doesNotMatch(JSON.stringify(extra.readiness()), /feed|private|raw/i);
});

test("armed reconciliation serializes every retryable state until exact finality", async () => {
  const timers = manualTimers();
  const controller = armedController([
    lifecycle("broadcast", "IDENTICAL_RAW_ACCEPTED"),
    lifecycle("broadcast-uncertain", "IDENTICAL_RAW_BROADCAST_UNCERTAIN"),
    lifecycle("pending", "EXPECTED_TRANSACTION_PENDING"),
    lifecycle("mined", "AWAITING_FINALIZED_PLUS_TWO"),
    lifecycle("finalized", "FINALIZED_PLUS_TWO_VERIFIED"),
  ]);
  const supervisor = createRecoveryV2DeploymentSupervisor({
    controller,
    setTimer: timers.set,
    clearTimer: timers.clear,
    delayMs: 37,
  });

  await supervisor.start();
  assert.equal(controller.runCalls, 1);
  assert.equal(controller.maxActive, 1);
  assert.equal(supervisor.readiness().statusCode, 503);
  assert.equal(supervisor.readiness().deploymentState, "broadcast");
  assert.equal(timers.size(), 1);
  assert.equal(timers.delays()[0], 37);

  for (const state of ["broadcast-uncertain", "pending", "mined"]) {
    await timers.fireNext();
    assert.equal(supervisor.readiness().statusCode, 503);
    assert.equal(supervisor.readiness().deploymentState, state);
    assert.equal(timers.size(), 1);
  }
  await timers.fireNext();
  assert.equal(controller.runCalls, 5);
  assert.equal(controller.maxActive, 1);
  assert.deepEqual(supervisor.readiness(), {
    ready: true,
    statusCode: 200,
    mode: "armed",
    deploymentState: "finalized",
    publicProfile: "v1",
    reason: "FINALIZED_PLUS_TWO_VERIFIED",
  });
  assert.equal(timers.size(), 0);
});

test("idempotent start and the in-flight guard prevent overlapping armed runs", async () => {
  const timers = manualTimers();
  const firstGate = deferred();
  const secondGate = deferred();
  let runCalls = 0;
  let active = 0;
  let maxActive = 0;
  const controller = {
    mode: "armed",
    readiness() { return armedControllerReadiness(false); },
    async run() {
      runCalls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = await (runCalls === 1 ? firstGate.promise : secondGate.promise);
      active -= 1;
      return result;
    },
  };
  const supervisor = createRecoveryV2DeploymentSupervisor({
    controller,
    setTimer: timers.set,
    clearTimer: timers.clear,
    delayMs: 0,
  });
  const firstStart = supervisor.start();
  const secondStart = supervisor.start();
  assert.equal(firstStart, secondStart);
  await Promise.resolve();
  assert.equal(runCalls, 1);
  assert.equal(supervisor.readiness().deploymentState, "reconciling");
  assert.equal(supervisor.readiness().statusCode, 503);

  firstGate.resolve(lifecycle("pending", "EXPECTED_TRANSACTION_PENDING"));
  await firstStart;
  assert.equal(timers.size(), 1);
  const callback = timers.peekNext();
  const activeRetry = callback();
  const duplicateRetry = callback();
  await Promise.resolve();
  assert.equal(runCalls, 2);
  assert.equal(maxActive, 1);
  await duplicateRetry;
  secondGate.resolve(lifecycle("pending", "EXPECTED_TRANSACTION_PENDING"));
  await activeRetry;
  assert.equal(maxActive, 1);
});

test("blocked, conflict, and failed are terminal 503 states with no timer", async () => {
  for (const status of ["blocked", "conflict", "failed"]) {
    const timers = manualTimers();
    const controller = armedController([lifecycle(status, `TEST_${status.toUpperCase()}`)]);
    const supervisor = createRecoveryV2DeploymentSupervisor({
      controller,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    await supervisor.start();
    assert.equal(controller.runCalls, 1, status);
    assert.equal(supervisor.readiness().statusCode, 503, status);
    assert.equal(supervisor.readiness().deploymentState, status, status);
    assert.equal(timers.size(), 0, status);
    await supervisor.start();
    assert.equal(controller.runCalls, 1, status);
  }
});

test("only explicitly transient blocked reasons are retried inside the armed window", async () => {
  const timers = manualTimers();
  const controller = armedController([
    lifecycle("blocked", "PROVIDER_STATE_UNAVAILABLE"),
    lifecycle("blocked", "PREBROADCAST_VERIFICATION_UNAVAILABLE"),
    lifecycle("blocked", "PRESEND_STATE_UNAVAILABLE"),
    lifecycle("blocked", "BROADCAST_WINDOW_NOT_OPEN"),
    lifecycle("pending", "EXPECTED_TRANSACTION_PENDING"),
    lifecycle("finalized", "FINALIZED_PLUS_TWO_VERIFIED"),
  ]);
  const supervisor = createRecoveryV2DeploymentSupervisor({
    controller,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  await supervisor.start();
  assert.equal(supervisor.readiness().statusCode, 503);
  assert.equal(timers.size(), 1);
  for (let index = 0; index < 5; index += 1) {
    await timers.fireNext();
    if (index < 4) assert.equal(timers.size(), 1);
  }
  assert.equal(controller.runCalls, 6);
  assert.equal(supervisor.readiness().statusCode, 200);
  assert.equal(supervisor.readiness().deploymentState, "finalized");
  assert.equal(timers.size(), 0);
});

test("a finalized label without the controller's exact finality readiness remains terminal 503", async () => {
  const controller = armedController(
    [lifecycle("finalized", "FINALIZED_PLUS_TWO_VERIFIED")],
    { confirmFinality: false },
  );
  const supervisor = createRecoveryV2DeploymentSupervisor({ controller });
  await supervisor.start();
  assert.deepEqual(supervisor.readiness(), {
    ready: false,
    statusCode: 503,
    mode: "armed",
    deploymentState: "blocked",
    publicProfile: "v1",
    reason: "RECOVERY_V2_FINALITY_NOT_CONFIRMED",
  });
});

test("stop clears the scheduled retry and stale callbacks remain inert", async () => {
  const timers = manualTimers();
  const controller = armedController([
    lifecycle("broadcast", "IDENTICAL_RAW_ACCEPTED"),
    lifecycle("pending", "EXPECTED_TRANSACTION_PENDING"),
  ]);
  const supervisor = createRecoveryV2DeploymentSupervisor({
    controller,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  await supervisor.start();
  const staleCallback = timers.peekNext();
  assert.equal(timers.size(), 1);
  const stopped = supervisor.stop();
  assert.equal(timers.size(), 0);
  assert.equal(stopped.statusCode, 503);
  assert.equal(stopped.deploymentState, "stopped");
  await staleCallback();
  assert.equal(controller.runCalls, 1);
  assert.equal(timers.size(), 0);
  supervisor.stop();
  assert.equal(controller.runCalls, 1);
});

test("factory, run, and scheduler errors expose codes only, never messages or secrets", async () => {
  const secret = "https://user:pass@example.test/0xfeed-private-key";
  const factoryFailure = createRecoveryV2DeploymentSupervisor({
    env: modeEnvironment("armed"),
    controllerFactory: async () => { throw new Error(secret); },
  });
  await factoryFailure.start();
  assert.equal(factoryFailure.readiness().statusCode, 503);
  assert.equal(factoryFailure.readiness().reason, "RECOVERY_V2_CONTROLLER_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(factoryFailure.readiness()), /user|pass|feed|example/i);

  const runFailure = createRecoveryV2DeploymentSupervisor({
    controller: {
      mode: "armed",
      readiness() { return armedControllerReadiness(false); },
      async run() { throw new Error(secret); },
    },
  });
  await runFailure.start();
  assert.equal(runFailure.readiness().reason, "RECOVERY_V2_RECONCILIATION_FAILED");
  assert.doesNotMatch(JSON.stringify(runFailure.readiness()), /user|pass|feed|example/i);

  const scheduleFailure = createRecoveryV2DeploymentSupervisor({
    controller: armedController([lifecycle("pending", "EXPECTED_TRANSACTION_PENDING")]),
    setTimer() { throw new Error(secret); },
    clearTimer() {},
  });
  await scheduleFailure.start();
  assert.equal(scheduleFailure.readiness().reason, "RECOVERY_V2_RECONCILIATION_SCHEDULE_FAILED");
  assert.doesNotMatch(JSON.stringify(scheduleFailure.readiness()), /user|pass|feed|example/i);
});

function modeEnvironment(mode) {
  return { RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE: mode };
}

function lifecycle(status, reason) {
  return Object.freeze({ status, reason });
}

function armedController(results, { confirmFinality = true } = {}) {
  let index = 0;
  let active = 0;
  let finalized = false;
  return {
    mode: "armed",
    runCalls: 0,
    maxActive: 0,
    readiness() { return armedControllerReadiness(finalized && confirmFinality); },
    async run() {
      this.runCalls += 1;
      active += 1;
      this.maxActive = Math.max(this.maxActive, active);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      await Promise.resolve();
      active -= 1;
      if (result?.status === "finalized") finalized = true;
      return result;
    },
  };
}

function armedControllerReadiness(ready) {
  return ready
    ? {
      ready: true,
      statusCode: 200,
      mode: "armed",
      deploymentState: "finalized",
      reason: "FINALIZED_PLUS_TWO_VERIFIED",
      publicProfile: "v1",
    }
    : {
      ready: false,
      statusCode: 503,
      mode: "armed",
      deploymentState: "pending",
      reason: "EXPECTED_TRANSACTION_PENDING",
      publicProfile: "v1",
    };
}

function manualTimers() {
  let nextId = 1;
  const entries = new Map();
  const cleared = [];
  return {
    set(callback, delay) {
      const id = nextId;
      nextId += 1;
      entries.set(id, { callback, delay });
      return id;
    },
    clear(id) {
      cleared.push(id);
      entries.delete(id);
    },
    size() { return entries.size; },
    delays() { return [...entries.values()].map((entry) => entry.delay); },
    peekNext() {
      const entry = entries.values().next().value;
      if (!entry) throw new Error("no timer");
      return entry.callback;
    },
    async fireNext() {
      const [id, entry] = entries.entries().next().value ?? [];
      if (!entry) throw new Error("no timer");
      entries.delete(id);
      await entry.callback();
    },
    cleared,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
