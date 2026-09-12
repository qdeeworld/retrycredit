import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createPairOperationGuard,
  createWalletOperationGuard,
  isRecoveryConfigReadable,
  recoveryCampaignsMatch,
  recoveryConfigsMatch,
  recoveryDiscoveryFailure,
  recoveryEligibleInspectionFlow,
  walletsMatch,
} from "../web/src/recovery-ui-state.mjs";
import { readRecoveryPairLink } from "../web/src/recovery-pair-handoff.mjs";
import {
  clearRecoveryResumeState,
  loadRecoveryResumeCandidate,
  RECOVERY_RESUME_STORAGE_KEY,
  saveRecoveryResumeState,
} from "../web/src/recovery-resume-state.mjs";

const SOURCE = readFileSync(new URL("../web/src/main.jsx", import.meta.url), "utf8");
const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const PAIR = Object.freeze({
  failedTransactionHash: `0x${"a".repeat(64)}`,
  successfulTransactionHash: `0x${"b".repeat(64)}`,
});

test("campaign change during a deferred wallet prompt cannot restore stale discovery busy state", async () => {
  const prompt = deferred();
  const harness = createHarness({ walletResponse: prompt.promise });
  const pending = harness.discover();
  assert.equal(harness.state.flow, "discovery-connecting");

  harness.applyConfig({ ...harness.context.config, campaignNumber: 3 });
  const invalidatedFlow = harness.state.flow;
  assert.equal(harness.context.isBusyFlow(invalidatedFlow), false);
  prompt.resolve(WALLET);
  await pending;

  assert.equal(harness.state.flow, invalidatedFlow);
  assert.equal(harness.context.isBusyFlow(harness.state.flow), false);
  assert.equal(harness.calls.backend, 0);
  // The invalidated continuation must not start another wallet operation.
  assert.equal(harness.calls.walletBegin, 1, "only campaign invalidation begins a wallet operation");
  assert.equal(harness.state.eligibility, null);
});

test("public-address inspection never connects or adopts the inspected source wallet", async t => {
  for (const account of ["", OTHER_WALLET]) await t.test(account ? "different connected wallet" : "no connected wallet", async () => {
    const harness = createHarness({ account });
    await harness.discover({ publicAddress: WALLET });

    assert.equal(harness.calls.connect, 0);
    assert.equal(harness.calls.connectedAccountUpdate, 0);
    assert.equal(harness.calls.walletBegin, 0);
    assert.equal(harness.context.walletOperations.current.currentAccount(), account.toLowerCase());
    assert.equal(harness.calls.backend, 1);
    assert.equal(harness.state.requestedWallet, WALLET);
    assert.equal(harness.state.eligibility.wallet, WALLET);
    assert.equal(harness.state.flow, account ? "wrong-wallet" : "qualifying");
  });
});

test("pair edits discard a deferred public-address discovery result", async () => {
  const response = deferred();
  const harness = createHarness({ discoveryResponse: response.promise });
  const pending = harness.discover({ publicAddress: WALLET });
  assert.equal(harness.state.flow, "discovering");
  assert.equal(harness.calls.backend, 1);

  const nextPair = { ...PAIR, failedTransactionHash: `0x${"c".repeat(64)}` };
  // Mirror the pair-edit invalidation without rendering or invoking a wallet.
  harness.context.discoveryGeneration.current += 1;
  harness.context.pairOperations.current.invalidate();
  harness.context.pairDraftRef.current = nextPair;
  harness.context.updateFlow("editing");
  response.resolve(discoveryResponse());
  await pending;

  assert.equal(harness.state.flow, "editing");
  assert.equal(harness.state.discoveryResult, null);
  assert.equal(harness.state.eligibility, null);
  assert.deepEqual(harness.context.pairDraftRef.current, nextPair);
  assert.equal(harness.calls.validate, 0);
});

test("campaign changes discard deferred public-address discovery successes and errors", async t => {
  for (const rejects of [false, true]) await t.test(rejects ? "stale rejection" : "stale success", async () => {
    const response = deferred();
    const harness = createHarness({ discoveryResponse: response.promise });
    const pending = harness.discover({ publicAddress: WALLET });
    harness.applyConfig({ ...harness.context.config, campaignNumber: 3 });
    const invalidatedFlow = harness.state.flow;
    if (rejects) response.reject(new Error("stale provider failure"));
    else response.resolve(discoveryResponse());
    await pending;

    assert.equal(harness.state.flow, invalidatedFlow);
    assert.equal(harness.state.error, "");
    assert.equal(harness.state.discoveryResult, null);
    assert.equal(harness.state.eligibility, null);
    assert.equal(harness.calls.validate, 0);
  });
});

test("public-address inspection rejects a result for a different derived source wallet", async () => {
  const response = discoveryResponse();
  response.matches[0].wallet = OTHER_WALLET;
  const harness = createHarness({ discoveryResponse: response });
  await harness.discover({ publicAddress: WALLET });

  assert.equal(harness.state.eligibility, null);
  assert.equal(harness.state.flow, "discovery-unavailable");
  assert.equal(harness.calls.connectedAccountUpdate, 0);
  assert.equal(harness.context.walletOperations.current.currentAccount(), "");
});

test("owner discovery and link adoption cannot replace a selected or active helper recovery", async () => {
  for (const state of [{ mode: "helper", locked: false }, { mode: "owner", locked: true }]) {
    const harness = createHarness();
    harness.context.recoveryModeRef.current = state.mode;
    harness.context.helperLockRef.current = state.locked;
    harness.context.pairDraftRef.current = PAIR;
    await harness.discover();
    harness.applySharedPair();
    assert.equal(harness.calls.connect, 0);
    assert.equal(harness.calls.backend, 0);
    assert.equal(harness.calls.resumeClear, 0);
    assert.deepEqual(harness.context.pairDraftRef.current, PAIR);
  }
});

test("shared-pair changes preserve saved recovery before configuration is readable", async t => {
  for (const config of [null, { enabled: false }]) await t.test(config ? "unavailable configuration" : "initial configuration pending", () => {
    const harness = createHarness();
    harness.saveResume("release-uncertain");
    harness.context.pairDraftRef.current = PAIR;
    const saved = harness.storage.getItem(RECOVERY_RESUME_STORAGE_KEY);
    harness.context.configRef.current = config;
    harness.applySharedPair();

    assert.deepEqual(harness.context.pairDraftRef.current, PAIR);
    assert.equal(harness.storage.getItem(RECOVERY_RESUME_STORAGE_KEY), saved);
    assert.equal(harness.calls.resumeRead, 0, "unknown campaign cannot inspect or clear stored identity");
    assert.equal(harness.calls.resumeClear, 0);
    assert.equal(harness.context.discoveryGeneration.current, 0);
    assert.equal(harness.state.flow, "empty");
    assert.match(harness.state.error, /Campaign checks are not ready/);
    assert.equal(harness.calls.backend, 0);
    assert.equal(harness.calls.connect, 0);
  });
});

test("shared-pair changes protect pending storage before the resume effect restores its flow", async t => {
  for (const status of ["proof-queued", "proof-building", "release-relaying", "release-processing", "release-uncertain"]) {
    await t.test(status, () => {
      const harness = createHarness();
      harness.saveResume(status);
      harness.context.pairDraftRef.current = PAIR;
      const saved = harness.storage.getItem(RECOVERY_RESUME_STORAGE_KEY);
      assert.equal(harness.state.flow, "empty", "reconciliation has not restored an active flow yet");
      harness.applySharedPair();

      assert.deepEqual(harness.context.pairDraftRef.current, PAIR);
      assert.equal(harness.storage.getItem(RECOVERY_RESUME_STORAGE_KEY), saved);
      assert.equal(harness.calls.resumeClear, 0);
      assert.equal(harness.context.discoveryGeneration.current, 0);
      assert.equal(harness.state.flow, "empty");
      assert.match(harness.state.error, /recovery action is still active/);
      assert.equal(harness.calls.backend, 0);
      assert.equal(harness.calls.connect, 0);
    });
  }
});

test("readable shared-pair adoption clears stale state only when no submission is pending", async t => {
  for (const status of [null, "released", "already-claimed"]) await t.test(status ?? "no saved recovery", () => {
    const harness = createHarness();
    if (status) harness.saveResume(status);
    harness.context.pairDraftRef.current = PAIR;
    harness.state.eligibility = { eligible: true };
    harness.state.discoveryResult = discoveryResponse();
    const oldOperation = harness.context.pairOperations.current.begin(PAIR);
    harness.applySharedPair();

    assert.deepEqual(harness.context.pairDraftRef.current, readRecoveryPairLink(harness.context.window.location.hash));
    assert.equal(harness.storage.getItem(RECOVERY_RESUME_STORAGE_KEY), null);
    assert.equal(harness.context.pairOperations.current.isCurrent(oldOperation), false);
    assert.equal(harness.state.eligibility, null);
    assert.equal(harness.state.discoveryResult, null);
    assert.equal(harness.state.error, "");
    assert.equal(harness.state.flow, "editing");
    assert.equal(harness.calls.backend, 0, "a shared link cannot start a check or release");
    assert.equal(harness.calls.connect, 0, "a shared link cannot request a wallet");
  });
});

// Execute the actual App orchestration with read-only, in-memory dependencies.
// Protocol response validation has dedicated recovery-ui-state tests; the stub
// here isolates operation ordering and prevents any network or wallet requests.
function createHarness({ account = "", walletResponse = WALLET, discoveryResponse: response = discoveryResponse() } = {}) {
  const calls = { connect: 0, connectedAccountUpdate: 0, walletBegin: 0, backend: 0, validate: 0, resumeRead: 0, resumeClear: 0 };
  const state = { flow: "empty", error: "", eligibility: null, discoveryResult: null, requestedWallet: null };
  const records = new Map();
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, value); },
    removeItem(key) { records.delete(key); },
  };
  const resumeOptions = { sessionStorage: storage, now: 1_800_000_000_000 };
  const guard = createWalletOperationGuard(account);
  const config = {
    enabled: true,
    poolAddress: "0x3333333333333333333333333333333333333333",
    campaignNumber: 2,
    publicOrigin: "https://retrycredit.example",
    source: { chainId: 1, chainKey: 3 },
    settlement: { chainId: 102031 },
    campaign: { creditAmount: "100000000000000000" },
    contractVersion: "v2",
    lineage: { scope: "sponsor", releasesUnlocked: true, predecessor: null },
    featuredCase: { wallet: WALLET, ...PAIR },
  };
  const context = {
    window: { location: { hash: `#failed=0x${"c".repeat(64)}&successful=0x${"d".repeat(64)}` } },
    online: true,
    authorizationInFlight: { current: false },
    recoveryModeRef: { current: "owner" },
    helperLockRef: { current: false },
    flowRef: { current: "empty" },
    discoveryGeneration: { current: 0 },
    discoveryMode: { current: null },
    pairDraftRef: { current: { failedTransactionHash: "", successfulTransactionHash: "" } },
    pairOperations: { current: createPairOperationGuard() },
    walletOperations: { current: { ...guard, begin(wallet) { calls.walletBegin += 1; return guard.begin(wallet); } } },
    config,
    configRef: { current: config },
    configState: "ready",
    API_ORIGIN: "https://api.retrycredit.example",
    updateFlow(flow) { context.flowRef.current = flow; state.flow = flow; },
    setError(error) { state.error = error; },
    setDiscoveryResult(result) { state.discoveryResult = result; },
    updateEligibility(value) { state.eligibility = value; },
    setReleaseResult() {},
    setPairDraft() {},
    setPairErrors() {},
    setFeaturedEligibility() {},
    setConfig(value) { context.config = value; },
    clearSubmittedRecovery() { calls.resumeClear += 1; clearRecoveryResumeState(resumeOptions); },
    loadRecoveryResumeCandidate(boundary) {
      calls.resumeRead += 1;
      return loadRecoveryResumeCandidate(boundary, resumeOptions);
    },
    async connectWallet() {
      calls.connect += 1;
      const wallet = await walletResponse;
      calls.connectedAccountUpdate += 1;
      guard.setAccount(wallet);
      return wallet;
    },
    async discoverRecoveryWallet({ wallet }) {
      calls.backend += 1;
      state.requestedWallet = wallet;
      return response;
    },
    validatePairEligibilityResponse({ response: value }) { calls.validate += 1; return value; },
    refreshConfig() { throw new Error("Unexpected configuration request"); },
    cleanError(error) { return error.message; },
    TemporaryUnavailableError: class TemporaryUnavailableError extends Error {},
    isRecoveryConfigReadable,
    recoveryCampaignsMatch,
    recoveryConfigsMatch,
    recoveryDiscoveryFailure,
    recoveryEligibleInspectionFlow,
    readRecoveryPairLink,
    walletsMatch,
  };
  for (const name of ["isBusyFlow", "needsReleaseStatusCheck", "hasPairDraft"]) {
    context[name] = runInNewContext(`(${appFunctionSource(name)})`, context);
  }
  return {
    context,
    calls,
    state,
    storage,
    saveResume(status) {
      const record = saveRecoveryResumeState({
        status, wallet: WALLET, poolAddress: config.poolAddress, campaignNumber: config.campaignNumber, ...PAIR,
      }, resumeOptions);
      assert.ok(record, "test submission must be valid resumable state");
    },
    discover: runInNewContext(`(${appFunctionSource("discoverWallet")})`, context),
    applyConfig: runInNewContext(`(${appFunctionSource("applyRecoveryConfig")})`, context),
    applySharedPair: runInNewContext(`(${sharedPairHandlerSource()})`, context),
  };
}

function appFunctionSource(name) {
  const declaration = new RegExp(`^( *)(?:async )?function ${name}\\(`, "m").exec(SOURCE);
  assert.ok(declaration, `${name} must remain an inspectable function`);
  const nextDeclaration = new RegExp(`^${declaration[1]}(?:async )?function `, "gm");
  nextDeclaration.lastIndex = declaration.index + declaration[0].length;
  const next = nextDeclaration.exec(SOURCE);
  assert.ok(next, `${name} must have a following declaration boundary`);
  return SOURCE.slice(declaration.index, next.index).trim();
}

function sharedPairHandlerSource() {
  const declaration = /const applySharedPair = (\(\) => \{[\s\S]*?\n    \});/.exec(SOURCE);
  assert.ok(declaration, "shared-pair handler must remain inspectable");
  return declaration[1];
}

function discoveryResponse() {
  return {
    authority: "advisory-discovery-only",
    wallet: WALLET,
    matches: [{ eligible: true, status: "eligible", wallet: WALLET, pair: { ...PAIR } }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
