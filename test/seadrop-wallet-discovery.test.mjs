import assert from "node:assert/strict";
import test from "node:test";
import { Interface, Wallet, getAddress } from "ethers";

import { SEA_DROP_MAINNET } from "../src/seadrop-recovery.mjs";
import {
  ROUTESCAN_ATTRIBUTION,
  ROUTESCAN_ETHEREUM_API,
  discoverWalletSeaDropPairsResilient,
  discoverSeaDropPairs,
  fetchWalletTransactions,
  fetchWalletTransactionsV2,
} from "../src/seadrop-wallet-discovery.mjs";

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

test("keyless RouteScan history carries its required public attribution", async () => {
  const result = await fetchWalletTransactions({
    wallet,
    startBlock: 100,
    endBlock: 200,
    apiUrl: ROUTESCAN_ETHEREUM_API,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "0", message: "No transactions found", result: [] }),
    }),
  });
  assert.deepEqual(result.attribution, ROUTESCAN_ATTRIBUTION);
});

test("Blockscout V2 history is bounded, normalized, and stops below the campaign window", async () => {
  const urls = [];
  const responses = [
    {
      items: [
        v2Transaction({ hashByte: "21", nonce: 3, block: 205, status: "ok" }),
        v2Transaction({ hashByte: "22", nonce: 2, block: 150, status: "error" }),
      ],
      next_page_params: {
        index: 2,
        value: "1000000000000000",
        filter: "from",
        hash: `0x${"88".repeat(32)}`,
        inserted_at: "2026-09-03T00:00:01.743095Z",
        block_number: 150,
        fee: "50450000000000",
        items_count: 50,
      },
    },
    {
      items: [v2Transaction({ hashByte: "23", nonce: 1, block: 90, status: "ok" })],
      next_page_params: { block_number: 90, index: 1 },
    },
  ];
  const result = await fetchWalletTransactionsV2({
    wallet,
    startBlock: 100,
    endBlock: 200,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => responses.shift() };
    },
  });

  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].hash, `0x${"22".repeat(32)}`);
  assert.equal(result.transactions[0].txreceipt_status, "0");
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(urls[0].searchParams.get("filter"), "from");
  assert.equal(urls[1].searchParams.get("block_number"), "150");
  assert.equal(urls[1].searchParams.get("index"), "2");
  assert.equal(urls[1].searchParams.get("filter"), "from");
  assert.equal(urls[1].searchParams.get("items_count"), "50");
});

test("Blockscout V2 history rejects an oversized response before parsing", async () => {
  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      maximumResponseBytes: 20,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => "21" },
        json: async () => ({ items: [] }),
      }),
    }),
    /response is too large/,
  );
});

test("Blockscout V2 preserves earlier rows after an oversized later page", async () => {
  let page = 0;
  let parsedOversize = 0;
  let cancellations = 0;
  const result = await fetchWalletTransactionsV2({
    wallet,
    startBlock: 100,
    endBlock: 200,
    maximumResponseBytes: 20,
    fetchImpl: async () => {
      page += 1;
      if (page === 1) {
        return {
          ok: true,
          json: async () => ({
            items: [v2Transaction({ hashByte: "26", nonce: 4, block: 150, status: "ok" })],
            next_page_params: { block_number: 150, index: 1, filter: "from" },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "21" },
        body: { cancel: async () => { cancellations += 1; } },
        json: async () => {
          parsedOversize += 1;
          return { items: [], next_page_params: null };
        },
      };
    },
  });

  assert.equal(page, 2);
  assert.equal(parsedOversize, 0);
  assert.equal(cancellations, 1);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.pages, 1);
  assert.equal(result.truncated, true);
});

test("Blockscout V2 history rejects unknown statuses and pagination keys", async () => {
  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          items: [v2Transaction({ hashByte: "24", nonce: 1, block: 150, status: "pending" })],
          next_page_params: null,
        }),
      }),
    }),
    /invalid transaction status/,
  );

  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          items: [],
          next_page_params: { block_number: 150, redirect: "https://example.com" },
        }),
      }),
    }),
    /invalid pagination cursor/,
  );

  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ items: [], next_page_params: { filter: "to", block_number: 150 } }),
      }),
    }),
    /invalid pagination cursor/,
  );

  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ items: [], next_page_params: { value: "1".repeat(81), block_number: 150 } }),
      }),
    }),
    /invalid pagination cursor/,
  );
});

test("Blockscout V2 history rejects a repeated pagination cursor", async () => {
  const cursor = { block_number: 150, index: 2, items_count: 50, filter: "from" };
  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          items: [v2Transaction({ hashByte: "25", nonce: 3, block: 150, status: "ok" })],
          next_page_params: cursor,
        }),
      }),
    }),
    /repeated its pagination cursor/,
  );
});

test("Etherscan-compatible history rejects an oversized response before parsing", async () => {
  let cancellations = 0;
  await assert.rejects(
    fetchWalletTransactions({
      wallet,
      startBlock: 100,
      endBlock: 200,
      maximumResponseBytes: 20,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => "21" },
        body: { cancel: async () => { cancellations += 1; } },
        json: async () => ({ status: "1", message: "OK", result: [] }),
      }),
    }),
    /response is too large/,
  );
  assert.equal(cancellations, 1);
});

test("a declared oversized first page falls back without parsing it", async () => {
  let parsed = 0;
  let fallbacks = 0;
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    historyFetchers: [
      (options) => fetchWalletTransactions({
        ...options,
        maximumResponseBytes: 20,
        fetchImpl: async () => ({
          ok: true,
          headers: { get: () => "21" },
          body: { cancel: async () => {} },
          json: async () => {
            parsed += 1;
            return { status: "1", message: "OK", result: [] };
          },
        }),
      }),
      async () => {
        fallbacks += 1;
        return { transactions: [], truncated: false, pages: 1 };
      },
    ],
  });

  assert.equal(parsed, 0);
  assert.equal(fallbacks, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.transactions, []);
});

test("history providers cancel unread rate-limit responses before fallback", async () => {
  let cancellations = 0;
  const rateLimited = () => ({
    ok: false,
    status: 429,
    body: { cancel: async () => { cancellations += 1; } },
  });
  await assert.rejects(
    fetchWalletTransactions({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => rateLimited(),
    }),
    /HTTP 429/,
  );
  await assert.rejects(
    fetchWalletTransactionsV2({
      wallet,
      startBlock: 100,
      endBlock: 200,
      fetchImpl: async () => rateLimited(),
    }),
    /HTTP 429/,
  );
  assert.equal(cancellations, 2);
});

test("resilient discovery falls back and still applies deterministic pair validation", async () => {
  const failedInput = mintInput(11n, `0x${"31".repeat(65)}`);
  const successfulInput = mintInput(12n, `0x${"32".repeat(65)}`);
  const calls = [];
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    feeRecipient,
    historyFetchers: [
      async () => {
        calls.push("primary");
        throw new Error("primary rate limited");
      },
      async () => {
        calls.push("fallback");
        return {
          transactions: [
            transaction({ hashByte: "33", nonce: 7, block: 140, status: 0, input: failedInput }),
            transaction({ hashByte: "34", nonce: 8, block: 141, status: 1, input: successfulInput }),
          ],
          truncated: false,
          pages: 1,
        };
      },
    ],
  });

  assert.deepEqual(calls, ["primary", "fallback"]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].failedTransactionHash, `0x${"33".repeat(32)}`);
  assert.equal(result.pairs[0].successfulTransactionHash, `0x${"34".repeat(32)}`);
});

test("default resilient discovery handles both keyless rate-limit response forms", async () => {
  for (const routeScanResponse of [
    { ok: false, status: 429, body: { cancel: async () => {} } },
    {
      ok: true,
      json: async () => ({ status: "0", message: "NOTOK", result: "Max rate limit reached" }),
    },
  ]) {
    const urls = [];
    const result = await discoverWalletSeaDropPairsResilient({
      ...config(),
      fetchImpl: async (url) => {
        urls.push(url);
        if (new URL(url).hostname === "api.routescan.io") return routeScanResponse;
        return {
          ok: true,
          json: async () => ({ items: [], next_page_params: null }),
        };
      },
    });
    assert.equal(urls.length, 2);
    assert.equal(urls[0].origin + urls[0].pathname, ROUTESCAN_ETHEREUM_API);
    assert.equal(urls[0].searchParams.get("address"), wallet);
    assert.equal(urls[0].searchParams.get("startblock"), "100");
    assert.equal(urls[0].searchParams.get("endblock"), "200");
    assert.equal(urls[0].searchParams.get("page"), "1");
    assert.equal(urls[0].searchParams.get("offset"), "100");
    assert.equal(urls[0].searchParams.get("sort"), "desc");
    assert.equal(urls[0].searchParams.has("apikey"), false);
    assert.equal(urls[1].hostname, "eth.blockscout.com");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.attribution, ROUTESCAN_ATTRIBUTION);
  }
});

test("a complete empty primary history does not call the fallback", async () => {
  let calls = 0;
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ status: "1", message: "OK", result: [] }),
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.pairs, []);
});

test("a complete-empty fallback cannot erase a valid pair from a truncated primary", async () => {
  const failedInput = mintInput(11n, `0x${"31".repeat(65)}`);
  const successfulInput = mintInput(12n, `0x${"32".repeat(65)}`);
  const validPair = [
    transaction({ hashByte: "35", nonce: 7, block: 140, status: 0, input: failedInput }),
    transaction({ hashByte: "36", nonce: 8, block: 141, status: 1, input: successfulInput }),
  ];
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    feeRecipient,
    historyFetchers: [
      async () => ({ transactions: validPair, truncated: true, pages: 10 }),
      async () => ({ transactions: [], truncated: false, pages: 1 }),
    ],
  });

  assert.equal(result.truncated, true);
  assert.equal(result.transactions.length, 2);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].failedTransactionHash, `0x${"35".repeat(32)}`);
});

test("a later-page rate limit preserves normalized rows as a marked partial history", async () => {
  const failedInput = mintInput(13n, `0x${"33".repeat(65)}`);
  const successfulInput = mintInput(14n, `0x${"34".repeat(65)}`);
  let page = 0;
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    feeRecipient,
    historyFetchers: [
      (options) => fetchWalletTransactions({
        ...options,
        pageSize: 2,
        maxPages: 3,
        fetchImpl: async () => {
          page += 1;
          if (page === 1) {
            return {
              ok: true,
              json: async () => ({
                status: "1",
                message: "OK",
                result: [
                  transaction({ hashByte: "37", nonce: 9, block: 150, status: 0, input: failedInput }),
                  transaction({ hashByte: "38", nonce: 10, block: 151, status: 1, input: successfulInput }),
                ],
              }),
            };
          }
          return { ok: false, status: 429, body: { cancel: async () => {} } };
        },
      }),
      async () => ({ transactions: [], truncated: false, pages: 1 }),
    ],
  });

  assert.equal(page, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].successfulTransactionHash, `0x${"38".repeat(32)}`);
});

test("a later-page HTTP-200 rate-limit envelope preserves normalized rows as partial", async () => {
  const failedInput = mintInput(17n, `0x${"37".repeat(65)}`);
  const successfulInput = mintInput(18n, `0x${"38".repeat(65)}`);
  let page = 0;
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    feeRecipient,
    historyFetchers: [
      (options) => fetchWalletTransactions({
        ...options,
        pageSize: 2,
        maxPages: 3,
        fetchImpl: async () => {
          page += 1;
          if (page === 1) {
            return {
              ok: true,
              json: async () => ({
                status: "1",
                message: "OK",
                result: [
                  transaction({ hashByte: "3b", nonce: 13, block: 162, status: 0, input: failedInput }),
                  transaction({ hashByte: "3c", nonce: 14, block: 163, status: 1, input: successfulInput }),
                ],
              }),
            };
          }
          return {
            ok: true,
            json: async () => ({
              status: "0",
              message: "NOTOK",
              result: "Max rate limit reached, please use API Key for higher rate limit",
            }),
          };
        },
      }),
      async () => ({ transactions: [], truncated: false, pages: 1 }),
    ],
  });

  assert.equal(page, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].successfulTransactionHash, `0x${"3c".repeat(32)}`);
});

test("a declared oversized later page preserves earlier rows as truncated without parsing", async () => {
  let page = 0;
  let parsedOversize = 0;
  let cancellations = 0;
  const result = await fetchWalletTransactions({
    ...config(),
    pageSize: 2,
    maxPages: 3,
    maximumResponseBytes: 200,
    fetchImpl: async () => {
      page += 1;
      if (page === 1) {
        return {
          ok: true,
          json: async () => ({
            status: "1",
            message: "OK",
            result: [
              transaction({ hashByte: "41", nonce: 19, block: 168, status: 0 }),
              transaction({ hashByte: "42", nonce: 20, block: 169, status: 1 }),
            ],
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => "201" },
        body: { cancel: async () => { cancellations += 1; } },
        json: async () => {
          parsedOversize += 1;
          return { status: "1", message: "OK", result: [] };
        },
      };
    },
  });

  assert.equal(page, 2);
  assert.equal(parsedOversize, 0);
  assert.equal(cancellations, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.transactions.length, 2);
});

test("a streamed oversized later page cancels its reader and preserves earlier rows", async () => {
  let page = 0;
  let reads = 0;
  let cancellations = 0;
  let releases = 0;
  const chunks = [new Uint8Array(12), new Uint8Array(12)];
  const result = await fetchWalletTransactions({
    ...config(),
    pageSize: 2,
    maxPages: 3,
    maximumResponseBytes: 20,
    fetchImpl: async () => {
      page += 1;
      if (page === 1) {
        return {
          ok: true,
          json: async () => ({
            status: "1",
            message: "OK",
            result: [
              transaction({ hashByte: "43", nonce: 21, block: 170, status: 0 }),
              transaction({ hashByte: "44", nonce: 22, block: 171, status: 1 }),
            ],
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: async () => {
              const value = chunks[reads];
              reads += 1;
              return value ? { done: false, value } : { done: true };
            },
            cancel: async () => {
              cancellations += 1;
              throw new Error("synthetic cancellation failure");
            },
            releaseLock: () => { releases += 1; },
          }),
        },
      };
    },
  });

  assert.equal(page, 2);
  assert.equal(reads, 2);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.transactions.length, 2);
});

test("malformed JSON on a later page remains a hard provider failure", async () => {
  let page = 0;
  await assert.rejects(
    fetchWalletTransactions({
      ...config(),
      pageSize: 2,
      maxPages: 3,
      fetchImpl: async () => {
        page += 1;
        if (page === 1) {
          return {
            ok: true,
            json: async () => ({
              status: "1",
              message: "OK",
              result: [
                transaction({ hashByte: "45", nonce: 23, block: 172, status: 0 }),
                transaction({ hashByte: "46", nonce: 24, block: 173, status: 1 }),
              ],
            }),
          };
        }
        return { ok: true, text: async () => "{" };
      },
    }),
    SyntaxError,
  );
  assert.equal(page, 2);
});

test("a stalled later-page body is aborted, cancelled, and retained as partial history", async () => {
  const failedInput = mintInput(19n, `0x${"39".repeat(65)}`);
  const successfulInput = mintInput(20n, `0x${"3a".repeat(65)}`);
  let page = 0;
  let aborts = 0;
  let cancellations = 0;
  let releases = 0;
  let finishRead;
  const started = performance.now();
  const result = await fetchWalletTransactions({
    ...config(),
    pageSize: 2,
    maxPages: 3,
    timeoutMs: 30,
    fetchImpl: async (_url, { signal }) => {
      page += 1;
      if (page === 1) {
        return {
          ok: true,
          json: async () => ({
            status: "1",
            message: "OK",
            result: [
              transaction({ hashByte: "3f", nonce: 17, block: 166, status: 0, input: failedInput }),
              transaction({ hashByte: "40", nonce: 18, block: 167, status: 1, input: successfulInput }),
            ],
          }),
        };
      }
      signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
      return {
        ok: true,
        headers: { get: () => null },
        body: {
          getReader: () => ({
            read: () => new Promise((resolve) => { finishRead = resolve; }),
            cancel: async () => {
              cancellations += 1;
              finishRead?.({ done: true });
            },
            releaseLock: () => { releases += 1; },
          }),
        },
      };
    },
  });
  const elapsed = performance.now() - started;

  assert.equal(page, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.transactions.length, 2);
  assert.equal(aborts, 1);
  assert.equal(cancellations, 1);
  assert.equal(releases, 1);
  assert.ok(elapsed >= 20, `body deadline ended too early: ${elapsed}ms`);
  assert.ok(elapsed < 200, `body deadline exceeded bound: ${elapsed}ms`);
});

test("a completed history body clears its page timer", async () => {
  let observedSignal;
  let aborts = 0;
  const result = await fetchWalletTransactions({
    ...config(),
    timeoutMs: 20,
    fetchImpl: async (_url, { signal }) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => { aborts += 1; }, { once: true });
      return {
        ok: true,
        json: async () => ({ status: "1", message: "OK", result: [] }),
      };
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(result.truncated, false);
  assert.equal(observedSignal.aborted, false);
  assert.equal(aborts, 0);
});

test("an arbitrary later-page NOTOK envelope remains a hard provider failure", async () => {
  let page = 0;
  await assert.rejects(
    fetchWalletTransactions({
      ...config(),
      pageSize: 2,
      maxPages: 3,
      fetchImpl: async () => {
        page += 1;
        if (page === 1) {
          return {
            ok: true,
            json: async () => ({
              status: "1",
              message: "OK",
              result: [
                transaction({ hashByte: "3d", nonce: 15, block: 164, status: 0 }),
                transaction({ hashByte: "3e", nonce: 16, block: 165, status: 1 }),
              ],
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            status: "0",
            message: "NOTOK",
            result: "Invalid API Key",
          }),
        };
      },
    }),
    /invalid transaction response/,
  );
  assert.equal(page, 2);
});

test("merged fallback ranks a qualifying pair above a larger irrelevant history", async () => {
  const failedInput = mintInput(15n, `0x${"35".repeat(65)}`);
  const successfulInput = mintInput(16n, `0x${"36".repeat(65)}`);
  const pairRows = [
    transaction({ hashByte: "39", nonce: 11, block: 160, status: 0, input: failedInput }),
    transaction({ hashByte: "3a", nonce: 12, block: 161, status: 1, input: successfulInput }),
  ];
  const irrelevantRows = Array.from({ length: 20 }, (_, index) => transaction({
    hashByte: (64 + index).toString(16),
    nonce: 30 + index,
    block: 170 + index,
    status: 1,
    input: "0x",
  }));
  const result = await discoverWalletSeaDropPairsResilient({
    ...config(),
    feeRecipient,
    historyFetchers: [
      async () => ({ transactions: pairRows, truncated: true, pages: 2 }),
      async () => ({ transactions: irrelevantRows, truncated: true, pages: 6 }),
    ],
  });

  assert.equal(result.transactions.length, 22);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].failedTransactionHash, `0x${"39".repeat(32)}`);
});

test("two hung default history providers remain inside their combined deadline", async () => {
  const started = performance.now();
  await assert.rejects(
    discoverWalletSeaDropPairsResilient({
      ...config(),
      timeoutMs: 20,
      fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }),
    AggregateError,
  );
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 30, `combined deadline ended too early: ${elapsed}ms`);
  assert.ok(elapsed < 200, `combined deadline exceeded bound: ${elapsed}ms`);
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

function v2Transaction({ hashByte, nonce, block, status }) {
  return {
    hash: `0x${hashByte.repeat(32)}`,
    from: { hash: wallet },
    to: { hash: SEA_DROP_MAINNET },
    nonce,
    block_number: block,
    status,
    result: status === "ok" ? "success" : "reverted",
    raw_input: "0x",
    value: "0",
  };
}
