import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { recoveryChallengeMessage as serverRecoveryChallengeMessage } from "../src/recovery-campaign-service.mjs";
import {
  createWalletOperationGuard,
  isRecoveryChallengeExpired,
  isRecoveryResponseMismatch,
  recoveryCampaignsMatch,
  recoveryRecordMatchesConfig,
  recoveryConfigsMatch,
  selectFeaturedRelease,
  selectRecoveryEvidence,
  selectVisibleRelease,
  validateChallengeResponse,
  validateEligibilityResponse,
  validateRecoveryConfigResponse,
  validateReleaseResponse,
} from "../web/src/recovery-ui-state.mjs";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const POOL_A = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const POOL_B = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

function pair(prefix) {
  return {
    failedTransactionHash: `0x${prefix.repeat(64)}`,
    successfulTransactionHash: `0x${String(Number(prefix) + 1).repeat(64)}`,
  };
}

function config(overrides = {}) {
  return {
    enabled: true,
    waking: false,
    publicOrigin: "https://retrycredit.example",
    poolAddress: POOL_A,
    campaignNumber: 7,
    campaign: { creditAmount: "10" },
    source: { name: "Ethereum Mainnet", chainId: 1, chainKey: 3 },
    settlement: { name: "Creditcoin Testnet", chainId: 102031 },
    featuredCase: { wallet: WALLET_A, ...pair("1") },
    ...overrides,
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
      campaignNumber: 7,
      beneficiary: WALLET_A,
      creditAmount: "10",
    },
    ...overrides,
  };
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
    config({ source: { chainId: "1", chainKey: 3 } }),
    config({ settlement: { chainId: 0 } }),
    config({ featuredCase: { wallet: WALLET_A, failedTransactionHash: "0x01", successfulTransactionHash: "0x02" } }),
    { ...config(), enabled: "true" },
    { ...config(), enabled: 1 },
    { ...config(), enabled: null },
    Object.fromEntries(Object.entries(config()).filter(([key]) => key !== "enabled")),
  ]) {
    assert.throws(
      () => validateRecoveryConfigResponse(response),
      (error) => error.code === "RECOVERY_RESPONSE_MISMATCH",
    );
  }

  const disabled = {
    enabled: false,
    waking: false,
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
