import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRecoveryEligibility,
  LEGACY_RELEASE_PENDING_MESSAGE,
  RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  recoveryAuthorizationDeadlines,
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
  let clock = 1_000;
  let wallClock = 10_000;
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
    authorizationStartedAtMs: 500,
    authorizationStartedAtWallMs: 9_500,
    now: () => clock,
    wallNow: () => wallClock,
    sleep: async (waitMs) => {
      clock += waitMs;
      wallClock += waitMs;
    },
    onPending: (value) => pending.push(value),
  });

  assert.equal(calls, 2);
  assert.deepEqual(bodies, [signed, signed]);
  assert.deepEqual(pending, [{ attempt: 1, code: "PROOF_PENDING", requestId: "req-1" }]);
  assert.equal(result.release.transactionHash, "0x03");
});

test("recovery release bounds hung requests with a retryable service error", async () => {
  const startedAt = Date.now();
  const issuedAt = Math.floor(startedAt / 1_000);
  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt,
      expiresAt: issuedAt + 300,
      authorizationStartedAtMs: performance.now(),
      authorizationStartedAtWallMs: Date.now(),
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

test("recovery polling is capped by the signed authorization deadline", async () => {
  const issuedAt = 1_000;
  const expiresAt = issuedAt + 300;
  const authorizationStartedAtMs = 50_000;
  const authorizationStartedAtWallMs = 500_000;
  const authorizationDeadlineMs = authorizationStartedAtMs + 300_000;
  const authorizationWallDeadlineMs = authorizationStartedAtWallMs + 300_000;
  let clock = authorizationDeadlineMs - 10_000;
  let wallClock = authorizationWallDeadlineMs - 10_000;
  const callTimes = [];
  const waits = [];

  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt,
      expiresAt,
      authorizationStartedAtMs,
      authorizationStartedAtWallMs,
      signature: "0x1234",
      fetchImpl: async () => {
        callTimes.push(clock);
        return new Response(JSON.stringify({
          error: { code: "RECOVERY_ATTESTATION_PENDING", message: "pending" },
        }), { status: 425 });
      },
      totalTimeoutMs: 15 * 60_000,
      requestTimeoutMs: 150_000,
      retryDelayMs: 15_000,
      now: () => clock,
      wallNow: () => wallClock,
      sleep: async (waitMs) => {
        waits.push(waitMs);
        clock += waitMs;
        wallClock += waitMs;
      },
    }),
    (error) => error.message === RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  );

  assert.deepEqual(callTimes, [authorizationDeadlineMs - 10_000]);
  assert.deepEqual(waits, [10_000]);
  assert.equal(clock, authorizationDeadlineMs);
});

test("an authorization at its local expiry boundary sends no release request", async () => {
  const issuedAt = 2_000;
  const expiresAt = issuedAt + 300;
  const authorizationStartedAtMs = 75_000;
  const authorizationStartedAtWallMs = 750_000;
  const clock = authorizationStartedAtMs + 300_000;
  const wallClock = authorizationStartedAtWallMs + 300_000;
  let calls = 0;

  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt,
      expiresAt,
      authorizationStartedAtMs,
      authorizationStartedAtWallMs,
      signature: "0x1234",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run");
      },
      now: () => clock,
      wallNow: () => wallClock,
    }),
    (error) => error.message === RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  );

  assert.equal(calls, 0);
  assert.deepEqual(recoveryAuthorizationDeadlines({
    authorizationStartedAtMs,
    authorizationStartedAtWallMs,
    issuedAt,
    expiresAt,
  }), { monotonic: clock, wallClock });
});

test("a request started just before expiry receives only the remaining authorization budget", async () => {
  const startedAt = performance.now();
  const authorizationStartedAtMs = startedAt - 950;
  const authorizationStartedAtWallMs = Date.now() - 950;
  let calls = 0;

  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt: 3_000,
      expiresAt: 3_001,
      authorizationStartedAtMs,
      authorizationStartedAtWallMs,
      signature: "0x1234",
      fetchImpl: (_url, options) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
      totalTimeoutMs: 15 * 60_000,
      requestTimeoutMs: 150_000,
    }),
    (error) => error instanceof TemporaryUnavailableError,
  );

  assert.equal(calls, 1);
  assert.ok(performance.now() - startedAt < 250);
});

test("authorization deadlines use signed lifetime and relative local clocks, not server epoch", () => {
  const inputs = {
    authorizationStartedAtMs: 12_345,
    authorizationStartedAtWallMs: 5_000_000,
    issuedAt: 1_788_000_000,
    expiresAt: 1_788_000_300,
  };
  assert.deepEqual(recoveryAuthorizationDeadlines(inputs), {
    monotonic: 312_345,
    wallClock: 5_300_000,
  });
  assert.deepEqual(recoveryAuthorizationDeadlines({
    ...inputs,
    authorizationStartedAtWallMs: 9_000_000,
    issuedAt: 9_999_999_000,
    expiresAt: 9_999_999_300,
  }), {
    monotonic: 312_345,
    wallClock: 9_300_000,
  });
});

test("wall-clock elapsed time expires authorization when the monotonic clock pauses during sleep", async () => {
  let calls = 0;
  await assert.rejects(
    releaseRecoveryWhenReady({
      wallet: WALLET,
      message: "message",
      issuedAt: 4_000,
      expiresAt: 4_300,
      authorizationStartedAtMs: 10_000,
      authorizationStartedAtWallMs: 1_000_000,
      signature: "0x1234",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not run after wake");
      },
      now: () => 11_000,
      wallNow: () => 1_300_000,
    }),
    (error) => error.code === "RECOVERY_CHALLENGE_EXPIRED",
  );
  assert.equal(calls, 0);
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

test("the archived V3 timeout never tells users to sign a V2 authorization", async () => {
  let clock = 0;
  let calls = 0;
  await assert.rejects(
    releaseWhenReady({
      serviceCreditNumber: "1",
      failedTransactionHash: "0x01",
      successfulTransactionHash: "0x02",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { code: "PROOF_PENDING", message: "pending" } }), {
          status: 425,
        });
      },
      totalTimeoutMs: 2,
      requestTimeoutMs: 2,
      retryDelayMs: 2,
      now: () => clock,
      sleep: async (waitMs) => { clock += waitMs; },
    }),
    (error) => error.message === LEGACY_RELEASE_PENDING_MESSAGE
      && !/sign|authorization/i.test(error.message),
  );
  assert.equal(calls, 1);
});
