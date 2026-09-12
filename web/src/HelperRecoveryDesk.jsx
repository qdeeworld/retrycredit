import React, { useEffect, useRef, useState } from "react";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import { AlertCircle, ArrowRight, Check, ChevronRight, ExternalLink, LoaderCircle, LockKeyhole, Search, Wallet } from "lucide-react";
import { checkRecoveryPairEligibility } from "./api.mjs";
import { discoverHelperRecovery, readHelperOperation, requestHelperChallenge, submitHelperRecovery } from "./recovery-helper-api.mjs";
import { canContinueHelperAuthorization, clearHelperResume, helperAdmissionAvailable, helperEnabled, helperErrorCopy, helperRequestDefinitelyRefused, readHelperResume, RECOVERY_HELPER_MODE, saveHelperResume, validateHelperChallenge, validateHelperDiscovery, validateHelperOperation } from "./recovery-helper-state.mjs";
import { recoveryCampaignsMatch, recoveryHostedAdmissionMessage, recoveryHostedAdmissionState, validatePairEligibilityResponse, validateRecoveryPairDraft, walletsMatch } from "./recovery-ui-state.mjs";
import { readRecoveryPairLink } from "./recovery-pair-handoff.mjs";
import { helperOutcomeResolved, helperSettlementConfirmed } from "./helper-settlement-view.mjs";

const EMPTY_PAIR = { failedTransactionHash: "", successfulTransactionHash: "" };
const POLL_INTERVAL_MS = 8_000;
const AUTO_POLL_WINDOW_MS = 15 * 60_000;

export function HelperRecoveryDesk({ config, configState, account, online, apiOrigin, onConnect, onOwnerPair, onLockChange, onEvidenceChange, TransactionField }) {
  const [draft, setDraft] = useState(() => readRecoveryPairLink(window.location.hash) ?? EMPTY_PAIR);
  const [errors, setErrors] = useState({});
  const [eligibility, setEligibility] = useState(null);
  const [operation, setOperation] = useState(null);
  const [phase, setPhase] = useState("empty");
  const [notice, setNotice] = useState("");
  const [discovery, setDiscovery] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const configRef = useRef(config);
  const previousConfig = useRef(config);
  const accountRef = useRef(account);
  const walletGeneration = useRef(0);
  const generation = useRef(0);
  const active = useRef(true);
  const actionBusy = useRef(false);
  const statusFlight = useRef(false);
  const submitted = useRef(null);
  const submittedConfig = useRef(null);
  const operationRef = useRef(null);
  const restoreAttempted = useRef(false);
  const statusReadRef = useRef(null);
  const connectRef = useRef(onConnect);
  configRef.current = config;
  accountRef.current = account;
  connectRef.current = onConnect;

  const busy = ["discovering", "checking", "connecting", "signing", "submitting"].includes(phase);
  const unresolved = Boolean(submitted.current && !helperOutcomeResolved(operation));
  const settlementConfirmed = helperSettlementConfirmed(operation);
  const locked = busy || unresolved || statusBusy;
  const available = configState === "ready" && helperAdmissionAvailable(config) && online;
  const pairAdmissionState = eligibility?.eligible ? recoveryHostedAdmissionState({ config, eligibility }) : "available";
  const pairAdmissionBlocked = pairAdmissionState !== "available";
  const display = helperDeskCopy({ phase, operation, eligibility, config, online });

  function setOperationState(next) {
    operationRef.current = next;
    setOperation(next);
  }
  function beginAction(nextPhase) {
    if (actionBusy.current || (submitted.current && !helperOutcomeResolved(operationRef.current))) return null;
    actionBusy.current = true;
    onLockChange(true);
    setPhase(nextPhase);
    setNotice("");
    return ++generation.current;
  }
  function finishAction(token) {
    if (token !== generation.current) return;
    actionBusy.current = false;
    // A changed campaign can invalidate an in-flight read before it publishes a
    // result. Never strand the panel in a busy state on that early-return path.
    setPhase((previous) => ["discovering", "checking", "connecting", "signing"].includes(previous) ? "empty" : previous);
    onLockChange(Boolean(submitted.current && !helperOutcomeResolved(operationRef.current)));
  }
  function current(token, initialConfig) {
    return active.current && token === generation.current && recoveryCampaignsMatch(initialConfig, configRef.current);
  }
  function focusHeading() {
    requestAnimationFrame(() => document.getElementById("eligibility-heading")?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return undefined;
    const changed = (accounts) => {
      if (!walletsMatch(accounts?.[0], accountRef.current)) walletGeneration.current += 1;
      accountRef.current = accounts?.[0] ?? "";
    };
    provider.on("accountsChanged", changed);
    return () => provider.removeListener?.("accountsChanged", changed);
  }, []);

  useEffect(() => {
    const previous = previousConfig.current;
    previousConfig.current = config;
    if (!previous || recoveryCampaignsMatch(previous, config)) return;
    if (submitted.current) {
      setNotice("The live campaign changed. This submitted operation remains bound to its original campaign and source pair; only its public status can be checked.");
      return;
    }
    generation.current += 1;
    actionBusy.current = false;
    onLockChange(false);
    setEligibility(null);
    setDiscovery(null);
    setPhase("empty");
    setNotice("Campaign configuration changed. Check the preserved pair again before requesting a recovery.");
  }, [config, onLockChange]);

  useEffect(() => {
    onEvidenceChange({ eligibility, flow: settlementConfirmed ? "released" : unresolved ? "release-processing" : eligibility ? "qualifying" : "empty",
      releaseResult: settlementConfirmed && eligibility?.release ? eligibility : null, helperOperation: operation });
  }, [eligibility, operation, unresolved, onEvidenceChange]);

  useEffect(() => {
    onLockChange(locked);
  }, [locked, onLockChange]);

  useEffect(() => {
    if (restoreAttempted.current || !config?.poolAddress) return;
    restoreAttempted.current = true;
    const saved = readHelperResume(config);
    if (!saved) return;
    submitted.current = saved;
    submittedConfig.current = config;
    onLockChange(true);
    setDraft(saved.pair);
    setPhase("uncertain");
    setNotice("Restoring only the public operation identity. Its durable status will be checked; no signature or release request is replayed.");
    void statusReadRef.current?.();
  }, [config?.poolAddress, config?.campaignNumber, onLockChange]);

  useEffect(() => {
    if (!online || !unresolved) return undefined;
    const tick = () => {
      if (document.visibilityState !== "visible" || Date.now() - submitted.current.createdAt >= AUTO_POLL_WINDOW_MS) return;
      void statusReadRef.current?.();
    };
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [online, unresolved]);

  useEffect(() => {
    function sharedPairChanged() {
      const pair = readRecoveryPairLink(window.location.hash);
      if (!pair) return;
      if (actionBusy.current || submitted.current) {
        setNotice("The shared link has not replaced this recovery. Finish checking its public status, then explicitly start another recovery.");
        return;
      }
      generation.current += 1;
      setDraft(pair);
      setErrors({});
      setEligibility(null);
      setPhase("empty");
      setNotice("The shared pair is prefilled only. Check it before requesting any recovery.");
    }
    window.addEventListener("hashchange", sharedPairChanged);
    return () => window.removeEventListener("hashchange", sharedPairChanged);
  }, []);

  async function discover() {
    if (!available) return;
    const token = beginAction("discovering");
    if (token === null) return;
    const initialConfig = configRef.current;
    setEligibility(null);
    setDiscovery(null);
    setErrors({});
    try {
      const response = validateHelperDiscovery(await discoverHelperRecovery({ apiOrigin }), initialConfig);
      if (!current(token, initialConfig)) return;
      setDiscovery(response);
      if (response.match) {
        setDraft(exactPair(response.match.pair));
        setEligibility(response.match);
        setPhase("eligible");
      } else setPhase(response.status);
      focusHeading();
    } catch (error) {
      if (!current(token, initialConfig)) return;
      setNotice(helperErrorCopy(error));
      setPhase("unavailable");
    } finally { finishAction(token); }
  }

  async function checkPair(event) {
    event.preventDefault();
    if (!available) return;
    const validation = validateRecoveryPairDraft(draft);
    setErrors(validation.errors);
    if (!validation.valid) {
      setPhase("invalid");
      document.getElementById(validation.errors.failedTransactionHash ? "helper-failed-transaction" : "helper-successful-transaction")?.focus();
      return;
    }
    const token = beginAction("checking");
    if (token === null) return;
    const initialConfig = configRef.current;
    setEligibility(null);
    try {
      const response = await checkRecoveryPairEligibility({ apiOrigin, pair: validation.pair });
      if (!current(token, initialConfig)) return;
      const result = validatePairEligibilityResponse({ response, requestedPair: validation.pair, config: initialConfig });
      setEligibility(result);
      setDraft(exactPair(result.pair));
      setPhase(result.eligible ? "eligible" : "unavailable-pair");
      focusHeading();
    } catch (error) {
      if (!current(token, initialConfig)) return;
      setNotice(error?.status === 422 ? "This pair does not match the funded recovery rule. Find another recovery or check the two source transactions." : helperErrorCopy(error));
      setPhase(error?.status === 422 ? "invalid" : "unavailable");
    } finally { finishAction(token); }
  }

  async function authorize() {
    if (!available || !eligibility?.eligible || eligibility.status !== "eligible") return;
    const admissionState = recoveryHostedAdmissionState({ config: configRef.current, eligibility });
    if (admissionState !== "available") {
      setNotice(recoveryHostedAdmissionMessage(admissionState));
      return;
    }
    const token = beginAction("connecting");
    if (token === null) return;
    const initialConfig = configRef.current;
    let sent = false;
    try {
      const requester = getAddress(await connectRef.current());
      if (!current(token, initialConfig)) return;
      if (walletsMatch(requester, eligibility.wallet)) {
        throw Object.assign(new Error("Use the source-owner recovery flow"), { code: "RECOVERY_HELPER_USE_OWNER_FLOW" });
      }
      // Read accounts after the wallet prompt too: account-change events may be
      // delivered before React commits the newly selected connected account.
      const selected = await window.ethereum.request({ method: "eth_accounts" });
      if (!walletsMatch(requester, selected?.[0])) throw new Error("Helper account changed");
      accountRef.current = requester;
      const walletVersion = walletGeneration.current;
      setPhase("signing");
      const response = await requestHelperChallenge({ apiOrigin, requester, pair: eligibility.pair });
      if (!current(token, initialConfig)) return;
      const challenge = validateHelperChallenge({ response, requester, eligibility, config: initialConfig, currentOrigin: window.location.origin });
      const canContinue = () => canContinueHelperAuthorization({ initialConfig, currentConfig: configRef.current,
        requester, currentAccount: accountRef.current, operationCurrent: current(token, initialConfig)
          && walletVersion === walletGeneration.current, expiresAt: challenge.expiresAt });
      if (!canContinue()) throw new Error("Helper authorization changed");
      const signature = await window.ethereum.request({ method: "personal_sign", params: [hexlify(toUtf8Bytes(challenge.message)), requester] });
      const accountsAfter = await window.ethereum.request({ method: "eth_accounts" });
      if (!canContinue() || !walletsMatch(accountsAfter?.[0], requester)) throw new Error("Helper account or campaign changed");
      // Persist the exact public identifier BEFORE the one-shot request. A lost
      // response or immediate reload must reconcile, never repeat this POST.
      const pending = { mode: RECOVERY_HELPER_MODE, requester, sourceWallet: challenge.sourceWallet, pair: challenge.pair,
        operationId: challenge.operationId, state: "submitted", createdAt: Date.now() };
      submitted.current = pending;
      submittedConfig.current = initialConfig;
      saveHelperResume(pending, initialConfig);
      setOperationState(null);
      setPhase("submitting");
      sent = true;
      const result = await submitHelperRecovery({ apiOrigin, challenge, signature });
      if (!active.current) return;
      acceptOperation(result, pending, initialConfig);
      void readStatus();
    } catch (error) {
      if (!active.current) return;
      if (sent && helperRequestDefinitelyRefused(error)) {
        submitted.current = null;
        submittedConfig.current = null;
        clearHelperResume();
        setOperationState(null);
        setNotice(helperErrorCopy(error));
        setPhase("eligible");
      } else if (sent) {
        setNotice(helperErrorCopy(error, { submitted: true }));
        setPhase("uncertain");
        void readStatus();
      } else if (current(token, initialConfig)) {
        setNotice(helperErrorCopy(error));
        setPhase("eligible");
      }
    } finally { finishAction(token); }
  }

  function acceptOperation(response, expected, initialConfig) {
    const result = validateHelperOperation(response, expected, initialConfig);
    const previous = operationRef.current;
    const receiptCheck = result.state === "settled"
      ? previous?.operationId === result.operationId && previous?.transactionHash === result.transactionHash
        ? previous.receiptCheck ?? "pending" : "pending"
      : null;
    setOperationState({ ...result, receiptCheck });
    saveHelperResume({ ...expected, state: result.state }, initialConfig);
    setPhase(result.state);
    setNotice(result.mode !== RECOVERY_HELPER_MODE || !walletsMatch(result.requester, expected.requester)
      ? "Another request already handles this exact source pair. No second recovery was started. The original recipient remains unchanged." : "");
    if (!helperOutcomeResolved({ ...result, receiptCheck })) onLockChange(true);
    return result;
  }

  async function readStatus() {
    const expected = submitted.current;
    if (!expected || statusFlight.current || !navigator.onLine) return;
    statusFlight.current = true;
    setStatusBusy(true);
    const initialConfig = submittedConfig.current ?? configRef.current;
    try {
      const response = await readHelperOperation({ apiOrigin, operationId: expected.operationId });
      if (!active.current || submitted.current?.operationId !== expected.operationId) return;
      const result = acceptOperation(response, expected, initialConfig);
      if (result.state === "settled") {
        const raw = await checkRecoveryPairEligibility({ apiOrigin, pair: expected.pair });
        if (!active.current || submitted.current?.operationId !== expected.operationId) return;
        let live;
        try {
          live = validatePairEligibilityResponse({ response: raw, requestedPair: expected.pair, config: initialConfig });
          if (live.status !== "claimed" || !walletsMatch(live.wallet, expected.sourceWallet)
            || live.release?.transactionHash?.toLowerCase() !== result.transactionHash.toLowerCase()) throw new Error("Receipt does not match operation");
        } catch (error) {
          throw Object.assign(error, { receiptConflict: true });
        }
        setEligibility(live);
        setOperationState({ ...result, receiptCheck: "confirmed" });
        onLockChange(false);
      }
    } catch (error) {
      if (!active.current || submitted.current?.operationId !== expected.operationId) return;
      if (error?.receiptConflict || error?.code === "RECOVERY_RESPONSE_MISMATCH" || error?.status === 422) {
        setEligibility(null);
        setOperationState({ ...(operationRef.current ?? {}), receiptCheck: "conflict" });
        setPhase("uncertain");
        onLockChange(true);
        setNotice("Public operation and receipt evidence conflict. Success is not confirmed. Keep this operation for status checks; do not sign another request.");
        return;
      }
      if (operationRef.current?.state === "settled") {
        if (!helperSettlementConfirmed(operationRef.current) && operationRef.current.receiptCheck !== "conflict") {
          setOperationState({ ...operationRef.current, receiptCheck: "unavailable" });
        }
        setNotice(helperSettlementConfirmed(operationRef.current)
          ? "The earlier receipt check confirmed this credit. The latest refresh is unavailable; this does not undo that confirmation."
          : "The receipt recheck is unavailable. Keep this operation and check status again without signing.");
        return;
      }
      setNotice(error?.status === 404
        ? "No durable admission is visible yet. The submitted request may still be reaching the service. This pair stays locked; check status again without signing."
        : helperErrorCopy(error, { submitted: true }));
    } finally {
      statusFlight.current = false;
      if (active.current) setStatusBusy(false);
    }
  }
  statusReadRef.current = readStatus;

  function startAnother() {
    if (!helperOutcomeResolved(operationRef.current) || actionBusy.current || statusFlight.current) return;
    generation.current += 1;
    submitted.current = null;
    submittedConfig.current = null;
    clearHelperResume();
    setOperationState(null);
    setEligibility(null);
    setDraft(EMPTY_PAIR);
    setNotice("");
    setDiscovery(null);
    setPhase("empty");
    onLockChange(false);
    focusHeading();
  }
  function edit(field, value) {
    if (locked || submitted.current) return;
    generation.current += 1;
    setDraft((previous) => ({ ...previous, [field]: value }));
    setErrors((previous) => ({ ...previous, [field]: undefined }));
    setEligibility(null);
    setPhase("empty");
    setNotice("");
  }

  const source = operation?.sourceWallet ?? submitted.current?.sourceWallet ?? eligibility?.wallet;
  const sourceConfirmed = Boolean(operation || eligibility);
  const connectedSource = !submitted.current && walletsMatch(account, source);
  const receipt = operation?.transactionHash;
  const creditConfig = submittedConfig.current ?? config;
  return <section className={`eligibility-desk helper-desk state-${settlementConfirmed ? "released" : locked ? "release-processing" : eligibility?.eligible ? "qualifying" : "empty"}`} aria-labelledby="eligibility-heading" aria-busy={busy || statusBusy}>
    <p className="helper-role-label">Community helper · source wallet receives the credit</p>
    <div className="desk-heading">
      <span className="state-mark" aria-hidden="true">{settlementConfirmed ? <Check /> : busy ? <LoaderCircle className="spin" /> : <ArrowRight />}</span>
      <div><h1 id="eligibility-heading" tabIndex="-1">{display.title}</h1><p role="status" aria-live="polite" aria-atomic="true">{display.body}</p></div>
    </div>

    {!submitted.current && !eligibility?.eligible && <div className="wallet-discovery">
      <button className="primary-action discovery-action" type="button" onClick={discover} disabled={!available || busy} aria-busy={phase === "discovering"} aria-describedby="helper-find-note">
        <span>{phase === "discovering" ? "Checking public recoveries" : discovery?.moreCandidates ? "Check another set of recoveries" : "Find a recovery to help with"}</span>
        {phase === "discovering" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
      </button>
      <p id="helper-find-note">No wallet or transaction hashes needed to search. Public candidates are advisory; each selected pair is independently checked.</p>
    </div>}

    {discovery && <p className="helper-search-receipt">{discovery.checkedCandidates} candidate{discovery.checkedCandidates === 1 ? "" : "s"} checked in this request · {discovery.totalCandidates} public pairs in this bounded catalog. These are source records, not users or promised payouts.</p>}

    {source && <div className="helper-recipient" role="note">
      <span className="helper-recipient-label">{sourceConfirmed ? "Only credit recipient" : "Recorded source · awaiting public confirmation"}</span><code>{source}</code>
      <p>{settlementConfirmed ? `${formatEther(creditConfig.campaign.creditAmount)} tCTC released to this source wallet.` : !sourceConfirmed ? "This locally restored identity has not yet been confirmed by the public operation status." : `${formatEther(creditConfig.campaign.creditAmount)} tCTC, if the native proof and final campaign checks pass.`}</p>
      <div className="helper-role-boundary"><strong>{connectedSource ? "This source wallet is connected." : "You receive no credit."}</strong><p>{connectedSource
        ? "Use the owner flow to request your own credit. The same pair can be carried over for a fresh check; no helper authorization is needed."
        : operation?.mode === "owner"
        ? "An existing source-owner request handles this pair. Your helper request did not create another release. A completed release uses that source wallet's one-time sponsor credit."
        : "Your signature requests a sponsor-funded recovery. It is not the recipient's consent. A completed release uses that source wallet's one-time sponsor credit."}</p></div>
    </div>}

    <details className="transaction-help helper-pair-details" open={Boolean(Object.keys(errors).some((key) => errors[key])) || undefined}>
      <summary><span>{source ? "Inspect the exact source pair" : "Advanced: enter an exact pair"}</span><ChevronRight aria-hidden="true" /></summary>
      <form className="pair-intake" onSubmit={checkPair} noValidate>
        <fieldset><legend>Ordered Ethereum pair</legend>
          <TransactionField disabled={locked || Boolean(submitted.current)} id="helper-failed-transaction" marker="A" label="Failed paid mint" helper="Public Ethereum hash or canonical etherscan.io transaction URL." value={draft.failedTransactionHash} error={errors.failedTransactionHash} onChange={(value) => edit("failedTransactionHash", value)} />
          <TransactionField disabled={locked || Boolean(submitted.current)} id="helper-successful-transaction" marker="B" label="Completed retry" helper="The later successful transaction from the same paid SeaDrop action." value={draft.successfulTransactionHash} error={errors.successfulTransactionHash} onChange={(value) => edit("successfulTransactionHash", value)} />
        </fieldset>
        {!submitted.current && <button className="example-action" type="submit" disabled={!available || busy}>Check exact pair <Search aria-hidden="true" /></button>}
      </form>
    </details>

    {notice && <div className="inline-notice" role="alert"><AlertCircle aria-hidden="true" /><span>{notice}</span></div>}

    {!submitted.current && eligibility?.eligible && <>
      <p className="helper-wallet-note">{account ? <>{connectedSource ? "Connected source owner" : "Connected helper"}: <code>{account}</code></> : "Connect your own wallet to request this recovery. You do not need Creditcoin funds or a network switch."}</p>
      <button className="primary-action authorization-action" type="button" onClick={connectedSource ? () => onOwnerPair(exactPair(eligibility.pair)) : authorize} disabled={busy || (!connectedSource && (!available || pairAdmissionBlocked))} aria-busy={busy} aria-describedby="helper-authorization-note">
        <span>{connectedSource ? "Continue with owner recovery" : pairAdmissionBlocked ? "Recovery admission unavailable" : phase === "connecting" ? "Connect your helper wallet" : phase === "signing" ? "Review helper request in your wallet" : account ? "Authorize recovery for this source wallet" : "Connect and help this source wallet"}</span>
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
      </button>
      <p id="helper-authorization-note" className="destination-note"><LockKeyhole aria-hidden="true" />{connectedSource ? "Switching to owner recovery only prefills this pair. You will check it again before any owner authorization." : pairAdmissionBlocked ? recoveryHostedAdmissionMessage(pairAdmissionState) : "Explicit helper signature only. The sponsor pays relayer gas; the contract fixes the source wallet as recipient."}</p>
      {pairAdmissionBlocked && <button className="example-action" type="button" onClick={checkPair} disabled={!available || busy}>Refresh recovery availability <Search aria-hidden="true" /></button>}
    </>}

    {submitted.current && <section className="helper-operation" aria-label="Public recovery operation">
      <dl><div><dt>Request role</dt><dd>{operation?.mode === "owner" ? "Source owner request" : "Community helper request"}</dd></div>
        <div><dt>Requester</dt><dd><code>{operation?.requester ?? submitted.current.requester}</code></dd></div>
        <div><dt>Public operation</dt><dd><code>{submitted.current.operationId}</code></dd></div></dl>
      {receipt && <a className="secondary-action" href={`https://creditcoin-testnet.blockscout.com/tx/${receipt}`} target="_blank" rel="noreferrer">{settlementConfirmed ? "Open credit release receipt" : operation.state === "reverted" ? "Open reverted transaction" : "Inspect recorded transaction"}<ExternalLink aria-hidden="true" /></a>}
      <button className="example-action" type="button" onClick={readStatus} disabled={!online || statusBusy} aria-busy={statusBusy}>{statusBusy ? "Checking public status" : "Check public status"}{statusBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}</button>
      <p>Status checks cannot authorize or repeat a release. Account changes do not change this operation&apos;s recipient.</p>
      {helperOutcomeResolved(operation) && <button className="secondary-action" type="button" onClick={startAnother} disabled={statusBusy}>Start another recovery <ArrowRight aria-hidden="true" /></button>}
    </section>}

    {!available && <p className="helper-availability-note" role="status">{!online ? "You are offline. The current pair is preserved; reconnect to check status." : !helperEnabled(config) ? "Helper admission is unavailable in this release. Saved operation identities remain available for status checks." : config?.helper?.admissionState === "budget-exhausted" ? "The bounded sponsor budget is fully allocated. Reserved capacity may not have been spent. New requests are disabled; existing operations can still be checked." : config?.helper?.admissionState === "busy" ? "The sponsor is processing another recovery. New requests are temporarily disabled." : "New helper requests are currently paused or the campaign is not open. Public status checks remain available."}</p>}
  </section>;
}

function exactPair(pair) { return { failedTransactionHash: pair.failedTransactionHash, successfulTransactionHash: pair.successfulTransactionHash }; }
function helperDeskCopy({ phase, operation, eligibility, online }) {
  if (operation?.receiptCheck === "conflict") return { title: "Recovery evidence does not match", body: "The public records conflict. This screen cannot confirm the credit; only status checks are available for this request." };
  if (operation?.state === "settled" && !helperSettlementConfirmed(operation)) return { title: "Settlement reported — checking the receipt", body: operation.receiptCheck === "unavailable" ? "The service reports settlement, but the receipt recheck is unavailable. This is not a confirmed failure or a reason to submit again." : "The service reports settlement. Checking the exact source recipient and release receipt before confirming the result." };
  if (operation?.state === "settled") return { title: "Credit reached the source wallet", body: "The durable operation confirms a successful Creditcoin release. The source wallet received the credit; the helper received nothing." };
  if (operation?.state === "reverted") return { title: "The release did not complete", body: "The transaction reverted. This operation will not be broadcast again, and no credit was released by it." };
  if (operation?.state === "stopped") return { title: "Stopped before broadcast", body: operation.reason === "fee-cap" ? "The estimated fee exceeded the pilot cap. No credit release was broadcast." : "The guarded recovery stopped before broadcast. This operation will not restart automatically." };
  if (operation?.state === "broadcast-prepared") return { title: "Checking the release outcome", body: "One exact transaction is durably recorded. Its broadcast or receipt may still be uncertain; no replacement is being signed." };
  if (operation?.state === "admitted") return { title: "Recovery request admitted", body: "The sponsor reserved bounded proof and gas capacity. The source-derived recipient cannot change while the native proof is prepared." };
  if (["submitting", "uncertain"].includes(phase)) return { title: "Checking this exact request", body: "Your submitted operation stays attached to its source pair. Public status checks do not send another recovery request." };
  if (!online) return { title: "Reconnect to continue", body: "Your source pair is preserved. Nothing new can be authorized while you are offline." };
  if (phase === "discovering") return { title: "Finding a recovery to help with", body: "Checking a small set of public source pairs against live receipts, campaign rules and prior recovery use." };
  if (phase === "checking") return { title: "Checking this source pair", body: "The same live eligibility checks apply to manual entry. No proof or release request has been sent." };
  if (phase === "none-in-window") return { title: "No available pair in this set", body: "This was a bounded search, not the whole catalog. Check another set or use an exact pair." };
  if (phase === "exhausted") return { title: "No available recovery found", body: "The checked catalog has no currently available pair. This does not mean all Ethereum history has been searched." };
  if (phase === "unavailable") return { title: "Public search could not finish", body: "An unavailable network or service is not an ineligible verdict. Try the search again when it is ready." };
  if (phase === "unavailable-pair") return { title: eligibility?.status === "claimed" ? "This source already recovered" : "This source pair cannot release now", body: "Prior use, campaign timing and capacity still apply to helpers. No second credit can be requested." };
  if (phase === "invalid") return { title: "Check the source pair", body: "Both exact transactions must match the funded failure-to-completion rule before a helper can proceed." };
  if (eligibility?.eligible) return { title: "Help this wallet receive its credit", body: "This public pair passed the live source checks. Connect your own wallet and review an explicit helper request; the original source remains the only recipient." };
  return { title: "Help a retry reach recovery", body: "Find a qualifying public retry and request its sponsor-funded credit. You can help without having a failed mint of your own." };
}
