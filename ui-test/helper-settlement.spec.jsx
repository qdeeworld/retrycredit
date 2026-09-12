import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HelperRecoveryDesk } from "../web/src/HelperRecoveryDesk.jsx";
import { HelperEvidenceConflict } from "../web/src/HelperEvidenceConflict.jsx";

const mocks = vi.hoisted(() => ({ read: vi.fn(), check: vi.fn(), evidence: vi.fn(), lock: vi.fn(), submit: vi.fn(), challenge: vi.fn() }));
vi.mock("../web/src/api.mjs", () => ({ checkRecoveryPairEligibility: mocks.check }));
vi.mock("../web/src/recovery-helper-api.mjs", () => ({ readHelperOperation: mocks.read,
  discoverHelperRecovery: vi.fn(), submitHelperRecovery: mocks.submit, requestHelperChallenge: mocks.challenge }));
// Domain schema validation has separate tests. This test mounts the real component
// and exercises its asynchronous reconciliation, rendered outcome and actions.
vi.mock("../web/src/recovery-helper-state.mjs", async (original) => ({ ...(await original()),
  readHelperResume: () => saved, saveHelperResume: vi.fn(), clearHelperResume: vi.fn(),
  validateHelperOperation: (response) => {
    if (response.invalidIdentity) throw Object.assign(new Error("identity mismatch"), { code: "RECOVERY_RESPONSE_MISMATCH" });
    return response;
  } }));
vi.mock("../web/src/recovery-ui-state.mjs", async (original) => ({ ...(await original()),
  validatePairEligibilityResponse: ({ response }) => {
    if (response.invalidIdentity) throw new Error("invalid receipt identity");
    return response;
  } }));

const source = `0x${"1".repeat(40)}`;
const requester = `0x${"2".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const saved = { sourceWallet: source, requester, operationId: `0x${"c".repeat(64)}`,
  pair: { failedTransactionHash: hash, successfulTransactionHash: `0x${"b".repeat(64)}` }, createdAt: Date.now() };
const settled = { ...saved, state: "settled", transactionHash: hash, mode: "community-helper-v1", blockNumber: 12 };
const receipt = { wallet: source, status: "claimed", eligible: false, pair: saved.pair, release: { transactionHash: hash } };
const config = { poolAddress: source, campaignNumber: 1, campaign: { creditAmount: "100000000000000000" } };
let container, root;
beforeEach(() => {
  vi.clearAllMocks();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  mocks.read.mockResolvedValue(settled);
  mocks.check.mockResolvedValue(receipt);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount() {
  function Harness() {
    const [evidence, setEvidence] = React.useState({});
    const acceptEvidence = React.useCallback((value) => { mocks.evidence(value); setEvidence(value); }, []);
    return <><HelperRecoveryDesk
    config={config}
    configState="ready" account={requester} online apiOrigin="https://api.example"
    onConnect={vi.fn()} onOwnerPair={vi.fn()} onLockChange={mocks.lock} onEvidenceChange={acceptEvidence}
    TransactionField={({ id, label, disabled }) => <label>{label}<input id={id} disabled={disabled} /></label>} />
    {evidence.helperOperation?.receiptCheck === "conflict" && <HelperEvidenceConflict operation={evidence.helperOperation} />}</>;
  }
  await act(async () => root.render(<Harness />));
}
const heading = () => container.querySelector("h1").textContent;
const button = (text) => [...container.querySelectorAll("button")].find((item) => item.textContent.includes(text));
async function refresh() { await act(async () => button("Check public status").click()); }
function expectStatusOnly() {
  expect(button("Start another recovery")).toBeUndefined();
  expect(button("Check public status") ?? button("Checking public status")).toBeDefined();
  expect(mocks.lock).toHaveBeenLastCalledWith(true);
  expect(mocks.evidence.mock.lastCall[0].flow).not.toBe("released");
  expect(mocks.evidence.mock.lastCall[0].releaseResult).toBeNull();
  expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.challenge).not.toHaveBeenCalled();
}

test("backend settlement remains provisional while receipt is pending, then confirms", async () => {
  let resolve;
  mocks.check.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await mount();
  expect(heading()).toBe("Settlement reported — checking the receipt"); expectStatusOnly();
  await act(async () => resolve(receipt));
  expect(heading()).toBe("Credit reached the source wallet");
  expect(mocks.lock).toHaveBeenLastCalledWith(false);
  expect(button("Start another recovery")).toBeDefined();
  expect(mocks.evidence.mock.lastCall[0].flow).toBe("released");
});

test.each([
  { ...receipt, release: { transactionHash: `0x${"d".repeat(64)}` } },
  { ...receipt, wallet: requester },
  { ...receipt, status: "eligible" },
  { invalidIdentity: true },
])("conflicting receipt never renders unconditional success", async (conflict) => {
  mocks.check.mockResolvedValueOnce(conflict); await mount();
  expect(heading()).toBe("Recovery evidence does not match");
  expect(container.textContent).not.toContain("tCTC released to this source wallet");
  expect(container.querySelector('[role="alert"]').textContent).toContain("conflict");
  expect(container.querySelector(`a[href="https://etherscan.io/tx/${saved.pair.failedTransactionHash}"]`)).not.toBeNull();
  expect(container.querySelector(`a[href="https://etherscan.io/tx/${saved.pair.successfulTransactionHash}"]`)).not.toBeNull();
  expect(container.textContent).not.toContain("No analyzed source pair");
  expectStatusOnly();
  await refresh(); expect(heading()).toBe("Credit reached the source wallet");
});

test("first receipt outage keeps backend settlement provisional", async () => {
  mocks.check.mockRejectedValueOnce(new Error("offline")); await mount();
  expect(heading()).toBe("Settlement reported — checking the receipt");
  expect(container.textContent).toContain("not a confirmed failure"); expectStatusOnly();
});

test("outage after confirmation preserves prior evidence; later conflict retracts it", async () => {
  await mount(); mocks.check.mockRejectedValueOnce(new Error("offline")); await refresh();
  expect(heading()).toBe("Credit reached the source wallet");
  expect(container.textContent).toContain("earlier receipt check confirmed");
  mocks.check.mockResolvedValueOnce({ ...receipt, wallet: requester }); await refresh();
  expect(heading()).toBe("Recovery evidence does not match"); expectStatusOnly();
});

test("operation identity conflict also retracts an earlier success", async () => {
  await mount(); mocks.read.mockResolvedValueOnce({ invalidIdentity: true }); await refresh();
  expect(heading()).toBe("Recovery evidence does not match"); expectStatusOnly();
});

test.each(["mismatch", "422"])("first restored status rejection stays explicitly unconfirmed: %s", async (kind) => {
  if (kind === "mismatch") mocks.read.mockResolvedValueOnce({ invalidIdentity: true });
  else mocks.read.mockRejectedValueOnce(Object.assign(new Error("invalid operation"), { status: 422 }));
  await mount();
  expect(heading()).toBe("Recovery evidence does not match");
  expect(container.textContent).toContain("Recorded source · awaiting public confirmation");
  expect(container.textContent).not.toContain("Only credit recipient");
  expect(container.textContent).toContain("public identity has not been confirmed");
  expect(container.querySelector(`a[href="https://etherscan.io/tx/${saved.pair.failedTransactionHash}"]`)).not.toBeNull();
  expect(container.querySelector(`a[href="https://etherscan.io/tx/${saved.pair.successfulTransactionHash}"]`)).not.toBeNull();
  expectStatusOnly();
  await refresh(); expect(heading()).toBe("Credit reached the source wallet");
  expect(container.textContent).toContain("Only credit recipient");
});

test("a structured invalid-pair response is a conflict, not a transport outage", async () => {
  mocks.check.mockRejectedValueOnce(Object.assign(new Error("invalid pair"), { status: 422 }));
  await mount(); expect(heading()).toBe("Recovery evidence does not match"); expectStatusOnly();
  mocks.check.mockRejectedValueOnce(new Error("offline")); await refresh();
  expect(heading()).toBe("Recovery evidence does not match"); expectStatusOnly();
});

test("refreshing confirmed evidence disables starting another request until the check ends", async () => {
  await mount(); let resolve;
  mocks.check.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  await refresh();
  expect(button("Start another recovery").disabled).toBe(true);
  expect(mocks.lock).toHaveBeenLastCalledWith(true);
  await act(async () => resolve(receipt));
  expect(button("Start another recovery").disabled).toBe(false);
  expect(mocks.lock).toHaveBeenLastCalledWith(false);
});
