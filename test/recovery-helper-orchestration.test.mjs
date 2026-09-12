import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { getAddress, hexlify, toUtf8Bytes } from "ethers";
import { helperOutcomeResolved, helperSettlementConfirmed } from "../web/src/helper-settlement-view.mjs";
import { canContinueHelperAuthorization, helperErrorCopy, helperOperationIsTerminal, helperRequestDefinitelyRefused, RECOVERY_HELPER_MODE } from "../web/src/recovery-helper-state.mjs";
import { recoveryCampaignsMatch, recoveryHostedAdmissionMessage, recoveryHostedAdmissionState, validateRecoveryPairDraft, walletsMatch } from "../web/src/recovery-ui-state.mjs";

const SOURCE = readFileSync(new URL("../web/src/HelperRecoveryDesk.jsx", import.meta.url), "utf8");
const requester = "0x2222222222222222222222222222222222222222";
const recipient = "0x1111111111111111111111111111111111111111";
const other = "0x4444444444444444444444444444444444444444";
const pair = { failedTransactionHash: `0x${"a".repeat(64)}`, successfulTransactionHash: `0x${"b".repeat(64)}` };
const operationId = `0x${"c".repeat(64)}`;
const config = { enabled: true, publicOrigin: "https://retrycredit.example", poolAddress: other, campaignNumber: 1,
  contractVersion: "v2", source: { chainId: 1, chainKey: 3 }, settlement: { chainId: 102031 },
  lineage: { scope: "sponsor", releasesUnlocked: true, predecessor: { poolAddress: recipient, campaignNumber: 1,
    sponsor: other, termsHash: `0x${"e".repeat(64)}`, deadline: 2_000_000_000, startBlock: 100, endBlock: 200 } },
  campaign: { creditAmount: "100000000000000000", open: true, deadline: 2_100_000_000, releaseState: "release-unlocked" },
  capacity: { remaining: 9 }, capabilities: { communityHelper: true },
  helper: { enabled: true, available: true, admissionState: "available", mode: RECOVERY_HELPER_MODE, recipientConsent: false, helperReceivesCredit: false } };
const challenge = { mode: RECOVERY_HELPER_MODE, requester, sourceWallet: recipient, pair, operationId,
  issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 300, message: "exact validated helper request" };
const admitted = { mode: RECOVERY_HELPER_MODE, requester, sourceWallet: recipient, pair, operationId,
  state: "admitted", transactionHash: null, blockNumber: null, reason: null, recipientConsent: false, helperReceivesCredit: false };

test("actual helper authorize handler persists public identity before exactly one release POST", async () => {
  const harness = createHarness();
  await harness.authorize();
  assert.deepEqual(harness.events.filter((event) => ["sign", "persist", "release"].includes(event)), ["sign", "persist", "release", "persist"]);
  assert.equal(harness.calls.release, 1);
  assert.equal(harness.calls.sign, 1);
  assert.equal(harness.calls.status, 1);
  assert.equal(harness.context.submitted.current.sourceWallet, recipient);
  assert.equal(harness.state.locked, true);
});

test("known shared/source admission refusals never open a helper wallet prompt", async () => {
  const states = ["paused", "busy", "budget-exhausted", "unavailable", "source-reserved"];
  for (const admissionState of states) {
    const harness = createHarness();
    harness.context.eligibility.hostedAdmission = { available: false, admissionState,
      operation: admissionState === "source-reserved" ? { ...admitted, state: "stopped", reason: "proof-unavailable" } : null };
    await harness.authorize();
    assert.equal(harness.calls.connect, 0, admissionState);
    assert.equal(harness.calls.challenge, 0, admissionState);
    assert.equal(harness.calls.sign, 0, admissionState);
    assert.equal(harness.calls.release, 0, admissionState);
    assert.equal(harness.state.locked, false, admissionState);
    assert.equal(harness.context.submitted.current, null, admissionState);
    assert.equal(harness.state.notice, recoveryHostedAdmissionMessage(admissionState));
  }
  const missing = createHarness();
  delete missing.context.eligibility.hostedAdmission;
  await missing.authorize();
  assert.equal(missing.calls.connect, 0);
  assert.match(SOURCE, /disabled=\{busy \|\| \(!connectedSource && \(!available \|\| pairAdmissionBlocked\)\)\}/);
});

test("duplicate helper clicks share the in-flight action and cannot open another wallet prompt", async () => {
  const pending = deferred();
  const harness = createHarness({ signature: pending.promise });
  const first = harness.authorize();
  await settle();
  assert.equal(harness.calls.sign, 1);
  await harness.authorize();
  assert.equal(harness.calls.connect, 1);
  assert.equal(harness.calls.sign, 1);
  pending.resolve("signed-helper-request");
  await first;
  assert.equal(harness.calls.release, 1);
});

test("account changes during a deferred challenge stop signing even when switched back", async () => {
  const pending = deferred();
  const harness = createHarness({ challengeResponse: pending.promise });
  const task = harness.authorize();
  await settle();
  harness.context.walletGeneration.current += 2;
  harness.context.accountRef.current = requester;
  pending.resolve(challenge);
  await task;
  assert.equal(harness.calls.sign, 0);
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.context.submitted.current, null);
  assert.equal(harness.state.locked, false);
});

test("a wallet selection changed after signing cannot send a helper release request", async () => {
  const pending = deferred();
  const harness = createHarness({ signature: pending.promise });
  const task = harness.authorize();
  await settle();
  harness.state.providerAccount = other;
  pending.resolve("signed-helper-request");
  await task;
  assert.equal(harness.calls.sign, 1);
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.context.submitted.current, null);
});

test("campaign changes during a wallet challenge leave the desk unlocked without a stale busy state", async () => {
  const pending = deferred();
  const harness = createHarness({ challengeResponse: pending.promise });
  const task = harness.authorize();
  await settle();
  harness.context.configRef.current = { ...config, campaignNumber: 2 };
  pending.resolve(challenge);
  await task;
  assert.equal(harness.calls.sign, 0);
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.state.locked, false);
  assert.equal(harness.state.phase, "empty");
});

test("budget becoming unavailable during signing stops the release POST", async () => {
  const pending = deferred();
  const harness = createHarness({ signature: pending.promise });
  const task = harness.authorize();
  await settle();
  harness.context.configRef.current = { ...config, helper: { ...config.helper, available: false, admissionState: "budget-exhausted" } };
  pending.resolve("signed-helper-request");
  await task;
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.context.submitted.current, null);
});

test("a lost release ACK retains the operation and makes later clicks status-only", async () => {
  const harness = createHarness({ releaseError: new Error("lost ACK after reserve") });
  await harness.authorize();
  assert.equal(harness.state.phase, "uncertain");
  assert.equal(harness.state.locked, true);
  assert.equal(harness.context.submitted.current.operationId, operationId);
  assert.equal(harness.calls.status, 1);
  assert.equal(harness.calls.clear, 0);
  await harness.authorize();
  assert.equal(harness.calls.release, 1);
  assert.equal(harness.calls.sign, 1);
});

test("explicit pre-admission budget refusal clears only the local marker and never retries automatically", async () => {
  const error = Object.assign(new Error("budget"), { code: "HELPER_LEDGER_BUDGET_EXHAUSTED", status: 429 });
  const harness = createHarness({ releaseError: error });
  await harness.authorize();
  assert.equal(harness.context.submitted.current, null);
  assert.equal(harness.calls.clear, 1);
  assert.equal(harness.calls.release, 1);
  assert.equal(harness.calls.status, 0);
  assert.equal(harness.state.locked, false);
  assert.match(harness.state.notice, /spending limit/);
});

test("wallet dismissal does not persist a request or release anything", async () => {
  const harness = createHarness({ signatureError: { code: 4001 } });
  await harness.authorize();
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.calls.persist, 0);
  assert.equal(harness.state.locked, false);
  assert.match(harness.state.notice, /closed/);
});

test("a source owner selecting helper mode is directed to owner recovery before challenge or signing", async () => {
  const harness = createHarness({ connectedWallet: recipient });
  await harness.authorize();
  assert.equal(harness.calls.challenge, 0);
  assert.equal(harness.calls.sign, 0);
  assert.equal(harness.calls.release, 0);
  assert.equal(harness.state.locked, false);
  assert.match(harness.state.notice, /Recover my retry/);
});

test("explicit helper-to-owner handoff only prefills the exact pair and clears completed owner resume", () => {
  const app = readFileSync(new URL("../web/src/main.jsx", import.meta.url), "utf8");
  const source = /^  function carryHelperPairToOwner\([^\n]*\) \{[\s\S]*?^  \}/m.exec(app)?.[0];
  assert.ok(source);
  const calls = [];
  const context = { helperLockRef: { current: false }, authorizationInFlight: { current: false }, recoveryModeRef: { current: "helper" },
    validateRecoveryPairDraft, pairDraftRef: { current: null }, pairOperations: { current: { invalidate: () => calls.push("invalidate") } },
    chooseRecoveryMode: (mode) => { context.recoveryModeRef.current = mode; calls.push("owner"); },
    clearSubmittedRecovery: () => calls.push("clear-completed-resume"), setPairDraft: () => calls.push("prefill"),
    setPairErrors() {}, updateEligibility() {}, setReleaseResult() {}, setDiscoveryResult() {}, setError() {}, updateFlow: () => calls.push("editing") };
  const handoff = runInNewContext(`(${source})`, context);
  handoff(pair);
  assert.deepEqual(context.pairDraftRef.current, pair);
  assert.deepEqual(calls, ["owner", "clear-completed-resume", "invalidate", "prefill", "editing"]);
  calls.length = 0;
  context.recoveryModeRef.current = "helper";
  context.helperLockRef.current = true;
  handoff(pair);
  assert.deepEqual(calls, []);
});

test("unmounting the helper desk before the challenge returns cannot sign or submit", async () => {
  const pending = deferred();
  const harness = createHarness({ challengeResponse: pending.promise });
  const task = harness.authorize();
  await settle();
  harness.context.active.current = false;
  harness.context.generation.current += 1;
  pending.resolve(challenge);
  await task;
  assert.equal(harness.calls.sign, 0);
  assert.equal(harness.calls.release, 0);
});

// Runs the real component functions, without React, a network, or a wallet. Pure
// response/domain validation has its own tests; this isolates async ordering.
function createHarness({ signature = "signed-helper-request", signatureError, challengeResponse = challenge, releaseError, connectedWallet = requester } = {}) {
  const calls = { connect: 0, challenge: 0, sign: 0, release: 0, persist: 0, status: 0, clear: 0 };
  const events = [];
  const state = { phase: "eligible", locked: false, notice: "", providerAccount: connectedWallet, operation: null };
  const context = {
    available: true, eligibility: { eligible: true, status: "eligible", wallet: recipient, pair,
      hostedAdmission: { available: true, admissionState: "available", operation: null } }, apiOrigin: "https://api.example",
    configRef: { current: config }, accountRef: { current: requester }, walletGeneration: { current: 0 },
    generation: { current: 0 }, active: { current: true }, actionBusy: { current: false },
    submitted: { current: null }, submittedConfig: { current: null }, operationRef: { current: null },
    connectRef: { current: async () => { calls.connect += 1; return connectedWallet; } },
    onLockChange(value) { state.locked = value; },
    setPhase(value) { state.phase = typeof value === "function" ? value(state.phase) : value; },
    setNotice(value) { state.notice = value; },
    setOperation(value) { state.operation = value; },
    requestHelperChallenge: async () => { calls.challenge += 1; return challengeResponse; },
    validateHelperChallenge: ({ response }) => response,
    submitHelperRecovery: async () => { calls.release += 1; events.push("release"); if (releaseError) throw releaseError; return admitted; },
    validateHelperOperation: (value) => value,
    readStatus: async () => { calls.status += 1; },
    saveHelperResume: () => { calls.persist += 1; events.push("persist"); },
    clearHelperResume: () => { calls.clear += 1; },
    window: { location: { origin: config.publicOrigin }, ethereum: { request: async ({ method }) => {
      if (method === "eth_accounts") return [state.providerAccount];
      if (method === "personal_sign") { calls.sign += 1; events.push("sign"); if (signatureError) throw signatureError; return signature; }
      throw new Error("Unexpected wallet action");
    } } },
    getAddress, hexlify, toUtf8Bytes, walletsMatch, recoveryCampaignsMatch, canContinueHelperAuthorization,
    recoveryHostedAdmissionState, recoveryHostedAdmissionMessage,
    helperOperationIsTerminal, helperOutcomeResolved, helperSettlementConfirmed, helperRequestDefinitelyRefused, helperErrorCopy, RECOVERY_HELPER_MODE,
  };
  for (const name of ["setOperationState", "beginAction", "finishAction", "current", "acceptOperation"]) {
    context[name] = runInNewContext(`(${componentFunction(name)})`, context);
  }
  return { context, state, calls, events, authorize: runInNewContext(`(${componentFunction("authorize")})`, context) };
}

function componentFunction(name) {
  const pattern = new RegExp(`^  (?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}`, "m");
  const match = pattern.exec(SOURCE);
  assert.ok(match, `${name} must remain an inspectable component function`);
  return match[0].trim();
}
function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}
async function settle() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }
