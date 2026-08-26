import {
  RECOVERY_V2_RUNTIME_ENV,
  RECOVERY_V2_RUNTIME_MODE,
  createRecoveryV2DeploymentController,
} from "./recovery-v2-deployment-runtime.mjs";

const RETRYABLE_ARMED_STATES = new Set([
  "broadcast",
  "broadcast-uncertain",
  "pending",
  "mined",
]);
const RETRYABLE_BLOCKED_REASONS = new Set([
  "BROADCAST_WINDOW_NOT_OPEN",
  "PREBROADCAST_VERIFICATION_UNAVAILABLE",
  "PRESEND_STATE_UNAVAILABLE",
  "PROVIDER_STATE_UNAVAILABLE",
]);
const TERMINAL_ARMED_STATES = new Set(["blocked", "conflict", "failed"]);
const PUBLIC_FINGERPRINT_KEYS = Object.freeze([
  "transactionHash",
  "contractAddress",
  "initCodeHash",
  "runtimeCodeHash",
]);
const DEFAULT_DELAY_MS = 5_000;

/**
 * Construct an inert deployment supervisor. Nothing is prepared, signed,
 * reconciled, scheduled, or broadcast until start() is explicitly invoked.
 */
export function createRecoveryV2DeploymentSupervisor({
  env = {},
  controller: injectedController,
  controllerFactory = createRecoveryV2DeploymentController,
  controllerOptions = {},
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  delayMs = DEFAULT_DELAY_MS,
} = {}) {
  const mode = resolveMode(env, injectedController);
  const retryDelayMs = requireDelay(delayMs);
  requireTimerFunctions(setTimer, clearTimer);
  if (!controllerOptions || typeof controllerOptions !== "object" || Array.isArray(controllerOptions)) {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_OPTIONS_INVALID");
  }
  if (
    mode !== RECOVERY_V2_RUNTIME_MODE.DISABLED
    && !injectedController
    && typeof controllerFactory !== "function"
  ) {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_FACTORY_INVALID");
  }

  let controller = null;
  let startPromise = null;
  let timerHandle = null;
  let running = false;
  let stopped = false;
  let terminal = false;
  let state = initialState(mode);

  const supervisor = {
    mode,
    readiness,
    start,
    stop,
  };

  function readiness() {
    return publicReadiness(mode, state);
  }

  function start() {
    if (startPromise) return startPromise;
    if (stopped) return Promise.resolve(readiness());
    startPromise = initialize().catch(() => {
      state = failureState(mode, "RECOVERY_V2_SUPERVISOR_START_FAILED");
      terminal = true;
      return readiness();
    });
    return startPromise;
  }

  async function initialize() {
    if (mode === RECOVERY_V2_RUNTIME_MODE.DISABLED) {
      state = Object.freeze({ deploymentState: "disabled" });
      terminal = true;
      return readiness();
    }
    let candidate;
    try {
      candidate = injectedController ?? await controllerFactory({ ...controllerOptions, env });
    } catch {
      state = failureState(mode, "RECOVERY_V2_CONTROLLER_UNAVAILABLE");
      terminal = true;
      return readiness();
    }
    if (!controllerMatches(candidate, mode)) {
      state = failureState(mode, "RECOVERY_V2_CONTROLLER_MISMATCH");
      terminal = true;
      return readiness();
    }
    controller = candidate;
    if (stopped) return readiness();

    if (mode === RECOVERY_V2_RUNTIME_MODE.PREPARE) {
      state = Object.freeze({ deploymentState: "preparing" });
      let prepared;
      try {
        prepared = await controller.prepare();
      } catch {
        state = Object.freeze({
          deploymentState: "prepare-failed",
          reason: "RECOVERY_V2_PREPARE_FAILED",
        });
        terminal = true;
        return readiness();
      }
      if (stopped) return readiness();
      const fingerprints = sanitizeFingerprints(prepared);
      if (!fingerprints) {
        state = Object.freeze({
          deploymentState: "prepare-failed",
          reason: "RECOVERY_V2_PREPARE_RESULT_INVALID",
        });
        terminal = true;
        return readiness();
      }
      state = Object.freeze({ deploymentState: "prepared", fingerprints });
      terminal = true;
      return readiness();
    }

    await reconcileOnce();
    return readiness();
  }

  async function reconcileOnce() {
    if (
      stopped
      || terminal
      || running
      || mode !== RECOVERY_V2_RUNTIME_MODE.ARMED
      || !controller
    ) return readiness();
    running = true;
    cancelTimer();
    state = Object.freeze({ deploymentState: "reconciling" });
    let result;
    try {
      result = await controller.run();
    } catch {
      if (!stopped) {
        state = Object.freeze({
          deploymentState: "blocked",
          reason: "RECOVERY_V2_RECONCILIATION_FAILED",
        });
        terminal = true;
      }
      return readiness();
    } finally {
      running = false;
    }
    if (stopped) return readiness();

    let sanitized;
    try {
      sanitized = sanitizeLifecycleState(result);
    } catch {
      sanitized = null;
    }
    if (!sanitized) {
      state = Object.freeze({
        deploymentState: "blocked",
        reason: "RECOVERY_V2_RECONCILIATION_RESULT_INVALID",
      });
      terminal = true;
      return readiness();
    }
    if (sanitized.deploymentState === "finalized") {
      if (!controllerReportsExactFinality(controller)) {
        state = Object.freeze({
          deploymentState: "blocked",
          reason: "RECOVERY_V2_FINALITY_NOT_CONFIRMED",
        });
        terminal = true;
        return readiness();
      }
      state = Object.freeze({
        deploymentState: "finalized",
        reason: "FINALIZED_PLUS_TWO_VERIFIED",
      });
      terminal = true;
      return readiness();
    }
    state = sanitized;
    if (
      RETRYABLE_ARMED_STATES.has(sanitized.deploymentState)
      || (
        sanitized.deploymentState === "blocked"
        && RETRYABLE_BLOCKED_REASONS.has(sanitized.reason)
      )
    ) {
      scheduleReconciliation();
      return readiness();
    }
    if (TERMINAL_ARMED_STATES.has(sanitized.deploymentState)) terminal = true;
    return readiness();
  }

  function scheduleReconciliation() {
    if (stopped || terminal || timerHandle !== null) return;
    try {
      const handle = setTimer(() => {
        timerHandle = null;
        return reconcileOnce();
      }, retryDelayMs);
      if (handle === undefined || handle === null) {
        throw supervisorFault("RECOVERY_V2_SUPERVISOR_TIMER_HANDLE_INVALID");
      }
      timerHandle = handle;
    } catch {
      state = Object.freeze({
        deploymentState: "blocked",
        reason: "RECOVERY_V2_RECONCILIATION_SCHEDULE_FAILED",
      });
      terminal = true;
      timerHandle = null;
    }
  }

  function stop() {
    if (stopped) return readiness();
    stopped = true;
    cancelTimer();
    if (mode === RECOVERY_V2_RUNTIME_MODE.ARMED && state.deploymentState !== "finalized") {
      state = Object.freeze({
        deploymentState: "stopped",
        reason: "RECOVERY_V2_SUPERVISOR_STOPPED",
      });
    }
    return readiness();
  }

  function cancelTimer() {
    if (timerHandle === null) return;
    const handle = timerHandle;
    timerHandle = null;
    try {
      clearTimer(handle);
    } catch {
      // Clearing is best effort; stopped/terminal guards keep the callback inert.
    }
  }

  return Object.freeze(supervisor);
}

function initialState(mode) {
  if (mode === RECOVERY_V2_RUNTIME_MODE.DISABLED) {
    return Object.freeze({ deploymentState: "disabled" });
  }
  return Object.freeze({
    deploymentState: "not-started",
    ...(mode === RECOVERY_V2_RUNTIME_MODE.ARMED
      ? { reason: "RECOVERY_V2_DEPLOYMENT_NOT_VERIFIED" }
      : {}),
  });
}

function failureState(mode, reason) {
  return Object.freeze({
    deploymentState: mode === RECOVERY_V2_RUNTIME_MODE.PREPARE ? "prepare-failed" : "blocked",
    reason,
  });
}

function publicReadiness(mode, state) {
  const ready = mode === RECOVERY_V2_RUNTIME_MODE.DISABLED
    ? state.deploymentState === "disabled"
    : mode === RECOVERY_V2_RUNTIME_MODE.PREPARE
      ? state.deploymentState === "prepared" && Boolean(state.fingerprints)
      : state.deploymentState === "finalized" && state.reason === "FINALIZED_PLUS_TWO_VERIFIED";
  const result = {
    ready,
    statusCode: ready ? 200 : 503,
    mode,
    deploymentState: safeDeploymentState(state.deploymentState),
    publicProfile: "v1",
  };
  const reason = safeReason(state.reason);
  if (reason) result.reason = reason;
  if (state.fingerprints) result.prepared = state.fingerprints;
  return deepFreeze(result);
}

function sanitizeFingerprints(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...PUBLIC_FINGERPRINT_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return null;
  }
  const normalized = {};
  for (const key of PUBLIC_FINGERPRINT_KEYS) {
    if (typeof value[key] !== "string" || !/^0x[0-9a-f]{64}$/.test(value[key])) {
      if (key === "contractAddress" && typeof value[key] === "string" && /^0x[0-9A-Fa-f]{40}$/.test(value[key])) {
        normalized[key] = value[key];
        continue;
      }
      return null;
    }
    normalized[key] = value[key];
  }
  return deepFreeze(normalized);
}

function sanitizeLifecycleState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deploymentState = safeLifecycleStatus(value.status);
  if (!deploymentState) return null;
  const reason = safeReason(value.reason) ?? "RECOVERY_V2_RECONCILIATION_RESULT_INVALID";
  if (deploymentState === "finalized" && reason !== "FINALIZED_PLUS_TWO_VERIFIED") return null;
  return Object.freeze({ deploymentState, reason });
}

function controllerReportsExactFinality(controller) {
  if (typeof controller.readiness !== "function") return false;
  let readiness;
  try {
    readiness = controller.readiness();
  } catch {
    return false;
  }
  return Boolean(
    readiness
    && typeof readiness === "object"
    && readiness.ready === true
    && readiness.statusCode === 200
    && readiness.mode === RECOVERY_V2_RUNTIME_MODE.ARMED
    && readiness.deploymentState === "finalized"
    && readiness.reason === "FINALIZED_PLUS_TWO_VERIFIED"
    && readiness.publicProfile === "v1"
  );
}

function controllerMatches(controller, mode) {
  if (!controller || typeof controller !== "object" || controller.mode !== mode) return false;
  if (typeof controller.readiness !== "function") return false;
  if (mode === RECOVERY_V2_RUNTIME_MODE.DISABLED) return true;
  if (mode === RECOVERY_V2_RUNTIME_MODE.PREPARE) return typeof controller.prepare === "function";
  return typeof controller.run === "function";
}

function resolveMode(env, controller) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_ENV_INVALID");
  }
  const configured = env[RECOVERY_V2_RUNTIME_ENV.mode];
  const value = configured === undefined
    ? (controller?.mode ?? RECOVERY_V2_RUNTIME_MODE.DISABLED)
    : configured;
  if (!Object.values(RECOVERY_V2_RUNTIME_MODE).includes(value)) {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_MODE_INVALID");
  }
  return value;
}

function safeLifecycleStatus(value) {
  const allowed = new Set([...RETRYABLE_ARMED_STATES, ...TERMINAL_ARMED_STATES, "finalized"]);
  return allowed.has(value) ? value : null;
}

function safeDeploymentState(value) {
  const allowed = new Set([
    "disabled",
    "not-started",
    "preparing",
    "prepared",
    "prepare-failed",
    "reconciling",
    "broadcast",
    "broadcast-uncertain",
    "pending",
    "mined",
    "blocked",
    "conflict",
    "failed",
    "finalized",
    "stopped",
  ]);
  return allowed.has(value) ? value : "blocked";
}

function safeReason(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : null;
}

function requireDelay(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60_000) {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_DELAY_INVALID");
  }
  return value;
}

function requireTimerFunctions(setTimer, clearTimer) {
  if (typeof setTimer !== "function" || typeof clearTimer !== "function") {
    throw supervisorFault("RECOVERY_V2_SUPERVISOR_TIMER_INVALID");
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export class RecoveryV2SupervisorFault extends Error {
  constructor(code) {
    super(code);
    this.name = "RecoveryV2SupervisorFault";
    this.code = code;
  }
}

function supervisorFault(code) {
  return new RecoveryV2SupervisorFault(code);
}
