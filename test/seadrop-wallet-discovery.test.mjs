import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Wallet, getAddress } from "ethers";

import { SEA_DROP_MAINNET } from "../src/seadrop-recovery.mjs";
import { discoverSeaDropPairs, fetchWalletTransactions } from "../src/seadrop-wallet-discovery.mjs";

const wallet = new Wallet(`0x${"a7".repeat(32)}`).address;
const nft = getAddress("0x1111111111111111111111111111111111111111");
const feeRecipient = getAddress("0x0000a26b00c1F0DF003000390027140000fAa719");
const interface_ = new Interface([
  "function mintSigned(address nftContract,address feeRecipient,address minterIfNotPayer,uint256 quantity,(uint256 mintPrice,uint256 maxTotalMintableByWallet,uint256 startTime,uint256 endTime,uint256 dropStageIndex,uint256 maxTokenSupplyForStage,uint256 feeBps,bool restrictFeeRecipients) mintParams,uint256 salt,bytes signature)",
]);

test("wallet history discovery is bounded and sends an exact address and block query", async () => {
  const urls = [];
  const rows = [{ hash: `0x${"11".repeat(32)}` }];
  const result = await fetchWalletTransactions({
    wallet,
    startBlock: 100,
    endBlock: 200,
    pageSize: 2,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ status: "1", message: "OK", result: rows }) };
    },
  });
  assert.equal(result.transactions.length, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.pages, 1);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("address"), wallet);
  assert.equal(urls[0].searchParams.get("startblock"), "100");
  assert.equal(urls[0].searchParams.get("endblock"), "200");
});

test("wallet history reports bounded truncation instead of implying completeness", async () => {
  const row = { hash: `0x${"12".repeat(32)}` };
  const result = await fetchWalletTransactions({
    wallet,
    startBlock: 100,
    endBlock: 200,
    pageSize: 1,
    maxPages: 2,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "1", message: "OK", result: [row] }),
    }),
  });
  assert.equal(result.transactions.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.pages, 2);
});

test("advisory discovery finds only an exact paid consecutive failed-then-success SeaDrop pair", () => {
  const failedInput = mintInput(1n, `0x${"22".repeat(65)}`);
  const successInput = mintInput(2n, `0x${"33".repeat(65)}`);
  const transactions = [
    transaction({ hashByte: "41", nonce: 8, block: 105, status: 0, input: failedInput }),
    transaction({ hashByte: "42", nonce: 9, block: 108, status: 1, input: successInput }),
    transaction({ hashByte: "43", nonce: 10, block: 109, status: 1, input: successInput, to: nft }),
  ];
  assert.deepEqual(discoverSeaDropPairs(transactions, {
    wallet,
    startBlock: 100,
    endBlock: 200,
    maxBlockGap: 5,
    maxQuantity: 2,
  }), [{
    wallet,
    failedTransactionHash: `0x${"41".repeat(32)}`,
    successfulTransactionHash: `0x${"42".repeat(32)}`,
    failureBlock: 105,
    successBlock: 108,
    blockGap: 3,
  }]);
});

test("discovery rejects a wide gap and a stable-action mutation", () => {
  const failedInput = mintInput(1n, `0x${"22".repeat(65)}`);
  const changedInput = mintInput(2n, `0x${"33".repeat(65)}`, 2n);
  const base = transaction({ hashByte: "51", nonce: 2, block: 120, status: 0, input: failedInput });
  assert.deepEqual(discoverSeaDropPairs([
    base,
    transaction({ hashByte: "52", nonce: 3, block: 126, status: 1, input: failedInput }),
  ], config()), []);
  assert.deepEqual(discoverSeaDropPairs([
    base,
    transaction({ hashByte: "53", nonce: 3, block: 122, status: 1, input: changedInput, value: "20000000000000000" }),
  ], config()), []);
});

test("campaign fee recipient filters advisory candidates before live-validation capacity", () => {
  const failedInput = mintInput(1n, `0x${"22".repeat(65)}`);
  const successInput = mintInput(2n, `0x${"33".repeat(65)}`);
  assert.deepEqual(discoverSeaDropPairs([
    transaction({ hashByte: "61", nonce: 4, block: 130, status: 0, input: failedInput }),
    transaction({ hashByte: "62", nonce: 5, block: 132, status: 1, input: successInput }),
  ], { ...config(), feeRecipient: "0x2222222222222222222222222222222222222222" }), []);
});

test("deterministic predicate failures cannot hide an older valid pair behind the validation cap", () => {
  const validFailed = mintInput(1n, `0x${"21".repeat(65)}`);
  const validSuccess = mintInput(2n, `0x${"22".repeat(65)}`);
  const delegatedFailed = mintInput(3n, `0x${"23".repeat(65)}`, 1n, { minterIfNotPayer: nft });
  const delegatedSuccess = mintInput(4n, `0x${"24".repeat(65)}`, 1n, { minterIfNotPayer: nft });
  const unrestrictedFailed = mintInput(5n, `0x${"25".repeat(65)}`, 1n, { restrictFeeRecipients: false });
  const unrestrictedSuccess = mintInput(6n, `0x${"26".repeat(65)}`, 1n, { restrictFeeRecipients: false });
  const zeroPriceFailed = mintInput(7n, `0x${"27".repeat(65)}`, 1n, { mintPrice: 0n });
  const zeroPriceSuccess = mintInput(8n, `0x${"28".repeat(65)}`, 1n, { mintPrice: 0n });
  const wrongPaymentFailed = mintInput(9n, `0x${"29".repeat(65)}`);
  const wrongPaymentSuccess = mintInput(10n, `0x${"2a".repeat(65)}`);

  const result = discoverSeaDropPairs([
    transaction({ hashByte: "71", nonce: 20, block: 190, status: 0, input: delegatedFailed }),
    transaction({ hashByte: "72", nonce: 21, block: 191, status: 1, input: delegatedSuccess }),
    transaction({ hashByte: "73", nonce: 18, block: 185, status: 0, input: unrestrictedFailed }),
    transaction({ hashByte: "74", nonce: 19, block: 186, status: 1, input: unrestrictedSuccess }),
    transaction({ hashByte: "75", nonce: 16, block: 180, status: 0, input: zeroPriceFailed }),
    transaction({ hashByte: "76", nonce: 17, block: 181, status: 1, input: zeroPriceSuccess }),
    transaction({ hashByte: "77", nonce: 14, block: 175, status: 0, input: wrongPaymentFailed, value: "9000000000000000" }),
    transaction({ hashByte: "78", nonce: 15, block: 176, status: 1, input: wrongPaymentSuccess, value: "9000000000000000" }),
    transaction({ hashByte: "79", nonce: 2, block: 120, status: 0, input: validFailed }),
    transaction({ hashByte: "7a", nonce: 3, block: 121, status: 1, input: validSuccess }),
  ], { ...config(), feeRecipient });

  assert.deepEqual(result, [{
    wallet,
    failedTransactionHash: `0x${"79".repeat(32)}`,
    successfulTransactionHash: `0x${"7a".repeat(32)}`,
    failureBlock: 120,
    successBlock: 121,
    blockGap: 1,
  }]);
});

function config() {
  return { wallet, startBlock: 100, endBlock: 200, maxBlockGap: 5, maxQuantity: 2 };
}

function mintInput(salt, signature, quantity = 1n, {
  minterIfNotPayer = "0x0000000000000000000000000000000000000000",
  mintPrice = 10_000_000_000_000_000n,
  restrictFeeRecipients = true,
} = {}) {
  return interface_.encodeFunctionData("mintSigned", [
    nft,
    feeRecipient,
    minterIfNotPayer,
    quantity,
    [mintPrice, 2n, 1n, 4_000_000_000n, 1n, 10_000n, 250n, restrictFeeRecipients],
    salt,
    signature,
  ]);
}

function transaction({ hashByte, nonce, block, status, input, to = SEA_DROP_MAINNET, value = "10000000000000000" }) {
  return {
    hash: `0x${hashByte.repeat(32)}`,
    from: wallet,
    to,
    nonce: String(nonce),
    blockNumber: String(block),
    txreceipt_status: String(status),
    isError: status === 0 ? "1" : "0",
    input,
    value,
  };
}
