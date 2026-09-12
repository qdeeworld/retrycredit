import { DurableObject } from "cloudflare:workers";
import {
  HELPER_LEDGER_STATES, HELPER_LEDGER_STOP_REASONS, helperLedgerAtom,
  ledgerAddress, ledgerError, ledgerHash, ledgerInteger, ledgerUint, normalizeLedgerPolicy,
  normalizeLedgerReservation, requireRecord,
} from "./helper-ledger-policy.mjs";

const ACTIVE = new Set(["admitted", "broadcast-prepared"]);
const METHODS = new Map([
  ["/v1/reserve", "reserve"], ["/v1/read", "read"], ["/v1/inspect", "inspect"],
  ["/v1/read-source", "readSource"], ["/v1/admission", "admission"],
  ["/v1/prepare-broadcast", "prepareBroadcast"], ["/v1/complete", "complete"],
  ["/v1/fail-before-broadcast", "failBeforeBroadcast"],
  ["/v1/abandon-before-broadcast", "abandonBeforeBroadcast"],
]);

/** @param {HelperLedgerEnv} env */
function configuredPolicy(env) {
  try { return normalizeLedgerPolicy(JSON.parse(env.HELPER_LEDGER_POLICY)); }
  catch { throw ledgerError("HELPER_LEDGER_CONFIG_INVALID", 503); }
}

function publicOperation(row) {
  if (!row) return null;
  return {
    operationId: row.operation_id, mode: row.mode, requester: row.requester,
    sourceWallet: row.source_wallet,
    pair: { failedTransactionHash: row.failed_hash, successfulTransactionHash: row.success_hash },
    state: row.state, maxFeeWei: row.max_fee_wei, creditWei: row.credit_wei,
    transactionHash: row.transaction_hash, nonce: row.nonce,
    receiptStatus: row.receipt_status, blockNumber: row.block_number,
    reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function digest(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (part) => part.toString(16).padStart(2, "0")).join("");
}

async function validSecret(provided, expected) {
  const encoder = new TextEncoder();
  const hashes = await Promise.all([provided, expected].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))));
  return crypto.subtle.timingSafeEqual(hashes[0], hashes[1]);
}

/**
 * One immutable spending atom, not a process lock or a lease. No alarm, refund,
 * automatic retry, or expiry can reopen an operation that may have broadcast.
 * The caller is the authenticated relayer, responsible for source verification
 * and receipt verification. This service never signs or sends a transaction.
 * @extends {DurableObject<HelperLedgerEnv>}
 */
export class HelperSpendingLedger extends DurableObject {
  /** @param {DurableObjectState} ctx @param {HelperLedgerEnv} env */
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS helper_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1), policy_json TEXT NOT NULL,
        attempts INTEGER NOT NULL, payouts INTEGER NOT NULL, reserved_fee_wei TEXT NOT NULL,
        active_operation TEXT
      )`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS helper_operations (
        operation_id TEXT PRIMARY KEY, mode TEXT NOT NULL, requester TEXT NOT NULL,
        source_wallet TEXT NOT NULL UNIQUE, failed_hash TEXT NOT NULL UNIQUE,
        success_hash TEXT NOT NULL UNIQUE, state TEXT NOT NULL, permit_digest TEXT NOT NULL,
        max_fee_wei TEXT NOT NULL, credit_wei TEXT NOT NULL,
        transaction_hash TEXT UNIQUE, nonce INTEGER UNIQUE, receipt_status INTEGER,
        block_number INTEGER, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`);
    });
  }

  // Return deliberate protocol errors as values over RPC. Remote Error custom
  // properties are not a stable wire contract, and rejected RPC promises can be
  // reported as unhandled runtime failures despite a caller's catch handler.
  async dispatch(method, request) {
    try {
      if (![...METHODS.values()].includes(method)) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
      return { ok: true, result: await this[method](request) };
    } catch (error) {
      const code = typeof error?.code === "string" && /^HELPER_LEDGER_[A-Z_]+$/.test(error.code)
        ? error.code : "HELPER_LEDGER_UNAVAILABLE";
      return { ok: false, code, status: [400, 403, 409, 429, 503].includes(error?.status) ? error.status : 503 };
    }
  }

  // All reads/changes below occur synchronously inside one SQLite transaction.
  // Validate persisted totals against individual rows, never reset corrupt state.
  checkedState(policy) {
    const policies = this.ctx.storage.sql.exec("SELECT * FROM helper_policy").toArray();
    const rows = this.ctx.storage.sql.exec("SELECT * FROM helper_operations ORDER BY created_at, operation_id").toArray();
    if (policies.length > 1 || rows.length > 32 || (!policies.length && rows.length)) {
      throw ledgerError("HELPER_LEDGER_STATE_INVALID", 503);
    }
    const metadata = policies[0] ?? null;
    if (!metadata) return { metadata: null, rows };
    if (metadata.policy_json !== JSON.stringify(policy)) throw ledgerError("HELPER_LEDGER_POLICY_CHANGED", 503);
    try {
      let reserved = 0n;
      const active = [];
      for (const row of rows) {
        normalizeLedgerReservation(policy.identity, {
          operationId: row.operation_id, mode: row.mode, requester: row.requester,
          sourceWallet: row.source_wallet,
          pair: { failedTransactionHash: row.failed_hash, successfulTransactionHash: row.success_hash },
          maxFeeWei: row.max_fee_wei,
        });
        if (typeof row.state !== "string" || typeof row.permit_digest !== "string"
          || typeof row.created_at !== "number" || typeof row.updated_at !== "number"
          || typeof row.max_fee_wei !== "string"
          || !HELPER_LEDGER_STATES.includes(row.state) || !/^[a-f0-9]{64}$/.test(row.permit_digest)
          || row.max_fee_wei !== policy.limits.maxFeeWei || row.credit_wei !== policy.limits.creditWei
          || !Number.isSafeInteger(row.created_at) || row.created_at <= 0
          || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at) throw Error();
        const hasTransaction = ["broadcast-prepared", "settled", "reverted"].includes(row.state);
        if (hasTransaction) { ledgerHash(row.transaction_hash); ledgerInteger(row.nonce, { zero: true }); }
        else if (row.transaction_hash !== null || row.nonce !== null) throw Error();
        if (["settled", "reverted"].includes(row.state)) {
          ledgerInteger(row.block_number);
          if (row.receipt_status !== (row.state === "settled" ? 1 : 0) || row.reason !== null) throw Error();
        } else if (row.receipt_status !== null || row.block_number !== null) throw Error();
        if (row.state === "stopped") {
          if (typeof row.reason !== "string" || ![...HELPER_LEDGER_STOP_REASONS, "operator-abandoned"].includes(row.reason)) throw Error();
        } else if (row.reason !== null) throw Error();
        if (ACTIVE.has(row.state)) active.push(row.operation_id);
        reserved += BigInt(row.max_fee_wei);
      }
      if (active.length > 1 || (active[0] ?? null) !== metadata.active_operation
        || metadata.attempts !== rows.length || metadata.payouts !== rows.length
        || ledgerUint(metadata.reserved_fee_wei, { zero: true }) !== reserved.toString()
        || metadata.attempts > policy.limits.maxAttempts || metadata.payouts > policy.limits.maxPayouts
        || reserved > BigInt(policy.limits.maxTotalFeeWei)) throw Error();
    } catch { throw ledgerError("HELPER_LEDGER_STATE_INVALID", 503); }
    return { metadata, rows };
  }

  checkRequest(request) {
    requireRecord(request, ["identity", "limits", "input"]);
    const policy = configuredPolicy(this.env);
    const received = normalizeLedgerPolicy({ identity: request.identity, limits: request.limits });
    if (JSON.stringify(received) !== JSON.stringify(policy)) throw ledgerError("HELPER_LEDGER_POLICY_CHANGED", 503);
    return policy;
  }

  requireEnabled(policy) {
    if (this.env.HELPER_LEDGER_ENABLED !== "true") throw ledgerError("HELPER_LEDGER_DISABLED", 503);
    if (Math.floor(Date.now() / 1000) >= policy.limits.expiresAt) throw ledgerError("HELPER_LEDGER_EXPIRED", 409);
  }

  async reserve(request) {
    const policy = this.checkRequest(request);
    this.requireEnabled(policy);
    const input = normalizeLedgerReservation(policy.identity, request.input);
    if (input.maxFeeWei !== policy.limits.maxFeeWei) throw ledgerError("HELPER_LEDGER_FEE_CAP", 409);
    const permitToken = crypto.randomUUID() + crypto.randomUUID();
    const permitDigest = await digest(permitToken);
    return this.ctx.storage.transactionSync(() => {
      this.requireEnabled(policy);
      const { metadata, rows } = this.checkedState(policy);
      const existing = rows.find((row) => row.operation_id === input.operationId);
      if (existing) return { created: false, operation: publicOperation(existing) };
      if (rows.some((row) => row.source_wallet === input.sourceWallet
        || row.failed_hash === input.pair.failedTransactionHash || row.success_hash === input.pair.successfulTransactionHash)) {
        throw ledgerError("HELPER_LEDGER_SOURCE_RESERVED", 409);
      }
      if (metadata?.active_operation) throw ledgerError("HELPER_LEDGER_BUSY", 409);
      const attempts = ledgerInteger(metadata?.attempts ?? 0, { zero: true }) + 1;
      const payouts = ledgerInteger(metadata?.payouts ?? 0, { zero: true }) + 1;
      const fee = BigInt(ledgerUint(metadata?.reserved_fee_wei ?? "0", { zero: true })) + BigInt(input.maxFeeWei);
      if (attempts > policy.limits.maxAttempts || payouts > policy.limits.maxPayouts
        || fee > BigInt(policy.limits.maxTotalFeeWei)) throw ledgerError("HELPER_LEDGER_BUDGET_EXHAUSTED", 429);
      const now = Date.now();
      this.ctx.storage.sql.exec(`INSERT INTO helper_operations (
        operation_id, mode, requester, source_wallet, failed_hash, success_hash, state,
        permit_digest, max_fee_wei, credit_wei, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, ?, ?)`,
      input.operationId, input.mode, input.requester, input.sourceWallet,
      input.pair.failedTransactionHash, input.pair.successfulTransactionHash,
      permitDigest, input.maxFeeWei, policy.limits.creditWei, now, now);
      this.ctx.storage.sql.exec(`INSERT INTO helper_policy VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts, payouts=excluded.payouts,
          reserved_fee_wei=excluded.reserved_fee_wei, active_operation=excluded.active_operation`,
      JSON.stringify(policy), attempts, payouts, fee.toString(), input.operationId);
      return { created: true, permitToken, operation: this.readRow(input.operationId) };
    });
  }

  readRow(operationId) {
    return publicOperation(this.ctx.storage.sql.exec("SELECT * FROM helper_operations WHERE operation_id = ?", operationId).toArray()[0]);
  }

  read(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["operationId"]);
    const operationId = ledgerHash(request.input.operationId);
    return this.ctx.storage.transactionSync(() => {
      this.checkedState(policy);
      return { operation: this.readRow(operationId) };
    });
  }

  inspect(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, []);
    return this.ctx.storage.transactionSync(() => {
      const { metadata } = this.checkedState(policy);
      return this.admissionTotals(policy, metadata);
    });
  }

  admissionTotals(policy, metadata) {
    return {
      identity: policy.identity, limits: policy.limits,
      enabled: this.env.HELPER_LEDGER_ENABLED === "true" && Math.floor(Date.now() / 1000) < policy.limits.expiresAt,
      attempts: metadata?.attempts ?? 0, payouts: metadata?.payouts ?? 0,
      reservedFeeWei: metadata?.reserved_fee_wei ?? "0",
      activeOperationId: metadata?.active_operation ?? null,
    };
  }

  admission(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["sourceWallet"]);
    const sourceWallet = ledgerAddress(request.input.sourceWallet);
    // Availability and the queried source lock must describe the same instant.
    // This reads only: no permit, allocation, policy initialization or future guarantee.
    return this.ctx.storage.transactionSync(() => {
      const { metadata, rows } = this.checkedState(policy);
      return { ...this.admissionTotals(policy, metadata), sourceWallet,
        operation: publicOperation(rows.find((row) => row.source_wallet === sourceWallet)) };
    });
  }

  readSource(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["sourceWallet"]);
    const sourceWallet = ledgerAddress(request.input.sourceWallet);
    return this.ctx.storage.transactionSync(() => {
      const { rows } = this.checkedState(policy);
      return { operation: publicOperation(rows.find((row) => row.source_wallet === sourceWallet)) };
    });
  }

  async prepareBroadcast(request) {
    const policy = this.checkRequest(request);
    this.requireEnabled(policy);
    requireRecord(request.input, ["operationId", "permitToken", "transactionHash", "nonce", "maxFeeWei"]);
    const input = request.input;
    const operationId = ledgerHash(input.operationId);
    const transactionHash = ledgerHash(input.transactionHash);
    const nonce = ledgerInteger(input.nonce, { zero: true });
    if (ledgerUint(input.maxFeeWei) !== policy.limits.maxFeeWei) throw ledgerError("HELPER_LEDGER_FEE_CAP", 409);
    const permitDigest = await this.checkPermitInput(input.permitToken);
    return this.ctx.storage.transactionSync(() => {
      this.requireEnabled(policy);
      const { rows } = this.checkedState(policy);
      const row = rows.find((entry) => entry.operation_id === operationId);
      this.requirePermit(row, permitDigest);
      if (row.state === "broadcast-prepared" && row.transaction_hash === transactionHash && row.nonce === nonce) {
        return { broadcastPermit: false, operation: publicOperation(row) };
      }
      if (row.state !== "admitted") throw ledgerError("HELPER_LEDGER_STATE_CONFLICT", 409);
      // A stale provider can report an old, previously unseen nonce. Reusing
      // anything at/below a recorded nonce cannot make forward progress and
      // would strand the one-shot broadcast operation on nonce-too-low.
      if (rows.some((entry) => (typeof entry.nonce === "number" && entry.nonce >= nonce)
        || entry.transaction_hash === transactionHash)) {
        throw ledgerError("HELPER_LEDGER_NONCE_RESERVED", 409);
      }
      this.ctx.storage.sql.exec(`UPDATE helper_operations SET state='broadcast-prepared',
        transaction_hash=?, nonce=?, updated_at=? WHERE operation_id=?`, transactionHash, nonce, Date.now(), operationId);
      return { broadcastPermit: true, operation: this.readRow(operationId) };
    });
  }

  async checkPermitInput(token) {
    if (typeof token !== "string" || token.length !== 72 || !/^[a-f0-9-]+$/.test(token)) {
      throw ledgerError("HELPER_LEDGER_PERMIT_INVALID", 403);
    }
    return digest(token);
  }

  requirePermit(row, permitDigest) {
    // The random capability is stored only as its fixed-size digest. SQL state
    // decides freshness; possession does not override an abandoned operation.
    if (!row || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(row.permit_digest), new TextEncoder().encode(permitDigest))) {
      throw ledgerError("HELPER_LEDGER_PERMIT_INVALID", 403);
    }
  }

  async failBeforeBroadcast(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["operationId", "permitToken", "reason"]);
    const operationId = ledgerHash(request.input.operationId);
    if (!HELPER_LEDGER_STOP_REASONS.includes(request.input.reason)) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
    const permitDigest = await this.checkPermitInput(request.input.permitToken);
    return this.ctx.storage.transactionSync(() => {
      const { rows } = this.checkedState(policy);
      const row = rows.find((entry) => entry.operation_id === operationId);
      this.requirePermit(row, permitDigest);
      return this.stopAdmitted(row, request.input.reason);
    });
  }

  // Privileged recovery only: revoke an acknowledged or lost pre-work permit.
  // Never expose this method as a public/browser timeout or retry endpoint.
  abandonBeforeBroadcast(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["operationId"]);
    const operationId = ledgerHash(request.input.operationId);
    return this.ctx.storage.transactionSync(() => {
      const { rows } = this.checkedState(policy);
      const row = rows.find((entry) => entry.operation_id === operationId);
      return this.stopAdmitted(row, "operator-abandoned");
    });
  }

  stopAdmitted(row, reason) {
    if (!row) throw ledgerError("HELPER_LEDGER_NOT_FOUND", 409);
    if (row.state === "stopped") return { operation: publicOperation(row) };
    if (row.state !== "admitted") throw ledgerError("HELPER_LEDGER_STATE_CONFLICT", 409);
    this.ctx.storage.sql.exec("UPDATE helper_operations SET state='stopped', reason=?, updated_at=? WHERE operation_id=?", reason, Date.now(), row.operation_id);
    this.ctx.storage.sql.exec("UPDATE helper_policy SET active_operation=NULL WHERE id=1");
    return { operation: this.readRow(row.operation_id) };
  }

  // Safe to reconcile after process restart: authenticated backend must first
  // verify this exact canonical transaction receipt and its expected logs.
  // Neither a missing receipt nor a nonce observation is proof of completion.
  complete(request) {
    const policy = this.checkRequest(request);
    requireRecord(request.input, ["operationId", "transactionHash", "receiptStatus", "blockNumber"]);
    const { input } = request;
    const operationId = ledgerHash(input.operationId);
    const transactionHash = ledgerHash(input.transactionHash);
    const blockNumber = ledgerInteger(input.blockNumber);
    if (![0, 1].includes(input.receiptStatus)) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
    return this.ctx.storage.transactionSync(() => {
      const { rows } = this.checkedState(policy);
      const row = rows.find((entry) => entry.operation_id === operationId);
      if (!row || row.transaction_hash !== transactionHash) throw ledgerError("HELPER_LEDGER_STATE_CONFLICT", 409);
      if (typeof row.state === "string" && ["settled", "reverted"].includes(row.state) && row.receipt_status === input.receiptStatus && row.block_number === blockNumber) {
        return { operation: publicOperation(row) };
      }
      if (row.state !== "broadcast-prepared") throw ledgerError("HELPER_LEDGER_STATE_CONFLICT", 409);
      this.ctx.storage.sql.exec(`UPDATE helper_operations SET state=?, receipt_status=?, block_number=?, updated_at=? WHERE operation_id=?`,
        input.receiptStatus === 1 ? "settled" : "reverted", input.receiptStatus, blockNumber, Date.now(), operationId);
      this.ctx.storage.sql.exec("UPDATE helper_policy SET active_operation=NULL WHERE id=1");
      return { operation: this.readRow(operationId) };
    });
  }
}

async function boundedJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
  const bytes = new Uint8Array(8_192);
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > bytes.byteLength) {
      await reader.cancel();
      throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
    }
    bytes.set(value, size); size += value.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))); }
  catch { throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400); }
}

/** @satisfies {ExportedHandler<HelperLedgerEnv>} */
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const method = METHODS.get(url.pathname);
      if (request.method !== "POST" || !method || url.search) return new Response("Not found", { status: 404 });
      const token = env.HELPER_LEDGER_TOKEN;
      if (typeof token !== "string" || token.length < 32 || token.length > 512) throw ledgerError("HELPER_LEDGER_CONFIG_INVALID", 503);
      const auth = request.headers.get("authorization") ?? "";
      if (auth.length > 520 || !await validSecret(auth, `Bearer ${token}`)) throw ledgerError("HELPER_LEDGER_UNAUTHORIZED", 401);
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw ledgerError("HELPER_LEDGER_INPUT_INVALID", 400);
      const policy = configuredPolicy(env);
      const body = await boundedJson(request);
      const stub = env.HELPER_LEDGER.getByName(helperLedgerAtom(policy.identity));
      const response = await stub.dispatch(method, body);
      if (!response.ok) throw ledgerError(response.code, response.status);
      return Response.json({ ok: true, result: response.result }, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    } catch (error) {
      const code = typeof error?.code === "string" && /^HELPER_LEDGER_[A-Z_]+$/.test(error.code)
        ? error.code : "HELPER_LEDGER_UNAVAILABLE";
      const status = [400, 401, 403, 409, 429, 503].includes(error?.status) ? error.status : 503;
      // Never log request bodies, authorization, wallet signatures or signed txs.
      return Response.json({ ok: false, code }, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    }
  },
};
