const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export const RECOVERY_ADAPTERS = Object.freeze([
  Object.freeze({
    id: "seadrop-paid-mint-v1",
    name: "Paid SeaDrop mint",
    source: "Ethereum Mainnet",
    evidence: "Organic mainnet incident",
    availability: "Active campaign",
    role: "primary",
  }),
  Object.freeze({
    id: "universal-router-v2",
    name: "Universal Router swap",
    source: "Ethereum Sepolia",
    evidence: "Founder-operated testnet lab",
    availability: "Archived reference",
    role: "reference-only",
  }),
]);

export const ARCHIVED_UNIVERSAL_ROUTER_CONFIG = Object.freeze({
  enabled: false,
  writesEnabled: false,
  source: Object.freeze({ name: "Ethereum Sepolia", chainId: 11_155_111, chainKey: 1 }),
  settlement: Object.freeze({ name: "Creditcoin Testnet", chainId: 102_031 }),
  creditAmount: "10000000000000000",
  maxSponsoredCredits: 10,
  poolAddress: "0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1",
  failedTransactionHash: "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
  successfulTransactionHash: "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
  releaseTransactionHash: "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
});

export function buildRecoveryCampaignManifest(config) {
  requireObject(config, "recovery configuration");
  requireObject(config.campaign, "campaign");
  requireObject(config.rule, "campaign rule");
  requireObject(config.source, "source network");
  requireObject(config.settlement, "settlement network");

  const manifest = {
    schema: "retrycredit.recovery-campaign/1",
    id: `${requireAddress(config.poolAddress, "recovery pool")}:${requirePositiveInteger(config.campaignNumber, "campaign number")}`,
    adapter: RECOVERY_ADAPTERS[0],
    sponsor: requireAddress(config.campaign.sponsor, "campaign sponsor"),
    source: {
      name: requireText(config.source.name, "source network name"),
      chainId: requirePositiveInteger(config.source.chainId, "source chain ID"),
      chainKey: requirePositiveInteger(config.source.chainKey, "Attestcoin source chain key"),
      startBlock: requirePositiveInteger(config.rule.startBlock, "source start block"),
      endBlock: requirePositiveInteger(config.rule.endBlock, "source end block"),
    },
    settlement: {
      name: requireText(config.settlement.name, "settlement network name"),
      chainId: requirePositiveInteger(config.settlement.chainId, "settlement chain ID"),
      poolAddress: requireAddress(config.poolAddress, "recovery pool"),
      campaignNumber: requirePositiveInteger(config.campaignNumber, "campaign number"),
    },
    authority: {
      contractVersion: requireVersion(config.contractVersion),
      verifierAddress: requireAddress(config.verifierAddress, "pair verifier"),
      predicateAddress: requireAddress(config.predicateAddress, "pair predicate"),
      termsHash: requireHash(config.campaign.termsHash, "campaign terms hash"),
    },
    promise: {
      mode: "retrospective-pilot",
      recoveryBackedBeforeAction: false,
      label: "Funded recovery campaign",
      disclosure: "This pilot was funded after the historical source incident. It proves the recovery mechanism, not a promise shown before those mints.",
    },
    credit: {
      amount: requireUintString(config.campaign.creditAmount, "fixed credit amount"),
      fundedAmount: requireUintString(config.campaign.fundedAmount, "funded reserve"),
      maxClaims: requireNonnegativeInteger(config.campaign.maxClaims, "maximum claims"),
      remainingClaims: requireNonnegativeInteger(config.campaign.remainingClaims, "remaining claims"),
      deadline: requirePositiveInteger(config.campaign.deadline, "campaign deadline"),
      releaseState: requireReleaseState(config.campaign.releaseState),
    },
  };

  return deepFreeze(manifest);
}

export function buildArchivedUniversalRouterManifest(config = ARCHIVED_UNIVERSAL_ROUTER_CONFIG) {
  requireObject(config, "archived recovery configuration");
  requireObject(config.source, "archived source network");
  requireObject(config.settlement, "archived settlement network");
  if (config.enabled !== false || config.writesEnabled !== false) {
    throw new Error("archived Universal Router writes must remain disabled");
  }
  const manifest = {
    schema: "retrycredit.recovery-campaign/1",
    id: `${requireAddress(config.poolAddress, "archived recovery pool")}:archive`,
    adapter: RECOVERY_ADAPTERS[1],
    sponsor: null,
    source: {
      name: requireText(config.source.name, "archived source network name"),
      chainId: requirePositiveInteger(config.source.chainId, "archived source chain ID"),
      chainKey: requirePositiveInteger(config.source.chainKey, "archived Attestcoin source chain key"),
      startBlock: null,
      endBlock: null,
    },
    settlement: {
      name: requireText(config.settlement.name, "archived settlement network name"),
      chainId: requirePositiveInteger(config.settlement.chainId, "archived settlement chain ID"),
      poolAddress: requireAddress(config.poolAddress, "archived recovery pool"),
      campaignNumber: null,
    },
    authority: {
      contractVersion: "archived-universal-router-v2",
      verifierAddress: null,
      predicateAddress: null,
      termsHash: null,
      evidenceTransactions: [
        requireHash(config.failedTransactionHash, "archived failed transaction"),
        requireHash(config.successfulTransactionHash, "archived successful transaction"),
        requireHash(config.releaseTransactionHash, "archived release transaction"),
      ],
    },
    promise: {
      mode: "controlled-lab",
      recoveryBackedBeforeAction: true,
      label: "Archived controlled service credit",
      disclosure: "The service pre-funded and generated this public testnet lifecycle. It proves a second strict adapter, not an organic incident, independent user, or active product promise.",
    },
    credit: {
      amount: requireUintString(config.creditAmount, "archived fixed credit amount"),
      fundedAmount: null,
      maxClaims: requireNonnegativeInteger(config.maxSponsoredCredits, "archived sponsorship cap"),
      remainingClaims: 0,
      deadline: null,
      releaseState: "archived",
    },
  };
  return deepFreeze(manifest);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is required`);
  return value;
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function requireAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value) || /^0x0{40}$/i.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value) || /^0x0{64}$/i.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function requireVersion(value) {
  if (!["v1", "v2"].includes(value)) throw new Error("recovery contract version is invalid");
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function requireNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function requireUintString(value, label) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${label} is invalid`);
  return value;
}

function requireReleaseState(value) {
  if (!["release-unlocked", "continuation-waiting", "closed", "full"].includes(value)) {
    throw new Error("campaign release state is invalid");
  }
  return value;
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object" && !Object.isFrozen(nested)) deepFreeze(nested);
  }
  return value;
}
