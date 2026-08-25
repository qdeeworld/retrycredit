import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import { Activity, ArrowRight, BookOpen, Check, CircleDollarSign, ExternalLink, Gauge, GitBranch, LoaderCircle, LockKeyhole, RefreshCw, Route, ShieldCheck, Wallet, X, Zap } from "lucide-react";
import { releaseWhenReady, requestJson, TemporaryUnavailableError, wakeConfig } from "./api.mjs";
import "./styles.css";

const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";
const CREDITCOIN_EXPLORER = "https://creditcoin-testnet.blockscout.com";
const API_ORIGIN = (import.meta.env.VITE_RETRYCREDIT_API_ORIGIN ?? "").replace(/\/+$/, "");
const STORAGE_KEY = "retrycredit-public-session-v2";
const HISTORICAL = {
  failed: "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
  successful: "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
  release: "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
};
const NAV_ITEMS = [
  { path: "/", label: "Recovery", icon: Route },
  { path: "/activity", label: "Activity", icon: Activity },
  { path: "/protocol", label: "Protocol", icon: BookOpen },
];

function App() {
  const path = usePathname();
  const previousPath = useRef(path);
  const [account, setAccount] = useState("");
  const [config, setConfig] = useState(null);
  const [availability, setAvailability] = useState("idle");
  const [session, setSession] = useState(readSession);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    window.ethereum.request({ method: "eth_accounts" }).then((items) => {
      if (items?.[0]) setAccount(getAddress(items[0]));
    }).catch(() => undefined);
    const changed = (items) => setAccount(items?.[0] ? getAddress(items[0]) : "");
    window.ethereum.on?.("accountsChanged", changed);
    return () => window.ethereum.removeListener?.("accountsChanged", changed);
  }, []);

  useEffect(() => {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  }, [session]);

  const phase = useMemo(() => currentPhase(session), [session]);
  const wrongWallet = Boolean(session?.beneficiary && account && session.beneficiary.toLowerCase() !== account.toLowerCase());

  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    document.getElementById("main-content")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [path]);

  async function connect() {
    if (!window.ethereum) throw new Error("Install an EVM wallet to run the public testnet journey");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const next = getAddress(accounts[0]);
    setAccount(next);
    return next;
  }

  async function act() {
    setBusy(true);
    setNotice(null);
    try {
      const wallet = account || await connect();
      if (session?.beneficiary && session.beneficiary.toLowerCase() !== wallet.toLowerCase()) throw new Error(`Reconnect ${short(session.beneficiary)} to resume this run`);
      const liveConfig = availability === "ready" && config ? config : await loadConfig();
      if (!liveConfig.enabled) throw new Error(session ? "The proof service is paused. Your saved recovery is unchanged; check again later." : "Sponsored service credits are replenishing. Check again shortly.");
      if (!session) {
        const challenge = await postJson("/api/retry-credit/challenge", { beneficiary: wallet });
        const signature = await window.ethereum.request({ method: "personal_sign", params: [hexlify(toUtf8Bytes(challenge.message)), wallet] });
        const prepared = await postJson("/api/retry-credit/prepare", { ...challenge, signature });
        setSession({ ...prepared, stage: "prepared", createdAt: Date.now() });
        setNotice({ tone: "success", text: "Your service credit is funded and both sponsored routes are committed." });
        return;
      }
      if (!session.failedTransactionHash) {
        const executed = await postJson(`/api/retry-credit/${session.serviceCreditNumber}/execute`, {});
        setSession((value) => value ? ({ ...value, stage: "settled", failedTransactionHash: executed.failedTransactionHash, successfulTransactionHash: executed.successfulTransactionHash, release: executed.release }) : value);
        setNotice({ tone: "success", text: executed.release ? "Your swap output and service credit arrived." : "The stale route was included, the refreshed swap settled, and Attestcoin is finalizing both receipts." });
        return;
      }
      const released = await releaseUntilReady(session);
      setSession((value) => value ? ({ ...value, stage: "released", release: released.release }) : value);
      setNotice({ tone: "success", text: "Credit released on Creditcoin. Replay is blocked onchain." });
    } catch (error) {
      if (error instanceof TemporaryUnavailableError || error?.temporaryUnavailable) setAvailability("temporarily-unavailable");
      setNotice({ tone: "error", text: cleanError(error) });
    } finally { setBusy(false); }
  }

  async function loadConfig() {
    setAvailability("waking");
    try {
      const next = await wakeConfig({ apiOrigin: API_ORIGIN });
      setConfig(next);
      setAvailability(next.enabled ? "ready" : "paused");
      return next;
    } catch (error) { setAvailability("temporarily-unavailable"); throw error; }
  }

  function startAnother() {
    setSession(null);
    setNotice({ tone: "success", text: "Saved browser state cleared. RetryCredit will resume any active onchain recovery or start a new one." });
  }

  const route = NAV_ITEMS.some((item) => item.path === path) ? path : "/";
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <AppRail route={route} />
    <div className="app-frame">
      <header className="statusbar">
        <div className="network-path"><GitBranch aria-hidden="true" /><span>Ethereum Sepolia</span><ArrowRight aria-hidden="true" /><span>Creditcoin Testnet</span></div>
        <span className={`service-state ${availability}`}><i aria-hidden="true" />{availabilityShortLabel(availability)}</span>
        <button className="wallet-button" onClick={() => connect().catch((error) => setNotice({ tone: "error", text: cleanError(error) }))}><Wallet aria-hidden="true" /> <span>{account ? short(account) : "Connect wallet"}</span></button>
      </header>
      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
      <main id="main-content" tabIndex="-1">
        {route === "/" && <RecoveryPage account={account} availability={availability} busy={busy} config={config} phase={phase} session={session} wrongWallet={wrongWallet} onAct={act} onReset={startAnother} />}
        {route === "/activity" && <ActivityPage session={session} />}
        {route === "/protocol" && <ProtocolPage />}
      </main>
      <footer className="app-footer"><span>RetryCredit public testnet pilot</span><a href="https://github.com/dolepee/retrycredit" target="_blank" rel="noreferrer">Source <ExternalLink aria-hidden="true" /></a></footer>
    </div>
    <MobileNav route={route} />
  </div>;
}

function AppRail({ route }) {
  return <aside className="app-rail"><AppLink className="brand" href="/" aria-label="RetryCredit recovery"><span className="brand-mark" aria-hidden="true">RC</span><span>RetryCredit</span></AppLink><nav aria-label="Primary navigation">{NAV_ITEMS.map(({ path, label, icon: Icon }) => <AppLink key={path} href={path} className={route === path ? "active" : ""} aria-current={route === path ? "page" : undefined}><Icon aria-hidden="true" /><span>{label}</span></AppLink>)}</nav><div className="rail-foot"><span>V3</span><small>TESTNET</small></div></aside>;
}
function MobileNav({ route }) { return <nav className="mobile-nav" aria-label="Mobile navigation">{NAV_ITEMS.map(({ path, label, icon: Icon }) => <AppLink key={path} href={path} className={route === path ? "active" : ""} aria-current={route === path ? "page" : undefined}><Icon aria-hidden="true" /><span>{label}</span></AppLink>)}</nav>; }

function RecoveryPage({ account, availability, busy, config, phase, session, wrongWallet, onAct, onReset }) {
  const stages = routeStages(phase, account, session);
  return <div className="workspace recovery-workspace">
    <header className="sheet-header"><div><h1>Clear one funded recovery</h1><p>Finish the swap without funding the retry. One ordered route moves from authorization to a fixed credit.</p></div><dl className="sheet-index"><div><dt>Sheet</dt><dd>{session?.serviceCreditNumber ? `RC-${String(session.serviceCreditNumber).padStart(6, "0")}` : "RC—NEW"}</dd></div><div><dt>Route class</dt><dd>Recovery</dd></div><div><dt>Status</dt><dd className={`stamp ${phase}`}>{routeStamp(phase)}</dd></div></dl></header>
    <section className="route-board" aria-labelledby="route-board-title"><h2 id="route-board-title" className="sr-only">Current recovery route</h2>{stages.map((stage, index) => <RoutePosition key={stage.label} {...stage} index={index} />)}</section>
    <section className="clearance-strip" aria-labelledby="clearance-title">
      <div className="service-register"><h2 id="clearance-title">Service availability</h2><ServiceAvailability availability={availability} hasSession={Boolean(session)} /><dl><div><dt>Wallet</dt><dd>{account ? short(account) : "Not connected"}</dd></div><div><dt>Deposit</dt><dd>None</dd></div><div><dt>Release</dt><dd>{config?.creditAmount ? formatEther(config.creditAmount) : "0.01"} tCTC</dd></div></dl></div>
      <div className="clearance-summary"><span>Current clearance</span><h2>{phaseTitle(phase)}</h2><p>{phaseCopy(phase)}</p><small><LockKeyhole aria-hidden="true" /> Your wallet signs the recipient only. The service sends the bounded testnet transactions.</small></div>
      <div className="action-bay" id="start">{wrongWallet && <div className="inline-warning" id="wrong-wallet-warning" role="alert">This saved run belongs to {short(session.beneficiary)}.</div>}<button className="primary-action" onClick={onAct} disabled={busy || wrongWallet || phase === "released"} aria-busy={busy} aria-describedby={wrongWallet ? "wrong-wallet-warning service-availability" : "service-availability"}>{busy ? <><LoaderCircle className="spin" aria-hidden="true" /> {busyLabel(phase, availability)}</> : <>{phaseIcon(phase)}<span>{phaseButton(phase, account, availability)}</span><ArrowRight aria-hidden="true" /></>}</button>{session && <button className="reset-action" onClick={onReset} disabled={busy}><RefreshCw aria-hidden="true" /> {phase === "released" ? "Clear local receipt" : "Restart saved run"}</button>}</div>
    </section>
    <div className="sheet-notes"><span>No mainnet asset or token approval</span><span>Gas and testnet input sponsored</span><span>Replay blocked onchain</span></div>
  </div>;
}

function RoutePosition({ index, label, meta, detail, state, tone }) {
  return <article className={`route-position ${state} ${tone ?? ""}`} aria-current={state === "current" ? "step" : undefined}><div className="position-heading"><span>{index + 1}</span><h3>{label}</h3><strong>{stateLabel(state, tone)}</strong></div><SwitchTrack index={index} state={state} tone={tone} /><dl><div><dt>State</dt><dd>{meta}</dd></div><div><dt>Result</dt><dd>{detail}</dd></div></dl></article>;
}

function SwitchTrack({ index, state, tone }) {
  const branches = [
    "M78 50 L116 18 H166 M78 50 L116 82 H166",
    "M48 50 L91 18 H142 M91 50 L134 82 H186",
    "M54 50 L90 18 H150 L186 50",
    "M42 50 L84 18 H142 M84 50 L128 82 H184",
    "M54 50 L98 18 H154 M98 50 L142 82 H194",
  ];
  return <div className="track" aria-hidden="true"><svg viewBox="0 0 240 100" preserveAspectRatio="none"><path className="track-main" d="M0 50 H240"/><path className={`track-branch branch-${index}`} d={branches[index]}/>{index === 0 && <rect className="track-terminal" x="4" y="34" width="16" height="32" />}{index === 4 && <rect className="track-terminal" x="220" y="34" width="16" height="32" />}{index === 2 && <path className="track-bypass" d="M55 50 L90 18 H150 L185 50" />}</svg><b>{tone === "blocked" ? <X /> : state === "done" ? <Check /> : <span />}</b></div>;
}

function ActivityPage({ session }) {
  return <div className="workspace activity-workspace"><header className="page-header"><div><h1>Recovery activity</h1><p>A route ledger for the saved browser run and the completed public lifecycle.</p></div><span>3 VERIFIED EVENTS</span></header><section className="current-run" aria-labelledby="current-run-title"><div><h2 id="current-run-title">Current browser run</h2><p>{session ? `Service credit #${session.serviceCreditNumber} is saved for ${short(session.beneficiary)}.` : "No recovery is saved in this browser."}</p>{session && (session.failedTransactionHash || session.successfulTransactionHash || session.release?.transactionHash) && <div className="saved-receipts" aria-label="Saved recovery receipts">{session.failedTransactionHash && <SavedReceipt label="Included stale route" hash={session.failedTransactionHash} base={SEPOLIA_EXPLORER} />}{session.successfulTransactionHash && <SavedReceipt label="Settled retry" hash={session.successfulTransactionHash} base={SEPOLIA_EXPLORER} />}{session.release?.transactionHash && <SavedReceipt label="Credit release" hash={session.release.transactionHash} base={CREDITCOIN_EXPLORER} />}</div>}</div><AppLink href="/">{session ? "Resume recovery" : "Start a recovery"}<ArrowRight aria-hidden="true" /></AppLink></section><section className="ledger" aria-labelledby="completed-run-title"><div className="ledger-head"><h2 id="completed-run-title">Completed public run</h2><p>From stale route to credit in 552 seconds.</p></div><LedgerRow time="00:00" tone="blocked" title="Route did not settle" chain="Ethereum Sepolia" result="Included · no swap" hash={HISTORICAL.failed} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.failed}`} /><LedgerRow time="00:31" tone="settled" title="Refreshed swap completed" chain="Ethereum Sepolia" result="0.218500 test USDC" hash={HISTORICAL.successful} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.successful}`} /><LedgerRow time="09:12" tone="released" title="Service credit received" chain="Creditcoin · 0.01 tCTC" result="Released once" hash={HISTORICAL.release} href={`${CREDITCOIN_EXPLORER}/tx/${HISTORICAL.release}`} /></section></div>;
}
function LedgerRow({ time, tone, title, chain, result, hash, href }) { return <a className={`ledger-row ${tone}`} href={href} target="_blank" rel="noreferrer" aria-label={`${title} on ${chain}; open transaction`}><time>{time}</time><i aria-hidden="true" /><div><strong>{title}</strong><span>{chain}</span></div><b>{result}</b><code title={hash}>{short(hash, 10)}</code><ExternalLink aria-hidden="true" /></a>; }
function SavedReceipt({ label, hash, base }) { return <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer"><span>{label}</span><code title={hash}>{short(hash, 8)}</code><ExternalLink aria-hidden="true" /></a>; }

function ProtocolPage() {
  return <div className="workspace protocol-workspace"><header className="page-header"><div><h1>The release boundary</h1><p>What RetryCredit verifies, what it cannot claim, and why two ordered receipts are required.</p></div><span>PUBLIC PILOT · V3</span></header><div className="protocol-layout"><article className="manual-copy"><h2>One funded action, two source receipts, one release.</h2><p>The service commits both signed Uniswap routes before execution. The first receipt must show the included stale attempt without settlement. The second must show the refreshed route and exact test-USDC output to the same beneficiary.</p><p>Attestcoin supplies those ordered receipts to the Creditcoin verifier. Only the matching pair can release the fixed credit, and the action, pair, query, and service-credit identifiers are consumed so the recovery cannot pay twice.</p><h2>What the proof does not establish</h2><p>RetryCredit does not determine the human-readable reason a transaction failed. It does not prove an organic user loss, exact gas expenditure, or an insurance event. The stale route in this pilot is a disclosed controlled test.</p></article><aside className="limits-sheet" aria-label="Current pilot limits"><h2>Current pilot</h2><dl><div><dt>Source</dt><dd>Ethereum Sepolia</dd></div><div><dt>Settlement</dt><dd>Creditcoin Testnet</dd></div><div><dt>Route</dt><dd>WETH → test USDC</dd></div><div><dt>Router</dt><dd>Uniswap Universal Router 2.1.1</dd></div><div><dt>Visitor funding</dt><dd>No deposit</dd></div><div><dt>Credit</dt><dd>Fixed · 0.01 tCTC</dd></div></dl></aside></div><section className="verification-line" aria-label="Verification sequence"><span><ShieldCheck aria-hidden="true" /><b>Commit</b>Both signed routes</span><ArrowRight aria-hidden="true" /><span><X aria-hidden="true" /><b>Include</b>No settlement</span><ArrowRight aria-hidden="true" /><span><Zap aria-hidden="true" /><b>Settle</b>Exact output</span><ArrowRight aria-hidden="true" /><span><CircleDollarSign aria-hidden="true" /><b>Release</b>Once</span></section></div>;
}

function ServiceAvailability({ availability, hasSession }) {
  const copy = { idle: hasSession ? "Your saved recovery stays in this browser. Service availability is checked when you resume." : "Service availability is checked when you start.", waking: "Waking the proof service — the first start can take up to about 45 seconds.", ready: "Proof service ready.", paused: hasSession ? "The proof service is paused. Your saved recovery is unchanged; check again later." : "Sponsored service credits are replenishing. Check again shortly.", "temporarily-unavailable": hasSession ? "The proof service did not respond yet. Your saved recovery is unchanged; try again." : "The proof service did not respond yet. Wake the service and try again." }[availability];
  return <p className={`service-availability ${availability}`} id="service-availability" role="status" aria-live="polite" aria-atomic="true"><i aria-hidden="true" />{copy}</p>;
}
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}><span>{tone === "error" ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}{text}</span><button onClick={onClose} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>; }
function AppLink({ href, onClick, ...props }) { return <a href={href} {...props} onClick={(event) => { onClick?.(event); if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); window.history.pushState({}, "", href); window.dispatchEvent(new PopStateEvent("popstate")); }} />; }
function usePathname() { const [path, setPath] = useState(() => window.location.pathname); useEffect(() => { const update = () => setPath(window.location.pathname); window.addEventListener("popstate", update); return () => window.removeEventListener("popstate", update); }, []); return path; }
function routeStages(phase, account, session) { const rank = { start: 0, prepared: 2, settled: 4, released: 5 }[phase]; const beneficiary = session?.beneficiary || account; return [
  { label: "Authorize", meta: beneficiary ? short(beneficiary) : "Wallet required", detail: beneficiary ? "Recipient selected" : "Connect to continue", state: rank > 0 ? "done" : "current" },
  { label: "Funded", meta: phase === "start" ? "Waiting" : "Service credit reserved", detail: phase === "start" ? "No route yet" : "Both routes committed", state: rank > 1 ? "done" : rank === 1 ? "current" : "future" },
  { label: "Stale included", meta: rank > 2 ? "Included on Sepolia" : "Expected failure", detail: rank > 2 ? "No swap output" : "Awaiting execution", state: rank > 2 ? "done" : rank === 2 ? "current" : "future", tone: "blocked" },
  { label: "Retry settled", meta: rank > 3 ? "Exact output matched" : "Refreshed route", detail: rank > 3 ? "test USDC received" : "Awaiting stale receipt", state: rank > 3 ? "done" : rank === 3 ? "current" : "future", tone: "settled" },
  { label: "Credit released", meta: rank > 4 ? "Released once" : "Attestcoin ordered pair", detail: rank > 4 ? "Replay blocked" : "Awaiting settlement", state: rank > 4 ? "done" : rank === 4 ? "current" : "future", tone: "released" },
]; }
function stateLabel(state, tone) { if (state === "current") return "CURRENT"; if (state === "future") return "QUEUED"; if (tone === "blocked") return "INCLUDED"; return "CLEARED"; }
function routeStamp(phase) { return ({ start: "NEW", prepared: "FUNDED", settled: "SETTLING", released: "RELEASED" })[phase]; }
function currentPhase(session) { if (!session) return "start"; if (session.release) return "released"; if (session.successfulTransactionHash) return "settled"; return "prepared"; }
function phaseTitle(phase) { return ({ start: "Recover a stale testnet swap.", prepared: "Run the sponsored retry.", settled: "Your swap settled. Finish the credit.", released: "Your service credit arrived." })[phase]; }
function phaseCopy(phase) { return ({ start: "Connect your wallet and authorize one bounded testnet recovery. RetryCredit pre-funds the credit and commits both sponsored routes before either is sent.", prepared: "RetryCredit will include the controlled stale route, refresh the quote, and send the settled test-USDC output to your wallet. No transaction is sent from your wallet.", settled: "Your test-USDC arrived on Sepolia. RetryCredit is checking both receipts together and releasing the fixed credit to the same address on Creditcoin Testnet.", released: "The swap output and fixed credit reached your wallet. This recovery cannot be paid twice." })[phase]; }
function availabilityShortLabel(availability) { return ({ idle: "Checked on start", waking: "Waking service", ready: "Service ready", paused: "Replenishing", "temporarily-unavailable": "Unavailable" })[availability]; }
function phaseButton(phase, account, availability) { if (phase === "start" && !account) return "Connect wallet to start"; if (availability === "temporarily-unavailable") return phase === "start" ? "Wake service and retry" : "Retry saved recovery"; if (availability === "paused") return phase === "start" ? "Check allocation again" : "Check service again"; if (phase === "start" && availability === "idle") return "Check availability and start"; return ({ start: "Start protected retry", prepared: "Run sponsored retry", settled: "Finish credit release", released: "Credit received" })[phase]; }
function busyLabel(phase, availability) { if (availability === "waking") return "Waking proof service…"; return ({ start: "Preparing your recovery…", prepared: "Running both routes…", settled: "Finalizing your credit…", released: "Checking saved receipt…" })[phase]; }
function phaseIcon(phase) { return phase === "released" ? <Check aria-hidden="true" /> : phase === "settled" ? <ShieldCheck aria-hidden="true" /> : phase === "start" ? <Gauge aria-hidden="true" /> : <Zap aria-hidden="true" />; }
async function releaseUntilReady(session) { return releaseWhenReady({ apiOrigin: API_ORIGIN, serviceCreditNumber: session.serviceCreditNumber, failedTransactionHash: session.failedTransactionHash, successfulTransactionHash: session.successfulTransactionHash }); }
async function postJson(path, body) { return requestJson({ apiOrigin: API_ORIGIN, path, options: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } }); }
function readSession() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); return value?.serviceCreditNumber && value?.beneficiary ? value : null; } catch { return null; } }
function short(value, size = 6) { return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : "—"; }
function cleanError(error) { return error?.shortMessage ?? error?.reason ?? error?.message ?? "Request failed"; }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
