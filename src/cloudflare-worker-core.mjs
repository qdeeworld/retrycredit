const MAX_BODY_BYTES = 16_384;
export const FRESH_READ_MINIMUM_INTERVAL_MS = 5_000;

export const FRESH_READ_NOT_BEFORE_KEY = "fresh-config:not-before-ms:v1";
const FRESH_READ_AUTHORIZATION_SCHEME = "RetryCreditFresh";
const MAX_FRESH_READ_AUTHORIZATION_HEADER_LENGTH = 2_080;

const ROUTES = Object.freeze(new Map([
  ["GET /api/recovery/config", Object.freeze({ operation: "configuration", body: false })],
  ["POST /api/recovery/discover", Object.freeze({ operation: "discover", body: true })],
  ["POST /api/recovery/intake/eligibility", Object.freeze({ operation: "intakeEligibility", body: true })],
  ["POST /api/recovery/intake/challenge", Object.freeze({ operation: "intakeChallenge", body: true })],
  ["POST /api/recovery/intake/release", Object.freeze({ operation: "intakeRelease", body: true })],
  ["POST /api/recovery/eligibility", Object.freeze({ operation: "eligibility", body: true })],
  ["POST /api/recovery/challenge", Object.freeze({ operation: "challenge", body: true })],
  ["POST /api/recovery/release", Object.freeze({ operation: "release", body: true })],
]));
const COORDINATOR_OPERATIONS = Object.freeze(new Set(
  Array.from(ROUTES.values(), ({ operation }) => operation),
));
const WRITE_OPERATIONS = Object.freeze(new Set(["intakeRelease", "release"]));

export class CloudflareApiError extends Error {
  constructor(code, message, status = 500, cause, retryAfter = null) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CloudflareApiError";
    this.code = code;
    this.status = status;
    this.retryAfter = normalizeRetryAfter(retryAfter);
  }
}

export function createFreshReadDutyCycle({
  storage,
  now = Date.now,
  minimumIntervalMs = FRESH_READ_MINIMUM_INTERVAL_MS,
} = {}) {
  if (!storage || typeof storage.transaction !== "function") {
    throw new TypeError("Durable Object transactional storage is required");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (
    !Number.isSafeInteger(minimumIntervalMs)
    || minimumIntervalMs < 1_000
    || minimumIntervalMs > 60_000
    || minimumIntervalMs % 1_000 !== 0
  ) {
    throw new TypeError("minimumIntervalMs must be a whole number of seconds from 1 to 60");
  }

  return async function admitFreshRead() {
    const requestedAtMs = now();
    if (!Number.isSafeInteger(requestedAtMs) || requestedAtMs < 0) {
      throw freshReadGateUnavailable();
    }

    let decision;
    try {
      decision = await storage.transaction(async (transaction) => {
        if (!transaction || typeof transaction.get !== "function" || typeof transaction.put !== "function") {
          throw new TypeError("Durable Object transaction is unavailable");
        }
        const notBeforeMs = await transaction.get(FRESH_READ_NOT_BEFORE_KEY);
        if (
          notBeforeMs !== undefined
          && (
            !Number.isSafeInteger(notBeforeMs)
            || notBeforeMs < 0
            || notBeforeMs > requestedAtMs + minimumIntervalMs
          )
        ) {
          throw new CloudflareApiError(
            "RECOVERY_FRESH_READ_STATE_INVALID",
            "Fresh campaign data cannot be checked right now",
            503,
          );
        }
        if (notBeforeMs !== undefined && requestedAtMs < notBeforeMs) {
          return {
            admitted: false,
            retryAfter: String(Math.max(1, Math.ceil((notBeforeMs - requestedAtMs) / 1_000))),
          };
        }
        await transaction.put(FRESH_READ_NOT_BEFORE_KEY, requestedAtMs + minimumIntervalMs);
        return { admitted: true };
      });
    } catch (error) {
      if (error instanceof CloudflareApiError) throw error;
      throw freshReadGateUnavailable(error);
    }

    if (decision?.admitted !== true) {
      throw new CloudflareApiError(
        "RECOVERY_FRESH_READ_THROTTLED",
        "Fresh campaign data was just checked. Try again in a few seconds.",
        429,
        undefined,
        decision?.retryAfter,
      );
    }
  };
}

export function createCloudflareApiHandler({
  coordinatorFor,
  observeRecoveryV2 = async () => ({
    status: 503,
    body: {
      ok: false,
      service: "retrycredit",
      network: 102031,
      recoveryV2: {
        mode: "observation-only",
        state: "not-implemented",
        publicProfile: "v1",
        reason: "RECOVERY_V2_OBSERVER_NOT_IMPLEMENTED",
      },
      revision: null,
    },
  }),
} = {}) {
  if (typeof coordinatorFor !== "function") {
    throw new TypeError("coordinatorFor must be a function");
  }

  return async function handle(request, env) {
    const requestId = crypto.randomUUID();
    let allowedOrigin = null;
    try {
      allowedOrigin = requireOrigin(env?.ALLOWED_ORIGIN, "ALLOWED_ORIGIN");
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return responseWithHeaders(null, 204, { requestId, allowedOrigin });
      }
      if (request.method === "GET" && url.pathname === "/health/recovery-v2") {
        let observation;
        try {
          observation = await observeRecoveryV2(env);
        } catch (error) {
          logSafeFailure("recovery_v2_observation_unavailable", error);
          observation = unavailableRecoveryV2Observation(env);
        }
        return responseWithHeaders({
          ...observation.body,
          workerVersion: workerVersionMetadata(env),
        }, observation.status, { requestId, allowedOrigin });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const coordinator = coordinatorFor(env);
        const health = await coordinator.health();
        return responseWithHeaders({
          ok: health.state === "ready",
          service: "retrycredit",
          network: 102031,
          recoveryState: health.state,
          recoveryV2: {
            mode: "observation-only",
            state: "separate-probe",
            publicProfile: "v1",
          },
          revision: normalizeRevision(env?.RETRYCREDIT_DEPLOYMENT_REVISION),
          workerVersion: workerVersionMetadata(env),
          hosting: "cloudflare-workers",
          environment: safeEnvironmentName(env?.RETRYCREDIT_ENVIRONMENT),
          writesEnabled: false,
        }, health.state === "ready" ? 200 : 503, { requestId, allowedOrigin });
      }

      const route = ROUTES.get(`${request.method} ${url.pathname}`);
      if (!route) {
        throw new CloudflareApiError("NOT_FOUND", "Route not found", 404);
      }
      const body = route.body
        ? await readJson(request)
        : route.operation === "configuration"
          ? configurationRequestBody(request, url)
          : {};
      const coordinator = coordinatorFor(env);
      const result = await coordinator.execute({
        operation: route.operation,
        body,
        requestId,
      });
      return responseWithHeaders(result.body, result.status, {
        requestId,
        allowedOrigin,
        retryAfter: result.retryAfter,
      });
    } catch (error) {
      const handled = normalizeApiError(error);
      return responseWithHeaders({
        error: {
          code: handled.code,
          message: handled.message,
          requestId,
        },
      }, handled.status, {
        requestId,
        allowedOrigin,
        retryAfter: handled.status === 429 || handled.status === 425
          ? handled.retryAfter ?? "5"
          : null,
      });
    }
  };
}

export function createCoordinatorRuntime({ serviceFactory, freshReadControl, env } = {}) {
  if (typeof serviceFactory !== "function") {
    throw new TypeError("serviceFactory is required");
  }
  if (
    !freshReadControl
    || typeof freshReadControl.admit !== "function"
    || typeof freshReadControl.issueReceipt !== "function"
  ) {
    throw new TypeError("freshReadControl is required");
  }
  let servicePromise = null;

  function initializeService(initializer = async (candidate) => {
    await candidate.readiness();
    return undefined;
  }) {
    let started = false;
    if (!servicePromise) {
      started = true;
      servicePromise = Promise.resolve()
        .then(() => serviceFactory(env))
        .then(async (candidate) => {
          const initialValue = await initializer(candidate);
          return { candidate, initialValue };
        })
        .catch((error) => {
          servicePromise = null;
          logSafeFailure("recovery_service_initialization_failed", error);
          throw error;
        });
    }
    return { promise: servicePromise, started };
  }

  async function health() {
    if (env?.RETRYCREDIT_RECOVERY_ENABLED !== "true") return { state: "disabled" };
    try {
      await initializeService().promise;
      return { state: "ready" };
    } catch {
      return { state: "error" };
    }
  }

  async function execute(input) {
    try {
      requireCoordinatorInput(input);
      if (env?.RETRYCREDIT_RECOVERY_ENABLED !== "true") {
        throw new CloudflareApiError("RECOVERY_DISABLED", "The funded recovery campaign is not configured", 503);
      }
      if (WRITE_OPERATIONS.has(input.operation)) {
        throw new CloudflareApiError(
          "RECOVERY_WRITES_DISABLED",
          "Recovery writes are not implemented on this isolated read-plane deployment",
          410,
        );
      }
      const freshConfiguration = input.operation === "configuration" && input.body?.fresh === true;
      if (freshConfiguration) {
        await freshReadControl.admit(input.body?.authorization);
      }
      const initialization = initializeService(freshConfiguration
        ? (candidate) => callService(candidate, input.operation, input.body)
        : undefined);
      const initialized = await initialization.promise;
      let value = initialization.started && freshConfiguration
        ? initialized.initialValue
        : await callService(initialized.candidate, input.operation, input.body);
      if (input.operation === "intakeChallenge") {
        value = {
          ...value,
          freshReadReceipt: await freshReadControl.issueReceipt(value),
        };
      }
      return { status: 200, body: configurationForMode(value, input.operation) };
    } catch (error) {
      const handled = normalizeApiError(error);
      if (handled.status >= 500) {
        logSafeFailure(`recovery_${safeOperationName(input?.operation)}_failed`, error);
      }
      return {
        status: handled.status,
        body: { error: { code: handled.code, message: handled.message, requestId: input?.requestId ?? null } },
        ...(handled.status === 429 || handled.status === 425
          ? { retryAfter: handled.retryAfter ?? "5" }
          : {}),
      };
    }
  }

  return Object.freeze({ health, execute });
}

async function callService(service, operation, body) {
  switch (operation) {
    case "configuration": return service.configuration({ fresh: body?.fresh === true });
    case "discover": return service.discover(body?.wallet);
    case "intakeEligibility": return service.intakeEligibility(body);
    case "intakeChallenge": return service.intakeChallenge(body);
    case "intakeRelease": return service.intakeRelease(body);
    case "eligibility": return service.eligibility(body?.wallet);
    case "challenge": return service.challenge(body?.wallet);
    case "release": return service.release(body);
    default: throw new CloudflareApiError("NOT_FOUND", "Route not found", 404);
  }
}

function configurationForMode(value, operation) {
  if (operation !== "configuration") return value;
  return {
    ...value,
    consent: {
      ...value.consent,
      freshReadAdmission: "pair-signature-v1",
    },
    enabled: false,
    readOnly: true,
    readOnlyReason: "isolated-cloudflare-staging",
  };
}

function configurationRequestBody(request, url) {
  const fresh = url.searchParams.get("fresh") === "1";
  if (!fresh) return { fresh: false };
  const authorization = request.headers.get("authorization");
  const prefix = FRESH_READ_AUTHORIZATION_SCHEME + " ";
  if (
    typeof authorization !== "string"
    || authorization.length <= prefix.length
    || authorization.length > MAX_FRESH_READ_AUTHORIZATION_HEADER_LENGTH
    || !authorization.startsWith(prefix)
    || authorization.slice(prefix.length).includes(" ")
  ) {
    throw new CloudflareApiError(
      "RECOVERY_FRESH_AUTHORIZATION_REQUIRED",
      "A signed campaign-check authorization is required.",
      401,
    );
  }
  return { fresh: true, authorization: authorization.slice(prefix.length) };
}

async function readJson(request) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new CloudflareApiError("INVALID_CONTENT_TYPE", "Request body must use application/json", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new CloudflareApiError("BODY_TOO_LARGE", "Request body exceeds 16 KB", 413);
  }
  const bytes = await readBoundedBody(request, MAX_BODY_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes) || "{}");
  } catch (error) {
    throw new CloudflareApiError("INVALID_JSON", "Request body must be valid JSON", 400, error);
  }
}

async function readBoundedBody(request, maximumBytes) {
  const reader = request.body?.getReader?.();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new CloudflareApiError("BODY_TOO_LARGE", "Request body exceeds 16 KB", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function responseWithHeaders(body, status, { requestId, allowedOrigin, retryAfter = null }) {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-expose-headers": "retry-after, x-request-id",
  });
  if (allowedOrigin) headers.set("access-control-allow-origin", allowedOrigin);
  if (retryAfter) headers.set("retry-after", retryAfter);
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

function requireCoordinatorInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CloudflareApiError("INVALID_REQUEST", "Coordinator request is invalid", 400);
  }
  if (typeof input.operation !== "string" || typeof input.requestId !== "string") {
    throw new CloudflareApiError("INVALID_REQUEST", "Coordinator request is invalid", 400);
  }
  if (!COORDINATOR_OPERATIONS.has(input.operation)) {
    throw new CloudflareApiError("NOT_FOUND", "Coordinator operation not found", 404);
  }
}

function normalizeApiError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "INTERNAL_ERROR";
  const message = status === 500
    ? "The worker could not process this request"
    : typeof error?.message === "string" && error.message.length <= 240
      ? error.message
      : "The request could not be processed";
  return new CloudflareApiError(code, message, status, undefined, error?.retryAfter);
}

function normalizeRetryAfter(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= 300 ? value : null;
}

function freshReadGateUnavailable(cause) {
  return new CloudflareApiError(
    "RECOVERY_FRESH_READ_GATE_UNAVAILABLE",
    "Fresh campaign data cannot be checked right now",
    503,
    cause,
  );
}

function requireOrigin(value, name) {
  if (typeof value !== "string") throw new CloudflareApiError("RECOVERY_MISCONFIGURED", `${name} is missing`, 503);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", `${name} is invalid`, 503, error);
  }
  if (url.origin !== value || !["https:", "http:"].includes(url.protocol)) {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", `${name} must be an exact origin`, 503);
  }
  return value;
}

function normalizeRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function unavailableRecoveryV2Observation(env) {
  return {
    status: 503,
    body: {
      ok: false,
      service: "retrycredit",
      network: 102031,
      recoveryV2: {
        mode: "observation-only",
        state: "blocked",
        publicProfile: "v1",
        reason: "RECOVERY_V2_OBSERVATION_FAILED",
      },
      revision: normalizeRevision(env?.RETRYCREDIT_DEPLOYMENT_REVISION),
    },
  };
}

function workerVersionMetadata(env) {
  const metadata = env?.CF_VERSION_METADATA;
  const id = typeof metadata?.id === "string" && /^[0-9a-f-]{36}$/i.test(metadata.id)
    ? metadata.id.toLowerCase()
    : null;
  const tag = typeof metadata?.tag === "string" && /^[0-9a-z._-]{1,64}$/i.test(metadata.tag)
    ? metadata.tag
    : null;
  return Object.freeze({ id, tag });
}

function safeEnvironmentName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : "unknown";
}

function safeOperationName(value) {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value)
    ? value
    : "unknown";
}

function logSafeFailure(event, error) {
  const safeMessage = (value) => typeof value === "string"
    ? value.replace(/0x[0-9a-f]{64}/gi, "[redacted-32-byte-value]").slice(0, 240)
    : null;
  const message = safeMessage(error?.message) ?? "unknown failure";
  const causeMessage = safeMessage(error?.cause?.message);
  const code = typeof error?.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : null;
  console.error(JSON.stringify({
    level: "error",
    event,
    errorName: typeof error?.name === "string" ? error.name.slice(0, 64) : "Error",
    errorCode: code,
    message,
    ...(causeMessage ? { causeMessage } : {}),
  }));
}
