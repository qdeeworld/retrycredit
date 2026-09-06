import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { recoveryChallengeMessage as serverRecoveryChallengeMessage } from "../src/recovery-campaign-service.mjs";
import {
  canContinueRecoveryAuthorization,
  createPairOperationGuard,
  createWalletOperationGuard,
  isRecoveryConfigReadable,
  isRecoveryChallengeExpired,
  isRecoveryFreshAuthorizationRejected,
  isRecoveryFreshAuthorizationUsed,
  isRecoveryPairInvalid,
  isRecoveryRateLimited,
  isRecoveryResponseMismatch,
  normalizeEthereumTransactionReference,
  recoveryAuthorizationInterruptionFlow,
  recoveryCampaignAvailability,
  recoveryCampaignsMatch,
  recoveryEligibleAccountUpdateFlow,
  recoveryEligibleInspectionFlow,
  recoveryRecordMatchesConfig,
  recoveryConfigsMatch,
  recoveryPairsMatch,
  selectDiscoveryAttribution,
  selectFeaturedRelease,
  selectRecoveryEvidence,
  selectVisibleRelease,
  validateChallengeResponse,
  validateEligibilityResponse,
  validatePairEligibilityResponse,
  validatePairReleaseResponse,
  validateRecoveryPairDraft,
  validateRecoveryConfigResponse,
  validateReleaseResponse,
} from "../web/src/recovery-ui-state.mjs";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const POOL_A = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const POOL_B = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
const VERIFIER = getAddress("0xcccccccccccccccccccccccccccccccccccccccc");
const PREDICATE = getAddress("0xdddddddddddddddddddddddddddddddddddddddd");
const FEE_RECIPIENT = getAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");

function pair(prefix) {
  return {
    failedTransactionHash: `0x${prefix.repeat(64)}`,
    successfulTransactionHash: `0x${String(Number(prefix) + 1).repeat(64)}`,
  };
}

function config(overrides = {}) {
  const base = {
    enabled: true,
    waking: false,
    capabilities: { selfServePairIntake: true },
    consent: {
      scope: "hosted-relayer",
      protocolEnforced: false,
      freshReadAdmission: "anonymous-v1",
    },
    contractVersion: "v1",
    lineage: { scope: "campaign", releasesUnlocked: true, predecessor: null },
    publicOrigin: "https://retrycredit.example",
    poolAddress: POOL_A,
    verifierAddress: VERIFIER,
    predicateAddress: PREDICATE,
    campaignNumber: 7,
    campaign: {
      sponsor: WALLET_B,
      creditAmount: "10",
      maxClaims: 3,
      claimCount: 0,
      remainingClaims: 3,
      deadline: 2_000_000_000,
      fundedAmount: "30",
      termsHash: `0x${"9".repeat(64)}`,
      releaseState: "release-unlocked",
      open: true,
    },
    rule: {
      feeRecipient: FEE_RECIPIENT,
      startBlock: 90,
      endBlock: 110,
      maxBlockGap: 10,
      maxQuantity: 2,
    },
    capacity: { total: 3, claimed: 0, remaining: 3 },
    source: { name: "Ethereum Mainnet", chainId: 1, chainKey: 3 },
    settlement: { name: "Creditcoin Testnet", chainId: 102031 },
    featuredCase: { wallet: WALLET_A, ...pair("1") },
    discoverySize: 3,
  };
  const campaign = { ...base.campaign, ...overrides.campaign };
  if (!Object.hasOwn(overrides.campaign ?? {}, "releaseState")) {
    campaign.releaseState = campaign.claimCount >= campaign.maxClaims
      ? "full"
      : campaign.open
        ? "release-unlocked"
        : "closed";
  }
  return {
    ...base,
    ...overrides,
    campaign,
    rule: { ...base.rule, ...overrides.rule },
    capacity: { ...base.capacity, ...overrides.capacity },
  };
}

function readOnlyConfig(overrides = {}) {
  return {
    ...config(overrides),
    enabled: false,
    readOnly: true,
    readOnlyReason: "isolated-cloudflare-staging",
  };
}

function analyzedPair(prefix = "1") {
  return {
    ...pair(prefix),
    sourceChainId: 1,
    sourceChainKey: 3,
    nftContract: "0x3333333333333333333333333333333333333333",
    quantity: "1",
    mintPriceWei: "1000000000000000",
    valueWei: "1000000000000000",
    failed: { blockNumber: 100, nonce: 9 },
    successful: { blockNumber: 102, nonce: 10, mintedTokenIds: ["42"] },
  };
}

function challengeMessage({ liveConfig, wallet = WALLET_A, sourcePair = pair("1"), issuedAt = 1_000, expiresAt = 1_300 }) {
  return [
    "RetryCredit recovery consent",
    `Origin: ${liveConfig.publicOrigin}`,
    `Settlement: Creditcoin Testnet (${liveConfig.settlement.chainId})`,
    `Recovery pool: ${liveConfig.poolAddress}`,
    `Campaign: ${liveConfig.campaignNumber}`,
    `Source wallet and credit recipient: ${wallet}`,
    `Failed Ethereum transaction: ${sourcePair.failedTransactionHash}`,
    `Successful Ethereum transaction: ${sourcePair.successfulTransactionHash}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
    "Authorize proof and relayer submission for this exact pair. The campaign contract derives the credit recipient from Ethereum; no destination can be substituted.",
  ].join("\n");
}

function claimedResponse(overrides = {}) {
  return {
    eligible: false,
    status: "claimed",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: pair("1"),
    release: {
      transactionHash: `0x${"5".repeat(64)}`,
      blockNumber: 123,
      campaignNumber: 7,
      beneficiary: WALLET_A,
      creditAmount: "10",
      actionId: `0x${"6".repeat(64)}`,
      failureQueryId: `0x${"7".repeat(64)}`,
      successQueryId: `0x${"8".repeat(64)}`,
      pairId: `0x${"a".repeat(64)}`,
      relayer: WALLET_B,
      claimCount: 1,
    },
    lineage: { scope: "campaign", status: "claimed-current" },
    ...overrides,
  };
}

function v2Config(overrides = {}) {
  const predecessor = {
    poolAddress: POOL_B,
    campaignNumber: 1,
    sponsor: WALLET_B,
    termsHash: `0x${"8".repeat(64)}`,
    deadline: 1_900_000_000,
    startBlock: 95,
    endBlock: 105,
  };
  const releasesUnlocked = overrides.lineage?.releasesUnlocked ?? true;
  return config({
    ...overrides,
    contractVersion: "v2",
    campaign: {
      ...overrides.campaign,
      open: overrides.campaign?.open ?? releasesUnlocked,
      releaseState: overrides.campaign?.releaseState
        ?? (releasesUnlocked ? "release-unlocked" : "continuation-waiting"),
    },
    lineage: {
      scope: "sponsor",
      releasesUnlocked: true,
      predecessor,
      ...overrides.lineage,
    },
  });
}

test("active wallet evidence never borrows the featured wallet release", () => {
  const walletPair = pair("1");
  const featuredPair = pair("3");
  const evidence = selectRecoveryEvidence({
    eligibility: { wallet: WALLET_A, pair: walletPair, release: null, creditAmount: "10" },
    releaseResult: null,
    featuredEligibility: {
      wallet: WALLET_B,
      pair: featuredPair,
      release: { transactionHash: `0x${"5".repeat(64)}` },
      creditAmount: "10",
    },
    featuredCase: { wallet: WALLET_B, ...featuredPair },
  });

  assert.equal(evidence.wallet, WALLET_A);
  assert.equal(evidence.pair, walletPair);
  assert.equal(evidence.release, null);
  assert.equal(evidence.source, "wallet");
});

test("a not-found wallet result renders no pair, source, or featured release claim", () => {
  const featuredPair = pair("3");
  const evidence = selectRecoveryEvidence({
    eligibility: { wallet: WALLET_A, status: "not-found", pair: null, release: null },
    releaseResult: null,
    featuredEligibility: {
      wallet: WALLET_B,
      pair: featuredPair,
      release: { transactionHash: `0x${"5".repeat(64)}` },
    },
    featuredCase: { wallet: WALLET_B, ...featuredPair },
  });

  assert.equal(evidence.wallet, null);
  assert.equal(evidence.pair, null);
  assert.equal(evidence.release, null);
  assert.equal(evidence.source, "wallet");
});

test("account changes and newer operations invalidate stale wallet completions", () => {
  const guard = createWalletOperationGuard(WALLET_A);
  const first = guard.begin(WALLET_A);
  assert.equal(guard.isCurrent(first), true);

  guard.setAccount(WALLET_B);
  assert.equal(guard.isCurrent(first), false);

  const second = guard.begin(WALLET_B);
  const third = guard.begin(WALLET_B);
  assert.equal(guard.isCurrent(second), false);
  assert.equal(guard.isCurrent(third), true);
});

test("pair intake accepts only hashes or canonical Ethereum-mainnet Etherscan URLs", () => {
  const sourcePair = pair("1");
  assert.equal(
    normalizeEthereumTransactionReference(sourcePair.failedTransactionHash.toUpperCase().replace("0X", "0x")),
    sourcePair.failedTransactionHash,
  );
  assert.equal(
    normalizeEthereumTransactionReference(`https://etherscan.io/tx/${sourcePair.successfulTransactionHash}`),
    sourcePair.successfulTransactionHash,
  );

  for (const invalid of [
    "",
    "0x1234",
    `http://etherscan.io/tx/${sourcePair.failedTransactionHash}`,
    `https://etherscan.io:443/tx/${sourcePair.failedTransactionHash}`,
    `https://sepolia.etherscan.io/tx/${sourcePair.failedTransactionHash}`,
    `https://etherscan.io/tx/${sourcePair.failedTransactionHash}?utm_source=test`,
    `https://etherscan.io/address/${sourcePair.failedTransactionHash}`,
  ]) {
    assert.throws(
      () => normalizeEthereumTransactionReference(invalid),
      (error) => error.code === "RECOVERY_PAIR_INPUT_INVALID",
    );
  }
});

test("pair draft validation preserves order and rejects duplicate transactions", () => {
  const sourcePair = pair("1");
  const valid = validateRecoveryPairDraft({
    failedTransactionHash: ` https://etherscan.io/tx/${sourcePair.failedTransactionHash} `,
    successfulTransactionHash: sourcePair.successfulTransactionHash.toUpperCase().replace("0X", "0x"),
  });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.pair, sourcePair);
  assert.equal(recoveryPairsMatch(valid.pair, sourcePair), true);

  const duplicate = validateRecoveryPairDraft({
    failedTransactionHash: sourcePair.failedTransactionHash,
    successfulTransactionHash: sourcePair.failedTransactionHash,
  });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors.successfulTransactionHash, /different transaction/);
});

test("pair edits and newer operations invalidate stale pair completions", () => {
  const guard = createPairOperationGuard();
  const firstPair = pair("1");
  const first = guard.begin(firstPair);
  assert.equal(guard.isCurrent(first, firstPair), true);

  guard.invalidate();
  assert.equal(guard.isCurrent(first, firstPair), false);

  const secondPair = pair("3");
  const second = guard.begin(secondPair);
  const third = guard.begin(secondPair);
  assert.equal(guard.isCurrent(second), false);
  assert.equal(guard.isCurrent(third, secondPair), true);
  assert.equal(guard.isCurrent(third, firstPair), false);
});

test("intake error classes stay distinct for semantic mismatch and capacity pressure", () => {
  assert.equal(isRecoveryPairInvalid({ status: 422, code: "RECOVERY_PAIR_INVALID" }), true);
  assert.equal(isRecoveryPairInvalid({ status: 422, code: "RECOVERY_PAIR_WALLET_MISMATCH" }), false);
  assert.equal(isRecoveryRateLimited({ status: 429, code: "RECOVERY_BUSY" }), true);
  assert.equal(isRecoveryRateLimited({ status: 503, code: "RECOVERY_SOURCE_TIMEOUT" }), false);
});

test("a completed old-wallet receipt is retained but hidden from the new account", () => {
  const completed = {
    wallet: WALLET_A,
    pair: pair("1"),
    release: { transactionHash: `0x${"5".repeat(64)}` },
    creditAmount: "10",
  };

  assert.equal(selectVisibleRelease({ account: WALLET_B, releaseResult: completed, eligibility: null }), null);
  assert.equal(
    selectVisibleRelease({ account: WALLET_A.toUpperCase(), releaseResult: completed, eligibility: null }),
    completed,
  );
});

test("an eligibility receipt must also match the connected wallet", () => {
  const eligibility = {
    wallet: WALLET_A,
    pair: pair("1"),
    release: { transactionHash: `0x${"5".repeat(64)}` },
  };

  assert.equal(selectVisibleRelease({ account: WALLET_B, releaseResult: null, eligibility }), null);
  assert.equal(selectVisibleRelease({ account: WALLET_A, releaseResult: null, eligibility })?.status, "claimed");
});

test("only the server challenge-expiry code returns authorization to the eligible step", () => {
  assert.equal(isRecoveryChallengeExpired({ code: "RECOVERY_CHALLENGE_EXPIRED" }), true);
  assert.equal(isRecoveryChallengeExpired({ code: "RECOVERY_ATTESTATION_PENDING" }), false);
  assert.equal(isRecoveryChallengeExpired(new Error("expired")), false);
});

test("fresh authorization safety branches require the exact status and code", () => {
  assert.equal(isRecoveryFreshAuthorizationUsed({
    status: 409,
    code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
  }), true);
  assert.equal(isRecoveryFreshAuthorizationUsed({
    status: 409,
    code: "RECOVERY_PAIR_USED",
  }), false);
  assert.equal(isRecoveryFreshAuthorizationUsed({
    status: 401,
    code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
  }), false);

  for (const code of [
    "RECOVERY_FRESH_AUTHORIZATION_REQUIRED",
    "RECOVERY_FRESH_AUTHORIZATION_INVALID",
  ]) {
    assert.equal(isRecoveryFreshAuthorizationRejected({ status: 401, code }), true);
    assert.equal(isRecoveryFreshAuthorizationRejected({ status: 409, code }), false);
  }
  assert.equal(isRecoveryFreshAuthorizationRejected({
    status: 401,
    code: "RECOVERY_CHALLENGE_EXPIRED",
  }), false);
});

test("only response-identity mismatches trigger a live config refresh", () => {
  assert.equal(isRecoveryResponseMismatch({ code: "RECOVERY_RESPONSE_MISMATCH" }), true);
  assert.equal(isRecoveryResponseMismatch({ code: "RECOVERY_CHALLENGE_EXPIRED" }), false);
  assert.equal(isRecoveryResponseMismatch(new Error("different campaign")), false);
});

test("eligibility is bound to the requested wallet, configured campaign, and featured pair", () => {
  const liveConfig = validateRecoveryConfigResponse(config());
  const response = claimedResponse();
  const validated = validateEligibilityResponse({
    response,
    requestedWallet: WALLET_A,
    config: liveConfig,
    expectedPair: liveConfig.featuredCase,
  });

  assert.deepEqual(validated.recoveryBoundary, { poolAddress: POOL_A.toLowerCase(), campaignNumber: 7 });
  assert.equal(validated.release.transactionHash, response.release.transactionHash);
  assert.equal(recoveryConfigsMatch(liveConfig, { ...liveConfig }), true);
  assert.equal(recoveryConfigsMatch(liveConfig, config({ poolAddress: POOL_B })), false);
  assert.equal(recoveryConfigsMatch(liveConfig, config({ campaignNumber: 8 })), false);
  assert.equal(recoveryConfigsMatch(liveConfig, config({
    featuredCase: { wallet: WALLET_B, ...pair("3") },
  })), false);
});

test("ready config requires a canonical origin, campaign amount, settlement, and featured identity", () => {
  assert.equal(validateRecoveryConfigResponse(config()).publicOrigin, "https://retrycredit.example");
  for (const response of [
    config({ publicOrigin: "https://retrycredit.example/path" }),
    config({ poolAddress: "0x1234" }),
    config({ campaignNumber: "7" }),
    config({ campaign: { creditAmount: "0" } }),
    config({ campaign: { creditAmount: 10 } }),
    config({ campaign: { creditAmount: "10", open: "true" } }),
    config({ campaign: { releaseState: "unknown" } }),
    config({ campaign: { releaseState: "closed", open: true } }),
    config({ campaign: { releaseState: "full", open: false } }),
    config({ verifierAddress: "0x1234" }),
    config({ predicateAddress: "0x1234" }),
    config({ campaign: { sponsor: "0x1234" } }),
    config({ campaign: { fundedAmount: "29" } }),
    config({ campaign: { termsHash: "0x01" } }),
    config({ campaign: { termsHash: `0x${"0".repeat(64)}` } }),
    config({ campaign: { maxClaims: 4 } }),
    config({ rule: { feeRecipient: "0x1234" } }),
    config({ rule: { endBlock: 89 } }),
    config({ rule: { endBlock: 90 } }),
    config({ rule: { maxBlockGap: 0 } }),
    config({ rule: { maxBlockGap: 1_001 } }),
    config({ rule: { maxQuantity: 0 } }),
    config({ capacity: { total: 3, claimed: 1, remaining: 3 } }),
    config({ campaign: { creditAmount: "10", open: true }, capacity: { total: 3, claimed: 3, remaining: 0 } }),
    config({ source: { chainId: "1", chainKey: 3 } }),
    config({ settlement: { chainId: 0 } }),
    config({ contractVersion: "v3" }),
    config({ lineage: { scope: "sponsor", releasesUnlocked: true, predecessor: null } }),
    config({ lineage: { scope: "campaign", releasesUnlocked: false, predecessor: null } }),
    config({ capabilities: { selfServePairIntake: false } }),
    config({ consent: {
      scope: "hosted-relayer",
      protocolEnforced: true,
      freshReadAdmission: "anonymous-v1",
    } }),
    config({ consent: { scope: "hosted-relayer", protocolEnforced: false } }),
    config({ consent: {
      scope: "hosted-relayer",
      protocolEnforced: false,
      freshReadAdmission: "unknown-v1",
    } }),
    config({ featuredCase: { wallet: WALLET_A, failedTransactionHash: "0x01", successfulTransactionHash: "0x02" } }),
    { ...config(), enabled: "true" },
    { ...config(), enabled: 1 },
    { ...config(), enabled: null },
    Object.fromEntries(Object.entries(config()).filter(([key]) => key !== "enabled")),
    Object.fromEntries(Object.entries(config()).filter(([key]) => key !== "contractVersion")),
    Object.fromEntries(Object.entries(config()).filter(([key]) => key !== "lineage")),
    {
      ...config(),
      campaign: Object.fromEntries(
        Object.entries(config().campaign).filter(([key]) => key !== "releaseState"),
      ),
    },
  ]) {
    assert.throws(
      () => validateRecoveryConfigResponse(response),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }

  const disabled = {
    enabled: false,
    waking: false,
    capabilities: { selfServePairIntake: true, walletNativeDiscovery: true },
    consent: {
      scope: "hosted-relayer",
      protocolEnforced: false,
      freshReadAdmission: "anonymous-v1",
    },
    publicOrigin: null,
    poolAddress: null,
    campaignNumber: null,
    campaign: null,
    rule: null,
    capacity: null,
    source: { name: "Ethereum Mainnet", chainId: 1, chainKey: 3 },
    settlement: { name: "Creditcoin Testnet", chainId: 102031 },
    featuredCase: { wallet: WALLET_A, ...pair("1") },
  };
  assert.equal(validateRecoveryConfigResponse(disabled).enabled, false);
});

test("a fully claimed campaign remains a valid closed state after its deadline", () => {
  const closed = validateRecoveryConfigResponse(config({
    campaign: {
      claimCount: 3,
      remainingClaims: 0,
      deadline: Math.floor(Date.now() / 1_000) - 1,
      releaseState: "closed",
      open: false,
    },
    capacity: { total: 3, claimed: 3, remaining: 0 },
  }));

  assert.equal(closed.campaign.releaseState, "closed");
  assert.equal(recoveryCampaignAvailability(closed), "closed");
});

test("provider-neutral isolated staging is readable but cannot authorize release", () => {
  const isolated = validateRecoveryConfigResponse(readOnlyConfig({ readOnlyReason: "isolated-readonly-staging" }));
  assert.equal(isolated.enabled, false);
  assert.equal(isRecoveryConfigReadable(isolated), true);
  assert.equal(canContinueRecoveryAuthorization({ operationCurrent: true, initialConfig: isolated, currentConfig: isolated }), false);
  assert.throws(() => validateRecoveryConfigResponse({ ...isolated, enabled: true }), isRecoveryResponseMismatch);
});

test("read-only staging preserves authenticated inspection without enabling release", () => {
  const readOnly = validateRecoveryConfigResponse(readOnlyConfig());
  const eligibilityResponse = {
    eligible: true,
    status: "eligible",
    reason: "This pair qualifies.",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: analyzedPair("1"),
    release: null,
    lineage: { scope: "campaign", status: "unused" },
  };
  const inspected = validatePairEligibilityResponse({
    response: eligibilityResponse,
    requestedPair: pair("1"),
    config: readOnly,
  });

  assert.equal(readOnly.enabled, false);
  assert.equal(readOnly.readOnly, true);
  assert.equal(isRecoveryConfigReadable(readOnly), true);
  assert.equal(recoveryCampaignAvailability(readOnly), "open");
  assert.equal(isRecoveryConfigReadable({ enabled: false }), false);
  assert.equal(inspected.eligible, true);
  assert.equal(recoveryRecordMatchesConfig(inspected, readOnly), true);
  assert.equal(recoveryCampaignsMatch(readOnly, validateRecoveryConfigResponse(config())), false);

  const challenge = {
    wallet: WALLET_A,
    poolAddress: POOL_A,
    campaignNumber: 7,
    pair: inspected.pair,
    issuedAt: 1_000,
    expiresAt: 1_300,
    message: challengeMessage({ liveConfig: readOnly, sourcePair: inspected.pair }),
  };
  const released = {
    status: "released",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: inspected.pair,
    release: claimedResponse().release,
    lineage: { scope: "campaign", status: "claimed-current" },
  };
  const live = validateRecoveryConfigResponse(config());
  const liveInspected = validatePairEligibilityResponse({
    response: eligibilityResponse,
    requestedPair: pair("1"),
    config: live,
  });
  assert.equal(validateChallengeResponse({
    response: challenge,
    wallet: WALLET_A,
    eligibility: liveInspected,
    config: live,
    currentOrigin: live.publicOrigin,
  }), challenge);
  assert.equal(validateReleaseResponse({
    response: released,
    wallet: WALLET_A,
    eligibility: liveInspected,
    config: live,
  }).status, "released");
  assert.equal(validatePairReleaseResponse({
    response: released,
    wallet: WALLET_A,
    eligibility: liveInspected,
    config: live,
  }).status, "released");
  for (const validateWriteResponse of [
    () => validateChallengeResponse({
      response: challenge,
      wallet: WALLET_A,
      eligibility: inspected,
      config: readOnly,
      currentOrigin: readOnly.publicOrigin,
    }),
    () => validateReleaseResponse({
      response: released,
      wallet: WALLET_A,
      eligibility: inspected,
      config: readOnly,
    }),
    () => validatePairReleaseResponse({
      response: released,
      wallet: WALLET_A,
      eligibility: inspected,
      config: readOnly,
    }),
  ]) {
    assert.throws(
      validateWriteResponse,
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }

  for (const invalid of [
    { ...readOnlyConfig(), enabled: true },
    { ...readOnlyConfig(), readOnly: "true" },
    { ...readOnlyConfig(), readOnlyReason: "operator-preview" },
  ]) {
    assert.throws(
      () => validateRecoveryConfigResponse(invalid),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("a mode or availability switch stops a deferred authorization before signing or release", async () => {
  const initialConfig = validateRecoveryConfigResponse(config());
  assert.equal(canContinueRecoveryAuthorization({
    operationCurrent: true,
    initialConfig,
    currentConfig: validateRecoveryConfigResponse(config()),
  }), true);
  const transitions = [
    ["read-only", "campaign-changed", validateRecoveryConfigResponse(readOnlyConfig())],
    ["capacity changed", "campaign-changed", validateRecoveryConfigResponse(config({
      campaign: { claimCount: 1, remainingClaims: 2 },
      capacity: { claimed: 1, remaining: 2 },
    }))],
    ["deadline changed", "campaign-changed", validateRecoveryConfigResponse(config({
      campaign: { deadline: 2_000_000_100 },
    }))],
    ["fresh admission changed", "campaign-changed", validateRecoveryConfigResponse(config({
      consent: {
        scope: "hosted-relayer",
        protocolEnforced: false,
        freshReadAdmission: "pair-signature-v1",
      },
    }))],
    ["closed", "campaign-closed", validateRecoveryConfigResponse(config({
      campaign: { open: false, releaseState: "closed" },
    }))],
    ["full", "campaign-full", validateRecoveryConfigResponse(config({
      campaign: { claimCount: 3, remainingClaims: 0, open: false, releaseState: "full" },
      capacity: { claimed: 3, remaining: 0 },
    }))],
    ["expired", "campaign-closed", validateRecoveryConfigResponse(config({
      campaign: { deadline: 1 },
    }))],
  ];

  for (const [label, expectedFlow, transitionedConfig] of transitions) {
    let currentConfig = initialConfig;
    let resolveChallenge;
    const challenge = new Promise((resolve) => {
      resolveChallenge = resolve;
    });
    let personalSignCalls = 0;
    let releaseCalls = 0;

    const authorization = (async () => {
      await challenge;
      if (!canContinueRecoveryAuthorization({
        operationCurrent: true,
        initialConfig,
        currentConfig,
      })) return;
      personalSignCalls += 1;
      releaseCalls += 1;
    })();

    currentConfig = transitionedConfig;
    resolveChallenge();
    await authorization;

    assert.equal(personalSignCalls, 0, `${label} transition must not request personal_sign`);
    assert.equal(releaseCalls, 0, `${label} transition must not request release`);
    assert.equal(recoveryAuthorizationInterruptionFlow({
      operationCurrent: true,
      currentConfig: transitionedConfig,
    }), expectedFlow);
  }

  const postSignatureCases = [
    ["unchanged", null, initialConfig, initialConfig, true, 1, true, true],
    ...transitions.map(([label, expectedFlow, transitionedConfig]) => [
      label,
      expectedFlow,
      transitionedConfig,
      transitionedConfig,
      true,
      0,
      false,
      false,
    ]),
    ["account changed", null, initialConfig, initialConfig, false, 0, false, false],
    ["authorization expired after fresh fetch", null, initialConfig, initialConfig, true, 1, true, false],
  ];
  for (const [
    label,
    expectedFlow,
    configAfterSignature,
    freshConfig,
    operationCurrent,
    expectedFreshConfigCalls,
    authorizationContinues,
    submissionStarts,
  ] of postSignatureCases) {
    let resolveSignature;
    const signature = new Promise((resolve) => {
      resolveSignature = resolve;
    });
    let personalSignCalls = 0;
    let freshConfigCalls = 0;
    let submittedAtWrites = 0;
    let proofQueuedWrites = 0;
    let releaseSubmittedWrites = 0;
    let persistenceCalls = 0;
    let releaseCalls = 0;
    let interruptionFlow = null;
    const fetchFreshConfig = async () => {
      freshConfigCalls += 1;
      return freshConfig;
    };

    const authorization = (async () => {
      if (!canContinueRecoveryAuthorization({
        operationCurrent: true,
        initialConfig,
        currentConfig: initialConfig,
      })) return;
      personalSignCalls += 1;
      await signature;
      if (!canContinueRecoveryAuthorization({
        operationCurrent,
        initialConfig,
        currentConfig: configAfterSignature,
      })) {
        interruptionFlow = recoveryAuthorizationInterruptionFlow({
          operationCurrent,
          currentConfig: configAfterSignature,
        });
        return;
      }
      const currentConfig = await fetchFreshConfig();
      if (!canContinueRecoveryAuthorization({
        operationCurrent,
        initialConfig,
        currentConfig,
      })) {
        interruptionFlow = recoveryAuthorizationInterruptionFlow({
          operationCurrent,
          currentConfig,
        });
        return;
      }
      if (!submissionStarts) return;
      const onSubmitting = () => {
        submittedAtWrites += 1;
        proofQueuedWrites += 1;
        releaseSubmittedWrites += 1;
        persistenceCalls += 1;
      };
      onSubmitting();
      releaseCalls += 1;
    })();

    resolveSignature();
    await authorization;

    assert.equal(personalSignCalls, 1, `${label} transition occurs while personal_sign is pending`);
    assert.equal(
      freshConfigCalls,
      expectedFreshConfigCalls,
      `${label} transition must not start a stale fresh campaign read`,
    );
    assert.equal(
      canContinueRecoveryAuthorization({ operationCurrent, initialConfig, currentConfig: freshConfig }),
      authorizationContinues,
      `${label} post-sign authorization gate`,
    );
    const expectedWrites = submissionStarts ? 1 : 0;
    assert.equal(submittedAtWrites, expectedWrites, `${label} submitted-at marker`);
    assert.equal(proofQueuedWrites, expectedWrites, `${label} proof-queued marker`);
    assert.equal(releaseSubmittedWrites, expectedWrites, `${label} release-submitted marker`);
    assert.equal(persistenceCalls, expectedWrites, `${label} persistence`);
    assert.equal(releaseCalls, expectedWrites, `${label} release request`);
    assert.equal(interruptionFlow, expectedFlow, `${label} transition must leave the busy flow`);
  }
  assert.equal(recoveryAuthorizationInterruptionFlow({
    operationCurrent: false,
    currentConfig: initialConfig,
  }), null);
});

test("read-only inspection never requires the source wallet while write mode does", () => {
  assert.equal(recoveryEligibleInspectionFlow({
    config: validateRecoveryConfigResponse(readOnlyConfig()),
    connectedAccount: WALLET_B,
    sourceWallet: WALLET_A,
  }), "qualifying");
  assert.equal(recoveryEligibleInspectionFlow({
    config: validateRecoveryConfigResponse(config()),
    connectedAccount: WALLET_B,
    sourceWallet: WALLET_A,
  }), "wrong-wallet");
  assert.equal(recoveryEligibleInspectionFlow({
    config: validateRecoveryConfigResponse(config()),
    connectedAccount: "",
    sourceWallet: WALLET_A,
  }), "qualifying");
});

test("eligible account updates preserve inspection and interrupt only active write authorization", () => {
  const cases = [
    {
      label: "delayed eth_accounts in read-only mode",
      config: validateRecoveryConfigResponse(readOnlyConfig()),
      currentFlow: "qualifying",
      externalChange: false,
      previousAccount: "",
      expected: "qualifying",
    },
    {
      label: "accountsChanged in read-only mode",
      config: validateRecoveryConfigResponse(readOnlyConfig()),
      currentFlow: "qualifying",
      externalChange: true,
      previousAccount: WALLET_A,
      expected: "qualifying",
    },
    {
      label: "accountsChanged during write authorization",
      config: validateRecoveryConfigResponse(config()),
      currentFlow: "authorization-requested",
      externalChange: true,
      previousAccount: WALLET_A,
      expected: "account-changed",
    },
    {
      label: "wallet disconnect during write authorization",
      config: validateRecoveryConfigResponse(config()),
      connectedAccount: "",
      currentFlow: "authorization-requested",
      externalChange: true,
      previousAccount: WALLET_A,
      expected: "account-changed",
    },
    {
      label: "wrong wallet during ordinary write inspection",
      config: validateRecoveryConfigResponse(config()),
      currentFlow: "qualifying",
      externalChange: true,
      previousAccount: WALLET_A,
      expected: "wrong-wallet",
    },
  ];

  for (const row of cases) {
    assert.equal(recoveryEligibleAccountUpdateFlow({
      config: row.config,
      connectedAccount: row.connectedAccount ?? WALLET_B,
      sourceWallet: WALLET_A,
      currentFlow: row.currentFlow,
      externalChange: row.externalChange,
      previousAccount: row.previousAccount,
    }), row.expected, row.label);
  }
});

test("discovery attribution allows only the exact RouteScan identity", () => {
  const exact = {
    label: "Powered by Routescan.io APIs",
    url: "https://routescan.io/",
  };
  assert.deepEqual(selectDiscoveryAttribution(exact), exact);
  assert.equal(selectDiscoveryAttribution(null), null);
  assert.equal(selectDiscoveryAttribution({ ...exact, label: "Explorer data" }), null);
  assert.equal(selectDiscoveryAttribution({ ...exact, url: "javascript:alert(1)" }), null);
  assert.equal(selectDiscoveryAttribution({ ...exact, url: "https://routescan.io.example/" }), null);
});

test("campaign availability fails closed from the live open flag and remaining capacity", () => {
  assert.equal(recoveryCampaignAvailability(validateRecoveryConfigResponse(config())), "open");
  assert.equal(recoveryCampaignAvailability(validateRecoveryConfigResponse(config({
    campaign: { deadline: Math.floor(Date.now() / 1_000) - 1, open: true },
  }))), "closed");
  assert.equal(recoveryCampaignAvailability(validateRecoveryConfigResponse(config({
    campaign: { creditAmount: "10", open: false },
  }))), "closed");
  assert.equal(recoveryCampaignAvailability(validateRecoveryConfigResponse(config({
    campaign: { creditAmount: "10", claimCount: 3, remainingClaims: 0, open: false },
    capacity: { total: 3, claimed: 3, remaining: 0 },
  }))), "full");
  assert.equal(recoveryCampaignAvailability(null), "unavailable");
});

test("lineage-aware configuration exposes a distinct predecessor-waiting state", () => {
  const waiting = validateRecoveryConfigResponse(v2Config({
    campaign: { open: false },
    lineage: { releasesUnlocked: false },
  }));
  assert.equal(recoveryCampaignAvailability(waiting), "continuation-waiting");
  assert.equal(waiting.lineage.predecessor.poolAddress, POOL_B);

  const unlocked = validateRecoveryConfigResponse(v2Config());
  assert.equal(recoveryCampaignAvailability(unlocked), "open");
  assert.equal(recoveryCampaignsMatch(waiting, unlocked), false);

  for (const invalid of [
    v2Config({ lineage: { predecessor: null } }),
    v2Config({ lineage: { scope: "campaign" } }),
    v2Config({ lineage: { predecessor: { poolAddress: POOL_A } } }),
    v2Config({ lineage: { predecessor: { sponsor: WALLET_A } } }),
    v2Config({ lineage: { predecessor: { termsHash: `0x${"0".repeat(64)}` } } }),
    v2Config({ lineage: { predecessor: { deadline: 2_000_000_000 } } }),
    v2Config({ lineage: { predecessor: { startBlock: 89 } } }),
    v2Config({ lineage: { predecessor: { endBlock: 111 } } }),
    v2Config({ campaign: { open: true }, lineage: { releasesUnlocked: false } }),
  ]) {
    assert.throws(
      () => validateRecoveryConfigResponse(invalid),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("lineage eligibility distinguishes unused, predecessor, and sponsor history", () => {
  const liveConfig = validateRecoveryConfigResponse(v2Config({
    campaign: { open: false },
    lineage: { releasesUnlocked: false },
  }));
  const sourcePair = analyzedPair("1");
  const base = {
    eligible: false,
    status: "continuation-waiting",
    reason: "The funded continuation is waiting for its predecessor.",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: sourcePair,
    release: null,
    lineage: { scope: "sponsor", status: "unused" },
  };
  const waiting = validatePairEligibilityResponse({
    response: base,
    requestedPair: pair("1"),
    config: liveConfig,
  });
  assert.equal(waiting.status, "continuation-waiting");

  for (const status of ["claimed-predecessor", "claimed-sponsor"]) {
    const historical = validatePairEligibilityResponse({
      response: {
        ...base,
        status: "claimed",
        reason: "This source wallet already recovered in sponsor-bound history.",
        lineage: { scope: "sponsor", status },
      },
      requestedPair: pair("1"),
      config: liveConfig,
    });
    assert.equal(historical.lineage.status, status);
    assert.equal(historical.release, null);
  }

  for (const mismatch of [
    { ...base, lineage: { scope: "campaign", status: "unused" } },
    { ...base, lineage: { scope: "sponsor", status: "claimed-current" } },
    { ...base, status: "claimed", lineage: { scope: "sponsor", status: "unused" } },
    { ...base, lineage: { scope: "sponsor", status: "unknown" } },
  ]) {
    assert.throws(
      () => validatePairEligibilityResponse({ response: mismatch, requestedPair: pair("1"), config: liveConfig }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("open-pair eligibility is bound to the submitted pair and live-derived facts", () => {
  const liveConfig = validateRecoveryConfigResponse(config());
  const sourcePair = analyzedPair("1");
  const response = {
    eligible: true,
    status: "eligible",
    reason: "This pair qualifies.",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: sourcePair,
    release: null,
    lineage: { scope: "campaign", status: "unused" },
  };
  const validated = validatePairEligibilityResponse({
    response,
    requestedPair: pair("1"),
    config: liveConfig,
  });

  assert.equal(validated.wallet, WALLET_A);
  assert.equal(validated.pair.failed.blockNumber, 100);
  assert.equal(recoveryRecordMatchesConfig(validated, liveConfig), true);

  const processing = validatePairEligibilityResponse({
    response: { ...response, eligible: false, status: "processing" },
    requestedPair: pair("1"),
    config: liveConfig,
  });
  assert.equal(processing.status, "processing");
  assert.equal(processing.eligible, false);

  for (const mismatch of [
    { ...response, wallet: "0x0000000000000000000000000000000000000000" },
    { ...response, pair: analyzedPair("3") },
    { ...response, pair: { ...sourcePair, sourceChainKey: 4 } },
    { ...response, pair: { ...sourcePair, successful: { ...sourcePair.successful, nonce: 11 } } },
    { ...response, pair: { ...sourcePair, successful: { ...sourcePair.successful, mintedTokenIds: [] } } },
    { ...response, pair: { ...sourcePair, valueWei: "999" } },
    { ...response, pair: { ...sourcePair, quantity: "3", valueWei: "3000000000000000", successful: { ...sourcePair.successful, mintedTokenIds: ["40", "41", "42"] } } },
    { ...response, pair: { ...sourcePair, successful: { ...sourcePair.successful, blockNumber: 111 } } },
    { ...response, pair: { ...sourcePair, successful: { ...sourcePair.successful, mintedTokenIds: ["42", "42"] }, quantity: "2", valueWei: "2000000000000000" } },
    { ...response, eligible: false },
  ]) {
    assert.throws(
      () => validatePairEligibilityResponse({ response: mismatch, requestedPair: pair("1"), config: liveConfig }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("eligibility rejects wallet, campaign, pair, and release identity mismatches", () => {
  const liveConfig = config();
  const attempts = [
    claimedResponse({ wallet: WALLET_B }),
    claimedResponse({ campaignNumber: 8 }),
    claimedResponse({ pair: pair("3") }),
    claimedResponse({ release: { ...claimedResponse().release, beneficiary: WALLET_B } }),
  ];

  for (const response of attempts) {
    assert.throws(
      () => validateEligibilityResponse({
        response,
        requestedWallet: WALLET_A,
        config: liveConfig,
        expectedPair: liveConfig.featuredCase,
      }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("challenge validation accepts only the exact canonical five-minute consent", () => {
  const liveConfig = validateRecoveryConfigResponse(config());
  const eligibility = validateEligibilityResponse({
    response: {
      ...claimedResponse(),
      eligible: true,
      status: "eligible",
      release: null,
      lineage: { scope: "campaign", status: "unused" },
    },
    requestedWallet: WALLET_A,
    config: liveConfig,
  });
  const challenge = {
    wallet: WALLET_A,
    poolAddress: POOL_A,
    campaignNumber: 7,
    pair: pair("1"),
    message: challengeMessage({ liveConfig }),
    issuedAt: 1_000,
    expiresAt: 1_300,
  };
  assert.equal(challenge.message, serverRecoveryChallengeMessage({
    origin: liveConfig.publicOrigin,
    poolAddress: liveConfig.poolAddress,
    campaignNumber: liveConfig.campaignNumber,
    wallet: WALLET_A,
    failedTransactionHash: challenge.pair.failedTransactionHash,
    successfulTransactionHash: challenge.pair.successfulTransactionHash,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  }));

  assert.equal(validateChallengeResponse({
    response: challenge,
    wallet: WALLET_A,
    eligibility,
    config: liveConfig,
    currentOrigin: liveConfig.publicOrigin,
  }), challenge);

  for (const response of [
    { ...challenge, wallet: WALLET_B },
    { ...challenge, poolAddress: POOL_B },
    { ...challenge, campaignNumber: 8 },
    { ...challenge, pair: pair("3") },
    { ...challenge, message: "Sign into unrelated.example" },
    { ...challenge, message: challenge.message.replace("Origin: https://retrycredit.example", "Origin: https://unrelated.example") },
    { ...challenge, message: challenge.message.replace("no destination can be substituted.", "send access elsewhere.") },
    { ...challenge, issuedAt: 999 },
    { ...challenge, expiresAt: 1_301 },
    {
      ...challenge,
      issuedAt: 0,
      expiresAt: 300,
      message: challengeMessage({ liveConfig, issuedAt: 0, expiresAt: 300 }),
    },
    {
      ...challenge,
      issuedAt: -1_000,
      expiresAt: -700,
      message: challengeMessage({ liveConfig, issuedAt: -1_000, expiresAt: -700 }),
    },
  ]) {
    assert.throws(
      () => validateChallengeResponse({
        response,
        wallet: WALLET_A,
        eligibility,
        config: liveConfig,
        currentOrigin: liveConfig.publicOrigin,
      }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
  assert.throws(
    () => validateChallengeResponse({
      response: challenge,
      wallet: WALLET_A,
      eligibility,
      config: liveConfig,
      currentOrigin: "https://preview.pages.dev",
    }),
    (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
  );

  const signedConfig = validateRecoveryConfigResponse(config({
    consent: {
      scope: "hosted-relayer",
      protocolEnforced: false,
      freshReadAdmission: "pair-signature-v1",
    },
  }));
  const signedChallenge = {
    ...challenge,
    freshReadReceipt: "v1." + "A".repeat(43),
  };
  assert.equal(validateChallengeResponse({
    response: signedChallenge,
    wallet: WALLET_A,
    eligibility,
    config: signedConfig,
    currentOrigin: signedConfig.publicOrigin,
  }), signedChallenge);
  for (const response of [
    challenge,
    { ...challenge, freshReadReceipt: "v1.short" },
    { ...challenge, freshReadReceipt: "v2." + "A".repeat(43) },
  ]) {
    assert.throws(
      () => validateChallengeResponse({
        response,
        wallet: WALLET_A,
        eligibility,
        config: signedConfig,
        currentOrigin: signedConfig.publicOrigin,
      }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
  assert.throws(
    () => validateChallengeResponse({
      response: signedChallenge,
      wallet: WALLET_A,
      eligibility,
      config: liveConfig,
      currentOrigin: liveConfig.publicOrigin,
    }),
    (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
  );
});

test("browser challenge reconstruction matches server hash and address canonicalization", () => {
  const mixedPair = {
    failedTransactionHash: `0x${"Ab".repeat(32)}`,
    successfulTransactionHash: `0x${"cD".repeat(32)}`,
  };
  const liveConfig = validateRecoveryConfigResponse(config({
    featuredCase: { wallet: WALLET_A, ...mixedPair },
  }));
  const eligibility = validateEligibilityResponse({
    response: {
      ...claimedResponse(),
      eligible: true,
      status: "eligible",
      pair: mixedPair,
      release: null,
      lineage: { scope: "campaign", status: "unused" },
    },
    requestedWallet: WALLET_A,
    config: liveConfig,
    expectedPair: mixedPair,
  });
  const response = {
    wallet: WALLET_A,
    poolAddress: POOL_A.toLowerCase(),
    campaignNumber: 7,
    pair: mixedPair,
    issuedAt: 2_000,
    expiresAt: 2_300,
    message: serverRecoveryChallengeMessage({
      origin: liveConfig.publicOrigin,
      poolAddress: POOL_A.toLowerCase(),
      campaignNumber: 7,
      wallet: WALLET_A,
      failedTransactionHash: mixedPair.failedTransactionHash,
      successfulTransactionHash: mixedPair.successfulTransactionHash,
      issuedAt: 2_000,
      expiresAt: 2_300,
    }),
  };

  assert.equal(validateChallengeResponse({
    response,
    wallet: WALLET_A,
    eligibility,
    config: liveConfig,
    currentOrigin: liveConfig.publicOrigin,
  }), response);
});

test("release validation binds the receipt and stale campaign evidence stays hidden", () => {
  const liveConfig = validateRecoveryConfigResponse(config());
  const eligibility = validateEligibilityResponse({
    response: {
      ...claimedResponse(),
      eligible: true,
      status: "eligible",
      release: null,
      lineage: { scope: "campaign", status: "unused" },
    },
    requestedWallet: WALLET_A,
    config: liveConfig,
  });
  const response = { ...claimedResponse(), status: "released" };
  const released = validateReleaseResponse({
    response,
    wallet: WALLET_A,
    eligibility,
    config: liveConfig,
  });

  assert.equal(selectVisibleRelease({
    account: WALLET_A,
    config: liveConfig,
    eligibility: null,
    releaseResult: released,
  }), released);
  assert.equal(selectVisibleRelease({
    account: WALLET_A,
    config: config({ campaignNumber: 8 }),
    eligibility: null,
    releaseResult: released,
  }), null);
  assert.equal(selectRecoveryEvidence({
    config: config({ poolAddress: POOL_B }),
    eligibility: null,
    releaseResult: released,
    featuredEligibility: null,
    featuredCase: null,
  }).pair, null);

  assert.throws(
    () => validateReleaseResponse({
      response: { ...response, pair: pair("3") },
      wallet: WALLET_A,
      eligibility,
      config: liveConfig,
    }),
    (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
  );
});

test("open-pair release keeps the full live pair facts bound to the receipt", () => {
  const liveConfig = validateRecoveryConfigResponse(config());
  const sourcePair = analyzedPair("1");
  const eligibility = validatePairEligibilityResponse({
    response: {
      eligible: true,
      status: "eligible",
      reason: "This pair qualifies.",
      wallet: WALLET_A,
      campaignNumber: 7,
      creditAmount: "10",
      pair: sourcePair,
      release: null,
      lineage: { scope: "campaign", status: "unused" },
    },
    requestedPair: pair("1"),
    config: liveConfig,
  });
  const response = {
    status: "released",
    wallet: WALLET_A,
    campaignNumber: 7,
    creditAmount: "10",
    pair: sourcePair,
    release: claimedResponse().release,
    lineage: { scope: "campaign", status: "claimed-current" },
  };

  assert.equal(validatePairReleaseResponse({
    response,
    wallet: WALLET_A,
    eligibility,
    config: liveConfig,
  }).pair.successful.mintedTokenIds[0], "42");
  assert.throws(
    () => validatePairReleaseResponse({
      response: { ...response, pair: { ...sourcePair, valueWei: "2" } },
      wallet: WALLET_A,
      eligibility,
      config: liveConfig,
    }),
    (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
  );
  for (const badRelease of [
    { ...response.release, blockNumber: -1 },
    { ...response.release, actionId: `0x${"0".repeat(64)}` },
    { ...response.release, successQueryId: response.release.failureQueryId },
    { ...response.release, relayer: "0x1234" },
    { ...response.release, claimCount: 0 },
  ]) {
    assert.throws(
      () => validatePairReleaseResponse({
        response: { ...response, release: badRelease },
        wallet: WALLET_A,
        eligibility,
        config: liveConfig,
      }),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }
});

test("same-campaign featured rotation rejects stale evidence, release, and closures", () => {
  const firstConfig = validateRecoveryConfigResponse(config());
  const secondConfig = validateRecoveryConfigResponse(config({
    featuredCase: { wallet: WALLET_B, ...pair("3") },
  }));
  const firstFeatured = validateEligibilityResponse({
    response: claimedResponse(),
    requestedWallet: WALLET_A,
    config: firstConfig,
    expectedPair: firstConfig.featuredCase,
  });

  assert.equal(recoveryConfigsMatch(firstConfig, secondConfig), false);
  assert.equal(recoveryCampaignsMatch(firstConfig, secondConfig), true);
  assert.equal(recoveryRecordMatchesConfig(firstFeatured, secondConfig), true);
  assert.equal(selectFeaturedRelease({
    config: secondConfig,
    eligibility: null,
    releaseResult: null,
    featuredEligibility: firstFeatured,
  }), null);

  const evidence = selectRecoveryEvidence({
    config: secondConfig,
    eligibility: null,
    releaseResult: null,
    featuredEligibility: firstFeatured,
    featuredCase: secondConfig.featuredCase,
  });
  assert.equal(evidence.wallet, WALLET_B);
  assert.deepEqual(evidence.pair, secondConfig.featuredCase);
  assert.equal(evidence.release, null);
});
