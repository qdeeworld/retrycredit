import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseWhenReady,
  requestJson,
  requestJsonWithTimeout,
  TEMPORARY_UNAVAILABLE_MESSAGE,
  TemporaryUnavailableError,
  wakeConfig,
} from "../web/src/api.mjs";

test("a timed JSON request bounds both the fetch and response body", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    requestJsonWithTimeout({
      path: "/api/retry-credit/1/release",
      fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
      timeoutMs: 8,
    }),
    (error) => error instanceof TemporaryUnavailableError,
  );

  assert.ok(Date.now() - startedAt < 250);
});

test("release polling bounds a hung request and preserves a retryable error", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    releaseWhenReady({
      serviceCreditNumber: "1",
      failedTransactionHash: "0x01",
      successfulTransactionHash: "0x02",
      fetchImpl: () => new Promise(() => undefined),
      totalTimeoutMs: 30,
      requestTimeoutMs: 8,
      retryDelayMs: 1,
    }),
    (error) => error instanceof TemporaryUnavailableError,
  );

  assert.ok(Date.now() - startedAt < 250);
});

test("release polling retries HTTP 425 and returns the completed release", async () => {
  let calls = 0;
  const result = await releaseWhenReady({
    serviceCreditNumber: "1",
    failedTransactionHash: "0x01",
    successfulTransactionHash: "0x02",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: "pending" } }), { status: 425 })
        : new Response(JSON.stringify({ release: { transactionHash: "0x03" } }), { status: 200 });
    },
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    retryDelayMs: 1,
  });

  assert.equal(calls, 2);
  assert.equal(result.release.transactionHash, "0x03");
});

test("config wake retries transient failures and returns the first successful config", async () => {
  const responses = [
    new Response(JSON.stringify({ error: { message: "starting" } }), { status: 503 }),
    new TypeError("network detail that must not reach the UI"),
    new Response(JSON.stringify({ enabled: true, creditAmount: "10000000000000000" }), { status: 200 }),
  ];
  let calls = 0;
  const fetchImpl = async () => {
    const result = responses[calls++];
    if (result instanceof Error) throw result;
    return result;
  };

  const config = await wakeConfig({
    fetchImpl,
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    attemptOffsetsMs: [0, 0, 0],
  });

  assert.equal(config.enabled, true);
  assert.equal(calls, 3);
});

test("config wake keeps a slow first request open instead of rotating immediately", async () => {
  const config = await wakeConfig({
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    },
    totalTimeoutMs: 60,
    requestTimeoutMs: 50,
    attemptOffsetsMs: [0, 3, 8],
  });

  assert.equal(config.enabled, true);
});

test("config wake stops within its bounded deadline when requests hang", async () => {
  let calls = 0;
  const startedAt = Date.now();

  await assert.rejects(
    wakeConfig({
      fetchImpl: () => {
        calls += 1;
        return new Promise(() => undefined);
      },
      totalTimeoutMs: 30,
      requestTimeoutMs: 8,
      attemptOffsetsMs: [0, 10, 20],
    }),
    (error) => error instanceof TemporaryUnavailableError && error.message === TEMPORARY_UNAVAILABLE_MESSAGE,
  );

  assert.equal(calls, 3);
  assert.ok(Date.now() - startedAt < 250);
});

test("config wake does not retry a deterministic client error", async () => {
  let calls = 0;

  await assert.rejects(
    wakeConfig({
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: "Wallet address is invalid" } }), { status: 400 });
      },
      attemptOffsetsMs: [0, 0, 0],
    }),
    /Wallet address is invalid/,
  );

  assert.equal(calls, 1);
});

test("raw network failures expose only the friendly temporary message", async () => {
  await assert.rejects(
    requestJson({
      path: "/api/retry-credit/config",
      fetchImpl: async () => { throw new TypeError("connect ECONNREFUSED 127.0.0.1:4179"); },
    }),
    (error) => error instanceof TemporaryUnavailableError
      && error.message === TEMPORARY_UNAVAILABLE_MESSAGE
      && !error.message.includes("ECONNREFUSED"),
  );
});
