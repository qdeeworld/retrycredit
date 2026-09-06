import assert from "node:assert/strict";
import test from "node:test";

import {
  RECOVERY_V2_OBSERVATION_CACHE_TTL_MS,
  createRecoveryV2ObservationCache,
  recoveryV2ObservationCacheIdentity,
} from "../src/cloudflare-v2-observation-cache.mjs";

const CACHE_STATE_KEY = "recovery-v2:observation-cache:v1";
const NOW_MS = 1_800_000_000_000;
const REVISION_A = "a".repeat(40);
const REVISION_B = "b".repeat(40);
const OBSERVER_REVISION = "f".repeat(40);
const WORKER_VERSION_A = "12345678-1234-1234-1234-1234567890ab";
const WORKER_VERSION_B = "abcdefab-cdef-abcd-efab-cdefabcdefab";
const IDENTITY_A = "recovery-v2-observation:pool-a";
const IDENTITY_B = "recovery-v2-observation:pool-b";

test("100 concurrent and sequential reads share one loader and one stored snapshot", async () => {
  const storage = memoryTransactionalStorage();
  const loaderStarted = deferred();
  const releaseLoader = deferred();
  let loaderCalls = 0;
  let refreshCalls = 0;
  const cache = createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    onRefresh: () => { refreshCalls += 1; },
    observe: async () => {
      loaderCalls += 1;
      loaderStarted.resolve();
      await releaseLoader.promise;
      return observation(200, OBSERVER_REVISION);
    },
  });

  const concurrent = Array.from({ length: 100 }, () => cache.read());
  await loaderStarted.promise;
  assert.equal(loaderCalls, 1);
  releaseLoader.resolve();

  const expected = materializedObservation(200, REVISION_A);
  for (const result of await Promise.all(concurrent)) assert.deepEqual(result, expected);
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(await cache.read(), expected);
  }

  assert.equal(loaderCalls, 1);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(storage.counts(), { transactions: 2, gets: 2, puts: 2 });
});

test("callers arriving after lease acquisition join the live provider flight", async () => {
  const loaderStarted = deferred();
  const releaseLoader = deferred();
  let loaderCalls = 0;
  let lateSettlements = 0;
  const cache = createRecoveryV2ObservationCache({
    storage: memoryTransactionalStorage(),
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      loaderStarted.resolve();
      await releaseLoader.promise;
      return observation(200, OBSERVER_REVISION);
    },
  });

  const first = cache.read();
  await loaderStarted.promise;
  const late = Array.from({ length: 99 }, () => cache.read().then((result) => {
    lateSettlements += 1;
    return result;
  }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lateSettlements, 0);
  assert.equal(loaderCalls, 1);

  releaseLoader.resolve();
  const expected = materializedObservation(200, REVISION_A);
  for (const result of await Promise.all([first, ...late])) assert.deepEqual(result, expected);
  assert.equal(lateSettlements, 99);
  assert.equal(loaderCalls, 1);
});

test("a valid observed 503 is cached instead of spending the provider budget again", async () => {
  let loaderCalls = 0;
  let nextStatus = 503;
  const cache = createRecoveryV2ObservationCache({
    storage: memoryTransactionalStorage(),
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      return observation(nextStatus, OBSERVER_REVISION);
    },
  });

  const expectedFailure = materializedObservation(503, REVISION_A);
  assert.deepEqual(await cache.read(), expectedFailure);
  nextStatus = 200;
  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(await cache.read(), expectedFailure);
  }
  assert.equal(loaderCalls, 1);
});

test("expiry refresh replaces stale success with a failure lease until the exact retry boundary", async () => {
  const storage = memoryTransactionalStorage();
  let nowMs = NOW_MS;
  let loaderCalls = 0;
  let loaderMode = "success";
  const createCache = () => createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => nowMs,
    observe: async () => {
      loaderCalls += 1;
      if (loaderMode === "failure") throw new Error("private provider failure");
      return observation(200, OBSERVER_REVISION);
    },
  });
  const cache = createCache();

  assert.equal((await cache.read()).status, 200);
  loaderMode = "failure";
  nowMs += RECOVERY_V2_OBSERVATION_CACHE_TTL_MS;
  assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
  assert.equal(loaderCalls, 2);

  nowMs += RECOVERY_V2_OBSERVATION_CACHE_TTL_MS - 1;
  assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
  assert.equal(loaderCalls, 2);

  const recreatedDuringLease = createCache();
  assert.deepEqual(await recreatedDuringLease.read(), materializedObservation(503, REVISION_A));
  assert.equal(loaderCalls, 2);

  loaderMode = "success";
  nowMs += 1;
  assert.equal((await recreatedDuringLease.read()).status, 200);
  assert.equal(loaderCalls, 3);
});

test("recreation reuses shared storage and reapplies the configured deployment revision", async () => {
  const storage = memoryTransactionalStorage();
  let loaderCalls = 0;
  const first = createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      return observation(200, OBSERVER_REVISION);
    },
  });

  assert.deepEqual(await first.read(), materializedObservation(200, REVISION_A));
  const recreated = createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      throw new Error("a persisted snapshot must avoid this loader");
    },
  });
  assert.deepEqual(await recreated.read(), materializedObservation(200, REVISION_A));

  const rotatedRevision = createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_B,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      return observation(200, OBSERVER_REVISION);
    },
  });
  assert.deepEqual(await rotatedRevision.read(), materializedObservation(200, REVISION_B));

  const invalidRevision = createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_B.toUpperCase(),
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      return observation(200, OBSERVER_REVISION);
    },
  });
  assert.deepEqual(await invalidRevision.read(), materializedObservation(200, null));
  assert.equal(loaderCalls, 3);
});

test("an identity or TTL mismatch cannot reuse another observer snapshot", async () => {
  const storage = memoryTransactionalStorage();
  let loaderCalls = 0;
  const cacheFor = (identity, ttlMs = RECOVERY_V2_OBSERVATION_CACHE_TTL_MS) => (
    createRecoveryV2ObservationCache({
      storage,
      identity,
      ttlMs,
      revision: REVISION_A,
      now: () => NOW_MS,
      observe: async () => {
        loaderCalls += 1;
        return observation(200, OBSERVER_REVISION);
      },
    })
  );

  assert.equal((await cacheFor(IDENTITY_A).read()).status, 200);
  assert.equal((await cacheFor(IDENTITY_B).read()).status, 200);
  assert.equal((await cacheFor(IDENTITY_B, 5_000).read()).status, 200);
  assert.equal(loaderCalls, 3);
});

test("a Cloudflare Worker version change invalidates a snapshot when Git revision is unavailable", async () => {
  const storage = memoryTransactionalStorage();
  let loaderCalls = 0;
  const createCache = (workerVersionId) => createRecoveryV2ObservationCache({
    storage,
    identity: recoveryV2ObservationCacheIdentity({
      primaryRpc: "https://primary.example",
      auditRpc: "https://audit.example",
      deploymentRevision: null,
      workerVersionId,
      observation: { deployment: "frozen-v2" },
    }),
    revision: null,
    now: () => NOW_MS,
    observe: async () => {
      loaderCalls += 1;
      return observation(200, null);
    },
  });

  assert.equal((await createCache(WORKER_VERSION_A).read()).status, 200);
  assert.equal((await createCache(WORKER_VERSION_B).read()).status, 200);
  assert.equal(loaderCalls, 2);
});

test("corrupt state and acquisition read or write failures stop before provider work", async (t) => {
  await t.test("corrupt state", async () => {
    let loaderCalls = 0;
    const storedIdentity = JSON.stringify([
      1,
      RECOVERY_V2_OBSERVATION_CACHE_TTL_MS,
      REVISION_A,
      IDENTITY_A,
    ]);
    const storage = memoryTransactionalStorage([[
      CACHE_STATE_KEY,
      {
        version: 1,
        identity: storedIdentity,
        nextProbeAtMs: NOW_MS + RECOVERY_V2_OBSERVATION_CACHE_TTL_MS + 1,
        snapshot: null,
      },
    ]]);
    const cache = createRecoveryV2ObservationCache({
      storage,
      identity: IDENTITY_A,
      revision: REVISION_A,
      now: () => NOW_MS,
      observe: async () => { loaderCalls += 1; return observation(200); },
    });

    assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
    assert.equal(loaderCalls, 0);
  });

  await t.test("state read failure", async () => {
    let loaderCalls = 0;
    const cache = createRecoveryV2ObservationCache({
      storage: memoryTransactionalStorage([], { failGets: [1] }),
      identity: IDENTITY_A,
      revision: REVISION_A,
      now: () => NOW_MS,
      observe: async () => { loaderCalls += 1; return observation(200); },
    });

    assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
    assert.equal(loaderCalls, 0);
  });

  await t.test("lease write failure", async () => {
    let loaderCalls = 0;
    const cache = createRecoveryV2ObservationCache({
      storage: memoryTransactionalStorage([], { failPuts: [1] }),
      identity: IDENTITY_A,
      revision: REVISION_A,
      now: () => NOW_MS,
      observe: async () => { loaderCalls += 1; return observation(200); },
    });

    assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
    assert.equal(loaderCalls, 0);
  });
});

test("a failed snapshot write retains the lease across reads and recreation", async () => {
  const storage = memoryTransactionalStorage([], { failPuts: [2] });
  let loaderCalls = 0;
  const createCache = () => createRecoveryV2ObservationCache({
    storage,
    identity: IDENTITY_A,
    revision: REVISION_A,
    now: () => NOW_MS,
    onRefresh() {
      throw new Error("observability must not weaken admission");
    },
    observe: async () => {
      loaderCalls += 1;
      return observation(200, OBSERVER_REVISION);
    },
  });

  const cache = createCache();
  assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
  assert.deepEqual(await cache.read(), materializedObservation(503, REVISION_A));
  assert.equal(loaderCalls, 1);

  const recreated = createCache();
  assert.deepEqual(await recreated.read(), materializedObservation(503, REVISION_A));
  assert.equal(loaderCalls, 1);
});

test("observation cache identity normalizes HTTPS endpoints and bigint fields", () => {
  const identity = recoveryV2ObservationCacheIdentity({
    primaryRpc: "https://PRIMARY.example:443/rpc?network=cc3",
    auditRpc: "https://AUDIT.example:443",
    deploymentRevision: REVISION_A,
    workerVersionId: WORKER_VERSION_A.toUpperCase(),
    observation: {
      campaignNumber: 2n,
      deployment: { blockNumber: 5_374_212n },
    },
  });
  assert.deepEqual(JSON.parse(identity), {
    schema: "retrycredit.recovery-v2-observation.v1",
    primaryRpc: "https://primary.example/rpc?network=cc3",
    auditRpc: "https://audit.example/",
    deployment: {
      revision: REVISION_A,
      workerVersionId: WORKER_VERSION_A,
    },
    observation: {
      campaignNumber: "2",
      deployment: { blockNumber: "5374212" },
    },
  });

  assert.throws(
    () => recoveryV2ObservationCacheIdentity({
      primaryRpc: "https://RPC.example:443",
      auditRpc: "https://rpc.example/",
      workerVersionId: WORKER_VERSION_A,
      observation: {},
    }),
    /must be independent/,
  );
  for (const primaryRpc of [
    "http://primary.example",
    "https://user:password@primary.example",
    "https://primary.example/#fragment",
  ]) {
    assert.throws(
      () => recoveryV2ObservationCacheIdentity({
        primaryRpc,
        auditRpc: "https://audit.example",
        workerVersionId: WORKER_VERSION_A,
        observation: {},
      }),
      /primary RPC is invalid/,
    );
  }

  const circular = {};
  circular.self = circular;
  assert.throws(
    () => recoveryV2ObservationCacheIdentity({
      primaryRpc: "https://primary.example",
      auditRpc: "https://audit.example",
      workerVersionId: WORKER_VERSION_A,
      observation: circular,
    }),
    /observation identity is invalid/,
  );

  assert.throws(
    () => recoveryV2ObservationCacheIdentity({
      primaryRpc: "https://primary.example",
      auditRpc: "https://audit.example",
      observation: {},
    }),
    /deployment identity is required/,
  );
});

function observation(status, revision = OBSERVER_REVISION) {
  const success = status === 200;
  return {
    status: success ? 200 : 503,
    body: {
      ok: success,
      service: "retrycredit",
      network: 102_031,
      recoveryV2: success
        ? {
            mode: "observation-only",
            state: "observed",
            publicProfile: "v1",
            reason: "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO",
            observers: 2,
          }
        : {
            mode: "observation-only",
            state: "blocked",
            publicProfile: "v1",
            reason: "RECOVERY_V2_OBSERVATION_FAILED",
          },
      revision,
    },
  };
}

function materializedObservation(status, revision) {
  return observation(status, revision);
}

function memoryTransactionalStorage(entries = [], { failGets = [], failPuts = [] } = {}) {
  const values = new Map(entries.map(([key, value]) => [key, clone(value)]));
  const failedGets = new Set(failGets);
  const failedPuts = new Set(failPuts);
  const counters = { transactions: 0, gets: 0, puts: 0 };
  let transactionTail = Promise.resolve();

  return {
    transaction(callback) {
      const result = transactionTail.then(async () => {
        counters.transactions += 1;
        const staged = new Map(
          Array.from(values, ([key, value]) => [key, clone(value)]),
        );
        const returned = await callback({
          async get(key) {
            counters.gets += 1;
            if (failedGets.has(counters.gets)) throw new Error("injected storage read failure");
            return clone(staged.get(key));
          },
          async put(key, value) {
            counters.puts += 1;
            if (failedPuts.has(counters.puts)) throw new Error("injected storage write failure");
            staged.set(key, clone(value));
          },
        });
        values.clear();
        for (const [key, value] of staged) values.set(key, value);
        return returned;
      });
      transactionTail = result.catch(() => undefined);
      return result;
    },
    counts() { return { ...counters }; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
