import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRecoveryEligibility,
  releaseRecoveryWhenReady,
  releaseWhenReady,
  requestJson,
  requestJsonWithTimeout,
  requestRecoveryChallenge,
  TEMPORARY_UNAVAILABLE_MESSAGE,
  TemporaryUnavailableError,
  wakeConfig,
  wakeRecoveryConfig,
} from "../web/src/api.mjs";

const WALLET = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";

test("a timed JSON request bounds both the fetch and response body", async () => {
  const startedAt = Date.now();

  await assert.rejects(
    requestJsonWithTimeout({
      path: "/api/recovery/config",
      fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
      timeoutMs: 8,
    }),
    (error) => error instanceof TemporaryUnavailableError,
  );

  assert.ok(Date.now() - startedAt < 250);
});

test("the recovery config wake uses the V2 route and retries transient starts", async () => {
  const seen = [];
  const responses = [
    new Response(JSON.stringify({ enabled: false, waking: true }), { status: 200 }),
    new TypeError("network detail that must not reach the UI"),
    new Response(JSON.stringify({ enabled: true, campaignNumber: 1 }), { status: 200 }),
  ];
  let calls = 0;
  const config = await wakeRecoveryConfig({
    apiOrigin: "https://api.example",
    fetchImpl: async (url) => {
      seen.push(url);
      const result = responses[calls++];
      if (result instanceof Error) throw result;
      return result;
    },
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    attemptOffsetsMs: [0, 0, 0],
  });

  assert.equal(config.campaignNumber, 1);
  assert.deepEqual(seen, Array(3).fill("https://api.example/api/recovery/config"));
});

test("eligibility posts only the source wallet to the V2 endpoint", async () => {
  let captured;
  const result = await checkRecoveryEligibility({
    wallet: WALLET,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({ eligible: true, status: "eligible", wallet: WALLET }), { status: 200 });
    },
  });

  assert.equal(result.status, "eligible");
  assert.equal(captured.url, "/api/recovery/eligibility");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), { wallet: WALLET });
});

test("challenge preserves the server-issued authorization fields", async () => {
  const challenge = {
    wallet: WALLET,
    message: "Authorize RetryCredit campaign 1",
    issuedAt: 1_788_000_000,
    expiresAt: 1_788_000_300,
    campaignNumber: 1,
  };
  let body;
  const result = await requestRecoveryChallenge({
    wallet: WALLET,
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify(challenge), { status: 200 });
    },
  });

  assert.deepEqual(body, { wallet: WALLET });
  assert.deepEqual(result, challenge);
});

test("recovery release retries HTTP 425 with the exact signed challenge", async () => {
  const signed = {
    wallet: WALLET,
    message: "Authorize RetryCredit campaign 1",
    issuedAt: 1_788_000_000,
    expiresAt: 1_788_000_300,
    signature: "0x1234",
  };
  const pending = [];
  const bodies = [];
  let calls = 0;
  const result = await releaseRecoveryWhenReady({
    ...signed,
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, "/api/recovery/release");
      bodies.push(JSON.parse(options.body));
      return calls === 1
        ? new Response(JSON.stringify({ error: { code: "PROOF_PENDING", message: "pending", requestId: "req-1" } }), { status: 425 })
        : new Response(JSON.stringify({ status: "released", wallet: WALLET, release: { transactionHash: "0x03" } }), { status: 200 });
    },
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    retryDelayMs: 1,
    onPending: (value) => pending.push(value),
  });

  assert.equal(calls, 2);
  assert.deepEqual(bodies, [signed, signed]);
  assert.deepEqual(pending, [{ attempt: 1, code: "PROOF_PENDING", requestId: "req-1" }]);
  assert.equal(result.release.transactionHash, "0x03");
});

test("recovery release bounds hung requests with a retryable service error", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt: 1,
      expiresAt: 2,
      signature: "0x1234",
      fetchImpl: () => new Promise(() => undefined),
      totalTimeoutMs: 30,
      requestTimeoutMs: 8,
      retryDelayMs: 1,
    }),
    (error) => error instanceof TemporaryUnavailableError,
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("structured client errors preserve safe code and request id", async () => {
  await assert.rejects(
    checkRecoveryEligibility({
      wallet: WALLET,
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "INVALID_WALLET", message: "Wallet address is invalid", requestId: "req-safe" },
      }), { status: 400 }),
    }),
    (error) => error.message === "Wallet address is invalid"
      && error.code === "INVALID_WALLET"
      && error.requestId === "req-safe",
  );
});

test("raw network failures expose only the friendly temporary message", async () => {
  await assert.rejects(
    requestJson({
      path: "/api/recovery/config",
      fetchImpl: async () => { throw new TypeError("connect ECONNREFUSED 127.0.0.1:4179"); },
    }),
    (error) => error instanceof TemporaryUnavailableError
      && error.message === TEMPORARY_UNAVAILABLE_MESSAGE
      && !error.message.includes("ECONNREFUSED"),
  );
});

test("the previous Uniswap helpers remain available as a fallback", async () => {
  let configPath;
  await wakeConfig({
    fetchImpl: async (url) => {
      configPath = url;
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    },
  });
  assert.equal(configPath, "/api/retry-credit/config");

  const result = await releaseWhenReady({
    serviceCreditNumber: "1",
    failedTransactionHash: "0x01",
    successfulTransactionHash: "0x02",
    fetchImpl: async () => new Response(JSON.stringify({ release: { transactionHash: "0x03" } }), { status: 200 }),
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    retryDelayMs: 1,
  });
  assert.equal(result.release.transactionHash, "0x03");
});
