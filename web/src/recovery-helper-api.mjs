import { requestJsonWithTimeout } from "./api.mjs";

// Each action is one HTTP request. In particular, release is never retried:
// an ambiguous acknowledgement is reconciled through the public operation GET.
export function discoverHelperRecovery(options = {}) {
  return helperPost("/discover", {}, options);
}
export function requestHelperChallenge({ requester, pair, ...options } = {}) {
  return helperPost("/challenge", { requester, pair: exactPair(pair) }, options);
}
export function submitHelperRecovery({ challenge, signature, ...options } = {}) {
  const { requester, sourceWallet, operationId, issuedAt, expiresAt } = challenge;
  return helperPost("/release", { requester, sourceWallet, pair: exactPair(challenge.pair), operationId, issuedAt, expiresAt, signature }, options);
}
export function readHelperOperation({ operationId, ...options } = {}) {
  if (!/^0x[0-9a-f]{64}$/.test(operationId)) throw new TypeError("Invalid helper operation identifier");
  return requestJsonWithTimeout({ ...options, path: `/api/recovery/helper/operations/${operationId}`,
    timeoutMs: options.timeoutMs ?? 30_000, options: { method: "GET", cache: "no-store" } });
}
function helperPost(path, body, options) {
  return requestJsonWithTimeout({ ...options, path: `/api/recovery/helper${path}`, timeoutMs: options.timeoutMs ?? 40_000,
    options: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
}
function exactPair(pair) {
  return { failedTransactionHash: pair?.failedTransactionHash, successfulTransactionHash: pair?.successfulTransactionHash };
}
