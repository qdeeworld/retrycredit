import assert from "node:assert/strict";
import test from "node:test";

import {
  CloudflareApiError,
  createCloudflareApiHandler,
  createCoordinatorRuntime,
  createFreshReadDutyCycle,
} from "../src/cloudflare-worker-core.mjs";

const ENV = Object.freeze({
  ALLOWED_ORIGIN: "https://preview.example",
  RETRYCREDIT_DEPLOYMENT_REVISION: "a".repeat(40),
  RETRYCREDIT_ENVIRONMENT: "staging",
  RETRYCREDIT_RECOVERY_ENABLED: "true",
  CF_VERSION_METADATA: Object.freeze({
    id: "12345678-1234-1234-1234-1234567890ab",
    tag: "a".repeat(40),
  }),
});

test("Cloudflare serializes advisory diagnostics only for rejected exact-pair inspection", async () => {
  const checks = ["source-network", "transaction-type", "action-family", "same-wallet", "receipt-status", "nonce-order", "block-gap", "campaign-window", "paid-mint", "mint-identity", "mint-outcome", "campaign-fee-recipient", "campaign-quantity"];
  const diagnostics = {
    schema: "retrycredit.pair-diagnostics/1", authority: "advisory-source-check", attestationVerified: false,
    checkedAt: "2026-09-12T08:00:00.000Z", sourceChainId: 1,
    pair: { failedTransactionHash: `0x${"1".repeat(64)}`, successfulTransactionHash: `0x${"2".repeat(64)}` },
    campaign: { poolAddress: `0x${"3".repeat(40)}`, campaignNumber: 1, termsHash: `0x${"4".repeat(64)}`, startBlock: 1, endBlock: 100, maxBlockGap: 5, maxQuantity: 2, creditAmount: "100", deadline: 2000000000 },
    checks: checks.map((id) => ({ id, status: id === "campaign-window" ? "fail" : "pass", message: "PRIVATE_PROVIDER_TEXT" })),
    facts: { failed: { blockNumber: 101, nonce: 1, status: 0 }, successful: { blockNumber: 102, nonce: 2, status: 1 } },
    signature: "PRIVATE_SIGNATURE", cause: "PRIVATE_CAUSE",
  };
  for (const [operation, status, code, expected] of [
    ["intakeEligibility", 422, "RECOVERY_PAIR_INVALID", true],
    ["intakeChallenge", 422, "RECOVERY_PAIR_INVALID", false],
    ["intakeEligibility", 503, "RECOVERY_SOURCE_UNAVAILABLE", false],
  ]) {
    const reject = async () => { const error = new CloudflareApiError(code, "Source check failed", status); error.diagnostics = diagnostics; throw error; };
    const runtime = createCoordinatorRuntime({ env: ENV,
      serviceFactory: async () => ({ readiness: async () => undefined, intakeEligibility: reject, intakeChallenge: reject }),
      freshReadControl: { admit: async () => undefined, issueReceipt: async () => undefined },
    });
    const result = await runtime.execute({ operation, body: {}, requestId: "test-diagnostic" });
    assert.equal(result.status, status);
    assert.equal(Boolean(result.body.error.diagnostics), expected);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    if (expected) assert.equal(result.body.error.diagnostics.attestationVerified, false);
  }
});

test("Cloudflare handler preserves exact CORS, revision, and read-only health", async () => {
  const coordinator = {
    async health() { return { state: "ready" }; },
  };
  const handler = createCloudflareApiHandler({ coordinatorFor: () => coordinator });
  const response = await handler(new Request("https://api.example/health"), ENV);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), ENV.ALLOWED_ORIGIN);
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(body.revision, ENV.RETRYCREDIT_DEPLOYMENT_REVISION);
  assert.deepEqual(body.workerVersion, {
    id: ENV.CF_VERSION_METADATA.id,
    tag: ENV.CF_VERSION_METADATA.tag,
  });
  assert.equal(body.recoveryState, "ready");
  assert.equal(body.writesEnabled, false);
  assert.equal(body.hosting, "cloudflare-workers");

  const preflight = await handler(new Request("https://api.example/api/recovery/config?fresh=1", {
    method: "OPTIONS",
    headers: {
      origin: ENV.ALLOWED_ORIGIN,
      "access-control-request-headers": "authorization",
      "access-control-request-method": "GET",
    },
  }), ENV);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "authorization, content-type");
});

test("V2 observation health keeps current per-request metadata outside its provider snapshot", async () => {
  let observationCalls = 0;
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => { throw new Error("campaign coordinator must not be used"); },
    observeRecoveryV2: async () => {
      observationCalls += 1;
      return {
        status: 200,
        body: {
          ok: true,
          service: "retrycredit",
          network: 102031,
          recoveryV2: {
            mode: "observation-only",
            state: "observed",
            publicProfile: "v1",
            reason: "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO",
            observers: 2,
          },
          revision: ENV.RETRYCREDIT_DEPLOYMENT_REVISION,
        },
      };
    },
  });
  const first = await handler(new Request("https://api.example/health/recovery-v2"), ENV);
  const second = await handler(new Request("https://api.example/health/recovery-v2"), ENV);
  const firstBody = await first.json();

  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("access-control-allow-origin"), ENV.ALLOWED_ORIGIN);
  assert.notEqual(first.headers.get("x-request-id"), second.headers.get("x-request-id"));
  assert.equal(firstBody.revision, ENV.RETRYCREDIT_DEPLOYMENT_REVISION);
  assert.deepEqual(firstBody.workerVersion, {
    id: ENV.CF_VERSION_METADATA.id,
    tag: ENV.CF_VERSION_METADATA.tag,
  });
  assert.equal(observationCalls, 2);
});

test("V2 observation health preserves its fail-closed contract when the object RPC rejects", async () => {
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => { throw new Error("campaign coordinator must not be used"); },
    observeRecoveryV2: async () => { throw new Error("private object failure"); },
  });
  const response = await handler(new Request("https://api.example/health/recovery-v2"), ENV);
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), ENV.ALLOWED_ORIGIN);
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, {
    ok: false,
    service: "retrycredit",
    network: 102031,
    recoveryV2: {
      mode: "observation-only",
      state: "blocked",
      publicProfile: "v1",
      reason: "RECOVERY_V2_OBSERVATION_FAILED",
    },
    revision: ENV.RETRYCREDIT_DEPLOYMENT_REVISION,
    workerVersion: {
      id: ENV.CF_VERSION_METADATA.id,
      tag: ENV.CF_VERSION_METADATA.tag,
    },
  });
});

test("Cloudflare handler rejects unsupported routes without invoking the coordinator", async () => {
  let called = false;
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => {
      called = true;
      return {};
    },
  });
  const response = await handler(new Request("https://api.example/not-a-route"), ENV);
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.equal(called, false);
});

test("Cloudflare config forwards only the explicit fresh query to the coordinator", async () => {
  const inputs = [];
  const coordinator = {
    async execute(input) {
      inputs.push(input);
      return { status: 200, body: { enabled: false } };
    },
  };
  const handler = createCloudflareApiHandler({ coordinatorFor: () => coordinator });

  assert.equal((await handler(new Request("https://api.example/api/recovery/config"), ENV)).status, 200);
  assert.equal((await handler(new Request("https://api.example/api/recovery/config?fresh=1", {
    headers: { authorization: "RetryCreditFresh credential" },
  }), ENV)).status, 200);
  assert.deepEqual(inputs.map(({ operation, body }) => ({ operation, body })), [
    { operation: "configuration", body: { fresh: false } },
    { operation: "configuration", body: { fresh: true, authorization: "credential" } },
  ]);
});

test("Cloudflare fresh config requires a bounded authorization header before coordinator lookup", async () => {
  let coordinatorCalls = 0;
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => {
      coordinatorCalls += 1;
      return { async execute() { throw new Error("must not execute"); } };
    },
  });

  for (const authorization of [
    null,
    "Bearer credential",
    "RetryCreditFresh ",
    "RetryCreditFresh two credentials",
    "RetryCreditFresh " + "a".repeat(2_100),
  ]) {
    const headers = authorization === null ? {} : { authorization };
    const response = await handler(new Request("https://api.example/api/recovery/config?fresh=1", { headers }), ENV);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "RECOVERY_FRESH_AUTHORIZATION_REQUIRED");
  }
  assert.equal(coordinatorCalls, 0);
});

test("Cloudflare handler preserves a fresh-read throttle envelope and exact retry timing", async () => {
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => ({
      async execute(input) {
        return {
          status: 429,
          retryAfter: "4",
          body: {
            error: {
              code: "RECOVERY_FRESH_READ_THROTTLED",
              message: "Fresh campaign data was just checked. Try again in a few seconds.",
              requestId: input.requestId,
            },
          },
        };
      },
    }),
  });
  const response = await handler(
    new Request("https://api.example/api/recovery/config?fresh=1", {
      headers: { authorization: "RetryCreditFresh credential" },
    }),
    ENV,
  );
  const body = await response.json();

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "4");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("access-control-allow-origin"), ENV.ALLOWED_ORIGIN);
  assert.equal(body.error.code, "RECOVERY_FRESH_READ_THROTTLED");
  assert.equal(body.error.requestId, response.headers.get("x-request-id"));
});

test("Cloudflare handler enforces JSON content type and 16 KB body bound", async () => {
  let coordinatorCalls = 0;
  const coordinator = { async execute() { coordinatorCalls += 1; throw new Error("must not execute"); } };
  const handler = createCloudflareApiHandler({ coordinatorFor: () => coordinator });

  const wrongType = await handler(new Request("https://api.example/api/recovery/discover", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "text/plain" },
  }), ENV);
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).error.code, "INVALID_CONTENT_TYPE");

  const tooLarge = await handler(new Request("https://api.example/api/recovery/discover", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(16_384) }),
    headers: { "content-type": "application/json" },
  }), ENV);
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error.code, "BODY_TOO_LARGE");
  assert.equal(coordinatorCalls, 0);
});

test("Cloudflare handler cancels an oversized streamed body before reading the tail", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10_000));
      controller.enqueue(new Uint8Array(10_000));
    },
    cancel() { cancelled = true; },
  });
  const handler = createCloudflareApiHandler({
    coordinatorFor: () => ({ async execute() { throw new Error("must not execute"); } }),
  });
  const response = await handler(new Request("https://api.example/api/recovery/discover", {
    method: "POST",
    body,
    duplex: "half",
    headers: { "content-type": "application/json" },
  }), ENV);

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, "BODY_TOO_LARGE");
  assert.equal(cancelled, true);
});

test("read-only coordinator exposes authenticated config but fails release closed", async () => {
  let readinessCalls = 0;
  let releaseCalls = 0;
  const configurationCalls = [];
  const service = {
    async readiness() { readinessCalls += 1; },
    async configuration(options) {
      configurationCalls.push(options);
      return { enabled: true, poolAddress: "0xpool" };
    },
    async intakeRelease() { releaseCalls += 1; return { status: "released" }; },
  };
  const runtime = createCoordinatorRuntime({
    serviceFactory: () => service,
    freshReadControl: mockFreshReadControl(),
    env: ENV,
  });

  const config = await runtime.execute(input("configuration", {}));
  assert.equal(config.status, 200);
  assert.equal(config.body.enabled, false);
  assert.equal(config.body.readOnly, true);
  assert.equal(config.body.consent.freshReadAdmission, "pair-signature-v1");
  assert.equal(readinessCalls, 1);
  assert.deepEqual(configurationCalls, [{ fresh: false }]);

  const freshConfig = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));
  assert.equal(freshConfig.status, 200);
  assert.deepEqual(configurationCalls, [{ fresh: false }, { fresh: true }]);

  const release = await runtime.execute({
    ...input("intakeRelease", { wallet: "0x01" }),
    release: false,
  });
  assert.equal(release.status, 410);
  assert.equal(release.body.error.code, "RECOVERY_WRITES_DISABLED");
  assert.equal(releaseCalls, 0);
});

test("the read plane cannot be switched into write mode through env or RPC input", async () => {
  let releaseCalls = 0;
  const env = { ...ENV, RETRYCREDIT_RECOVERY_WRITES_ENABLED: "true" };
  const runtime = createCoordinatorRuntime({
    env,
    freshReadControl: mockFreshReadControl(),
    serviceFactory: () => ({
      async readiness() {},
      async intakeRelease() {
        releaseCalls += 1;
        return { status: "released" };
      },
    }),
  });
  const result = await runtime.execute({
    ...input("intakeRelease", { wallet: "0x01" }),
    release: false,
  });

  assert.equal(result.status, 410);
  assert.equal(result.body.error.code, "RECOVERY_WRITES_DISABLED");
  assert.equal(releaseCalls, 0);
});

test("the persisted fresh-read duty cycle admits one of 100 callers and survives recreation", async () => {
  let nowMs = 1_000_000;
  const storage = memoryTransactionalStorage();
  const gate = createFreshReadDutyCycle({ storage, now: () => nowMs });
  const decisions = await Promise.allSettled(Array.from({ length: 100 }, () => gate()));
  const admitted = decisions.filter(({ status }) => status === "fulfilled");
  const rejected = decisions.filter(({ status }) => status === "rejected");

  assert.equal(admitted.length, 1);
  assert.equal(rejected.length, 99);
  for (const { reason } of rejected) {
    assert.ok(reason instanceof CloudflareApiError);
    assert.equal(reason.status, 429);
    assert.equal(reason.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(reason.retryAfter, "5");
  }

  const recreatedGate = createFreshReadDutyCycle({ storage, now: () => nowMs });
  await assert.rejects(recreatedGate(), (error) => {
    assert.equal(error.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(error.retryAfter, "5");
    return true;
  });

  nowMs += 5_000;
  await recreatedGate();
});

test("a cold fresh configuration is itself the single readiness state read", async () => {
  let readinessCalls = 0;
  let configurationCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: ENV,
    freshReadControl: mockFreshReadControl(),
    serviceFactory: () => ({
      async readiness() { readinessCalls += 1; },
      async configuration(options) {
        configurationCalls += 1;
        assert.deepEqual(options, { fresh: true });
        return { enabled: true, poolAddress: "0xpool" };
      },
    }),
  });

  const fresh = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));
  assert.equal(fresh.status, 200);
  assert.equal(readinessCalls, 0);
  assert.equal(configurationCalls, 1);

  assert.deepEqual(await runtime.health(), { state: "ready" });
  assert.equal(readinessCalls, 0);
  assert.equal(configurationCalls, 1);
});

test("fresh-read admission precedes service work and provider failure consumes the window", async () => {
  let nowMs = 2_000_000;
  let serviceFactoryCalls = 0;
  let configurationCalls = 0;
  const storage = memoryTransactionalStorage();
  const runtime = createCoordinatorRuntime({
    env: ENV,
    freshReadControl: mockFreshReadControl({
      admit: createFreshReadDutyCycle({ storage, now: () => nowMs }),
    }),
    serviceFactory: () => {
      serviceFactoryCalls += 1;
      return {
        async readiness() {},
        async configuration() {
          configurationCalls += 1;
          throw new CloudflareApiError(
            "RECOVERY_UPSTREAM_UNAVAILABLE",
            "Campaign data is temporarily unavailable",
            503,
          );
        },
      };
    },
  });

  const failed = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "RECOVERY_UPSTREAM_UNAVAILABLE");

  const throttled = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, "RECOVERY_FRESH_READ_THROTTLED");
  assert.equal(throttled.retryAfter, "5");
  assert.equal(serviceFactoryCalls, 1);
  assert.equal(configurationCalls, 1);

  nowMs += 5_000;
  const failedAtBoundary = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));
  assert.equal(failedAtBoundary.status, 503);
  assert.equal(serviceFactoryCalls, 2);
  assert.equal(configurationCalls, 2);
});

test("normal reads and unrelated operations bypass the fresh-read duty cycle", async () => {
  let admissionCalls = 0;
  let configurationCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: ENV,
    freshReadControl: mockFreshReadControl({ admit: async () => { admissionCalls += 1; } }),
    serviceFactory: () => ({
      async readiness() {},
      async configuration() {
        configurationCalls += 1;
        return { enabled: true, poolAddress: "0xpool" };
      },
      async eligibility() { return { eligible: false }; },
    }),
  });

  assert.equal((await runtime.execute(input("configuration", {}))).status, 200);
  assert.equal((await runtime.execute(input("eligibility", { wallet: "0x01" }))).status, 200);
  assert.equal(admissionCalls, 0);
  assert.equal(configurationCalls, 1);

  assert.equal((await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }))).status, 200);
  assert.equal(admissionCalls, 1);
  assert.equal(configurationCalls, 2);
});

test("fresh-read storage failure and corrupt state fail closed before service construction", async () => {
  for (const [label, storage, expectedCode] of [
    ["storage failure", {
      async transaction() { throw new Error("private storage detail"); },
    }, "RECOVERY_FRESH_READ_GATE_UNAVAILABLE"],
    ["corrupt state", memoryTransactionalStorage([
      ["fresh-config:not-before-ms:v1", "not-a-timestamp"],
    ]), "RECOVERY_FRESH_READ_STATE_INVALID"],
  ]) {
    let serviceFactoryCalls = 0;
    const runtime = createCoordinatorRuntime({
      env: ENV,
      freshReadControl: mockFreshReadControl({
        admit: createFreshReadDutyCycle({ storage, now: () => 3_000_000 }),
      }),
      serviceFactory: () => {
        serviceFactoryCalls += 1;
        throw new Error("service must not be constructed");
      },
    });
    const result = await runtime.execute(input("configuration", { fresh: true, authorization: "credential" }));

    assert.equal(result.status, 503, label);
    assert.equal(result.body.error.code, expectedCode, label);
    assert.equal(serviceFactoryCalls, 0, label);
  }
});

function input(operation, body) {
  return { operation, body, requestId: crypto.randomUUID() };
}

function mockFreshReadControl({ admit = async () => {}, issueReceipt = async () => "v1.receipt" } = {}) {
  return { admit, issueReceipt };
}

function memoryTransactionalStorage(entries = []) {
  const values = new Map(entries);
  let transactionTail = Promise.resolve();
  return {
    transaction(callback) {
      const result = transactionTail.then(async () => {
        const staged = new Map(values);
        const value = await callback({
          async get(key) { return staged.get(key); },
          async put(key, nextValue) { staged.set(key, nextValue); },
        });
        values.clear();
        for (const [key, nextValue] of staged) values.set(key, nextValue);
        return value;
      });
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
}
