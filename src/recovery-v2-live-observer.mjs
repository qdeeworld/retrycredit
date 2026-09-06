import { observeRecoveryV2, RECOVERY_V2_OBSERVATION } from "./recovery-v2-observer.mjs";
import { createRecoveryV2AuditTransport } from "./recovery-v2-audit-transport.mjs";

// Leave room for a full slow observation before the previous sample expires.
export const V2_OBSERVER_INTERVAL_MS = 15_000;
export const V2_OBSERVER_TIMEOUT_MS = 25_000;
const MAX_AGE_MS = 45_000;

// Post-deployment verification has no wallet, deployment controller, arm digest,
// or broadcast path. Public reads only inspect this bounded background sample.
export function createRecoveryV2LiveObserver({
  env = {}, observe = observeRecoveryV2, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (env.RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE !== "observation-only"
    || env.RETRYCREDIT_RECOVERY_CONTRACT_VERSION !== "v2"
    || env.RETRYCREDIT_RECOVERY_ENABLED !== "true"
    || env.RETRYCREDIT_RECOVERY_POOL_ADDRESS?.toLowerCase() !== RECOVERY_V2_OBSERVATION.contractAddress
    || env.RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER !== "1"
    || !/^[0-9a-f]{40}$/.test(env.RENDER_GIT_COMMIT ?? "")) {
    throw new Error("RECOVERY_V2_OBSERVER_PROFILE_INVALID");
  }
  const audit = createRecoveryV2AuditTransport(env);
  const observationEnv = Object.freeze({
    CREDITCOIN_RPC: "https://rpc.cc3-testnet.creditcoin.network",
    CREDITCOIN_LOG_RPC: audit.auditUrl,
    RETRYCREDIT_DEPLOYMENT_REVISION: env.RENDER_GIT_COMMIT,
  });
  let stopped = false;
  let started = false;
  let flight = null;
  let timer = null;
  let verifiedAt = null;

  function readiness() {
    let timestamp;
    try { timestamp = now(); } catch { timestamp = NaN; }
    const ready = !stopped && verifiedAt !== null && Number.isSafeInteger(timestamp)
      && timestamp >= verifiedAt && timestamp - verifiedAt < MAX_AGE_MS;
    return {
      ready, statusCode: ready ? 200 : 503,
      mode: "observation-only", deploymentState: ready ? "observed" : "blocked",
      publicProfile: "v2",
      reason: ready ? "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO" : "RECOVERY_V2_OBSERVATION_FAILED",
      observers: ready ? 2 : 0,
    };
  }
  function sample() {
    if (stopped) return Promise.resolve(readiness());
    if (flight) return flight;
    flight = (async () => {
      try {
        const result = await Promise.resolve().then(() => observe(observationEnv, {
          timeoutMs: V2_OBSERVER_TIMEOUT_MS,
          ...(audit.fetchImpl ? { fetchImpl: audit.fetchImpl } : {}),
        }));
        const value = result?.body?.recoveryV2;
        const timestamp = now();
        verifiedAt = !stopped && result?.status === 200 && result?.body?.ok === true
          && result.body.revision === observationEnv.RETRYCREDIT_DEPLOYMENT_REVISION
          && result.body.network === 102031 && value?.mode === "observation-only"
          && value?.state === "observed" && value?.observers === 2
          && value?.reason === "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO"
          && Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
      } catch { verifiedAt = null; }
      finally {
        flight = null;
        if (!stopped) {
          try {
            timer = setTimer(() => { timer = null; void sample(); }, V2_OBSERVER_INTERVAL_MS);
            timer?.unref?.();
          } catch { verifiedAt = null; }
        }
      }
      return readiness();
    })();
    return flight;
  }
  return Object.freeze({
    readiness,
    start() { if (started) return flight ?? Promise.resolve(readiness()); started = true; return sample(); },
    stop() { stopped = true; verifiedAt = null; if (timer !== null) clearTimer(timer); timer = null; },
  });
}
