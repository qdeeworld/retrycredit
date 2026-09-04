import assert from "node:assert/strict";
import test from "node:test";

import {
  createCloudflareApiHandler,
  createCoordinatorRuntime,
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
  assert.equal((await handler(new Request("https://api.example/api/recovery/config?fresh=1"), ENV)).status, 200);
  assert.deepEqual(inputs.map(({ operation, body }) => ({ operation, body })), [
    { operation: "configuration", body: { fresh: false } },
    { operation: "configuration", body: { fresh: true } },
  ]);
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
    env: ENV,
  });

  const config = await runtime.execute(input("configuration", {}));
  assert.equal(config.status, 200);
  assert.equal(config.body.enabled, false);
  assert.equal(config.body.readOnly, true);
  assert.equal(readinessCalls, 1);
  assert.deepEqual(configurationCalls, [{ fresh: false }]);

  const freshConfig = await runtime.execute(input("configuration", { fresh: true }));
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

function input(operation, body) {
  return { operation, body, requestId: crypto.randomUUID() };
}
