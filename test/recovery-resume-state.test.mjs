import assert from "node:assert/strict";
import test from "node:test";
import {
  RECOVERY_RESUME_SCHEMA,
  RECOVERY_RESUME_STATUSES,
  RECOVERY_RESUME_STORAGE_KEY,
  RECOVERY_RESUME_TTL_MS,
  RECOVERY_RESUME_VERSION,
  clearRecoveryResumeState,
  loadRecoveryResumeCandidate,
  loadRecoveryResumeState,
  saveRecoveryResumeState,
} from "../web/src/recovery-resume-state.mjs";

const NOW = 1_800_000_000_000;
const POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_POOL = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const FAILED_HASH = `0x${"ab".repeat(32)}`;
const SUCCESSFUL_HASH = `0x${"cd".repeat(32)}`;
const OTHER_HASH = `0x${"ef".repeat(32)}`;
const FAILURE_QUERY_ID = `0x${"12".repeat(32)}`;
const SUCCESS_QUERY_ID = `0x${"34".repeat(32)}`;
const PAIR_ID = `0x${"56".repeat(32)}`;
const RELEASE_HASH = `0x${"78".repeat(32)}`;

function identity(overrides = {}) {
  return {
    poolAddress: POOL,
    campaignNumber: 7,
    wallet: WALLET,
    failedTransactionHash: FAILED_HASH,
    successfulTransactionHash: SUCCESSFUL_HASH,
    ...overrides,
  };
}

function submittedState(overrides = {}) {
  return {
    ...identity(),
    status: "proof-queued",
    failureQueryId: null,
    successQueryId: null,
    pairId: null,
    releaseTransactionHash: null,
    ...overrides,
  };
}

function createSessionStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    getItem(key) {
      calls.push(["getItem", key]);
      return entries.has(key) ? entries.get(key) : null;
    },
    setItem(key, value) {
      calls.push(["setItem", key, value]);
      entries.set(String(key), String(value));
    },
    removeItem(key) {
      calls.push(["removeItem", key]);
      entries.delete(key);
    },
    value(key = RECOVERY_RESUME_STORAGE_KEY) {
      return entries.get(key) ?? null;
    },
  };
}

function saveValid(sessionStorage, overrides = {}, now = NOW) {
  return saveRecoveryResumeState(submittedState(overrides), { sessionStorage, now });
}

test("stores and restores only a normalized, versioned, short-lived public record", () => {
  const sessionStorage = createSessionStorage();
  const saved = saveRecoveryResumeState(submittedState({
    poolAddress: POOL.toUpperCase().replace("0X", "0x"),
    campaignNumber: "007",
    wallet: WALLET.toUpperCase().replace("0X", "0x"),
    failedTransactionHash: FAILED_HASH.toUpperCase().replace("0X", "0x"),
    failureQueryId: FAILURE_QUERY_ID.toUpperCase().replace("0X", "0x"),
    successQueryId: SUCCESS_QUERY_ID,
    pairId: PAIR_ID,
    releaseTransactionHash: RELEASE_HASH,
  }), { sessionStorage, now: NOW });

  assert.deepEqual(saved, {
    schema: RECOVERY_RESUME_SCHEMA,
    version: RECOVERY_RESUME_VERSION,
    status: "proof-queued",
    poolAddress: POOL,
    campaignNumber: 7,
    wallet: WALLET,
    failedTransactionHash: FAILED_HASH,
    successfulTransactionHash: SUCCESSFUL_HASH,
    failureQueryId: FAILURE_QUERY_ID,
    successQueryId: SUCCESS_QUERY_ID,
    pairId: PAIR_ID,
    releaseTransactionHash: RELEASE_HASH,
    createdAt: NOW,
    updatedAt: NOW,
    ttlMs: RECOVERY_RESUME_TTL_MS,
    expiresAt: NOW + RECOVERY_RESUME_TTL_MS,
  });
  assert.deepEqual(
    Object.keys(JSON.parse(sessionStorage.value())).sort(),
    Object.keys(saved).sort(),
  );
  assert.deepEqual(
    loadRecoveryResumeState(identity(), { sessionStorage, now: NOW + 1 }),
    saved,
  );
  assert.equal(Object.isFrozen(saved), true);
});

test("a campaign-bound candidate can only seed a fresh read-only pair reconciliation", () => {
  const sessionStorage = createSessionStorage();
  const saved = saveValid(sessionStorage);
  assert.deepEqual(loadRecoveryResumeCandidate({
    poolAddress: POOL.toUpperCase().replace("0X", "0x"),
    campaignNumber: "7",
  }, { sessionStorage, now: NOW + 1 }), saved);

  const wrongCampaign = createSessionStorage({
    [RECOVERY_RESUME_STORAGE_KEY]: sessionStorage.value(),
  });
  assert.equal(loadRecoveryResumeCandidate({
    poolAddress: POOL,
    campaignNumber: 8,
  }, { sessionStorage: wrongCampaign, now: NOW + 1 }), null);
  assert.equal(wrongCampaign.value(), null);

  const invalidBoundary = createSessionStorage({
    [RECOVERY_RESUME_STORAGE_KEY]: sessionStorage.value(),
  });
  assert.equal(loadRecoveryResumeCandidate({
    poolAddress: "0x1234",
    campaignNumber: 7,
  }, { sessionStorage: invalidBoundary, now: NOW + 1 }), null);
  assert.equal(invalidBoundary.value(), null);
});

test("allows only submitted, reconciliation, and completed statuses", () => {
  assert.deepEqual([...RECOVERY_RESUME_STATUSES], [
    "proof-queued",
    "proof-building",
    "release-relaying",
    "release-processing",
    "release-uncertain",
    "released",
    "already-claimed",
  ]);

  for (const status of RECOVERY_RESUME_STATUSES) {
    const sessionStorage = createSessionStorage();
    assert.equal(saveValid(sessionStorage, { status })?.status, status);
  }

  for (const status of [
    "checking",
    "wallet-connecting",
    "authorization-requested",
    "qualifying",
    "",
    "unexpected",
  ]) {
    const sessionStorage = createSessionStorage();
    saveValid(sessionStorage);
    assert.equal(saveValid(sessionStorage, { status }, NOW + 1), null);
    assert.equal(sessionStorage.value(), null);
  }
});

test("never serializes signatures, raw transactions, authorization material, or proofs", () => {
  const sessionStorage = createSessionStorage();
  const secretValues = ["secret-signature", "secret-raw-tx", "secret-private-key", "secret-auth", "secret-proof"];
  const saved = saveRecoveryResumeState({
    ...submittedState(),
    signature: secretValues[0],
    rawTransaction: secretValues[1],
    privateKey: secretValues[2],
    authorization: { challenge: secretValues[3] },
    proof: { plaintext: secretValues[4] },
  }, { sessionStorage, now: NOW });

  assert.ok(saved);
  const serialized = sessionStorage.value();
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
  for (const forbiddenKey of ["signature", "rawTransaction", "privateKey", "authorization", "proof"]) {
    assert.equal(Object.hasOwn(JSON.parse(serialized), forbiddenKey), false);
  }
});

test("updates preserve the original fifteen-minute submission window", () => {
  const sessionStorage = createSessionStorage();
  saveValid(sessionStorage);
  const updated = saveValid(sessionStorage, {
    status: "released",
    failureQueryId: FAILURE_QUERY_ID,
    successQueryId: SUCCESS_QUERY_ID,
    pairId: PAIR_ID,
    releaseTransactionHash: RELEASE_HASH,
  }, NOW + 5_000);

  assert.equal(updated.createdAt, NOW);
  assert.equal(updated.updatedAt, NOW + 5_000);
  assert.equal(updated.expiresAt, NOW + RECOVERY_RESUME_TTL_MS);
});

test("an explicit submission time cannot renew or mutate the original window", () => {
  const sessionStorage = createSessionStorage();
  assert.ok(saveValid(sessionStorage, { createdAt: NOW }, NOW + 1_000));
  assert.equal(saveValid(sessionStorage, {
    createdAt: NOW,
    status: "release-uncertain",
  }, NOW + RECOVERY_RESUME_TTL_MS), null);
  assert.equal(sessionStorage.value(), null);

  const mismatched = createSessionStorage();
  saveValid(mismatched, { createdAt: NOW }, NOW + 1_000);
  assert.equal(saveValid(mismatched, { createdAt: NOW + 1 }, NOW + 2_000), null);
  assert.equal(mismatched.value(), null);

  const future = createSessionStorage();
  assert.equal(saveValid(future, { createdAt: NOW + 2_000 }, NOW + 1_000), null);
  assert.equal(future.value(), null);
});

test("a different identity starts a new record instead of inheriting timestamps", () => {
  const sessionStorage = createSessionStorage();
  saveValid(sessionStorage);
  const replacement = saveValid(sessionStorage, { wallet: OTHER_WALLET }, NOW + 2_000);

  assert.equal(replacement.wallet, OTHER_WALLET);
  assert.equal(replacement.createdAt, NOW + 2_000);
});

test("stale records clear at the exact expiry boundary", () => {
  const sessionStorage = createSessionStorage();
  saveValid(sessionStorage);

  assert.ok(loadRecoveryResumeState(identity(), {
    sessionStorage,
    now: NOW + RECOVERY_RESUME_TTL_MS - 1,
  }));
  assert.equal(loadRecoveryResumeState(identity(), {
    sessionStorage,
    now: NOW + RECOVERY_RESUME_TTL_MS,
  }), null);
  assert.equal(sessionStorage.value(), null);
});

test("corrupted, noncanonical, and schema-invalid records clear fail-closed", () => {
  const mutations = [
    ["corrupt JSON", () => "{"],
    ["wrong schema", (record) => JSON.stringify({ ...record, schema: "other" })],
    ["wrong version", (record) => JSON.stringify({ ...record, version: 2 })],
    ["extra property", (record) => JSON.stringify({ ...record, signature: "must-not-survive" })],
    ["missing property", (record) => {
      const next = { ...record };
      delete next.pairId;
      return JSON.stringify(next);
    }],
    ["noncanonical address", (record) => JSON.stringify({
      ...record,
      poolAddress: record.poolAddress.toUpperCase().replace("0X", "0x"),
    })],
    ["noncanonical hash", (record) => JSON.stringify({
      ...record,
      failedTransactionHash: record.failedTransactionHash.toUpperCase().replace("0X", "0x"),
    })],
    ["invalid campaign", (record) => JSON.stringify({ ...record, campaignNumber: "7" })],
    ["unknown status", (record) => JSON.stringify({ ...record, status: "authorization-requested" })],
    ["wrong TTL", (record) => JSON.stringify({ ...record, ttlMs: RECOVERY_RESUME_TTL_MS + 1 })],
    ["inconsistent expiry", (record) => JSON.stringify({ ...record, expiresAt: record.expiresAt + 1 })],
    ["future update", (record) => JSON.stringify({
      ...record,
      updatedAt: NOW + 1,
      expiresAt: NOW + RECOVERY_RESUME_TTL_MS,
    })],
    ["same transaction twice", (record) => JSON.stringify({ ...record, successfulTransactionHash: record.failedTransactionHash })],
    ["invalid optional identifier", (record) => JSON.stringify({ ...record, pairId: "0x1234" })],
  ];

  for (const [label, mutate] of mutations) {
    const validStorage = createSessionStorage();
    saveValid(validStorage);
    const sessionStorage = createSessionStorage({
      [RECOVERY_RESUME_STORAGE_KEY]: mutate(JSON.parse(validStorage.value())),
    });
    assert.equal(
      loadRecoveryResumeState(identity(), { sessionStorage, now: NOW }),
      null,
      label,
    );
    assert.equal(sessionStorage.value(), null, label);
  }
});

test("a pool, campaign, wallet, failed hash, or successful hash mismatch clears", () => {
  const mismatches = [
    { poolAddress: OTHER_POOL },
    { campaignNumber: 8 },
    { wallet: OTHER_WALLET },
    { failedTransactionHash: OTHER_HASH },
    { successfulTransactionHash: OTHER_HASH },
  ];

  for (const mismatch of mismatches) {
    const sessionStorage = createSessionStorage();
    saveValid(sessionStorage);
    assert.equal(loadRecoveryResumeState(identity(mismatch), { sessionStorage, now: NOW }), null);
    assert.equal(sessionStorage.value(), null);
  }
});

test("invalid save identities and optional identifiers clear rather than persist", () => {
  const invalidStates = [
    { poolAddress: "0x1234" },
    { campaignNumber: 0 },
    { wallet: "0x0000000000000000000000000000000000000000" },
    { failedTransactionHash: "0x1234" },
    { successfulTransactionHash: FAILED_HASH },
    { failureQueryId: "0x1234" },
    { successQueryId: `0x${"0".repeat(64)}` },
    { pairId: "not-a-hash" },
    { releaseTransactionHash: "not-a-hash" },
  ];

  for (const invalid of invalidStates) {
    const sessionStorage = createSessionStorage();
    saveValid(sessionStorage);
    assert.equal(saveValid(sessionStorage, invalid, NOW + 1), null);
    assert.equal(sessionStorage.value(), null);
  }
});

test("storage access failures never escape or fall back to another persistence mechanism", () => {
  const throwingSessionStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };

  assert.equal(saveValid(throwingSessionStorage), null);
  assert.equal(loadRecoveryResumeState(identity(), {
    sessionStorage: throwingSessionStorage,
    now: NOW,
  }), null);
  assert.equal(clearRecoveryResumeState({ sessionStorage: throwingSessionStorage }), false);
});

test("clear is scoped to the recovery resume session key", () => {
  const sessionStorage = createSessionStorage({ unrelated: "keep" });
  saveValid(sessionStorage);
  assert.equal(clearRecoveryResumeState({ sessionStorage }), true);
  assert.equal(sessionStorage.value(), null);
  assert.equal(sessionStorage.value("unrelated"), "keep");
  assert.deepEqual(sessionStorage.calls.at(-1), ["removeItem", RECOVERY_RESUME_STORAGE_KEY]);
});
