import { WorkerError } from "./proof-worker.mjs";

export const RECOVERY_STARTUP_POLICY = Object.freeze({
  attemptTimeoutMs: 60_000,
  retryDelaysMs: Object.freeze([15_000, 30_000, 60_000, 60_000]),
});

const TRANSPORT_CODES = new Set([
  "TIMEOUT", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
]);
const READINESS_WRAPPERS = new Set(["RECOVERY_MISCONFIGURED", "RECOVERY_STATE_UNAVAILABLE"]);

// Readiness deliberately wraps both bad bindings and failed reads. Only a
// recognizable transport cause may turn those wrappers into a startup retry.
export function isRetryableRecoveryStartupError(error) {
  const seen = new Set();
  for (let depth = 0; error && typeof error === "object" && depth < 5; depth += 1) {
    if (seen.has(error)) return false;
    seen.add(error);
    if (error instanceof WorkerError && !READINESS_WRAPPERS.has(error.code)) return false;
    if (TRANSPORT_CODES.has(error.code)) return true;
    if (error.code === "NETWORK_ERROR") {
      // A detected chain change is an identity failure, not a temporary outage.
      return error.event !== "changed";
    }
    if (error.code === "SERVER_ERROR") {
      const status = error.response?.statusCode
        ?? Number(String(error.info?.responseStatus ?? "").match(/^([0-9]{3})(?: |$)/)?.[1]);
      return status === 429 || (status >= 500 && status <= 599);
    }
    if (error.code && !READINESS_WRAPPERS.has(error.code)) return false;
    error = error.cause;
  }
  return false;
}

export function createRecoveryStartupLifecycle({
  service,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}) {
  if (!service || typeof service.readiness !== "function") {
    throw new TypeError("Recovery startup requires a readiness service");
  }
  let started = false;
  let stopped = false;
  let generation = 0;
  let attempts = 0;
  let timer = null;
  const lifecycle = { state: "waking", service, error: null, start, stop };

  function clearTimer() {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  }

  function schedule(callback, milliseconds) {
    timer = setTimeoutImpl(() => { timer = null; callback(); }, milliseconds);
    timer?.unref?.();
  }

  function fail(error) {
    clearTimer();
    generation += 1;
    lifecycle.state = "error";
    lifecycle.error = error;
  }

  function attempt() {
    if (stopped || lifecycle.state !== "waking") return;
    attempts += 1;
    const current = ++generation;
    schedule(() => {
      // readiness cannot currently be cancelled. Never overlap it with another
      // attempt, or accept a late success after its bounded startup deadline.
      fail(new WorkerError("RECOVERY_STARTUP_TIMEOUT", "Recovery startup timed out", 503));
    }, RECOVERY_STARTUP_POLICY.attemptTimeoutMs);
    Promise.resolve().then(() => {
      if (stopped || current !== generation) return;
      return service.readiness();
    }).then(
      () => {
        if (stopped || current !== generation) return;
        clearTimer();
        lifecycle.state = "ready";
        lifecycle.error = null;
      },
      (error) => {
        if (stopped || current !== generation) return;
        clearTimer();
        const delay = RECOVERY_STARTUP_POLICY.retryDelaysMs[attempts - 1];
        if (!isRetryableRecoveryStartupError(error) || delay === undefined) {
          fail(error);
          return;
        }
        // Completion-relative backoff also allows the service's parallel
        // 15-second HTTP reads to drain before the next readiness call.
        schedule(attempt, delay);
      },
    );
  }

  function start() {
    if (started || stopped) return;
    started = true;
    attempt();
  }

  function stop() {
    stopped = true;
    fail(new WorkerError("RECOVERY_STARTUP_STOPPED", "The recovery service is stopped", 503));
  }

  return lifecycle;
}
