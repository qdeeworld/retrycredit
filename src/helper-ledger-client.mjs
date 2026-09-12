import {
  HELPER_LEDGER_STATES, HELPER_LEDGER_STOP_REASONS, helperOperationId,
  ledgerAddress, ledgerError, ledgerHash, ledgerInteger, normalizeLedgerPolicy,
  normalizeLedgerReservation, requireRecord,
} from "./helper-ledger-policy.mjs";

// Backend-only transport. Never expose this client or its bearer token to a browser.
// A timeout is UNKNOWN, not permission to retry work or broadcast a transaction.
export function createHelperLedgerClient({ url, token, identity, limits, fetchImpl = fetch, timeoutMs = 8_000 }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || (endpoint.pathname !== "/" && endpoint.pathname !== "")) {
    throw ledgerError("HELPER_LEDGER_CONFIG_INVALID", 503);
  }
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /\s/.test(token)) {
    throw ledgerError("HELPER_LEDGER_CONFIG_INVALID", 503);
  }
  const policy = normalizeLedgerPolicy({ identity, limits });
  Object.freeze(policy.identity);
  Object.freeze(policy.limits);
  Object.freeze(policy);
  async function call(method, input = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(new URL(`/v1/${method}`, endpoint).href, {
        method: "POST", redirect: "manual", signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...policy, input }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw ledgerError("HELPER_LEDGER_UNAVAILABLE", 503);
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 16_384) {
          await reader.cancel();
          throw ledgerError("HELPER_LEDGER_UNAVAILABLE", 503);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      requireRecord(payload, ["ok", "result", "code"]);
      if (!response.ok || payload.ok !== true) {
        const code = typeof payload.code === "string" && /^HELPER_LEDGER_[A-Z_]+$/.test(payload.code)
          ? payload.code : "HELPER_LEDGER_UNAVAILABLE";
        throw ledgerError(code, [400, 401, 403, 409, 429, 503].includes(response.status) ? response.status : 503);
      }
      try { validateResult(method, payload.result, input, policy); }
      catch { throw ledgerError("HELPER_LEDGER_UNAVAILABLE", 503); }
      return payload.result;
    } catch (error) {
      if (error?.code?.startsWith("HELPER_LEDGER_")) throw error;
      throw ledgerError("HELPER_LEDGER_UNAVAILABLE", 503);
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    policy,
    reserve: (input) => call("reserve", input),
    read: (input) => call("read", input),
    readSource: (input) => call("read-source", input),
    inspect: () => call("inspect"),
    prepareBroadcast: (input) => call("prepare-broadcast", input),
    complete: (input) => call("complete", input),
    failBeforeBroadcast: (input) => call("fail-before-broadcast", input),
    abandonBeforeBroadcast: (input) => call("abandon-before-broadcast", input),
  });
}

function validateOperation(operation, policy) {
  requireRecord(operation, ["operationId", "mode", "requester", "sourceWallet", "pair", "state", "maxFeeWei", "creditWei",
    "transactionHash", "nonce", "receiptStatus", "blockNumber", "reason", "createdAt", "updatedAt"]);
  normalizeLedgerReservation(policy.identity, {
    operationId: operation.operationId, mode: operation.mode, requester: operation.requester,
    sourceWallet: operation.sourceWallet, pair: operation.pair, maxFeeWei: operation.maxFeeWei,
  });
  if (!HELPER_LEDGER_STATES.includes(operation.state) || operation.maxFeeWei !== policy.limits.maxFeeWei
    || operation.creditWei !== policy.limits.creditWei || ledgerInteger(operation.updatedAt) < ledgerInteger(operation.createdAt)) throw Error();
  if (["broadcast-prepared", "settled", "reverted"].includes(operation.state)) {
    ledgerHash(operation.transactionHash); ledgerInteger(operation.nonce, { zero: true });
  } else if (operation.transactionHash !== null || operation.nonce !== null) throw Error();
  if (["settled", "reverted"].includes(operation.state)) {
    ledgerInteger(operation.blockNumber);
    if (operation.receiptStatus !== (operation.state === "settled" ? 1 : 0)) throw Error();
  } else if (operation.receiptStatus !== null || operation.blockNumber !== null) throw Error();
  if (operation.state === "stopped") {
    if (![...HELPER_LEDGER_STOP_REASONS, "operator-abandoned"].includes(operation.reason)) throw Error();
  } else if (operation.reason !== null) throw Error();
}

function validateResult(method, result, input, policy) {
  if (method === "inspect") {
    requireRecord(result, ["identity", "limits", "enabled", "attempts", "payouts", "reservedFeeWei", "activeOperationId"]);
    if (JSON.stringify(normalizeLedgerPolicy({ identity: result.identity, limits: result.limits })) !== JSON.stringify(policy)
      || typeof result.enabled !== "boolean") throw Error();
    const attempts = ledgerInteger(result.attempts, { zero: true, max: policy.limits.maxAttempts });
    if (ledgerInteger(result.payouts, { zero: true, max: policy.limits.maxPayouts }) !== attempts
      || result.reservedFeeWei !== (BigInt(attempts) * BigInt(policy.limits.maxFeeWei)).toString()
      || BigInt(result.reservedFeeWei) > BigInt(policy.limits.maxTotalFeeWei)) throw Error();
    if (result.activeOperationId !== null) ledgerHash(result.activeOperationId);
    return;
  }
  requireRecord(result, method === "reserve" ? ["created", "permitToken", "operation"]
    : method === "prepare-broadcast" ? ["broadcastPermit", "operation"] : ["operation"]);
  if (["read", "read-source"].includes(method) && result.operation === null) return;
  validateOperation(result.operation, policy);
  const operation = result.operation;
  if (method === "read-source") {
    if (operation.sourceWallet !== ledgerAddress(input.sourceWallet)) throw Error();
  } else if (operation.operationId !== ledgerHash(input.operationId)) throw Error();
  if (method === "reserve") {
    if (typeof result.created !== "boolean") throw Error();
    if (result.created) {
      if (operation.state !== "admitted" || operation.mode !== input.mode
        || operation.requester !== ledgerAddress(input.requester)
        || operation.operationId !== helperOperationId(policy.identity, input.sourceWallet, input.pair)
        || typeof result.permitToken !== "string" || result.permitToken.length !== 72 || !/^[a-f0-9-]+$/.test(result.permitToken)) throw Error();
    } else if (result.permitToken !== undefined) throw Error();
  }
  if (method === "prepare-broadcast" && (typeof result.broadcastPermit !== "boolean"
    || operation.state !== "broadcast-prepared" || operation.transactionHash !== ledgerHash(input.transactionHash)
    || operation.nonce !== input.nonce)) throw Error();
  if (["fail-before-broadcast", "abandon-before-broadcast"].includes(method) && operation.state !== "stopped") throw Error();
  if (method === "complete" && (operation.state !== (input.receiptStatus === 1 ? "settled" : "reverted")
    || operation.transactionHash !== ledgerHash(input.transactionHash) || operation.blockNumber !== input.blockNumber)) throw Error();
}
