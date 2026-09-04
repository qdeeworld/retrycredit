const OBSERVATION_STATE_KEY = "recovery-v2:observation-cache:v1";
const OBSERVATION_STATE_VERSION = 1;

export const RECOVERY_V2_OBSERVATION_CACHE_TTL_MS = 30_000;

export function createRecoveryV2ObservationCache({
  storage,
  observe,
  identity,
  revision,
  now = Date.now,
  ttlMs = RECOVERY_V2_OBSERVATION_CACHE_TTL_MS,
  onRefresh = () => {},
} = {}) {
  if (!storage || typeof storage.transaction !== "function") {
    throw new TypeError("Durable Object transactional storage is required");
  }
  if (typeof observe !== "function") throw new TypeError("observe is required");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof onRefresh !== "function") throw new TypeError("onRefresh must be a function");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 5_000 || ttlMs > 300_000 || ttlMs % 1_000 !== 0) {
    throw new TypeError("ttlMs must be a whole number of seconds from 5 to 300");
  }
  const currentRevision = normalizeRevision(revision);
  const cacheIdentity = requireIdentity(identity, ttlMs, currentRevision);
  let memoryState = null;
  let refreshFlight = null;

  async function read() {
    let readAtMs;
    try {
      readAtMs = requireClock(now());
      if (refreshFlight) return refreshFlight;
      const memoryDecision = decisionFromState(memoryState, readAtMs);
      if (memoryDecision.kind === "snapshot") {
        return materialize(memoryDecision.snapshot, currentRevision);
      }
      if (memoryDecision.kind === "leased") return unavailable(currentRevision);
    } catch {
      memoryState = null;
      return unavailable(currentRevision);
    }
    refreshFlight = refresh().finally(() => {
      refreshFlight = null;
    });
    return refreshFlight;
  }

  async function refresh() {
    let lease;
    try {
      lease = await storage.transaction(async (transaction) => {
        requireTransaction(transaction);
        const acquiredAtMs = requireClock(now());
        const current = normalizeState(
          await transaction.get(OBSERVATION_STATE_KEY),
          cacheIdentity,
          acquiredAtMs,
          ttlMs,
        );
        const currentDecision = decisionFromState(current, acquiredAtMs);
        if (currentDecision.kind !== "refresh") {
          return { ...currentDecision, state: current };
        }
        const nextProbeAtMs = acquiredAtMs + ttlMs;
        if (!Number.isSafeInteger(nextProbeAtMs)) throw new Error("observation lease overflow");
        const state = {
          version: OBSERVATION_STATE_VERSION,
          identity: cacheIdentity,
          nextProbeAtMs,
          snapshot: null,
        };
        await transaction.put(OBSERVATION_STATE_KEY, state);
        return { kind: "refresh", state, leaseUntilMs: nextProbeAtMs };
      });
    } catch {
      memoryState = null;
      return unavailable(currentRevision);
    }

    memoryState = lease.state;
    if (lease.kind === "snapshot") return materialize(lease.snapshot, currentRevision);
    if (lease.kind === "leased") return unavailable(currentRevision);

    try {
      onRefresh();
    } catch {
      // Observability must never weaken the provider budget.
    }

    let observation;
    try {
      observation = normalizeObservation(await observe());
    } catch {
      return unavailable(currentRevision);
    }

    try {
      const committed = await storage.transaction(async (transaction) => {
        requireTransaction(transaction);
        const committedAtMs = requireClock(now());
        const current = normalizeState(
          await transaction.get(OBSERVATION_STATE_KEY),
          cacheIdentity,
          committedAtMs,
          ttlMs,
        );
        if (current.nextProbeAtMs !== lease.leaseUntilMs || current.snapshot !== null) {
          throw new Error("observation lease changed");
        }
        const expiresAtMs = committedAtMs + ttlMs;
        if (!Number.isSafeInteger(expiresAtMs)) throw new Error("observation expiry overflow");
        const state = {
          version: OBSERVATION_STATE_VERSION,
          identity: cacheIdentity,
          nextProbeAtMs: expiresAtMs,
          snapshot: {
            checkedAtMs: committedAtMs,
            expiresAtMs,
            status: observation.status,
            value: observation.value,
          },
        };
        await transaction.put(OBSERVATION_STATE_KEY, state);
        return state;
      });
      memoryState = committed;
      return materialize(committed.snapshot, currentRevision);
    } catch {
      memoryState = lease.state;
      return unavailable(currentRevision);
    }
  }

  function decisionFromState(state, atMs) {
    if (!state) return { kind: "refresh" };
    if (state.snapshot && atMs < state.snapshot.expiresAtMs) {
      return { kind: "snapshot", snapshot: state.snapshot };
    }
    if (atMs < state.nextProbeAtMs) return { kind: "leased" };
    return { kind: "refresh" };
  }

  return Object.freeze({ read });
}

export function recoveryV2ObservationCacheIdentity({
  primaryRpc,
  auditRpc,
  observation,
  deploymentRevision,
  workerVersionId,
} = {}) {
  const primary = requireHttpsUrl(primaryRpc, "primary RPC");
  const audit = requireHttpsUrl(auditRpc, "audit RPC");
  if (primary === audit) throw new TypeError("observation RPCs must be independent");
  const deployment = {
    revision: normalizeRevision(deploymentRevision),
    workerVersionId: normalizeWorkerVersionId(workerVersionId),
  };
  if (deployment.revision === null && deployment.workerVersionId === null) {
    throw new TypeError("observation deployment identity is required");
  }
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    throw new TypeError("observation identity is required");
  }
  let value;
  try {
    value = JSON.stringify({
      schema: "retrycredit.recovery-v2-observation.v1",
      primaryRpc: primary,
      auditRpc: audit,
      deployment,
      observation,
    }, (_key, entry) => typeof entry === "bigint" ? entry.toString() : entry);
  } catch (error) {
    throw new TypeError("observation identity is invalid", { cause: error });
  }
  if (value.length < 1 || value.length > 8_192) {
    throw new TypeError("observation identity is invalid");
  }
  return value;
}

function normalizeState(value, identity, nowMs, ttlMs) {
  if (value === undefined) {
    return {
      version: OBSERVATION_STATE_VERSION,
      identity,
      nextProbeAtMs: 0,
      snapshot: null,
    };
  }
  requireExactObject(value, ["version", "identity", "nextProbeAtMs", "snapshot"]);
  if (
    value.version !== OBSERVATION_STATE_VERSION
    || typeof value.identity !== "string"
    || value.identity.length < 1
    || value.identity.length > 8_320
    || !Number.isSafeInteger(value.nextProbeAtMs)
    || value.nextProbeAtMs < 0
  ) {
    throw new Error("invalid observation state");
  }
  if (value.identity !== identity) {
    return {
      version: OBSERVATION_STATE_VERSION,
      identity,
      nextProbeAtMs: 0,
      snapshot: null,
    };
  }
  if (value.nextProbeAtMs > nowMs + ttlMs) throw new Error("invalid observation lease");
  if (value.snapshot === null) return value;
  requireExactObject(value.snapshot, ["checkedAtMs", "expiresAtMs", "status", "value"]);
  if (
    !Number.isSafeInteger(value.snapshot.checkedAtMs)
    || value.snapshot.checkedAtMs < 0
    || value.snapshot.checkedAtMs > nowMs
    || !Number.isSafeInteger(value.snapshot.expiresAtMs)
    || value.snapshot.expiresAtMs !== value.nextProbeAtMs
    || value.snapshot.expiresAtMs < value.snapshot.checkedAtMs
  ) {
    throw new Error("invalid observation snapshot");
  }
  normalizeStoredObservation(value.snapshot.status, value.snapshot.value);
  return value;
}

function normalizeObservation(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("invalid observation result");
  }
  requireExactObject(result, ["status", "body"]);
  requireExactObject(result.body, ["ok", "service", "network", "recoveryV2", "revision"]);
  if (result.body.service !== "retrycredit" || result.body.network !== 102_031) {
    throw new Error("invalid observation result");
  }
  return {
    status: result.status,
    value: normalizeStoredObservation(result.status, {
      ok: result.body.ok,
      recoveryV2: result.body.recoveryV2,
    }),
  };
}

function normalizeStoredObservation(status, value) {
  requireExactObject(value, ["ok", "recoveryV2"]);
  const success = status === 200;
  if ((!success && status !== 503) || value.ok !== success) {
    throw new Error("invalid observation status");
  }
  const expectedFields = success
    ? ["mode", "state", "publicProfile", "reason", "observers"]
    : ["mode", "state", "publicProfile", "reason"];
  requireExactObject(value.recoveryV2, expectedFields);
  if (
    value.recoveryV2.mode !== "observation-only"
    || value.recoveryV2.publicProfile !== "v1"
    || (success && (
      value.recoveryV2.state !== "observed"
      || value.recoveryV2.reason !== "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO"
      || value.recoveryV2.observers !== 2
    ))
    || (!success && (
      value.recoveryV2.state !== "blocked"
      || value.recoveryV2.reason !== "RECOVERY_V2_OBSERVATION_FAILED"
    ))
  ) {
    throw new Error("invalid observation value");
  }
  return Object.freeze({
    ok: value.ok,
    recoveryV2: Object.freeze({ ...value.recoveryV2 }),
  });
}

function materialize(snapshot, revision) {
  return {
    status: snapshot.status,
    body: {
      ok: snapshot.value.ok,
      service: "retrycredit",
      network: 102_031,
      recoveryV2: { ...snapshot.value.recoveryV2 },
      revision,
    },
  };
}

function unavailable(revision) {
  return {
    status: 503,
    body: {
      ok: false,
      service: "retrycredit",
      network: 102_031,
      recoveryV2: {
        mode: "observation-only",
        state: "blocked",
        publicProfile: "v1",
        reason: "RECOVERY_V2_OBSERVATION_FAILED",
      },
      revision,
    },
  };
}

function requireIdentity(value, ttlMs, revision) {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) {
    throw new TypeError("identity is required");
  }
  return JSON.stringify([OBSERVATION_STATE_VERSION, ttlMs, revision, value]);
}

function normalizeRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function normalizeWorkerVersionId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}

function requireClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid clock");
  return value;
}

function requireTransaction(transaction) {
  if (!transaction || typeof transaction.get !== "function" || typeof transaction.put !== "function") {
    throw new TypeError("Durable Object transaction is unavailable");
  }
}

function requireExactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid observation object");
  }
  const expected = new Set(fields);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !expected.has(key))) {
    throw new Error("invalid observation object");
  }
}

function requireHttpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch (error) {
    throw new TypeError(label + " is invalid", { cause: error });
  }
}
