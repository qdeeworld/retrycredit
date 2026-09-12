import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRecoveryEligibility,
  createRecoveryFreshReadAuthorization,
  discoverRecoveryWallet,
  LEGACY_RELEASE_PENDING_MESSAGE,
  RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  RateLimitedError,
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
const FRESH_PAIR = Object.freeze({
  failedTransactionHash: "0x" + "11".repeat(32),
  successfulTransactionHash: "0x" + "22".repeat(32),
});
const FRESH_SIGNATURE = "0x" + "33".repeat(65);
const FRESH_RECEIPT = "v1." + "A".repeat(43);

test("default config wake retains a late attempt after a slow cold-start failure", async () => {
  let elapsed = 0;
  const starts = [];
  const waits = [];
  const result = await wakeRecoveryConfig({
    now: () => elapsed,
    sleep: async (ms) => { waits.push(ms); elapsed += ms; },
    fetchImpl: async (url) => {
      assert.equal(url, "/api/recovery/config");
      starts.push(elapsed);
      // The observed idle-start request took 13.494 seconds, outlasting
      // both early retry offsets. Service readiness is deliberately later.
      if (starts.length === 1) elapsed += 13_494;
      return elapsed >= 30_000
        ? new Response(JSON.stringify({ enabled: true, campaignNumber: 1 }), { status: 200 })
        : new Response(JSON.stringify({ error: { code: "RECOVERY_UNAVAILABLE", message: "Waking" } }), { status: 503 });
    },
  });
  assert.equal(result.enabled, true);
  assert.deepEqual(starts, [0, 13_494, 30_000]);
  assert.deepEqual(waits, [16_506]);
});

test("default config wake still stops after three unavailable responses", async () => {
  let elapsed = 0;
  const starts = [];
  await assert.rejects(wakeRecoveryConfig({
    now: () => elapsed,
    sleep: async (ms) => { elapsed += ms; },
    fetchImpl: async () => {
      starts.push(elapsed);
      return new Response(JSON.stringify({ error: { code: "RECOVERY_UNAVAILABLE", message: "Unavailable" } }), { status: 503 });
    },
  }), TemporaryUnavailableError);
  assert.deepEqual(starts, [0, 3_000, 30_000]);
});

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

  const freshSeen = [];
  await wakeRecoveryConfig({
    apiOrigin: "https://api.example",
    fresh: true,
    fetchImpl: async (url) => {
      freshSeen.push(url);
      return new Response(JSON.stringify({ enabled: true, campaignNumber: 1 }), { status: 200 });
    },
    totalTimeoutMs: 50,
    requestTimeoutMs: 25,
    attemptOffsetsMs: [0],
  });
  assert.deepEqual(freshSeen, ["https://api.example/api/recovery/config?fresh=1"]);
});

test("signed fresh config retries reuse one exact canonical Authorization envelope", async () => {
  const freshAuthorization = createRecoveryFreshReadAuthorization({
    challenge: {
      wallet: WALLET,
      pair: FRESH_PAIR,
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_300,
      freshReadReceipt: FRESH_RECEIPT,
      message: "must not be serialized",
      destination: "must not be serialized",
    },
    signature: FRESH_SIGNATURE,
  });
  const [scheme, token] = freshAuthorization.split(" ");
  const credential = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  assert.equal(scheme, "RetryCreditFresh");
  assert.deepEqual(Object.keys(credential), [
    "v", "wallet", "pair", "issuedAt", "expiresAt", "signature", "receipt",
  ]);
  assert.deepEqual(Object.keys(credential.pair), [
    "failedTransactionHash", "successfulTransactionHash",
  ]);
  assert.deepEqual(credential, {
    v: 1,
    wallet: WALLET,
    pair: FRESH_PAIR,
    issuedAt: 1_800_000_000,
    expiresAt: 1_800_000_300,
    signature: FRESH_SIGNATURE,
    receipt: FRESH_RECEIPT,
  });
  assert.equal("message" in credential, false);
  assert.equal("destination" in credential, false);

  let nowMs = 10_000;
  const headers = [];
  let calls = 0;
  const result = await wakeRecoveryConfig({
    fresh: true,
    freshAuthorization,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/recovery/config?fresh=1");
      headers.push(options.headers.authorization);
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({
          error: {
            code: "RECOVERY_FRESH_READ_THROTTLED",
            message: "wait",
            requestId: "signed-throttle",
          },
        }), { status: 429, headers: { "retry-after": "5" } })
        : new Response(JSON.stringify({ enabled: true }), { status: 200 });
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0],
    now: () => nowMs,
    random: () => 0,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
  });

  assert.equal(result.enabled, true);
  assert.deepEqual(headers, [freshAuthorization, freshAuthorization]);
});

test("signed fresh config never retries or downgrades a rejected authorization", async () => {
  const freshAuthorization = "RetryCreditFresh credential";
  for (const [status, code] of [
    [401, "RECOVERY_FRESH_AUTHORIZATION_INVALID"],
    [409, "RECOVERY_FRESH_READ_AUTHORIZATION_USED"],
  ]) {
    let calls = 0;
    await assert.rejects(wakeRecoveryConfig({
      fresh: true,
      freshAuthorization,
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, "/api/recovery/config?fresh=1");
        assert.equal(options.headers.authorization, freshAuthorization);
        return new Response(JSON.stringify({
          error: { code, message: "rejected", requestId: "signed-rejected" },
        }), { status });
      },
      attemptOffsetsMs: [0, 0, 0],
    }), (error) => error.status === status && error.code === code);
    assert.equal(calls, 1);
  }
});

test("fresh authorization is never attached to an ordinary or malformed request", async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ enabled: true }), { status: 200 });
  };
  await assert.rejects(
    wakeRecoveryConfig({ freshAuthorization: "RetryCreditFresh credential", fetchImpl }),
    (error) => error instanceof TypeError,
  );
  for (const freshAuthorization of [
    "Bearer credential",
    "RetryCreditFresh two credentials",
    "RetryCreditFresh " + "a".repeat(2_049),
  ]) {
    await assert.rejects(
      wakeRecoveryConfig({ fresh: true, freshAuthorization, fetchImpl }),
      (error) => error instanceof TypeError,
    );
  }
  assert.equal(fetchCalls, 0);

  const seenOptions = [];
  await wakeRecoveryConfig({
    fresh: true,
    fetchImpl: async (_url, options) => {
      seenOptions.push(options);
      return new Response(JSON.stringify({ enabled: true }), { status: 200 });
    },
    attemptOffsetsMs: [0],
  });
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].headers, undefined);
});

test("a lost admitted response retries with the same credential and surfaces its used result", async () => {
  const freshAuthorization = "RetryCreditFresh credential";
  const headers = [];
  let calls = 0;
  await assert.rejects(wakeRecoveryConfig({
    fresh: true,
    freshAuthorization,
    fetchImpl: async (url, options) => {
      calls += 1;
      headers.push(options.headers.authorization);
      if (calls === 1) throw new TypeError("response lost after admission");
      return new Response(JSON.stringify({
        error: {
          code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
          message: "used",
          requestId: "used-after-loss",
        },
      }), { status: 409 });
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0],
    sleep: async () => {},
  }), (error) => error.status === 409
    && error.code === "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
  assert.deepEqual(headers, [freshAuthorization, freshAuthorization]);
});

test("a fresh config wake honors Retry-After and never treats a throttled body as fresh truth", async () => {
  let nowMs = 10_000;
  const waits = [];
  const seen = [];
  const responses = [
    new Response(JSON.stringify({
      enabled: true,
      campaignNumber: 1,
      error: {
        code: "RECOVERY_FRESH_READ_THROTTLED",
        message: "Fresh campaign data was just checked. Try again in a few seconds.",
        requestId: "request-one",
      },
    }), {
      status: 429,
      headers: { "retry-after": "5" },
    }),
    new Response(JSON.stringify({ enabled: true, campaignNumber: 2 }), { status: 200 }),
  ];
  const config = await wakeRecoveryConfig({
    apiOrigin: "https://api.example",
    fresh: true,
    fetchImpl: async (url) => {
      seen.push(url);
      return responses.shift();
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0],
    now: () => nowMs,
    random: () => 0,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      nowMs += milliseconds;
    },
  });

  assert.equal(config.campaignNumber, 2);
  assert.deepEqual(seen, Array(2).fill("https://api.example/api/recovery/config?fresh=1"));
  assert.deepEqual(waits, [5_000]);
});

test("fresh config retries stay bounded and ordinary config never retries a rate limit", async () => {
  let freshNowMs = 20_000;
  let freshCalls = 0;
  const throttled = () => new Response(JSON.stringify({
    error: {
      code: "RECOVERY_FRESH_READ_THROTTLED",
      message: "Fresh campaign data was just checked. Try again in a few seconds.",
      requestId: `request-${freshCalls}`,
    },
  }), { status: 429, headers: { "retry-after": "5" } });

  await assert.rejects(wakeRecoveryConfig({
    fresh: true,
    fetchImpl: async () => {
      freshCalls += 1;
      return throttled();
    },
    totalTimeoutMs: 12_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0, 0],
    now: () => freshNowMs,
    random: () => 0,
    sleep: async (milliseconds) => { freshNowMs += milliseconds; },
  }), (error) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(error.retryAfter, "5");
    return true;
  });
  assert.equal(freshCalls, 3);

  let ordinaryCalls = 0;
  await assert.rejects(wakeRecoveryConfig({
    fetchImpl: async () => {
      ordinaryCalls += 1;
      return throttled();
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0, 0],
  }), (error) => error instanceof RateLimitedError);
  assert.equal(ordinaryCalls, 1);

  let unrelatedRateLimitCalls = 0;
  await assert.rejects(wakeRecoveryConfig({
    fresh: true,
    fetchImpl: async () => {
      unrelatedRateLimitCalls += 1;
      return new Response(JSON.stringify({
        error: {
          code: "RECOVERY_BUSY",
          message: "Recovery intake is busy.",
          requestId: "unrelated-rate-limit",
        },
      }), { status: 429, headers: { "retry-after": "5" } });
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0, 0],
  }), (error) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.code, "RECOVERY_BUSY");
    return true;
  });
  assert.equal(unrelatedRateLimitCalls, 1);

  let untrustedRetryCalls = 0;
  await assert.rejects(wakeRecoveryConfig({
    fresh: true,
    fetchImpl: async () => {
      untrustedRetryCalls += 1;
      return new Response(JSON.stringify({
        error: {
          code: "RECOVERY_FRESH_READ_THROTTLED",
          message: "Fresh campaign data was just checked. Try again in a few seconds.",
          requestId: "missing-retry-after",
        },
      }), { status: 429 });
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0, 0],
  }), (error) => error instanceof RateLimitedError);
  assert.equal(untrustedRetryCalls, 1);
});

test("a stale signed operation cannot consume a later fresh-read admission", async () => {
  let nowMs = 30_000;
  let current = true;
  let calls = 0;
  const waits = [];

  await assert.rejects(wakeRecoveryConfig({
    fresh: true,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({
        error: {
          code: "RECOVERY_FRESH_READ_THROTTLED",
          message: "Fresh campaign data was just checked. Try again in a few seconds.",
          requestId: "stale-operation",
        },
      }), { status: 429, headers: { "retry-after": "5" } });
    },
    totalTimeoutMs: 10_000,
    requestTimeoutMs: 1_000,
    attemptOffsetsMs: [0, 0, 0],
    now: () => nowMs,
    random: () => 0.5,
    canAttempt: () => current,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      nowMs += milliseconds;
      current = false;
    },
  }), (error) => error instanceof TemporaryUnavailableError);

  assert.equal(calls, 1);
  assert.deepEqual(waits, [5_125]);
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

test("wallet discovery posts only the connected address to the advisory endpoint", async () => {
  let captured;
  const result = await discoverRecoveryWallet({
    wallet: WALLET,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        wallet: WALLET,
        authority: "advisory-discovery-only",
        matches: [],
      }), { status: 200 });
    },
  });
  assert.equal(result.authority, "advisory-discovery-only");
  assert.equal(captured.url, "/api/recovery/discover");
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
