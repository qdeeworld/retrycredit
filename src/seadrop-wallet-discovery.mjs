import { ZeroAddress, getAddress, isHexString } from "ethers";

import {
  MINT_PARAM_FIELDS,
  MINT_SIGNED_SELECTOR,
  SEA_DROP_MAINNET,
  decodeCanonicalSeaDropMintSigned,
} from "./seadrop-recovery.mjs";

export const BLOCKSCOUT_ETHEREUM_API = "https://eth.blockscout.com/api";
export const BLOCKSCOUT_ETHEREUM_V2_API = "https://eth.blockscout.com/api/v2";
export const ROUTESCAN_ETHEREUM_API =
  "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api";
export const ROUTESCAN_ATTRIBUTION = Object.freeze({
  label: "Powered by Routescan.io APIs",
  url: "https://routescan.io/",
});
const MAX_HISTORY_RESPONSE_BYTES = 2_000_000;
const BLOCKSCOUT_V2_CURSOR_KEYS = Object.freeze(new Set([
  "block_number",
  "fee",
  "filter",
  "hash",
  "index",
  "inserted_at",
  "items_count",
  "value",
]));

class HistoryAvailabilityError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HistoryAvailabilityError";
  }
}

const DEFAULT_HISTORY_FETCHERS = Object.freeze([
  (options) => fetchWalletTransactions({ ...options, apiUrl: ROUTESCAN_ETHEREUM_API }),
  (options) => fetchWalletTransactionsV2({ ...options, apiUrl: BLOCKSCOUT_ETHEREUM_V2_API }),
]);

export async function discoverWalletSeaDropPairs(options = {}) {
  const history = await fetchWalletTransactions(options);
  return Object.freeze({
    ...history,
    pairs: discoverSeaDropPairs(history.transactions, options),
  });
}

export async function discoverWalletSeaDropPairsV2(options = {}) {
  const history = await fetchWalletTransactionsV2(options);
  return Object.freeze({
    ...history,
    pairs: discoverSeaDropPairs(history.transactions, options),
  });
}

export async function discoverWalletSeaDropPairsResilient({
  historyFetchers = DEFAULT_HISTORY_FETCHERS,
  ...options
} = {}) {
  if (
    !Array.isArray(historyFetchers)
    || historyFetchers.length < 1
    || historyFetchers.length > 3
    || historyFetchers.some((fetchHistory) => typeof fetchHistory !== "function")
  ) {
    throw new Error("historyFetchers must contain one to three functions");
  }

  const failures = [];
  const successes = [];
  const usesRouteScan = historyFetchers === DEFAULT_HISTORY_FETCHERS;
  for (const fetchHistory of historyFetchers) {
    try {
      const history = await fetchHistory(options);
      const result = Object.freeze({
        ...history,
        pairs: discoverSeaDropPairs(history.transactions, options),
      });
      successes.push(result);
      if (!history.truncated && successes.length === 1) {
        return withRequiredAttribution(result, usesRouteScan);
      }
      if (!history.truncated) break;
    } catch (error) {
      failures.push(error);
    }
  }
  if (successes.length > 0) {
    return mergeHistoryResults(successes, options, { usesRouteScan });
  }
  throw new AggregateError(failures, "wallet history providers are unavailable");
}

function mergeHistoryResults(histories, options, { usesRouteScan }) {
  const transactions = [];
  const hashes = new Set();
  for (const history of histories) {
    for (const transaction of history.transactions) {
      const hash = typeof transaction?.hash === "string" ? transaction.hash.toLowerCase() : null;
      if (hash && hashes.has(hash)) continue;
      if (hash) hashes.add(hash);
      transactions.push(transaction);
    }
  }
  const merged = Object.freeze({
    transactions: Object.freeze(transactions),
    // Once any provider reports a partial history, preserve that uncertainty
    // even if another provider reports an empty complete view. Discovery is
    // advisory, so retaining live-revalidated candidates is safer than a false
    // empty result while the manual pair entry remains available.
    truncated: histories.some(({ truncated }) => truncated),
    pages: histories.reduce((total, { pages }) => total + pages, 0),
    pairs: discoverSeaDropPairs(transactions, options),
  });
  return withRequiredAttribution(
    merged,
    usesRouteScan || histories.some(({ attribution }) => attribution?.url === ROUTESCAN_ATTRIBUTION.url),
  );
}

function withRequiredAttribution(result, usesRouteScan) {
  if (!usesRouteScan || result.attribution) return result;
  return Object.freeze({ ...result, attribution: ROUTESCAN_ATTRIBUTION });
}

export async function fetchWalletTransactionsV2({
  wallet,
  startBlock,
  endBlock,
  fetchImpl = fetch,
  apiUrl = BLOCKSCOUT_ETHEREUM_V2_API,
  maxPages = 10,
  timeoutMs = 10_000,
  maximumResponseBytes = MAX_HISTORY_RESPONSE_BYTES,
} = {}) {
  const sourceWallet = getAddress(wallet);
  const firstBlock = requireBlock(startBlock, "startBlock");
  const lastBlock = requireBlock(endBlock, "endBlock");
  if (lastBlock < firstBlock) throw new Error("endBlock must not precede startBlock");
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new Error("maxPages must be between 1 and 20");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > 4_000_000) {
    throw new Error("maximumResponseBytes must be between 1 and 4000000");
  }

  const endpoint = new URL(`${String(apiUrl).replace(/\/+$/, "")}/addresses/${sourceWallet}/transactions`);
  endpoint.searchParams.set("filter", "from");
  const transactions = [];
  const startedAt = Date.now();
  let cursor = null;
  let pages = 0;
  let truncated = false;
  const cursorKeys = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const url = new URL(endpoint);
      if (cursor) {
        for (const [key, value] of Object.entries(cursor)) {
          if (value !== null && ["string", "number", "boolean"].includes(typeof value)) {
            url.searchParams.set(key, String(value));
          }
        }
      }
      url.searchParams.set("filter", "from");
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new HistoryAvailabilityError("wallet history discovery timed out");
      const response = await fetchHistoryPage(fetchImpl, url, remainingMs);
      if (!response.ok) {
        await cancelUnreadBody(response);
        throw new HistoryAvailabilityError(`wallet history provider returned HTTP ${response.status}`);
      }
      const body = await readBoundedJson(response, maximumResponseBytes);
      if (!body || !Array.isArray(body.items)) {
        throw new Error("wallet history provider returned an invalid transaction response");
      }
      const normalized = body.items.map(normalizeV2Transaction);
      transactions.push(...normalized.filter(({ blockNumber }) => {
        const block = Number(blockNumber);
        return block >= firstBlock && block <= lastBlock;
      }));
      const reachedStart = normalized.length > 0
        && normalized.every(({ blockNumber }) => Number(blockNumber) < firstBlock);
      cursor = normalizeV2Cursor(body.next_page_params);
      pages = page;
      if (!cursor || reachedStart) break;
      const cursorKey = JSON.stringify(Object.entries(cursor).sort(([left], [right]) => left.localeCompare(right)));
      if (cursorKeys.has(cursorKey)) {
        throw new Error("wallet history provider repeated its pagination cursor");
      }
      cursorKeys.add(cursorKey);
      if (page === maxPages) truncated = true;
    } catch (error) {
      if (pages === 0 || !(error instanceof HistoryAvailabilityError)) throw error;
      truncated = true;
      break;
    }
  }
  return Object.freeze({
    transactions: Object.freeze(transactions.map(Object.freeze)),
    truncated,
    pages,
  });
}

export async function fetchWalletTransactions({
  wallet,
  startBlock,
  endBlock,
  fetchImpl = fetch,
  apiUrl = BLOCKSCOUT_ETHEREUM_API,
  pageSize = 100,
  maxPages = 10,
  timeoutMs = 10_000,
  maximumResponseBytes = MAX_HISTORY_RESPONSE_BYTES,
} = {}) {
  const sourceWallet = getAddress(wallet);
  const firstBlock = requireBlock(startBlock, "startBlock");
  const lastBlock = requireBlock(endBlock, "endBlock");
  if (lastBlock < firstBlock) throw new Error("endBlock must not precede startBlock");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("pageSize must be between 1 and 1000");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
    throw new Error("maxPages must be between 1 and 20");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > 4_000_000) {
    throw new Error("maximumResponseBytes must be between 1 and 4000000");
  }

  const transactions = [];
  const startedAt = Date.now();
  let truncated = false;
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const url = new URL(apiUrl);
      url.search = new URLSearchParams({
        module: "account",
        action: "txlist",
        address: sourceWallet,
        startblock: String(firstBlock),
        endblock: String(lastBlock),
        page: String(page),
        offset: String(pageSize),
        sort: "desc",
      }).toString();
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) throw new HistoryAvailabilityError("wallet history discovery timed out");
      const response = await fetchHistoryPage(fetchImpl, url, remainingMs);
      if (!response.ok) {
        await cancelUnreadBody(response);
        throw new HistoryAvailabilityError(`wallet history provider returned HTTP ${response.status}`);
      }
      const body = await readBoundedJson(response, maximumResponseBytes);
      if (body?.status === "0" && body?.message === "No transactions found") break;
      if (body?.status !== "1" || !Array.isArray(body.result)) {
        throw new Error("wallet history provider returned an invalid transaction response");
      }
      pages = page;
      transactions.push(...body.result);
      if (body.result.length < pageSize) break;
      if (page === maxPages) truncated = true;
    } catch (error) {
      if (pages === 0 || !(error instanceof HistoryAvailabilityError)) throw error;
      truncated = true;
      break;
    }
  }
  return Object.freeze({
    transactions: Object.freeze(transactions.map(Object.freeze)),
    truncated,
    pages,
    ...(String(apiUrl) === ROUTESCAN_ETHEREUM_API ? { attribution: ROUTESCAN_ATTRIBUTION } : {}),
  });
}

async function fetchHistoryPage(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("wallet history provider request timed out")),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    throw new HistoryAvailabilityError("wallet history provider request failed", error);
  } finally {
    clearTimeout(timer);
  }
}

export function discoverSeaDropPairs(transactions, {
  wallet,
  startBlock,
  endBlock,
  maxBlockGap,
  maxQuantity,
  feeRecipient,
} = {}) {
  if (!Array.isArray(transactions)) throw new Error("transactions must be an array");
  const sourceWallet = getAddress(wallet).toLowerCase();
  const firstBlock = requireBlock(startBlock, "startBlock");
  const lastBlock = requireBlock(endBlock, "endBlock");
  const gapLimit = requirePositiveInteger(maxBlockGap, "maxBlockGap");
  const quantityLimit = BigInt(requirePositiveInteger(maxQuantity, "maxQuantity"));
  const expectedFeeRecipient = feeRecipient ? getAddress(feeRecipient).toLowerCase() : null;

  const calls = transactions.flatMap((transaction) => {
    try {
      const from = getAddress(transaction.from).toLowerCase();
      const to = getAddress(transaction.to).toLowerCase();
      const blockNumber = requireBlock(Number(transaction.blockNumber), "transaction blockNumber");
      const nonce = requireBlock(Number(transaction.nonce), "transaction nonce");
      const hash = requireHash(transaction.hash);
      const input = transaction.input;
      if (
        from !== sourceWallet
        || to !== SEA_DROP_MAINNET.toLowerCase()
        || blockNumber < firstBlock
        || blockNumber > lastBlock
        || typeof input !== "string"
        || input.slice(0, 10).toLowerCase() !== MINT_SIGNED_SELECTOR.toLowerCase()
      ) return [];
      const mint = decodeCanonicalSeaDropMintSigned(input);
      const value = BigInt(transaction.value);
      if (
        value <= 0n
        || mint.nftContract === ZeroAddress
        || mint.minterIfNotPayer !== ZeroAddress
        || mint.quantity > quantityLimit
        || mint.mintParams.mintPrice <= 0n
        || !mint.mintParams.restrictFeeRecipients
        || value !== mint.quantity * mint.mintParams.mintPrice
        || (expectedFeeRecipient && mint.feeRecipient.toLowerCase() !== expectedFeeRecipient)
      ) return [];
      return [{
        hash,
        blockNumber,
        nonce,
        status: normalizeStatus(transaction),
        value,
        mint,
        stableKey: stableMintKey(mint, value),
      }];
    } catch {
      return [];
    }
  });

  const successesByNonce = new Map(
    calls.filter(({ status }) => status === 1).map((call) => [call.nonce, call]),
  );
  return Object.freeze(calls
    .filter(({ status }) => status === 0)
    .flatMap((failed) => {
      const successful = successesByNonce.get(failed.nonce + 1);
      if (!successful) return [];
      const blockGap = successful.blockNumber - failed.blockNumber;
      if (blockGap <= 0 || blockGap > gapLimit || successful.stableKey !== failed.stableKey) return [];
      return [Object.freeze({
        wallet: getAddress(wallet),
        failedTransactionHash: failed.hash,
        successfulTransactionHash: successful.hash,
        failureBlock: failed.blockNumber,
        successBlock: successful.blockNumber,
        blockGap,
      })];
    })
    .sort((left, right) => right.successBlock - left.successBlock));
}

function stableMintKey(mint, value) {
  return JSON.stringify({
    nftContract: mint.nftContract,
    feeRecipient: mint.feeRecipient,
    minterIfNotPayer: mint.minterIfNotPayer,
    quantity: mint.quantity.toString(),
    calldataSuffix: mint.calldataSuffix,
    value: value.toString(),
    mintParams: Object.fromEntries(
      MINT_PARAM_FIELDS.map((field) => [field, typeof mint.mintParams[field] === "bigint"
        ? mint.mintParams[field].toString()
        : mint.mintParams[field]]),
    ),
  });
}

function normalizeStatus(transaction) {
  const status = transaction.txreceipt_status ?? (transaction.isError === "1" ? "0" : "1");
  if (status === "0" || status === 0) return 0;
  if (status === "1" || status === 1) return 1;
  throw new Error("transaction status is invalid");
}

function normalizeV2Transaction(transaction) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new Error("wallet history provider returned an invalid transaction row");
  }
  let status;
  if (transaction.status === "ok") status = "1";
  else if (transaction.status === "error") status = "0";
  else throw new Error("wallet history provider returned an invalid transaction status");
  return {
    hash: requireHash(transaction.hash),
    from: getAddress(transaction.from?.hash),
    to: transaction.to?.hash ? getAddress(transaction.to.hash) : ZeroAddress,
    nonce: String(requireBlock(Number(transaction.nonce), "transaction nonce")),
    blockNumber: String(requireBlock(Number(transaction.block_number), "transaction blockNumber")),
    txreceipt_status: status,
    isError: status === "0" ? "1" : "0",
    input: transaction.raw_input,
    value: String(transaction.value),
  };
}

function normalizeV2Cursor(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("wallet history provider returned an invalid pagination cursor");
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 12) {
    throw new Error("wallet history provider returned an invalid pagination cursor");
  }
  const normalized = {};
  for (const [key, entry] of entries) {
    if (!BLOCKSCOUT_V2_CURSOR_KEYS.has(key)) {
      throw new Error("wallet history provider returned an invalid pagination cursor");
    }
    if (["block_number", "index", "items_count"].includes(key)) {
      if (!Number.isSafeInteger(entry) || entry < 0) {
        throw new Error("wallet history provider returned an invalid pagination cursor");
      }
      normalized[key] = entry;
    } else if (key === "filter") {
      if (entry !== "from") throw new Error("wallet history provider returned an invalid pagination cursor");
      normalized[key] = entry;
    } else if (key === "hash") {
      normalized[key] = requireHash(entry);
    } else if (["fee", "value"].includes(key)) {
      if (typeof entry !== "string" || !/^\d{1,80}$/.test(entry)) {
        throw new Error("wallet history provider returned an invalid pagination cursor");
      }
      normalized[key] = entry;
    } else if (key === "inserted_at") {
      if (
        typeof entry !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(entry)
      ) {
        throw new Error("wallet history provider returned an invalid pagination cursor");
      }
      normalized[key] = entry;
    }
  }
  return Object.freeze(normalized);
}

async function readBoundedJson(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await cancelUnreadBody(response);
    throw new Error("wallet history provider response is too large");
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          throw new Error("wallet history provider response is too large");
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
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof response.text === "function") {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new Error("wallet history provider response is too large");
    }
    return JSON.parse(text);
  }
  return response.json();
}

async function cancelUnreadBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already unusable. Cancellation is best-effort cleanup.
  }
}

function requireBlock(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireHash(value) {
  if (!isHexString(value, 32)) throw new Error("transaction hash must be 32 bytes");
  return value.toLowerCase();
}
