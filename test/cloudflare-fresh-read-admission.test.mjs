import assert from "node:assert/strict";
import test from "node:test";

import { Wallet, getAddress } from "ethers";

import {
  createSignedFreshReadControl,
  encodeFreshReadCredential,
} from "../src/cloudflare-fresh-read-admission.mjs";
import {
  CloudflareApiError,
  createCloudflareApiHandler,
  createCoordinatorRuntime,
} from "../src/cloudflare-worker-core.mjs";
import { recoveryChallengeMessage } from "../src/recovery-campaign-service.mjs";
import {
  createRecoveryFreshReadAuthorization,
  requestRecoveryIntakeChallenge,
} from "../web/src/api.mjs";

const PRIVATE_KEY = "0x" + "11".repeat(32);
const WALLET = new Wallet(PRIVATE_KEY);
const POOL = getAddress("0x" + "aa".repeat(20));
const ORIGIN = "https://retrycredit.example";
const CAMPAIGN = 7;
const INITIAL_NOW_MS = 1_800_000_000_000;

test("a live-qualified HMAC receipt and exact wallet signature admit once", async () => {
  const fixture = createFixture();
  const authorization = await signedAuthorization(fixture);

  await fixture.control.admit(authorization);
  await assert.rejects(fixture.control.admit(authorization), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
    return true;
  });
});

test("the browser header crosses the HTTP parser and signed coordinator as one exact credential", async () => {
  const fixture = createFixture();
  const serviceChallenge = challengeFor({ nowMs: fixture.nowMs() });
  let challengeCalls = 0;
  let readinessCalls = 0;
  let configurationCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: fixture.control,
    serviceFactory: () => ({
      async readiness() { readinessCalls += 1; },
      async intakeChallenge({ pair }) {
        challengeCalls += 1;
        assert.deepEqual(pair, serviceChallenge.pair);
        return serviceChallenge;
      },
      async configuration({ fresh }) {
        configurationCalls += 1;
        return { enabled: true, consent: {}, fresh };
      },
    }),
  });
  const handler = createCloudflareApiHandler({ coordinatorFor: () => runtime });
  const env = { ALLOWED_ORIGIN: ORIGIN };
  const fetchImpl = (url, options) => handler(
    new Request("https://api.example" + url, options),
    env,
  );
  const challenge = await requestRecoveryIntakeChallenge({
    pair: serviceChallenge.pair,
    fetchImpl,
  });
  assert.equal(challengeCalls, 1);
  assert.equal(readinessCalls, 1);
  assert.match(challenge.freshReadReceipt, /^v1\.[A-Za-z0-9_-]{43}$/);
  const authorization = createRecoveryFreshReadAuthorization({
    challenge,
    signature: await WALLET.signMessage(challenge.message),
  });
  const request = () => new Request("https://api.example/api/recovery/config?fresh=1", {
    headers: { authorization },
  });

  const admitted = await handler(request(), env);
  assert.equal(admitted.status, 200);
  assert.equal((await admitted.json()).consent.freshReadAdmission, "pair-signature-v1");
  assert.equal(configurationCalls, 1);

  const replayed = await handler(request(), env);
  assert.equal(replayed.status, 409);
  assert.equal((await replayed.json()).error.code, "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
  assert.equal(configurationCalls, 1);
});

test("an invalid receipt is rejected before wallet-signature recovery", async () => {
  let signatureRecoveries = 0;
  const fixture = createFixture({
    recoverSigner() {
      signatureRecoveries += 1;
      return WALLET.address;
    },
  });
  const challenge = challengeFor({ nowMs: fixture.nowMs() });
  const authorization = encodeFreshReadCredential({
    v: 1,
    wallet: challenge.wallet,
    pair: challenge.pair,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature: "0x" + "22".repeat(65),
    receipt: "v1." + "A".repeat(43),
  });

  await assert.rejects(fixture.control.admit(authorization), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "RECOVERY_FRESH_READ_STATE_INVALID");
    return true;
  });
  assert.equal(signatureRecoveries, 0);

  await fixture.control.issueReceipt(challenge);
  await assert.rejects(fixture.control.admit(authorization), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "RECOVERY_FRESH_AUTHORIZATION_INVALID");
    return true;
  });
  assert.equal(signatureRecoveries, 0);
});

test("the receipt binds wallet, pair, origin, pool, campaign, and timestamps", async () => {
  const fixture = createFixture();
  const challenge = challengeFor({ nowMs: fixture.nowMs() });
  const receipt = await fixture.control.issueReceipt(challenge);
  const signature = await WALLET.signMessage(challenge.message);
  const base = {
    v: 1,
    wallet: challenge.wallet,
    pair: challenge.pair,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature,
    receipt,
  };

  const mutations = [
    { ...base, wallet: getAddress("0x" + "bb".repeat(20)) },
    { ...base, pair: { ...base.pair, failedTransactionHash: hashFor(9_001) } },
    { ...base, issuedAt: base.issuedAt + 1, expiresAt: base.expiresAt + 1 },
    { ...base, signature: "0x" + "33".repeat(65) },
  ];
  for (const mutation of mutations) {
    await assert.rejects(fixture.control.admit(encodeFreshReadCredential(mutation)), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "RECOVERY_FRESH_AUTHORIZATION_INVALID");
      return true;
    });
  }

  for (const boundaryMutation of [
    { publicOrigin: "https://other.example" },
    { poolAddress: getAddress("0x" + "cc".repeat(20)) },
    { campaignNumber: CAMPAIGN + 1 },
  ]) {
    const other = createFixture({
      storage: fixture.storage,
      ...boundaryMutation,
    });
    await assert.rejects(other.control.admit(encodeFreshReadCredential(base)), (error) => {
      assert.equal(error.status, 401);
      assert.equal(error.code, "RECOVERY_FRESH_AUTHORIZATION_INVALID");
      return true;
    });
  }
});

test("a wrong-wallet signature does not consume a valid receipt", async () => {
  const fixture = createFixture();
  const challenge = challengeFor({ nowMs: fixture.nowMs() });
  const receipt = await fixture.control.issueReceipt(challenge);
  const otherWallet = new Wallet("0x" + "22".repeat(32));
  const credential = (signature) => encodeFreshReadCredential({
    v: 1,
    wallet: challenge.wallet,
    pair: challenge.pair,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature,
    receipt,
  });

  await assert.rejects(
    fixture.control.admit(credential(await otherWallet.signMessage(challenge.message))),
    (error) => error.status === 401 && error.code === "RECOVERY_FRESH_AUTHORIZATION_INVALID",
  );
  await fixture.control.admit(credential(await WALLET.signMessage(challenge.message)));
});

test("a non-canonical base64url alias of a valid receipt is rejected", async () => {
  const fixture = createFixture();
  const challenge = challengeFor({ nowMs: fixture.nowMs() });
  const receipt = await fixture.control.issueReceipt(challenge);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonicalLast = receipt.at(-1);
  const aliasedReceipt = receipt.slice(0, -1) + alphabet[alphabet.indexOf(canonicalLast) + 1];
  const signature = await WALLET.signMessage(challenge.message);
  const credential = (freshReadReceipt) => encodeFreshReadCredential({
    v: 1,
    wallet: challenge.wallet,
    pair: challenge.pair,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature,
    receipt: freshReadReceipt,
  });

  assert.notEqual(aliasedReceipt, receipt);
  assert.deepEqual(
    Buffer.from(aliasedReceipt.slice(3), "base64url"),
    Buffer.from(receipt.slice(3), "base64url"),
  );
  await assert.rejects(fixture.control.admit(credential(aliasedReceipt)), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "RECOVERY_FRESH_AUTHORIZATION_INVALID");
    return true;
  });
  await fixture.control.admit(credential(receipt));
});

test("one of 100 distinct signed authorizations wins and throttled credentials remain usable", async () => {
  const fixture = createFixture({ recoverSigner: () => WALLET.address });
  const placeholderSignature = "0x" + "44".repeat(65);
  const authorizations = [];
  for (let index = 0; index < 100; index += 1) {
    const pair = {
      failedTransactionHash: hashFor(index * 2 + 1),
      successfulTransactionHash: hashFor(index * 2 + 2),
    };
    const challenge = challengeFor({ nowMs: fixture.nowMs(), pair });
    const receipt = await fixture.control.issueReceipt(challenge);
    authorizations.push(encodeFreshReadCredential({
      v: 1,
      wallet: challenge.wallet,
      pair,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature: placeholderSignature,
      receipt,
    }));
  }

  const decisions = await Promise.allSettled(
    authorizations.map((authorization) => fixture.control.admit(authorization)),
  );
  assert.equal(decisions.filter(({ status }) => status === "fulfilled").length, 1);
  const throttled = decisions
    .map((decision, index) => ({ decision, authorization: authorizations[index] }))
    .filter(({ decision }) => decision.status === "rejected");
  assert.equal(throttled.length, 99);
  for (const { decision } of throttled) {
    assert.equal(decision.reason.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(decision.reason.retryAfter, "5");
  }

  fixture.advance(5_000);
  await fixture.control.admit(throttled[0].authorization);
});

test("one of 100 copies wins and every replay conflicts without resetting cadence", async () => {
  const fixture = createFixture({ recoverSigner: () => WALLET.address });
  const authorization = await signedAuthorization(fixture, {
    signature: "0x" + "55".repeat(65),
  });
  const decisions = await Promise.allSettled(
    Array.from({ length: 100 }, () => fixture.control.admit(authorization)),
  );

  assert.equal(decisions.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = decisions.filter(({ status }) => status === "rejected");
  assert.equal(rejected.length, 99);
  for (const { reason } of rejected) {
    assert.equal(reason.status, 409);
    assert.equal(reason.code, "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
  }
});

test("a throttled authorization is not consumed, while expiry and storage corruption fail closed", async () => {
  const fixture = createFixture();
  const first = await signedAuthorization(fixture);
  await fixture.control.admit(first);

  fixture.advance(1_000);
  const second = await signedAuthorization(fixture, { pair: pairFor(50), issuedAtOffset: 1 });
  await assert.rejects(fixture.control.admit(second), (error) => {
    assert.equal(error.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(error.retryAfter, "4");
    return true;
  });
  fixture.advance(4_000);
  await fixture.control.admit(second);

  fixture.advance(301_000);
  await assert.rejects(fixture.control.admit(second), (error) => {
    assert.equal(error.code, "RECOVERY_CHALLENGE_EXPIRED");
    return true;
  });

  const corruptStorage = memoryTransactionalStorage([
    ["fresh-config:receipt-hmac-key:v1", "not-a-key"],
  ]);
  const corrupt = createFixture({ storage: corruptStorage });
  const challenge = challengeFor({ nowMs: corrupt.nowMs() });
  await assert.rejects(corrupt.control.issueReceipt(challenge), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "RECOVERY_FRESH_READ_STATE_INVALID");
    return true;
  });
});

test("expiry and cadence are re-evaluated at the atomic admission decision", async () => {
  let expiryNowMs = INITIAL_NOW_MS;
  const expiryStorage = memoryTransactionalStorage();
  const expiryControl = createSignedFreshReadControl({
    storage: expiryStorage,
    publicOrigin: ORIGIN,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    now: () => expiryNowMs,
    recoverSigner() {
      expiryNowMs += 301_000;
      return WALLET.address;
    },
  });
  const expiringChallenge = challengeFor({ nowMs: expiryNowMs });
  const expiringReceipt = await expiryControl.issueReceipt(expiringChallenge);
  const expiringCredential = encodeFreshReadCredential({
    v: 1,
    wallet: WALLET.address,
    pair: expiringChallenge.pair,
    issuedAt: expiringChallenge.issuedAt,
    expiresAt: expiringChallenge.expiresAt,
    signature: "0x" + "77".repeat(65),
    receipt: expiringReceipt,
  });
  await assert.rejects(expiryControl.admit(expiringCredential), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.code, "RECOVERY_CHALLENGE_EXPIRED");
    return true;
  });
  assert.equal(await expiryStorage.get("fresh-config:not-before-ms:v1"), undefined);

  let cadenceNowMs = INITIAL_NOW_MS;
  let signatureRecoveries = 0;
  const cadenceControl = createSignedFreshReadControl({
    storage: memoryTransactionalStorage(),
    publicOrigin: ORIGIN,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    now: () => cadenceNowMs,
    recoverSigner() {
      signatureRecoveries += 1;
      if (signatureRecoveries === 1) cadenceNowMs += 10_000;
      return WALLET.address;
    },
  });
  const cadenceCredentials = [];
  for (const pair of [pairFor(60), pairFor(61)]) {
    const challenge = challengeFor({ nowMs: cadenceNowMs, pair });
    cadenceCredentials.push(encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature: "0x" + "88".repeat(65),
      receipt: await cadenceControl.issueReceipt(challenge),
    }));
  }
  await cadenceControl.admit(cadenceCredentials[0]);
  await assert.rejects(cadenceControl.admit(cadenceCredentials[1]), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(error.retryAfter, "5");
    return true;
  });
});

test("invalid HMAC admission and replay stop before service construction", async () => {
  const fixture = createFixture();
  const legitimate = await signedAuthorization(fixture);
  const alteredChallenge = challengeFor({ nowMs: fixture.nowMs(), pair: pairFor(80) });
  const legitimateCredential = decodeCredential(legitimate);
  const fabricated = encodeFreshReadCredential({
    ...legitimateCredential,
    pair: alteredChallenge.pair,
    signature: await WALLET.signMessage(alteredChallenge.message),
  });
  let serviceFactoryCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: fixture.control,
    serviceFactory() {
      serviceFactoryCalls += 1;
      return { async configuration() { return { enabled: true }; } };
    },
  });

  const rejected = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: fabricated,
  }));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, "RECOVERY_FRESH_AUTHORIZATION_INVALID");
  assert.equal(serviceFactoryCalls, 0);

  const admitted = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: legitimate,
  }));
  assert.equal(admitted.status, 200);
  assert.equal(serviceFactoryCalls, 1);
  const replayed = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: legitimate,
  }));
  assert.equal(replayed.status, 409);
  assert.equal(replayed.body.error.code, "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
  assert.equal(serviceFactoryCalls, 1);
});

test("provider failure burns the signed admission and its persisted duty-cycle window", async () => {
  const fixture = createFixture();
  const first = await signedAuthorization(fixture);
  const second = await signedAuthorization(fixture, { pair: pairFor(90) });
  let serviceFactoryCalls = 0;
  let configurationCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: fixture.control,
    serviceFactory() {
      serviceFactoryCalls += 1;
      return {
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

  const failed = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: first,
  }));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.error.code, "RECOVERY_UPSTREAM_UNAVAILABLE");
  assert.equal(serviceFactoryCalls, 1);
  assert.equal(configurationCalls, 1);

  const replayed = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: first,
  }));
  assert.equal(replayed.status, 409);
  assert.equal(replayed.body.error.code, "RECOVERY_FRESH_READ_AUTHORIZATION_USED");
  const throttled = await runtime.execute(runtimeInput("configuration", {
    fresh: true,
    authorization: second,
  }));
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, "RECOVERY_FRESH_READ_THROTTLED");
  assert.equal(serviceFactoryCalls, 1);
  assert.equal(configurationCalls, 1);
});

test("the coordinator attaches a receipt only after intake challenge qualification", async () => {
  const challenge = challengeFor({ nowMs: INITIAL_NOW_MS });
  const issued = [];
  let readinessCalls = 0;
  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: {
      async admit() {},
      async issueReceipt(value) {
        issued.push(value);
        return "v1." + "A".repeat(43);
      },
    },
    serviceFactory: () => ({
      async readiness() { readinessCalls += 1; },
      async intakeChallenge() { return challenge; },
    }),
  });

  const result = await runtime.execute(runtimeInput("intakeChallenge", { pair: challenge.pair }));
  assert.equal(result.status, 200);
  assert.equal(result.body.freshReadReceipt, "v1." + "A".repeat(43));
  assert.deepEqual(issued, [challenge]);
  assert.equal(readinessCalls, 1);
});

test("challenge failures and non-challenge operations never expose a receipt", async () => {
  let receiptCalls = 0;
  const expectedFailure = new CloudflareApiError(
    "RECOVERY_PAIR_INVALID",
    "The pair does not qualify",
    422,
  );
  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: {
      async admit() {},
      async issueReceipt() { receiptCalls += 1; return "v1." + "A".repeat(43); },
    },
    serviceFactory: () => ({
      async readiness() {},
      async intakeChallenge() { throw expectedFailure; },
      async intakeEligibility() { return { eligible: true }; },
    }),
  });

  const eligibility = await runtime.execute(runtimeInput("intakeEligibility", { pair: pairFor(1) }));
  assert.equal(eligibility.status, 200);
  assert.equal("freshReadReceipt" in eligibility.body, false);
  const challengeFailure = await runtime.execute(runtimeInput("intakeChallenge", { pair: pairFor(1) }));
  assert.equal(challengeFailure.status, 422);
  assert.equal(challengeFailure.body.error.code, "RECOVERY_PAIR_INVALID");
  assert.equal("freshReadReceipt" in challengeFailure.body, false);
  assert.equal(receiptCalls, 0);
});

test("malformed internal challenge truth and receipt generation failure fail closed", async () => {
  const fixture = createFixture();
  const malformed = {
    ...challengeFor({ nowMs: fixture.nowMs() }),
    message: "substituted consent",
  };
  await assert.rejects(fixture.control.issueReceipt(malformed), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "RECOVERY_FRESH_READ_GATE_UNAVAILABLE");
    return true;
  });

  const runtime = createCoordinatorRuntime({
    env: { RETRYCREDIT_RECOVERY_ENABLED: "true" },
    freshReadControl: {
      async admit() {},
      async issueReceipt() {
        throw new CloudflareApiError(
          "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
          "Fresh campaign data cannot be checked right now",
          503,
        );
      },
    },
    serviceFactory: () => ({
      async readiness() {},
      async intakeChallenge() { return challengeFor({ nowMs: INITIAL_NOW_MS }); },
    }),
  });
  const result = await runtime.execute(runtimeInput("intakeChallenge", { pair: pairFor(1) }));
  assert.equal(result.status, 503);
  assert.deepEqual(Object.keys(result.body), ["error"]);
  assert.equal(result.body.error.code, "RECOVERY_FRESH_READ_GATE_UNAVAILABLE");
});

test("the new signed control preserves the legacy duty-cycle checkpoint across upgrade", async () => {
  const fixture = createFixture();
  const authorization = await signedAuthorization(fixture);
  fixture.storage.set("fresh-config:not-before-ms:v1", fixture.nowMs() + 5_000);

  await assert.rejects(fixture.control.admit(authorization), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.code, "RECOVERY_FRESH_READ_THROTTLED");
    assert.equal(error.retryAfter, "5");
    return true;
  });
  fixture.advance(5_000);
  await fixture.control.admit(authorization);

  const corrupt = createFixture();
  const corruptAuthorization = await signedAuthorization(corrupt);
  corrupt.storage.set("fresh-config:not-before-ms:v1", "corrupt");
  await assert.rejects(corrupt.control.admit(corruptAuthorization), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "RECOVERY_FRESH_READ_STATE_INVALID");
    return true;
  });
});

test("an allowed wide timing profile retains more than 128 active replay records", async () => {
  const storage = memoryTransactionalStorage();
  let nowMs = INITIAL_NOW_MS;
  const control = createSignedFreshReadControl({
    storage,
    publicOrigin: ORIGIN,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    now: () => nowMs,
    minimumIntervalMs: 1_000,
    recoverSigner: () => WALLET.address,
  });
  for (let index = 0; index < 129; index += 1) {
    const pair = pairFor(200 + index);
    const challenge = challengeFor({ nowMs, pair });
    const receipt = await control.issueReceipt(challenge);
    await control.admit(encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature: "0x" + "66".repeat(65),
      receipt,
    }));
    nowMs += 1_000;
  }
});

test("Web Crypto failures and impossible persisted replay expiry fail closed", async () => {
  const signFailure = createFixture({
    cryptoImpl: cryptoWith({
      async sign() { throw new Error("private HMAC detail"); },
    }),
  });
  await assert.rejects(
    signFailure.control.issueReceipt(challengeFor({ nowMs: signFailure.nowMs() })),
    (error) => error.status === 503 && error.code === "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
  );

  const good = createFixture();
  const authorization = await signedAuthorization(good);
  const verifyFailure = createFixture({
    storage: good.storage,
    cryptoImpl: cryptoWith({
      async verify() { throw new Error("private HMAC detail"); },
    }),
  });
  await assert.rejects(
    verifyFailure.control.admit(authorization),
    (error) => error.status === 503 && error.code === "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
  );

  const digestFailure = createFixture({
    storage: good.storage,
    cryptoImpl: cryptoWith({
      async digest() { throw new Error("private digest detail"); },
    }),
  });
  await assert.rejects(
    digestFailure.control.admit(authorization),
    (error) => error.status === 503 && error.code === "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
  );

  good.storage.set("fresh-config:used-authorizations:v1", [{
    id: "a".repeat(64),
    expiresAt: Math.floor(good.nowMs() / 1_000) + 1_000,
  }]);
  await assert.rejects(good.control.admit(authorization), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "RECOVERY_FRESH_READ_STATE_INVALID");
    return true;
  });
});

async function signedAuthorization(fixture, {
  pair = pairFor(1),
  issuedAtOffset = 0,
  signature,
} = {}) {
  const challenge = challengeFor({
    nowMs: fixture.nowMs(),
    pair,
    issuedAtOffset,
  });
  const receipt = await fixture.control.issueReceipt(challenge);
  return encodeFreshReadCredential({
    v: 1,
    wallet: challenge.wallet,
    pair: challenge.pair,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    signature: signature ?? await WALLET.signMessage(challenge.message),
    receipt,
  });
}

function challengeFor({ nowMs, pair = pairFor(1), issuedAtOffset = 0 }) {
  const issuedAt = Math.floor(nowMs / 1_000) + issuedAtOffset;
  const expiresAt = issuedAt + 300;
  const message = recoveryChallengeMessage({
    origin: ORIGIN,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    wallet: WALLET.address,
    failedTransactionHash: pair.failedTransactionHash,
    successfulTransactionHash: pair.successfulTransactionHash,
    issuedAt,
    expiresAt,
  });
  return {
    wallet: WALLET.address,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    pair,
    issuedAt,
    expiresAt,
    message,
  };
}

function createFixture({
  storage = memoryTransactionalStorage(),
  publicOrigin = ORIGIN,
  poolAddress = POOL,
  campaignNumber = CAMPAIGN,
  recoverSigner,
  cryptoImpl,
} = {}) {
  let nowMs = INITIAL_NOW_MS;
  const control = createSignedFreshReadControl({
    storage,
    publicOrigin,
    poolAddress,
    campaignNumber,
    now: () => nowMs,
    ...(recoverSigner ? { recoverSigner } : {}),
    ...(cryptoImpl ? { cryptoImpl } : {}),
  });
  return {
    control,
    storage,
    nowMs: () => nowMs,
    advance(milliseconds) { nowMs += milliseconds; },
  };
}

function pairFor(index) {
  return {
    failedTransactionHash: hashFor(index * 2 + 1),
    successfulTransactionHash: hashFor(index * 2 + 2),
  };
}

function hashFor(value) {
  return "0x" + value.toString(16).padStart(64, "0");
}

function memoryTransactionalStorage(entries = []) {
  const values = new Map(entries);
  let transactionTail = Promise.resolve();
  return {
    async get(key) { return values.get(key); },
    set(key, value) { values.set(key, structuredClone(value)); },
    transaction(callback) {
      const result = transactionTail.then(async () => {
        const staged = new Map(values);
        const value = await callback({
          async get(key) { return staged.get(key); },
          async put(key, nextValue) { staged.set(key, structuredClone(nextValue)); },
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

function cryptoWith(overrides = {}) {
  const subtle = globalThis.crypto.subtle;
  return {
    getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    subtle: {
      importKey: subtle.importKey.bind(subtle),
      sign: subtle.sign.bind(subtle),
      verify: subtle.verify.bind(subtle),
      digest: subtle.digest.bind(subtle),
      ...overrides,
    },
  };
}

function decodeCredential(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function runtimeInput(operation, body) {
  return { operation, body, requestId: crypto.randomUUID() };
}
