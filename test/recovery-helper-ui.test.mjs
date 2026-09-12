import assert from "node:assert/strict";
import test from "node:test";
import { getAddress } from "ethers";
import { formatRecoveryHelperMessage, RECOVERY_HELPER_MODE } from "../src/recovery-helper-consent.mjs";
import { helperOperationId } from "../src/helper-ledger-policy.mjs";
import { discoverHelperRecovery, readHelperOperation, requestHelperChallenge, submitHelperRecovery } from "../web/src/recovery-helper-api.mjs";
import { canContinueHelperAuthorization, clearHelperResume, HELPER_RESUME_FRESH_MS, HELPER_RESUME_KEY, helperAdmissionAvailable, helperEnabled, helperErrorCopy, helperOperationIdentity, helperOperationIsTerminal, helperRequestDefinitelyRefused, readHelperResume, saveHelperResume, validateHelperChallenge, validateHelperDiscovery, validateHelperOperation } from "../web/src/recovery-helper-state.mjs";
import { validatePairEligibilityResponse, validateRecoveryConfigResponse } from "../web/src/recovery-ui-state.mjs";

const source = getAddress("0x1111111111111111111111111111111111111111");
const requester = getAddress("0x2222222222222222222222222222222222222222");
const pool = getAddress("0x3333333333333333333333333333333333333333");
const other = getAddress("0x4444444444444444444444444444444444444444");
const pair = { failedTransactionHash: `0x${"a".repeat(64)}`, successfulTransactionHash: `0x${"b".repeat(64)}` };
const now = 1_900_000_000_000;
const config = {
  enabled: true, waking: false, contractVersion: "v2", publicOrigin: "https://retrycredit.example", poolAddress: pool, campaignNumber: 1,
  verifierAddress: requester, predicateAddress: other, featuredCase: { wallet: source, ...pair },
  source: { chainId: 1, chainKey: 3 }, settlement: { chainId: 102031 },
  campaign: { sponsor: other, creditAmount: "100000000000000000", maxClaims: 10, claimCount: 1,
    remainingClaims: 9, fundedAmount: "1000000000000000000", deadline: 2_100_000_000,
    termsHash: `0x${"c".repeat(64)}`, open: true, releaseState: "release-unlocked" },
  capacity: { total: 10, claimed: 1, remaining: 9 },
  rule: { startBlock: 100, endBlock: 200, maxBlockGap: 5, maxQuantity: 2, feeRecipient: other },
  lineage: { scope: "sponsor", releasesUnlocked: true, predecessor: { poolAddress: source, campaignNumber: 1,
    sponsor: other, termsHash: `0x${"e".repeat(64)}`, deadline: 2_000_000_000, startBlock: 100, endBlock: 200 } },
  consent: { scope: "hosted-relayer", protocolEnforced: false, freshReadAdmission: "anonymous-v1" },
  capabilities: { communityHelper: true, selfServePairIntake: true },
  helper: { enabled: true, available: true, admissionState: "available", mode: RECOVERY_HELPER_MODE, recipientConsent: false,
    helperReceivesCredit: false, maxTransactionFeeWei: "2000000000000000" },
};
const rawEligibility = {
  wallet: source, campaignNumber: 1, creditAmount: config.campaign.creditAmount,
  eligible: true, status: "eligible", reason: "The exact source pair is eligible.", release: null,
  hostedAdmission: { available: true, admissionState: "available", operation: null },
  lineage: { scope: "sponsor", status: "unused" },
  pair: { ...pair, sourceChainId: 1, sourceChainKey: 3, nftContract: other, quantity: "2", mintPriceWei: "1000", valueWei: "2000",
    failed: { blockNumber: 101, nonce: 1 }, successful: { blockNumber: 103, nonce: 2, mintedTokenIds: ["1", "2"] } },
};
function eligibility() {
  return validatePairEligibilityResponse({ response: structuredClone(rawEligibility), requestedPair: pair, config });
}
function challenge() {
  const issuedAt = Math.floor(now / 1000);
  const operationId = helperOperationIdentity(config, source, pair);
  const value = { mode: RECOVERY_HELPER_MODE, requester, sourceWallet: source, poolAddress: pool, campaignNumber: 1,
    pair: { ...pair }, operationId, issuedAt, expiresAt: issuedAt + 300,
    hostedAdmission: { available: true, admissionState: "available", operation: null } };
  value.message = formatRecoveryHelperMessage({ origin: config.publicOrigin, settlementChainId: 102031,
    ...value, ...pair });
  return value;
}
function validateChallenge(response, overrides = {}) {
  return validateHelperChallenge({ response, requester, eligibility: eligibility(), config,
    currentOrigin: config.publicOrigin, now, ...overrides });
}
function operation(state = "admitted", overrides = {}) {
  const hasTransaction = ["broadcast-prepared", "settled", "reverted"].includes(state);
  return { operationId: helperOperationIdentity(config, source, pair), state, mode: RECOVERY_HELPER_MODE, requester,
    sourceWallet: source, pair: { ...pair }, transactionHash: hasTransaction ? `0x${"d".repeat(64)}` : null,
    blockNumber: ["settled", "reverted"].includes(state) ? 500 : null,
    reason: state === "stopped" ? "fee-cap" : null, recipientConsent: false, helperReceivesCredit: false, ...overrides };
}
function storage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}

test("helper capability is opt-in and never turns an owner-only or read-only release into helper admission", () => {
  assert.equal(validateRecoveryConfigResponse(config).contractVersion, "v2");
  assert.equal(helperEnabled(config), true);
  for (const value of [null, {}, { ...config, helper: undefined }, { ...config, capabilities: {} },
    { ...config, enabled: false }, { ...config, readOnly: true }, { ...config, contractVersion: "v1" }, { ...config, helper: { ...config.helper, enabled: false } },
    { ...config, helper: { ...config.helper, recipientConsent: true } }, { ...config, helper: { ...config.helper, helperReceivesCredit: true } }]) {
    assert.equal(helperEnabled(value), false);
    assert.equal(helperAdmissionAvailable(value), false);
  }
});

test("paused, busy and exhausted admission disable new actions but keep helper status capability", () => {
  assert.equal(helperAdmissionAvailable(config), true);
  for (const admissionState of ["paused", "busy", "budget-exhausted", "unavailable"]) {
    const changed = { ...config, helper: { ...config.helper, available: false, admissionState } };
    assert.equal(helperEnabled(changed), true);
    assert.equal(helperAdmissionAvailable(changed), false);
  }
  assert.equal(helperAdmissionAvailable({ ...config, helper: { ...config.helper, available: true, admissionState: "busy" } }), false);
});

test("browser independently derives the same canonical source-bound operation ID as the coordinator", () => {
  const identity = { chainId: 102031, poolAddress: pool, campaignNumber: 1, relayerAddress: other };
  assert.equal(helperOperationIdentity(config, source, pair), helperOperationId(identity, source, pair));
  assert.notEqual(helperOperationIdentity(config, source, pair), helperOperationIdentity(config, requester, pair));
  assert.notEqual(helperOperationIdentity(config, source, pair), helperOperationIdentity({ ...config, campaignNumber: 2 }, source, pair));
  assert.notEqual(helperOperationIdentity(config, source, pair), helperOperationIdentity(config, source, {
    failedTransactionHash: pair.successfulTransactionHash, successfulTransactionHash: pair.failedTransactionHash }));
});

test("a no-hash discovery result receives the normal independent eligibility response validation", () => {
  const result = validateHelperDiscovery({ status: "found", checkedCandidates: 1, totalCandidates: 89, moreCandidates: true,
    match: rawEligibility }, config);
  assert.equal(result.match.wallet, source);
  assert.equal(result.match.eligible, true);
  assert.deepEqual(result.match.recoveryBoundary, { poolAddress: pool.toLowerCase(), campaignNumber: 1 });
  assert.throws(() => validateHelperDiscovery({ ...result, match: { ...rawEligibility, creditAmount: "500" } }, config));
  assert.throws(() => validateHelperDiscovery({ ...result, checkedCandidates: 5 }, config));
  assert.throws(() => validateHelperDiscovery({ ...result, match: { ...rawEligibility, status: "claimed" } }, config));
});

test("empty, exhausted and unavailable discovery are distinct non-verdict states", () => {
  for (const status of ["none-in-window", "exhausted", "unavailable"]) {
    const result = { status, checkedCandidates: 4, totalCandidates: 89, moreCandidates: true, match: null };
    assert.deepEqual(validateHelperDiscovery(result, config), result);
    assert.throws(() => validateHelperDiscovery({ ...result, match: rawEligibility }, config));
  }
});

test("helper challenge signs the helper role with original source recipient and exact domain", () => {
  const checked = validateChallenge(challenge());
  assert.equal(checked.requester, requester);
  assert.equal(checked.sourceWallet, source);
  assert.match(checked.message, /This is my request, not the source owner's consent/);
  assert.match(checked.message, /helper receives no credit/);
  assert.match(checked.message, /one-time sponsor credit/);
});

test("helper challenge rejects every identity substitution and owner consent relabeling", () => {
  for (const fields of [{ requester: other }, { sourceWallet: requester }, { poolAddress: other }, { campaignNumber: 2 },
    { mode: "owner" }, { operationId: `0x${"f".repeat(64)}` }, { pair: { ...pair, failedTransactionHash: `0x${"e".repeat(64)}` } },
    { message: "RetryCredit recovery consent" }]) assert.throws(() => validateChallenge({ ...challenge(), ...fields }));
  assert.throws(() => validateChallenge(challenge(), { currentOrigin: "https://another.example" }));
  assert.throws(() => validateChallenge({ ...challenge(), requester: source }, { requester: source }));
  assert.throws(() => validateChallenge(challenge(), { eligibility: { ...eligibility(), eligible: false } }));
});

test("helper challenge cannot extend its five-minute validity or survive expiry", () => {
  const valid = challenge();
  assert.throws(() => validateChallenge({ ...valid, expiresAt: valid.expiresAt + 1 }));
  assert.throws(() => validateChallenge(valid, { now: valid.expiresAt * 1000 }));
  assert.throws(() => validateChallenge({ ...valid, issuedAt: valid.issuedAt + 61, expiresAt: valid.expiresAt + 61 }));
});

test("account, operation, campaign and admission races stop authorization before POST", () => {
  const state = { initialConfig: config, currentConfig: config, requester, currentAccount: requester, operationCurrent: true,
    expiresAt: Math.floor(now / 1000) + 300, now };
  assert.equal(canContinueHelperAuthorization(state), true);
  for (const overrides of [{ currentAccount: other }, { operationCurrent: false }, { expiresAt: Math.floor(now / 1000) },
    { currentConfig: { ...config, poolAddress: other } }, { currentConfig: { ...config, helper: { ...config.helper, available: false } } }]) {
    assert.equal(canContinueHelperAuthorization({ ...state, ...overrides }), false);
  }
});

test("durable statuses require a coherent exact pair, source, transaction and terminal receipt", () => {
  for (const state of ["admitted", "broadcast-prepared", "settled", "reverted", "stopped"]) {
    assert.equal(validateHelperOperation(operation(state), challenge(), config).state, state);
  }
  for (const malformed of [operation("settled", { transactionHash: null }), operation("settled", { blockNumber: null }),
    operation("admitted", { transactionHash: `0x${"d".repeat(64)}` }), operation("stopped", { reason: "internal-secret" }),
    operation("admitted", { sourceWallet: requester }), operation("admitted", { recipientConsent: true }),
    operation("admitted", { helperReceivesCredit: true }), operation("submitted")]) {
    assert.throws(() => validateHelperOperation(malformed, challenge(), config));
  }
});

test("a concurrent canonical owner or other helper operation preserves its actual actor, never relabels consent", () => {
  const owner = validateHelperOperation(operation("admitted", { mode: "owner", requester: source, recipientConsent: true }), challenge(), config);
  assert.equal(owner.mode, "owner");
  assert.equal(owner.recipientConsent, true);
  assert.equal(owner.requester, source);
  const anotherHelper = validateHelperOperation(operation("admitted", { requester: other }), challenge(), config);
  assert.equal(anotherHelper.requester, other);
  assert.equal(anotherHelper.recipientConsent, false);
  assert.throws(() => validateHelperOperation(operation("admitted", { mode: "owner", requester: other, recipientConsent: true }), challenge(), config));
  assert.throws(() => validateHelperOperation(operation("admitted", { requester: source }), challenge(), config));
});

test("only verified terminal states can unlock the next helper journey", () => {
  for (const state of ["submitted", "admitted", "broadcast-prepared", "unknown", undefined]) assert.equal(helperOperationIsTerminal({ state }), false);
  for (const state of ["settled", "reverted", "stopped"]) assert.equal(helperOperationIsTerminal({ state }), true);
});

test("resume storage persists only public identity and never signs or carries authorization material", () => {
  const store = storage();
  saveHelperResume({ ...operation(), signature: "SECRET-SIGNATURE", message: "SECRET-MESSAGE", proof: "SECRET-PROOF", rawTransaction: "SECRET-RAW" }, config, { storage: store, now });
  const raw = store.getItem(HELPER_RESUME_KEY);
  assert.doesNotMatch(raw, /SECRET|signature|message|proof|rawTransaction|transactionHash/);
  const record = readHelperResume(config, { storage: store, now });
  assert.equal(record.operationId, challenge().operationId);
  assert.equal(record.requester, requester);
  assert.equal(record.sourceWallet, source);
  assert.equal(record.stale, false);
});

test("freshness expiry retains the unresolved public identity instead of authorizing another request", () => {
  const store = storage();
  saveHelperResume(operation(), config, { storage: store, now });
  const stale = readHelperResume(config, { storage: store, now: now + HELPER_RESUME_FRESH_MS + 1 });
  assert.equal(stale.stale, true);
  assert.equal(stale.operationId, challenge().operationId);
  assert.equal(helperOperationIsTerminal(stale), false);
  saveHelperResume(operation("broadcast-prepared"), config, { storage: store, now: now + HELPER_RESUME_FRESH_MS + 2 });
  assert.equal(readHelperResume(config, { storage: store, now: now + HELPER_RESUME_FRESH_MS + 2 }).createdAt, now);
});

test("tampered or foreign campaign resume records are not accepted as live operation identity", () => {
  const store = storage();
  saveHelperResume(operation(), config, { storage: store, now });
  assert.equal(readHelperResume({ ...config, campaignNumber: 2 }, { storage: store, now }), null);
  const original = JSON.parse(store.getItem(HELPER_RESUME_KEY));
  for (const changes of [{ requester: "invalid" }, { sourceWallet: other }, { createdAt: now + 1 },
    { expiresAt: now + 1 }, { signature: "unexpected" }, { pair: { ...pair, destination: other } }]) {
    store.setItem(HELPER_RESUME_KEY, JSON.stringify({ ...original, ...changes }));
    assert.equal(readHelperResume(config, { storage: store, now }), null);
  }
});

test("explicit clear removes only the helper public resume record", () => {
  const store = storage();
  store.setItem("owner-flow", "unchanged");
  saveHelperResume(operation(), config, { storage: store, now });
  clearHelperResume({ storage: store });
  assert.equal(store.getItem(HELPER_RESUME_KEY), null);
  assert.equal(store.getItem("owner-flow"), "unchanged");
});

test("only explicit pre-admission refusals can clear an uncertain local submission", () => {
  for (const code of ["HELPER_LEDGER_BUDGET_EXHAUSTED", "HELPER_LEDGER_BUSY", "HELPER_LEDGER_SOURCE_RESERVED", "RECOVERY_SIGNATURE_INVALID"]) {
    assert.equal(helperRequestDefinitelyRefused({ code, status: 409 }), true);
    assert.equal(helperRequestDefinitelyRefused({ code, status: 503 }), false);
  }
  assert.equal(helperRequestDefinitelyRefused({ status: 404, code: "RECOVERY_HELPER_NOT_FOUND" }), false);
  assert.equal(helperRequestDefinitelyRefused(new Error("Lost acknowledgement")), false);
  assert.match(helperErrorCopy({ status: 429, code: "HELPER_LEDGER_BUDGET_EXHAUSTED" }), /spending limit/);
  assert.match(helperErrorCopy({ status: 404 }, { submitted: true }), /pair is locked/);
});

test("discovery is one read-only candidate request with no wallet, destination or hash input", async () => {
  const calls = [];
  await discoverHelperRecovery({ apiOrigin: "https://api.example", destination: other, fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return Response.json({ status: "exhausted" });
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/api/recovery/helper/discover");
  assert.deepEqual(JSON.parse(calls[0].body), {});
});

test("challenge and release serialize only their narrow request fields", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, ...options }); return Response.json({ accepted: true }); };
  await requestHelperChallenge({ requester, pair: { ...pair, destination: other }, destination: other, fetchImpl });
  assert.deepEqual(JSON.parse(calls[0].body), { requester, pair });
  await submitHelperRecovery({ challenge: { ...challenge(), destination: other, proof: "not-sent" }, signature: `0x${"e".repeat(130)}`, fetchImpl });
  assert.deepEqual(Object.keys(JSON.parse(calls[1].body)).sort(), ["requester", "sourceWallet", "pair", "operationId", "issuedAt", "expiresAt", "signature"].sort());
  assert.doesNotMatch(calls[1].body, /destination|message|proof|poolAddress/);
});

test("lost release acknowledgement never retries the signed POST", async () => {
  let requests = 0;
  await assert.rejects(submitHelperRecovery({ challenge: challenge(), signature: "signature", fetchImpl: async () => {
    requests += 1; throw new Error("connection closed after server admission");
  } }));
  assert.equal(requests, 1);
});

test("a rate-limited release requires explicit user action rather than an automatic POST loop", async () => {
  let requests = 0;
  await assert.rejects(submitHelperRecovery({ challenge: challenge(), signature: "signature", fetchImpl: async () => {
    requests += 1; return Response.json({ error: { code: "HELPER_LEDGER_BUDGET_EXHAUSTED", message: "No remaining budget" } }, { status: 429 });
  } }), { code: "HELPER_LEDGER_BUDGET_EXHAUSTED" });
  assert.equal(requests, 1);
});

test("resume/status requests use only GET and a canonical public identifier", async () => {
  const calls = [];
  await readHelperOperation({ operationId: challenge().operationId, fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return Response.json(operation());
  } });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, undefined);
  assert.equal(calls[0].cache, "no-store");
  assert.throws(() => readHelperOperation({ operationId: "../release" }));
});
