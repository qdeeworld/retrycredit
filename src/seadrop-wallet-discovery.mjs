import { ZeroAddress, getAddress, isHexString } from "ethers";

import {
  MINT_PARAM_FIELDS,
  MINT_SIGNED_SELECTOR,
  SEA_DROP_MAINNET,
  decodeCanonicalSeaDropMintSigned,
} from "./seadrop-recovery.mjs";

export const BLOCKSCOUT_ETHEREUM_API = "https://eth.blockscout.com/api";

export async function discoverWalletSeaDropPairs(options = {}) {
  const history = await fetchWalletTransactions(options);
  return Object.freeze({
    ...history,
    pairs: discoverSeaDropPairs(history.transactions, options),
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

  const transactions = [];
  const startedAt = Date.now();
  let truncated = false;
  let pages = 0;
  for (let page = 1; page <= maxPages; page += 1) {
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
    if (remainingMs <= 0) throw new Error("wallet history discovery timed out");
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(remainingMs) });
    if (!response.ok) throw new Error(`wallet history provider returned HTTP ${response.status}`);
    const body = await response.json();
    if (body?.status === "0" && body?.message === "No transactions found") break;
    if (body?.status !== "1" || !Array.isArray(body.result)) {
      throw new Error("wallet history provider returned an invalid transaction response");
    }
    pages = page;
    transactions.push(...body.result);
    if (body.result.length < pageSize) break;
    if (page === maxPages) truncated = true;
  }
  return Object.freeze({
    transactions: Object.freeze(transactions.map(Object.freeze)),
    truncated,
    pages,
  });
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
