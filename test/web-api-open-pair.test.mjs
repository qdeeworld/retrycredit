import assert from "node:assert/strict";
import test from "node:test";
import {
  checkRecoveryPairEligibility,
  RateLimitedError,
  RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  releaseRecoveryPairWhenReady,
  requestRecoveryIntakeChallenge,
} from "../web/src/api.mjs";

const WALLET = "0xbad35FA6e368e90fC4faf63507F2D0A2Fdf94BAF";
const PAIR = Object.freeze({
  failedTransactionHash: `0x${"1".repeat(64)}`,
  successfulTransactionHash: `0x${"2".repeat(64)}`,
});

test("open eligibility and challenge send only the ordered pair to their intake routes", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await checkRecoveryPairEligibility({ pair: PAIR, fetchImpl });
  await requestRecoveryIntakeChallenge({ pair: PAIR, fetchImpl });

  assert.deepEqual(seen, [
    { url: "/api/recovery/intake/eligibility", body: { pair: PAIR } },
    { url: "/api/recovery/intake/challenge", body: { pair: PAIR } },
  ]);
  assert.equal("wallet" in seen[0].body, false);
});

test("open release retries pending proof with the exact pair-bound signature fields", async () => {
  const bodies = [];
  const pending = [];
  const retrying = [];
  const events = [];
  let calls = 0;
  let clock = 1_000;
  let wallClock = 10_000;
  const signed = {
    wallet: WALLET,
    pair: PAIR,
    issuedAt: 1_788_000_000,
    expiresAt: 1_788_000_300,
    signature: "0x1234",
  };

  const result = await releaseRecoveryPairWhenReady({
    ...signed,
    authorizationStartedAtMs: 500,
    authorizationStartedAtWallMs: 9_500,
    totalTimeoutMs: 100,
    requestTimeoutMs: 50,
    retryDelayMs: 1,
    now: () => clock,
    wallNow: () => wallClock,
    sleep: async (waitMs) => {
      clock += waitMs;
      wallClock += waitMs;
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/recovery/intake/release");
      events.push(`fetch-${calls + 1}`);
      bodies.push(JSON.parse(options.body));
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({
          error: { code: "RECOVERY_ATTESTATION_PENDING", message: "pending", requestId: "req-pair" },
        }), { status: 425 })
        : new Response(JSON.stringify({ status: "released", wallet: WALLET }), { status: 200 });
    },
    onSubmitting: () => events.push("submitting"),
    onPending: (value) => pending.push(value),
    onRetrying: (value) => retrying.push(value),
  });

  assert.equal(result.status, "released");
  assert.deepEqual(bodies, [signed, signed]);
  assert.equal("message" in bodies[0], false);
  assert.deepEqual(events, ["submitting", "fetch-1", "fetch-2"]);
  assert.deepEqual(pending, [{ attempt: 1, code: "RECOVERY_ATTESTATION_PENDING", requestId: "req-pair" }]);
  assert.deepEqual(retrying, [{ attempt: 2 }]);
});

test("an expired open-pair authorization never announces or attempts submission", async () => {
  let submittingCalls = 0;
  let fetchCalls = 0;

  await assert.rejects(
    releaseRecoveryPairWhenReady({
      wallet: WALLET,
      pair: PAIR,
      issuedAt: 2_000,
      expiresAt: 2_300,
      authorizationStartedAtMs: 75_000,
      authorizationStartedAtWallMs: 750_000,
      signature: "0x1234",
      now: () => 375_000,
      wallNow: () => 1_050_000,
      onSubmitting: () => { submittingCalls += 1; },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not submit");
      },
    }),
    (error) => error.code === "RECOVERY_CHALLENGE_EXPIRED"
      && error.message === RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE,
  );

  assert.equal(submittingCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("rate limiting remains distinct from service unavailability", async () => {
  await assert.rejects(
    checkRecoveryPairEligibility({
      pair: PAIR,
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "RECOVERY_BUSY", message: "Recovery source intake is busy; retry shortly.", requestId: "req-busy" },
      }), { status: 429, headers: { "retry-after": "3" } }),
    }),
    (error) => error instanceof RateLimitedError
      && error.status === 429
      && error.code === "RECOVERY_BUSY"
      && error.requestId === "req-busy"
      && error.retryAfter === "3",
  );
});

test("semantic pair errors preserve their safe status and code", async () => {
  await assert.rejects(
    checkRecoveryPairEligibility({
      pair: PAIR,
      fetchImpl: async () => new Response(JSON.stringify({
        error: { code: "RECOVERY_PAIR_INVALID", message: "The transactions do not form the required retry pair." },
      }), { status: 422 }),
    }),
    (error) => error.status === 422 && error.code === "RECOVERY_PAIR_INVALID",
  );
});
