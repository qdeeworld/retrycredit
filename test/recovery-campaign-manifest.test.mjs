import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVED_UNIVERSAL_ROUTER_CONFIG,
  buildArchivedUniversalRouterManifest,
  buildRecoveryCampaignManifest,
  RECOVERY_ADAPTERS,
} from "../web/src/recovery-campaign-manifest.mjs";

const ADDRESS = "0x1111111111111111111111111111111111111111";

function config(overrides = {}) {
  const base = {
    contractVersion: "v2",
    poolAddress: ADDRESS,
    verifierAddress: "0x2222222222222222222222222222222222222222",
    predicateAddress: "0x3333333333333333333333333333333333333333",
    campaignNumber: 1,
    source: { name: "Ethereum Mainnet", chainId: 1, chainKey: 3 },
    settlement: { name: "Creditcoin Testnet", chainId: 102031 },
    campaign: {
      sponsor: "0x4444444444444444444444444444444444444444",
      creditAmount: "100000000000000000",
      fundedAmount: "1000000000000000000",
      maxClaims: 10,
      remainingClaims: 10,
      deadline: 2_000_000_000,
      releaseState: "continuation-waiting",
      termsHash: `0x${"5".repeat(64)}`,
    },
    rule: { startBlock: 25_000_000, endBlock: 25_100_000 },
  };
  return {
    ...base,
    ...overrides,
    source: { ...base.source, ...overrides.source },
    settlement: { ...base.settlement, ...overrides.settlement },
    campaign: { ...base.campaign, ...overrides.campaign },
    rule: { ...base.rule, ...overrides.rule },
  };
}

test("builds one immutable manifest from authenticated recovery configuration", () => {
  const manifest = buildRecoveryCampaignManifest(config());
  assert.equal(manifest.id, `${ADDRESS}:1`);
  assert.equal(manifest.adapter.id, "seadrop-paid-mint-v1");
  assert.equal(manifest.promise.recoveryBackedBeforeAction, false);
  assert.match(manifest.promise.disclosure, /funded after the historical source incident/i);
  assert.equal(manifest.source.chainKey, 3);
  assert.equal(manifest.credit.amount, "100000000000000000");
  assert.equal(manifest.authority.contractVersion, "v2");
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.authority), true);
});

test("accepts a canonical source window beginning at genesis", () => {
  const manifest = buildRecoveryCampaignManifest(config({
    rule: { startBlock: 0, endBlock: 1 },
  }));
  assert.equal(manifest.source.startBlock, 0);
  assert.equal(manifest.source.endBlock, 1);
});

test("keeps the organic adapter and controlled lab evidence distinct", () => {
  assert.deepEqual(RECOVERY_ADAPTERS.map(({ role }) => role), ["primary", "reference-only"]);
  assert.match(RECOVERY_ADAPTERS[0].evidence, /Organic mainnet/);
  assert.match(RECOVERY_ADAPTERS[1].evidence, /Founder-operated testnet/);
});

test("normalizes the archived Universal Router lab through the same manifest schema", () => {
  const active = buildRecoveryCampaignManifest(config());
  const archived = buildArchivedUniversalRouterManifest();
  assert.equal(archived.schema, active.schema);
  assert.deepEqual(Object.keys(archived), Object.keys(active));
  assert.equal(archived.adapter.role, "reference-only");
  assert.equal(archived.credit.releaseState, "archived");
  assert.equal(archived.authority.evidenceTransactions.length, 3);
  assert.match(archived.promise.disclosure, /not an organic incident/);
  assert.throws(() => buildArchivedUniversalRouterManifest({
    ...ARCHIVED_UNIVERSAL_ROUTER_CONFIG,
    writesEnabled: true,
  }), /writes must remain disabled/);
});

test("refuses incomplete or mutable-looking authority fields", () => {
  for (const invalid of [
    config({ poolAddress: "0x0" }),
    config({ campaignNumber: 0 }),
    config({ contractVersion: "v3" }),
    config({ campaign: { sponsor: `0x${"0".repeat(40)}` } }),
    config({ campaign: { termsHash: `0x${"0".repeat(64)}` } }),
    config({ campaign: { creditAmount: "0" } }),
    config({ campaign: { releaseState: "unknown" } }),
    config({ rule: { startBlock: -1 } }),
    config({ rule: { endBlock: 0 } }),
  ]) assert.throws(() => buildRecoveryCampaignManifest(invalid));
});
