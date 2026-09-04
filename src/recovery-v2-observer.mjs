import { isHexString, keccak256 } from "ethers";

export const RECOVERY_V2_OBSERVATION = Object.freeze({
  transactionHash: "0xef8136a0424254ba502f3499f6324e8a02c12bc7ac341d64c00c9a505085149b",
  contractAddress: "0x3eee179edd6fe6e40d7d23f0110ea639f2da82b8",
  signerAddress: "0x813c4bf413beea09a7f61450bd9a9fa321ed25db",
  blockNumber: 5_381_782,
  blockHash: "0x38120513ea1193b9aae217ef6caa2903ba3090e8acdc8f9ba8a44787915e1de6",
  chainId: 102_031,
  nonce: 55,
  value: 1_000_000_000_000_000_000n,
  transactionType: 2,
  initCodeHash: "0xd069ba5cc3a80251a47b9915c9692e97d9a61d72e903bf590c28a42d4a2b33a6",
  runtimeCodeHash: "0xd0770affc097e8922811def99af7cda6ac7f863f2eaae09eea684e2af737ce07",
  eventTopics: Object.freeze([
    "0xcc65cab25283383f4374b541fccbffd5a816b3cd7771d2bdc54cacef2a1ee933",
    "0x1c8b8e053ebe700f45087e0dbdf0199d02c28db93d605084ed2028761a87c066",
  ]),
});

export async function observeRecoveryV2(env = {}, {
  fetchImpl = fetch,
  timeoutMs = 12_000,
  observation = RECOVERY_V2_OBSERVATION,
} = {}) {
  try {
    const endpoints = [
      requireHttpsUrl(env.CREDITCOIN_RPC, "primary Creditcoin RPC"),
      requireHttpsUrl(env.CREDITCOIN_LOG_RPC, "audit Creditcoin RPC"),
    ];
    if (endpoints[0] === endpoints[1]) throw new Error("V2 observation requires independent RPC URLs");
    const observations = await Promise.all(
      endpoints.map((endpoint) => observeEndpoint(endpoint, { fetchImpl, timeoutMs, observation })),
    );
    const [primary, audit] = observations;
    if (primary.fingerprint !== audit.fingerprint) {
      throw new Error("V2 RPC observations disagree");
    }
    return {
      status: 200,
      body: {
        ok: true,
        service: "retrycredit",
        network: 102031,
        recoveryV2: {
          mode: "observation-only",
          state: "observed",
          publicProfile: "v1",
          reason: "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO",
          observers: 2,
        },
        revision: normalizeRevision(env.RETRYCREDIT_DEPLOYMENT_REVISION),
      },
    };
  } catch {
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
        revision: normalizeRevision(env.RETRYCREDIT_DEPLOYMENT_REVISION),
      },
    };
  }
}

async function observeEndpoint(endpoint, { fetchImpl, timeoutMs, observation }) {
  const payload = [
    { jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [observation.transactionHash] },
    { jsonrpc: "2.0", id: 2, method: "eth_getCode", params: [observation.contractAddress, "latest"] },
    { jsonrpc: "2.0", id: 3, method: "eth_blockNumber", params: [] },
    { jsonrpc: "2.0", id: 4, method: "eth_chainId", params: [] },
    { jsonrpc: "2.0", id: 5, method: "eth_getTransactionByHash", params: [observation.transactionHash] },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "eth_getBlockByNumber",
      params: [`0x${observation.blockNumber.toString(16)}`, false],
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "eth_getCode",
      params: [observation.contractAddress, `0x${observation.blockNumber.toString(16)}`],
    },
  ];
  const startedAt = Date.now();
  const entries = [];
  for (let index = 0; index < payload.length; index += 3) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw new Error("V2 observer RPC timed out");
    const batch = payload.slice(index, index + 3);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(remainingMs),
    });
    if (!response.ok) {
      await cancelUnreadBody(response);
      throw new Error("V2 observer RPC returned an HTTP error");
    }
    const body = await readBoundedJson(response, 256_000);
    if (!Array.isArray(body) || body.length !== batch.length) {
      throw new Error("V2 observer RPC returned an invalid batch");
    }
    entries.push(...body);
  }
  const byId = new Map(entries.map((entry) => [entry?.id, entry]));
  if ([1, 2, 3, 4, 5, 6, 7].some((id) => byId.get(id)?.error || !("result" in (byId.get(id) ?? {})))) {
    throw new Error("V2 observer RPC returned an incomplete batch");
  }
  const receipt = byId.get(1).result;
  const latestCode = byId.get(2).result;
  const latestBlock = parseHexQuantity(byId.get(3).result, "latest block");
  const chainId = parseHexQuantity(byId.get(4).result, "chain id");
  const transaction = byId.get(5).result;
  const canonicalBlock = byId.get(6).result;
  const deploymentCode = byId.get(7).result;
  if (chainId !== observation.chainId) throw new Error("V2 observer is on the wrong chain");
  validateReceipt(receipt, observation);
  validateTransaction(transaction, observation);
  validateCanonicalBlock(canonicalBlock, observation);
  if (
    !isHexString(latestCode)
    || latestCode === "0x"
    || !isHexString(deploymentCode)
    || deploymentCode === "0x"
    || keccak256(latestCode) !== observation.runtimeCodeHash
    || keccak256(deploymentCode) !== observation.runtimeCodeHash
  ) {
    throw new Error("V2 runtime code does not match");
  }
  if (latestBlock < observation.blockNumber + 2) {
    throw new Error("V2 deployment does not have two confirmations");
  }
  const fingerprint = JSON.stringify({
    transactionHash: receipt.transactionHash.toLowerCase(),
    transactionNonce: parseHexQuantity(transaction.nonce, "transaction nonce"),
    transactionType: parseHexQuantity(transaction.type, "transaction type"),
    transactionValue: parseHexBigInt(transaction.value, "transaction value").toString(),
    initCodeHash: keccak256(transaction.input),
    chainId,
    blockNumber: parseHexQuantity(receipt.blockNumber, "receipt block"),
    blockHash: receipt.blockHash.toLowerCase(),
    contractAddress: receipt.contractAddress.toLowerCase(),
    runtimeCodeHash: keccak256(latestCode),
    topics: receipt.logs.map((log) => log.topics[0].toLowerCase()),
  });
  return { fingerprint, latestBlock };
}

function validateTransaction(transaction, observation) {
  if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
    throw new Error("V2 transaction is unavailable");
  }
  if (
    transaction.hash?.toLowerCase() !== observation.transactionHash
    || transaction.from?.toLowerCase() !== observation.signerAddress
    || transaction.to !== null
    || transaction.blockHash?.toLowerCase() !== observation.blockHash
    || parseHexQuantity(transaction.blockNumber, "transaction block") !== observation.blockNumber
    || parseHexQuantity(transaction.nonce, "transaction nonce") !== observation.nonce
    || parseHexQuantity(transaction.type, "transaction type") !== observation.transactionType
    || parseHexBigInt(transaction.value, "transaction value") !== observation.value
    || !isHexString(transaction.input)
    || keccak256(transaction.input) !== observation.initCodeHash
  ) {
    throw new Error("V2 transaction identity does not match");
  }
}

function validateCanonicalBlock(block, observation) {
  if (
    !block
    || typeof block !== "object"
    || Array.isArray(block)
    || block.hash?.toLowerCase() !== observation.blockHash
    || parseHexQuantity(block.number, "canonical block") !== observation.blockNumber
    || !Array.isArray(block.transactions)
    || !block.transactions.some((hash) => hash?.toLowerCase() === observation.transactionHash)
  ) {
    throw new Error("V2 canonical block does not match");
  }
}

function validateReceipt(receipt, observation) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error("V2 receipt is unavailable");
  }
  if (
    receipt.transactionHash?.toLowerCase() !== observation.transactionHash
    || receipt.contractAddress?.toLowerCase() !== observation.contractAddress
    || receipt.from?.toLowerCase() !== observation.signerAddress
    || receipt.to !== null
    || receipt.status !== "0x1"
    || parseHexQuantity(receipt.blockNumber, "receipt block") !== observation.blockNumber
    || receipt.blockHash?.toLowerCase() !== observation.blockHash
    || !Array.isArray(receipt.logs)
    || receipt.logs.length !== 2
  ) {
    throw new Error("V2 receipt identity does not match");
  }
  for (let index = 0; index < receipt.logs.length; index += 1) {
    const log = receipt.logs[index];
    if (
      log?.address?.toLowerCase() !== observation.contractAddress
      || !Array.isArray(log.topics)
      || log.topics[0]?.toLowerCase() !== observation.eventTopics[index]
    ) {
      throw new Error("V2 deployment events do not match");
    }
  }
}

async function readBoundedJson(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await cancelUnreadBody(response);
    throw new Error("V2 observer response is too large");
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("V2 observer response body is unavailable");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("V2 observer response is too large");
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

async function cancelUnreadBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // The response is already unusable. Cancellation is best-effort cleanup.
  }
}

function parseHexQuantity(value, name) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  const parsed = Number(BigInt(value));
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is unsafe`);
  return parsed;
}

function parseHexBigInt(value, name) {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return BigInt(value);
}

function requireHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${name} is invalid`);
  }
  return url.toString();
}

function normalizeRevision(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}
