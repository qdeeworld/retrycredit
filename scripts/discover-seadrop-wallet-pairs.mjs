import { discoverSeaDropPairs, fetchWalletTransactions } from "../src/seadrop-wallet-discovery.mjs";

const [wallet, startBlockValue, endBlockValue, maxBlockGapValue = "5", maxQuantityValue = "2"] = process.argv.slice(2);
if (!wallet || !startBlockValue || !endBlockValue) {
  throw new Error("usage: node scripts/discover-seadrop-wallet-pairs.mjs <wallet> <startBlock> <endBlock> [maxBlockGap] [maxQuantity]");
}

const options = {
  wallet,
  startBlock: Number(startBlockValue),
  endBlock: Number(endBlockValue),
  maxBlockGap: Number(maxBlockGapValue),
  maxQuantity: Number(maxQuantityValue),
};
const history = await fetchWalletTransactions(options);
const pairs = discoverSeaDropPairs(history.transactions, options);
process.stdout.write(`${JSON.stringify({
  wallet,
  historyRowsInspected: history.transactions.length,
  historyTruncated: history.truncated,
  pagesInspected: history.pages,
  authority: "advisory-discovery-only",
  pairs,
}, null, 2)}\n`);
