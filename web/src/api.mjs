export const TEMPORARY_UNAVAILABLE_MESSAGE = "RetryCredit is temporarily unavailable. Please try again shortly.";
export const CONFIG_WAKE_TOTAL_TIMEOUT_MS = 45_000;
export const CONFIG_WAKE_REQUEST_TIMEOUT_MS = 38_000;
export const CONFIG_WAKE_ATTEMPT_OFFSETS_MS = [0, 3_000, 8_000];
export const RELEASE_TOTAL_TIMEOUT_MS = 15 * 60_000;
export const RELEASE_REQUEST_TIMEOUT_MS = 150_000;
export const RELEASE_RETRY_DELAY_MS = 15_000;
export const RECOVERY_ACTION_REQUEST_TIMEOUT_MS = 30_000;
export const RECOVERY_INTAKE_ELIGIBILITY_PATH = "/api/recovery/intake/eligibility";
export const RECOVERY_INTAKE_CHALLENGE_PATH = "/api/recovery/intake/challenge";
export const RECOVERY_INTAKE_RELEASE_PATH = "/api/recovery/intake/release";
export const RECOVERY_DISCOVERY_PATH = "/api/recovery/discover";

const RECOVERY_RELEASE_PENDING_MESSAGE = "Attestcoin is still finalizing. Check the wallet again before signing a fresh authorization.";
export const LEGACY_RELEASE_PENDING_MESSAGE = "The archived RetryCredit release is still finalizing. Retry the archived flow shortly.";
export const RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE = "The signed authorization window ended. Authorize again with a fresh signature.";

export function recoveryClockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function recoveryWallClockNow() {
  return Date.now();
}

export class TemporaryUnavailableError extends Error {
  constructor(message = TEMPORARY_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "TemporaryUnavailableError";
    this.temporaryUnavailable = true;
  }
}

export class RateLimitedError extends Error {
  constructor(message = "Recovery intake is busy. Wait a moment, then check the same pair again.", options = {}) {
    super(message);
    this.name = "RateLimitedError";
    this.status = 429;
    this.code = options.code ?? "RECOVERY_BUSY";
    this.requestId = options.requestId;
    this.retryAfter = options.retryAfter ?? null;
    this.rateLimited = true;
  }
}

export async function wakeRecoveryConfig(options = {}) {
  return wakeEndpoint({
    ...options,
    path: "/api/recovery/config",
    shouldRetry: (value) => value?.waking === true,
  });
}

// Kept for the previous Uniswap public-lab fallback.
export async function wakeConfig(options = {}) {
  return wakeEndpoint({ ...options, path: "/api/retry-credit/config" });
}

export async function checkRecoveryEligibility({
  apiOrigin = "",
  wallet,
  fetchImpl = globalThis.fetch,
  timeoutMs = RECOVERY_ACTION_REQUEST_TIMEOUT_MS,
} = {}) {
  return postRecoveryJson({
    apiOrigin,
    path: "/api/recovery/eligibility",
    body: { wallet },
    fetchImpl,
    timeoutMs,
  });
}

export async function checkRecoveryPairEligibility({
  apiOrigin = "",
  pair,
  fetchImpl = globalThis.fetch,
  timeoutMs = RECOVERY_ACTION_REQUEST_TIMEOUT_MS,
} = {}) {
  return postRecoveryJson({
    apiOrigin,
    path: RECOVERY_INTAKE_ELIGIBILITY_PATH,
    body: { pair },
    fetchImpl,
    timeoutMs,
  });
}

export async function discoverRecoveryWallet({
  apiOrigin = "",
  wallet,
  fetchImpl = globalThis.fetch,
  timeoutMs = RECOVERY_ACTION_REQUEST_TIMEOUT_MS,
} = {}) {
  return postRecoveryJson({
    apiOrigin,
    path: RECOVERY_DISCOVERY_PATH,
    body: { wallet },
    fetchImpl,
    timeoutMs,
  });
}

export async function requestRecoveryChallenge({
  apiOrigin = "",
  wallet,
  fetchImpl = globalThis.fetch,
  timeoutMs = RECOVERY_ACTION_REQUEST_TIMEOUT_MS,
} = {}) {
  return postRecoveryJson({
    apiOrigin,
    path: "/api/recovery/challenge",
    body: { wallet },
    fetchImpl,
    timeoutMs,
  });
}

export async function requestRecoveryIntakeChallenge({
  apiOrigin = "",
  pair,
  fetchImpl = globalThis.fetch,
  timeoutMs = RECOVERY_ACTION_REQUEST_TIMEOUT_MS,
} = {}) {
  return postRecoveryJson({
    apiOrigin,
    path: RECOVERY_INTAKE_CHALLENGE_PATH,
    body: { pair },
    fetchImpl,
    timeoutMs,
  });
}

export async function releaseRecoveryPairWhenReady({
  apiOrigin = "",
  wallet,
  pair,
  issuedAt,
  expiresAt,
  authorizationStartedAtMs,
  authorizationStartedAtWallMs,
  signature,
  fetchImpl = globalThis.fetch,
  totalTimeoutMs = RELEASE_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = RELEASE_REQUEST_TIMEOUT_MS,
  retryDelayMs = RELEASE_RETRY_DELAY_MS,
  now = recoveryClockNow,
  wallNow = recoveryWallClockNow,
  sleep = delay,
  onPending,
  onRetrying,
} = {}) {
  const startedAt = now();
  const totalDeadline = startedAt + Math.max(0, totalTimeoutMs);
  const authorizationDeadlines = recoveryAuthorizationDeadlines({
    authorizationStartedAtMs,
    authorizationStartedAtWallMs,
    issuedAt,
    expiresAt,
  });
  let pendingCount = 0;

  while (true) {
    const attemptBudget = recoveryReleaseBudget({
      authorizationDeadlines,
      now,
      totalDeadline,
      wallNow,
    });
    const attemptTimeoutMs = Math.floor(Math.min(requestTimeoutMs, attemptBudget.remainingMs));
    if (attemptTimeoutMs <= 0) break;

    try {
      return await postRecoveryJson({
        apiOrigin,
        path: RECOVERY_INTAKE_RELEASE_PATH,
        body: { wallet, pair, issuedAt, expiresAt, signature },
        fetchImpl,
        timeoutMs: attemptTimeoutMs,
      });
    } catch (error) {
      if (error?.status !== 425) throw error;
      pendingCount += 1;
      onPending?.({ attempt: pendingCount, code: error.code, requestId: error.requestId });
    }

    const waitBudget = recoveryReleaseBudget({
      authorizationDeadlines,
      now,
      totalDeadline,
      wallNow,
    });
    const waitMs = Math.floor(Math.min(retryDelayMs, waitBudget.remainingMs));
    if (waitMs > 0) await sleep(waitMs);
    onRetrying?.({ attempt: pendingCount + 1 });
  }

  const finalBudget = recoveryReleaseBudget({
    authorizationDeadlines,
    now,
    totalDeadline,
    wallNow,
  });
  if (finalBudget.authorizationRemainingMs <= 0) throw recoveryAuthorizationError();
  throw new Error(RECOVERY_RELEASE_PENDING_MESSAGE);
}

export async function releaseRecoveryWhenReady({
  apiOrigin = "",
  wallet,
  message,
  issuedAt,
  expiresAt,
  authorizationStartedAtMs,
  authorizationStartedAtWallMs,
  signature,
  fetchImpl = globalThis.fetch,
  totalTimeoutMs = RELEASE_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = RELEASE_REQUEST_TIMEOUT_MS,
  retryDelayMs = RELEASE_RETRY_DELAY_MS,
  now = recoveryClockNow,
  wallNow = recoveryWallClockNow,
  sleep = delay,
  onPending,
} = {}) {
  const startedAt = now();
  const totalDeadline = startedAt + Math.max(0, totalTimeoutMs);
  const authorizationDeadlines = recoveryAuthorizationDeadlines({
    authorizationStartedAtMs,
    authorizationStartedAtWallMs,
    issuedAt,
    expiresAt,
  });
  let pendingCount = 0;

  while (true) {
    const attemptBudget = recoveryReleaseBudget({
      authorizationDeadlines,
      now,
      totalDeadline,
      wallNow,
    });
    const attemptTimeoutMs = Math.floor(Math.min(requestTimeoutMs, attemptBudget.remainingMs));
    if (attemptTimeoutMs <= 0) break;

    try {
      return await postRecoveryJson({
        apiOrigin,
        path: "/api/recovery/release",
        body: { wallet, message, issuedAt, expiresAt, signature },
        fetchImpl,
        timeoutMs: attemptTimeoutMs,
      });
    } catch (error) {
      if (error?.status !== 425) throw error;
      pendingCount += 1;
      onPending?.({ attempt: pendingCount, code: error.code, requestId: error.requestId });
    }

    const waitBudget = recoveryReleaseBudget({
      authorizationDeadlines,
      now,
      totalDeadline,
      wallNow,
    });
    const waitMs = Math.floor(Math.min(retryDelayMs, waitBudget.remainingMs));
    if (waitMs > 0) await sleep(waitMs);
  }

  const finalBudget = recoveryReleaseBudget({
    authorizationDeadlines,
    now,
    totalDeadline,
    wallNow,
  });
  if (finalBudget.authorizationRemainingMs <= 0) {
    throw recoveryAuthorizationError();
  }
  throw new Error(RECOVERY_RELEASE_PENDING_MESSAGE);
}

export function recoveryAuthorizationDeadlines({
  authorizationStartedAtMs,
  authorizationStartedAtWallMs,
  issuedAt,
  expiresAt,
} = {}) {
  const issued = Number(issuedAt);
  const expires = Number(expiresAt);
  const started = Number(authorizationStartedAtMs);
  const wallStarted = Number(authorizationStartedAtWallMs);
  if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(expires) || expires <= issued) {
    const error = new Error("The recovery challenge timestamps are invalid. Check eligibility and request a fresh authorization.");
    error.code = "RECOVERY_CHALLENGE_INVALID";
    throw error;
  }
  if (!Number.isFinite(started) || !Number.isFinite(wallStarted)) {
    const error = new Error("The recovery authorization timing boundary is missing. Check eligibility and authorize again.");
    error.code = "RECOVERY_CHALLENGE_INVALID";
    throw error;
  }
  const lifetimeMs = (expires - issued) * 1_000;
  return Object.freeze({
    monotonic: started + lifetimeMs,
    wallClock: wallStarted + lifetimeMs,
  });
}

function recoveryReleaseBudget({ authorizationDeadlines, now, totalDeadline, wallNow }) {
  const monotonicNow = now();
  const wallClockNow = wallNow();
  const authorizationRemainingMs = Math.min(
    authorizationDeadlines.monotonic - monotonicNow,
    authorizationDeadlines.wallClock - wallClockNow,
  );
  return {
    authorizationRemainingMs,
    remainingMs: Math.min(totalDeadline - monotonicNow, authorizationRemainingMs),
  };
}

function recoveryAuthorizationError() {
  const error = new Error(RECOVERY_AUTHORIZATION_EXPIRED_MESSAGE);
  error.code = "RECOVERY_CHALLENGE_EXPIRED";
  return error;
}

// Kept for the previous Uniswap public-lab fallback.
export async function releaseWhenReady({
  apiOrigin = "",
  serviceCreditNumber,
  failedTransactionHash,
  successfulTransactionHash,
  fetchImpl = globalThis.fetch,
  totalTimeoutMs = RELEASE_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = RELEASE_REQUEST_TIMEOUT_MS,
  retryDelayMs = RELEASE_RETRY_DELAY_MS,
  now = Date.now,
  sleep = delay,
}) {
  const startedAt = now();

  while (now() - startedAt < totalTimeoutMs) {
    const remainingMs = totalTimeoutMs - (now() - startedAt);

    try {
      return await requestJsonWithTimeout({
        apiOrigin,
        path: `/api/retry-credit/${serviceCreditNumber}/release`,
        options: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ failedTransactionHash, successfulTransactionHash }),
        },
        fetchImpl,
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      });
    } catch (error) {
      if (error?.status !== 425) throw error;
    }

    const waitMs = Math.min(retryDelayMs, totalTimeoutMs - (now() - startedAt));
    if (waitMs > 0) await sleep(waitMs);
  }

  throw new Error(LEGACY_RELEASE_PENDING_MESSAGE);
}

export async function requestJson({ apiOrigin = "", path, options, fetchImpl = globalThis.fetch }) {
  return parseJsonResponse(await requestApi({ apiOrigin, path, options, fetchImpl }));
}

export async function requestApi({ apiOrigin = "", path, options, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== "function") throw new TemporaryUnavailableError();
  try {
    return await fetchImpl(`${apiOrigin}${path}`, options);
  } catch {
    throw new TemporaryUnavailableError();
  }
}

export async function parseJsonResponse(response) {
  let data;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new TemporaryUnavailableError();
  }

  if (!response.ok) {
    const message = data?.error?.message;
    if (response.status === 429) {
      throw new RateLimitedError(message, {
        code: data?.error?.code,
        requestId: data?.error?.requestId,
        retryAfter: response.headers?.get?.("retry-after"),
      });
    }
    if (response.status >= 500 || response.status === 408) {
      throw new TemporaryUnavailableError();
    }
    const error = new Error(message ?? "Request failed");
    error.status = response.status;
    error.code = data?.error?.code;
    error.requestId = data?.error?.requestId;
    throw error;
  }

  if (!data) throw new TemporaryUnavailableError();
  return data;
}

export async function requestJsonWithTimeout({ apiOrigin = "", path, options, fetchImpl = globalThis.fetch, timeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new TemporaryUnavailableError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      requestJson({
        apiOrigin,
        path,
        fetchImpl,
        options: { ...options, signal: controller.signal },
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function wakeEndpoint({
  apiOrigin = "",
  path,
  fetchImpl = globalThis.fetch,
  totalTimeoutMs = CONFIG_WAKE_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = CONFIG_WAKE_REQUEST_TIMEOUT_MS,
  attemptOffsetsMs = CONFIG_WAKE_ATTEMPT_OFFSETS_MS,
  now = Date.now,
  sleep = delay,
  shouldRetry = () => false,
} = {}) {
  const startedAt = now();
  let lastError = new TemporaryUnavailableError();

  for (const offsetMs of attemptOffsetsMs) {
    const waitMs = offsetMs - (now() - startedAt);
    if (waitMs > 0) await sleep(waitMs);

    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;

    try {
      const value = await requestJsonWithTimeout({
        apiOrigin,
        path,
        fetchImpl,
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      });
      if (!shouldRetry(value)) return value;
      lastError = new TemporaryUnavailableError();
    } catch (error) {
      if (!error?.temporaryUnavailable) throw error;
      lastError = error;
    }
  }

  throw new TemporaryUnavailableError(lastError.message);
}

function postRecoveryJson({ apiOrigin, path, body, fetchImpl, timeoutMs }) {
  return requestJsonWithTimeout({
    apiOrigin,
    path,
    fetchImpl,
    timeoutMs,
    options: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
