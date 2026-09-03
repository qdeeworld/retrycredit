import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";

import {
  RECOVERY_V2_OBSERVATION,
  observeRecoveryV2,
} from "../src/recovery-v2-observer.mjs";

const ENV = Object.freeze({
  CREDITCOIN_RPC: "https://primary.example/rpc",
  CREDITCOIN_LOG_RPC: "https://audit.example/rpc",
  RETRYCREDIT_DEPLOYMENT_REVISION: "a".repeat(40),
});
const runtimeCode = "0x6000";
const initCode = "0x6001";
const observation = Object.freeze({
  ...RECOVERY_V2_OBSERVATION,
  initCodeHash: keccak256(initCode),
  runtimeCodeHash: keccak256(runtimeCode),
});

test("V2 observer requires two exact agreeing canonical observations", async () => {
  const requests = [];
  const response = await observeRecoveryV2(ENV, {
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      const responses = new Map(batchResponse().map((entry) => [entry.id, entry]));
      return jsonResponse(payload.map(({ id }) => responses.get(id)));
    },
    observation,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.recoveryV2.mode, "observation-only");
  assert.equal(response.body.recoveryV2.state, "observed");
  assert.equal(response.body.recoveryV2.reason, "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO");
  assert.equal(response.body.recoveryV2.observers, 2);
  assert.equal(requests.length, 6);
  for (const endpoint of ["https://primary.example/rpc", "https://audit.example/rpc"]) {
    const endpointRequests = requests.filter(({ url }) => url === endpoint);
    assert.deepEqual(endpointRequests.map(({ payload }) => payload.map(({ method }) => method)), [
      ["eth_getTransactionReceipt", "eth_getCode", "eth_blockNumber"],
      ["eth_chainId", "eth_getTransactionByHash", "eth_getBlockByNumber"],
      ["eth_getCode"],
    ]);
  }
});

test("V2 observer fails closed on disagreement or a mutated receipt", async () => {
  const response = await observeRecoveryV2(ENV, {
    fetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      const responses = new Map(batchResponse().map((entry) => [entry.id, entry]));
      if (url === ENV.CREDITCOIN_LOG_RPC && payload.some(({ id }) => id === 1)) {
        responses.get(1).result.blockHash = `0x${"99".repeat(32)}`;
      }
      return jsonResponse(payload.map(({ id }) => responses.get(id)));
    },
    observation,
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.recoveryV2.reason, "RECOVERY_V2_OBSERVATION_FAILED");
});

test("V2 observer rejects transaction or canonical-block drift", async () => {
  for (const mutate of [
    (responses) => { responses.get(5).result.input = "0x6002"; },
    (responses) => { responses.get(6).result.transactions = []; },
  ]) {
    const response = await observeRecoveryV2(ENV, {
      fetchImpl: async (_url, options) => {
        const payload = JSON.parse(options.body);
        const responses = new Map(batchResponse().map((entry) => [entry.id, entry]));
        mutate(responses);
        return jsonResponse(payload.map(({ id }) => responses.get(id)));
      },
      observation,
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.recoveryV2.reason, "RECOVERY_V2_OBSERVATION_FAILED");
  }
});

test("V2 observer cancels an oversized streamed RPC response", async () => {
  let cancellations = 0;
  const response = await observeRecoveryV2(ENV, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(200_000));
        controller.enqueue(new Uint8Array(100_000));
      },
      cancel() { cancellations += 1; },
    }), { status: 200 }),
    observation,
  });
  assert.equal(response.status, 503);
  assert.ok(cancellations >= 1);
});

function batchResponse() {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        transactionHash: RECOVERY_V2_OBSERVATION.transactionHash,
        contractAddress: RECOVERY_V2_OBSERVATION.contractAddress,
        from: RECOVERY_V2_OBSERVATION.signerAddress,
        to: null,
        status: "0x1",
        blockNumber: `0x${RECOVERY_V2_OBSERVATION.blockNumber.toString(16)}`,
        blockHash: RECOVERY_V2_OBSERVATION.blockHash,
        logs: RECOVERY_V2_OBSERVATION.eventTopics.map((topic) => ({
          address: RECOVERY_V2_OBSERVATION.contractAddress,
          topics: [topic],
        })),
      },
    },
    { jsonrpc: "2.0", id: 2, result: runtimeCode },
    {
      jsonrpc: "2.0",
      id: 3,
      result: `0x${(RECOVERY_V2_OBSERVATION.blockNumber + 2).toString(16)}`,
    },
    { jsonrpc: "2.0", id: 4, result: `0x${RECOVERY_V2_OBSERVATION.chainId.toString(16)}` },
    {
      jsonrpc: "2.0",
      id: 5,
      result: {
        hash: RECOVERY_V2_OBSERVATION.transactionHash,
        from: RECOVERY_V2_OBSERVATION.signerAddress,
        to: null,
        blockHash: RECOVERY_V2_OBSERVATION.blockHash,
        blockNumber: `0x${RECOVERY_V2_OBSERVATION.blockNumber.toString(16)}`,
        nonce: `0x${RECOVERY_V2_OBSERVATION.nonce.toString(16)}`,
        type: `0x${RECOVERY_V2_OBSERVATION.transactionType.toString(16)}`,
        value: `0x${RECOVERY_V2_OBSERVATION.value.toString(16)}`,
        input: initCode,
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      result: {
        hash: RECOVERY_V2_OBSERVATION.blockHash,
        number: `0x${RECOVERY_V2_OBSERVATION.blockNumber.toString(16)}`,
        transactions: [RECOVERY_V2_OBSERVATION.transactionHash],
      },
    },
    { jsonrpc: "2.0", id: 7, result: runtimeCode },
  ];
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
