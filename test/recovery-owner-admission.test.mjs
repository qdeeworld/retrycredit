import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { getAddress, hexlify, toUtf8Bytes } from "ethers";
import { formatRecoveryChallengeMessage } from "../src/recovery-consent.mjs";
import { TemporaryUnavailableError } from "../web/src/api.mjs";
import { helperOperationIdentity, validateHelperOperation } from "../web/src/recovery-helper-state.mjs";
import { canContinueRecoveryAuthorization, isRecoveryConfigReadable, isRecoveryChallengeExpired, isRecoveryFreshAuthorizationRejected, isRecoveryFreshAuthorizationUsed,
  isRecoveryRateLimited, isRecoveryResponseMismatch, recoveryAuthorizationInterruptionFlow, recoveryCampaignAvailability,
  recoveryHostedAdmissionMessage, recoveryHostedAdmissionState, recoveryRecordMatchesConfig, recoveryUsesHostedAdmission,
  validateChallengeResponse, validatePairEligibilityResponse, validateRecoveryConfigResponse, validateRecoveryHostedAdmission, walletsMatch } from "../web/src/recovery-ui-state.mjs";

const SOURCE = readFileSync(new URL("../web/src/main.jsx", import.meta.url), "utf8");
const wallet = "0x1111111111111111111111111111111111111111";
const helper = "0x2222222222222222222222222222222222222222";
const pool = "0x3333333333333333333333333333333333333333";
const sponsor = "0x4444444444444444444444444444444444444444";
const pair = { failedTransactionHash: `0x${"a".repeat(64)}`, successfulTransactionHash: `0x${"b".repeat(64)}` };
const available = { available: true, admissionState: "available", operation: null };
function config({ shared = true } = {}) {
  return validateRecoveryConfigResponse({ enabled: true, waking: false, contractVersion: "v2", publicOrigin: "https://retrycredit.example",
    poolAddress: pool, campaignNumber: 1, verifierAddress: wallet, predicateAddress: helper,
    source: { chainId: 1, chainKey: 3 }, settlement: { chainId: 102031 }, featuredCase: { wallet, ...pair },
    campaign: { sponsor, creditAmount: "100000000000000000", fundedAmount: "1000000000000000000", maxClaims: 10,
      claimCount: 0, remainingClaims: 10, deadline: 2_100_000_000, open: true, releaseState: "release-unlocked", termsHash: `0x${"c".repeat(64)}` },
    capacity: { total: 10, claimed: 0, remaining: 10 }, rule: { startBlock: 100, endBlock: 200, maxBlockGap: 5, maxQuantity: 2, feeRecipient: sponsor },
    lineage: { scope: "sponsor", releasesUnlocked: true, predecessor: { poolAddress: wallet, campaignNumber: 1, sponsor,
      termsHash: `0x${"d".repeat(64)}`, deadline: 2_000_000_000, startBlock: 100, endBlock: 200 } },
    consent: { scope: "hosted-relayer", protocolEnforced: false, freshReadAdmission: "anonymous-v1" },
    capabilities: { selfServePairIntake: true, walletNativeDiscovery: true, ...(shared ? { communityHelper: true } : {}) },
    ...(shared ? { helper: { enabled: true, available: true, admissionState: "available", mode: "community-helper-v1", recipientConsent: false, helperReceivesCredit: false } } : {}),
  });
}
function rawEligibility(admission = available, shared = true) {
  return { wallet, campaignNumber: 1, eligible: true, status: "eligible", reason: "The source pair qualifies.", creditAmount: "100000000000000000",
    release: null, lineage: { scope: "sponsor", status: "unused" },
    pair: { ...pair, sourceChainId: 1, sourceChainKey: 3, nftContract: sponsor, quantity: "2", mintPriceWei: "1000", valueWei: "2000",
      failed: { blockNumber: 101, nonce: 1 }, successful: { blockNumber: 103, nonce: 2, mintedTokenIds: ["1", "2"] } },
    ...(shared ? { hostedAdmission: admission } : {}),
  };
}
function sourceReserved(state = "stopped", mode = "community-helper-v1") {
  const transaction = ["broadcast-prepared", "settled", "reverted"].includes(state);
  const reservedPair = { failedTransactionHash: `0x${"6".repeat(64)}`, successfulTransactionHash: `0x${"7".repeat(64)}` };
  return { available: false, admissionState: "source-reserved", operation: { operationId: helperOperationIdentity(config(), wallet, reservedPair),
    state, mode, requester: mode === "owner" ? wallet : helper, sourceWallet: wallet,
    // An alternate exact pair still consumes this source's durable slot.
    pair: reservedPair,
    transactionHash: transaction ? `0x${"f".repeat(64)}` : null, blockNumber: ["settled", "reverted"].includes(state) ? 10 : null,
    reason: state === "stopped" ? "proof-unavailable" : null, recipientConsent: mode === "owner", helperReceivesCredit: false } };
}
function challenge(liveConfig, admission = available) {
  const issuedAt = Math.floor(Date.now() / 1000);
  return { wallet, pair, poolAddress: pool, campaignNumber: 1, issuedAt, expiresAt: issuedAt + 300,
    message: formatRecoveryChallengeMessage({ origin: liveConfig.publicOrigin, settlementChainId: 102031, poolAddress: pool,
      campaignNumber: 1, wallet, ...pair, issuedAt, expiresAt: issuedAt + 300 }),
    ...(recoveryUsesHostedAdmission(liveConfig) ? { hostedAdmission: admission } : {}) };
}

test("shared owner admission fails closed on missing, inconsistent and unavailable descriptors", () => {
  const liveConfig = config();
  assert.equal(recoveryHostedAdmissionState({ config: liveConfig, eligibility: rawEligibility() }), "available");
  for (const admission of [undefined, null, {}, { ...available, available: false }, { ...available, operation: {} }]) {
    assert.throws(() => validateRecoveryHostedAdmission(admission, { config: liveConfig, wallet }));
    assert.equal(recoveryHostedAdmissionState({ config: liveConfig, eligibility: { ...rawEligibility(), hostedAdmission: admission } }), "unavailable");
  }
  for (const admissionState of ["paused", "busy", "budget-exhausted", "unavailable"]) {
    assert.equal(recoveryHostedAdmissionState({ config: liveConfig, eligibility: rawEligibility({ available: false, admissionState, operation: null }) }), admissionState);
    assert.equal(recoveryHostedAdmissionState({ config: { ...liveConfig, helper: { ...liveConfig.helper, available: false, admissionState } }, eligibility: rawEligibility() }), admissionState);
  }
});

test("a permanently reserved alternate pair keeps its actual requester and role", () => {
  const liveConfig = config();
  for (const state of ["admitted", "broadcast-prepared", "settled", "reverted", "stopped"]) {
    for (const mode of ["owner", "community-helper-v1"]) {
      const result = validatePairEligibilityResponse({ response: rawEligibility(sourceReserved(state, mode)), requestedPair: pair, config: liveConfig });
      assert.equal(result.eligible, true, "source qualification is not rewritten as ineligible");
      assert.equal(recoveryHostedAdmissionState({ config: liveConfig, eligibility: result }), "source-reserved");
      assert.equal(result.hostedAdmission.operation.mode, mode);
      assert.equal(result.hostedAdmission.operation.requester, mode === "owner" ? wallet : helper);
      assert.notEqual(result.hostedAdmission.operation.pair.failedTransactionHash, pair.failedTransactionHash);
    }
  }
  const wrongSource = sourceReserved();
  wrongSource.operation.sourceWallet = helper;
  assert.throws(() => validateRecoveryHostedAdmission(wrongSource, { config: liveConfig, wallet }));
});

test("shared owner challenge must independently carry fresh available source admission", () => {
  const liveConfig = config();
  const eligibility = validatePairEligibilityResponse({ response: rawEligibility(), requestedPair: pair, config: liveConfig });
  const check = (response) => validateChallengeResponse({ response, wallet, eligibility, config: liveConfig, currentOrigin: liveConfig.publicOrigin });
  assert.equal(check(challenge(liveConfig)).hostedAdmission.available, true);
  for (const admission of [undefined, sourceReserved(), { available: false, admissionState: "busy", operation: null }]) {
    assert.throws(() => check({ ...challenge(liveConfig), hostedAdmission: admission }));
  }
});

test("legacy owner-only admission and challenge response shape remain compatible", () => {
  const liveConfig = config({ shared: false });
  const eligibility = validatePairEligibilityResponse({ response: rawEligibility(undefined, false), requestedPair: pair, config: liveConfig });
  assert.equal(eligibility.hostedAdmission, undefined);
  assert.equal(recoveryHostedAdmissionState({ config: liveConfig, eligibility }), "available");
  assert.equal(validateChallengeResponse({ response: challenge(liveConfig), wallet, eligibility, config: liveConfig,
    currentOrigin: liveConfig.publicOrigin }).hostedAdmission, undefined);
  assert.equal(canContinueRecoveryAuthorization({ operationCurrent: true, initialConfig: liveConfig, currentConfig: liveConfig, eligibility }), true);
});

test("budget and source-reservation copy do not misstate actual spending or a closed campaign", () => {
  assert.match(recoveryHostedAdmissionMessage("budget-exhausted"), /fully allocated/);
  assert.match(recoveryHostedAdmissionMessage("budget-exhausted"), /may not have been spent/);
  assert.doesNotMatch(recoveryHostedAdmissionMessage("budget-exhausted"), /budget is spent/);
  assert.doesNotMatch(recoveryHostedAdmissionMessage("source-reserved"), /[Cc]ampaign closed or full/);
  assert.match(SOURCE, /hostedAdmissionBlocked \? recoveryHostedAdmissionMessage\(hostedAdmissionState\)/);
});

test("owner availability refresh reconciles the exact existing public operation before fresh source eligibility", async () => {
  for (const mode of ["owner", "community-helper-v1"]) {
    const liveConfig = config();
    const existing = sourceReserved("broadcast-prepared", mode).operation;
    const events = [];
    const context = { online: true, recoveryModeRef: { current: "owner" }, helperLockRef: { current: false }, authorizationInFlight: { current: false },
      flowRef: { current: "release-uncertain" }, isBusyFlow: () => false, eligibilityRef: { current: { ...rawEligibility(), hostedAdmission: { available: false, admissionState: "source-reserved", operation: existing } } },
      configRef: { current: liveConfig }, pairOperations: { current: { begin: () => ({}) } }, operationIsCurrent: () => true,
      updateFlow() {}, setError() {}, API_ORIGIN: "https://api.example", recoveryCampaignsMatch: (left, right) => left === right,
      readHelperOperation: async ({ operationId }) => { assert.equal(operationId, existing.operationId); events.push("public-operation-get"); return { ...existing, state: "settled", blockNumber: 22 }; },
      validateHelperOperation, walletsMatch, checkPair: async () => events.push("fresh-pair-eligibility"),
    };
    const source = /^  async function refreshOwnerAdmission\([^\n]*\) \{[\s\S]*?^  \}/m.exec(SOURCE)?.[0];
    assert.ok(source);
    await runInNewContext(`(${source})`, context)({ preventDefault: () => events.push("prevent-form-navigation") });
    assert.deepEqual(events, ["prevent-form-navigation", "public-operation-get", "fresh-pair-eligibility"]);
    events.length = 0;
    context.readHelperOperation = async () => ({ ...existing, requester: sponsor });
    await runInNewContext(`(${source})`, context)();
    assert.deepEqual(events, [], "a different requester cannot be treated as reconciliation of this operation");
  }
  assert.match(SOURCE, /onSubmit=\{needsStatusCheck && eligibility\?\.hostedAdmission\?\.operation \? onRefreshAdmission : onCheckPair\}/);
});

test("known blocked shared admission never connects, signs or requests proof in actual owner handler", async () => {
  for (const admissionState of ["paused", "busy", "budget-exhausted", "unavailable", "source-reserved"]) {
    const admission = admissionState === "source-reserved" ? sourceReserved() : { available: false, admissionState, operation: null };
    const harness = createHarness({ initialAdmission: admission });
    await harness.authorize();
    assert.deepEqual(harness.events, []);
    assert.equal(harness.state.flow, "hosted-admission-blocked");
    assert.equal(harness.context.authorizationInFlight.current, false);
  }
});

test("fresh preflight catches a newly reserved source before the first wallet prompt", async () => {
  const harness = createHarness({ freshResponse: rawEligibility(sourceReserved()) });
  await harness.authorize();
  assert.deepEqual(harness.events, ["preflight"]);
  assert.equal(harness.state.flow, "hosted-admission-blocked");
  assert.equal(harness.context.eligibilityRef.current.hostedAdmission.operation.requester, helper);
});

test("a deferred preflight respects account/campaign operation invalidation before connecting", async () => {
  const pending = deferred();
  const harness = createHarness({ freshResponse: pending.promise });
  const running = harness.authorize();
  harness.state.operationCurrent = false;
  pending.resolve(rawEligibility());
  await running;
  assert.deepEqual(harness.events, ["preflight"]);
  assert.equal(harness.context.authorizationInFlight.current, false);
});

test("successful shared owner order is fresh source check, wallet, fresh challenge, signature, fresh config, release", async () => {
  const harness = createHarness();
  await harness.authorize();
  assert.deepEqual(harness.events, ["preflight", "connect", "challenge", "sign", "fresh-config", "release"]);
  assert.equal(harness.state.flow, "released");
});

test("a new source reservation discovered by challenge issuance prevents personal_sign", async () => {
  const harness = createHarness({ challengeError: Object.assign(new Error("Source already reserved"), { code: "RECOVERY_PROCESSING", status: 409 }) });
  await harness.authorize();
  assert.deepEqual(harness.events, ["preflight", "connect", "challenge"]);
  assert.equal(harness.state.flow, "hosted-admission-blocked");
});

test("a challenge with missing fresh admission is rejected without signing", async () => {
  const harness = createHarness({ challengeAdmission: null });
  await harness.authorize();
  assert.deepEqual(harness.events, ["preflight", "connect", "challenge"]);
  assert.equal(harness.state.flow, "retryable-error");
});

test("shared admission changes while signing stop the later release continuation", async () => {
  const pending = deferred();
  const harness = createHarness({ signature: pending.promise });
  const running = harness.authorize();
  await settle();
  harness.context.configRef.current = { ...harness.context.configRef.current,
    helper: { ...harness.context.configRef.current.helper, available: false, admissionState: "paused" } };
  pending.resolve("owner-signature");
  await running;
  assert.deepEqual(harness.events, ["preflight", "connect", "challenge", "sign"]);
  assert.equal(harness.state.flow, "hosted-admission-blocked");
});

test("legacy owner-only handler does not gain a shared-ledger preflight requirement", async () => {
  const harness = createHarness({ shared: false });
  await harness.authorize();
  assert.deepEqual(harness.events, ["connect", "challenge", "sign", "fresh-config", "release"]);
  assert.equal(harness.state.flow, "released");
});

function createHarness({ shared = true, initialAdmission = available, freshResponse = rawEligibility(), challengeError, challengeAdmission = available, signature = "owner-signature" } = {}) {
  const events = [];
  const state = { flow: "qualifying", error: "", operationCurrent: true, account: "" };
  const liveConfig = config({ shared });
  const initial = validatePairEligibilityResponse({ response: rawEligibility(initialAdmission, shared), requestedPair: pair, config: liveConfig });
  const context = {
    recoveryModeRef: { current: "owner" }, helperLockRef: { current: false }, authorizationInFlight: { current: false }, flowRef: { current: "qualifying" },
    eligibilityRef: { current: initial }, configRef: { current: liveConfig },
    pairOperations: { current: { begin: () => ({ pair }) } }, walletOperations: { current: { currentAccount: () => state.account, begin: () => ({ wallet }) } },
    operationIsCurrent: () => state.operationCurrent, isBusyFlow: () => false, isContinuationWaiting: () => false,
    setError: (value) => { state.error = value; }, updateFlow: (value) => { state.flow = value; context.flowRef.current = value; },
    updateEligibility: (value) => { context.eligibilityRef.current = value; }, setReleaseResult() {}, setAuthorizationPending() {},
    checkRecoveryPairEligibility: async () => { events.push("preflight"); return freshResponse; },
    connectWallet: async () => { events.push("connect"); state.account = wallet; return wallet; },
    requestRecoveryIntakeChallenge: async () => { events.push("challenge"); if (challengeError) throw challengeError;
      return challenge(liveConfig, challengeAdmission); },
    window: { location: { origin: liveConfig.publicOrigin }, ethereum: { request: async ({ method }) => {
      assert.equal(method, "personal_sign"); events.push("sign"); return signature;
    } } },
    fetchRecoveryConfig: async () => { events.push("fresh-config"); return context.configRef.current; },
    applyRecoveryConfig: (value) => { context.configRef.current = value; }, setConfigState() {},
    releaseRecoveryPairWhenReady: async ({ onSubmitting }) => { events.push("release"); onSubmitting(); return { status: "released", release: { transactionHash: `0x${"f".repeat(64)}` } }; },
    validatePairReleaseResponse: ({ response }) => response, persistSubmittedRecovery() {}, submittedRecoveryStartedAt: { current: null },
    refreshConfig() {}, clearSubmittedRecovery() {}, refreshAfterResponseMismatch: async () => { state.flow = "retryable-error"; },
    cleanError: (error) => error.message, recoveryClockNow: () => 1, recoveryWallClockNow: () => Date.now(), API_ORIGIN: "https://api.example",
    recoveryHostedAdmissionState, recoveryHostedAdmissionMessage, recoveryUsesHostedAdmission, recoveryRecordMatchesConfig,
    recoveryCampaignAvailability, canContinueRecoveryAuthorization, recoveryAuthorizationInterruptionFlow, validatePairEligibilityResponse,
    validateChallengeResponse, walletsMatch, getAddress, hexlify, toUtf8Bytes, isRecoveryResponseMismatch, isRecoveryChallengeExpired,
    isRecoveryFreshAuthorizationUsed, isRecoveryFreshAuthorizationRejected, isRecoveryRateLimited, TemporaryUnavailableError,
    isRecoveryConfigReadable,
  };
  const source = /^  async function authorizeAndRelease\(\) \{[\s\S]*?^  \}/m.exec(SOURCE)?.[0];
  assert.ok(source);
  return { events, state, context, authorize: runInNewContext(`(${source})`, context) };
}
function deferred() { let resolve; const promise = new Promise((accept) => { resolve = accept; }); return { promise, resolve }; }
async function settle() { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
