export const TEMPORARY_UNAVAILABLE_MESSAGE = "RetryCredit is temporarily unavailable. Please try again shortly.";
export const CONFIG_WAKE_TOTAL_TIMEOUT_MS = 45_000;
export const CONFIG_WAKE_REQUEST_TIMEOUT_MS = 38_000;
export const CONFIG_WAKE_ATTEMPT_OFFSETS_MS = [0, 3_000, 8_000];
export const RELEASE_TOTAL_TIMEOUT_MS = 15 * 60_000;
export const RELEASE_REQUEST_TIMEOUT_MS = 150_000;
export const RELEASE_RETRY_DELAY_MS = 15_000;

const RELEASE_PENDING_MESSAGE = "Attestcoin is still finalizing. Your receipt is saved; return and retry release shortly.";

export class TemporaryUnavailableError extends Error {
  constructor(message = TEMPORARY_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "TemporaryUnavailableError";
    this.temporaryUnavailable = true;
  }
}

export async function wakeConfig({
  apiOrigin = "",
  fetchImpl = globalThis.fetch,
  totalTimeoutMs = CONFIG_WAKE_TOTAL_TIMEOUT_MS,
  requestTimeoutMs = CONFIG_WAKE_REQUEST_TIMEOUT_MS,
  attemptOffsetsMs = CONFIG_WAKE_ATTEMPT_OFFSETS_MS,
  now = Date.now,
  sleep = delay,
} = {}) {
  const startedAt = now();
  let lastError = new TemporaryUnavailableError();

  for (const offsetMs of attemptOffsetsMs) {
    const waitMs = offsetMs - (now() - startedAt);
    if (waitMs > 0) await sleep(waitMs);

    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;

    try {
      return await requestJsonWithTimeout({
        apiOrigin,
        path: "/api/retry-credit/config",
        fetchImpl,
        timeoutMs: Math.min(requestTimeoutMs, remainingMs),
      });
    } catch (error) {
      if (!error?.temporaryUnavailable) throw error;
      lastError = error;
    }
  }

  throw new TemporaryUnavailableError(lastError.message);
}

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

  throw new Error(RELEASE_PENDING_MESSAGE);
}

export async function requestJson({ apiOrigin = "", path, options, fetchImpl = globalThis.fetch }) {
  return parseJsonResponse(await requestApi({ apiOrigin, path, options, fetchImpl }));
}

export async function requestApi({ apiOrigin = "", path, options, fetchImpl = globalThis.fetch }) {
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
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new TemporaryUnavailableError();
    }
    const error = new Error(message ?? "Request failed");
    error.status = response.status;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
