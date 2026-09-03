const MAX_BODY_BYTES = 16_384;

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
  constructor(code, message, status = 500, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CloudflareApiError";
    this.code = code;
    this.status = status;
  }
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
        const observation = await observeRecoveryV2(env);
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
      const coordinator = coordinatorFor(env);
      const body = route.body ? await readJson(request) : {};
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
        retryAfter: handled.status === 429 || handled.status === 425 ? "5" : null,
      });
    }
  };
}

export function createCoordinatorRuntime({ serviceFactory, env } = {}) {
  if (typeof serviceFactory !== "function") {
    throw new TypeError("serviceFactory is required");
  }
  let servicePromise = null;

  function service() {
    if (!servicePromise) {
      servicePromise = Promise.resolve()
        .then(() => serviceFactory(env))
        .then(async (candidate) => {
          await candidate.readiness();
          return candidate;
        })
        .catch((error) => {
          servicePromise = null;
          logSafeFailure("recovery_service_initialization_failed", error);
          throw error;
        });
    }
    return servicePromise;
  }

  async function health() {
    if (env?.RETRYCREDIT_RECOVERY_ENABLED !== "true") return { state: "disabled" };
    try {
      await service();
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
      const value = await callService(await service(), input.operation, input.body);
      return { status: 200, body: configurationForMode(value, input.operation) };
    } catch (error) {
      const handled = normalizeApiError(error);
      if (handled.status >= 500) {
        logSafeFailure(`recovery_${safeOperationName(input?.operation)}_failed`, error);
      }
      return {
        status: handled.status,
        body: { error: { code: handled.code, message: handled.message, requestId: input?.requestId ?? null } },
        ...(handled.status === 429 || handled.status === 425 ? { retryAfter: "5" } : {}),
      };
    }
  }

  return Object.freeze({ health, execute });
}

async function callService(service, operation, body) {
  switch (operation) {
    case "configuration": return service.configuration();
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
    enabled: false,
    readOnly: true,
    readOnlyReason: "isolated-cloudflare-staging",
  };
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
    "access-control-allow-headers": "content-type",
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
  return new CloudflareApiError(code, message, status);
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
