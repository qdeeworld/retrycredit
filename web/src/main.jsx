import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import { ArrowRight, Check, CircleDollarSign, ExternalLink, LoaderCircle, LockKeyhole, RefreshCw, Route, ShieldCheck, Wallet, X, Zap } from "lucide-react";
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

function App() {
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
      if (session?.beneficiary && session.beneficiary.toLowerCase() !== wallet.toLowerCase()) {
        throw new Error(`Reconnect ${short(session.beneficiary)} to resume this run`);
      }
      const liveConfig = availability === "ready" && config ? config : await loadConfig();
      if (!liveConfig.enabled) {
        throw new Error(session
          ? "The proof service is paused. Your saved recovery is unchanged; check again later."
          : "Sponsored service credits are replenishing. Check again shortly.");
      }
      if (!session) {
        const challenge = await postJson("/api/retry-credit/challenge", { beneficiary: wallet });
        const signature = await window.ethereum.request({
          method: "personal_sign",
          params: [hexlify(toUtf8Bytes(challenge.message)), wallet],
        });
        const prepared = await postJson("/api/retry-credit/prepare", { ...challenge, signature });
        setSession({ ...prepared, stage: "prepared", createdAt: Date.now() });
        setNotice({ tone: "success", text: "Your service credit is funded and both sponsored routes are committed." });
        return;
      }
      if (!session.failedTransactionHash) {
        const executed = await postJson(`/api/retry-credit/${session.serviceCreditNumber}/execute`, {});
        setSession((value) => value ? ({
          ...value,
          stage: "settled",
          failedTransactionHash: executed.failedTransactionHash,
          successfulTransactionHash: executed.successfulTransactionHash,
          release: executed.release,
        }) : value);
        setNotice({ tone: "success", text: executed.release ? "Your swap output and service credit arrived." : "The stale route was included, the refreshed swap settled, and Attestcoin is finalizing both receipts." });
        return;
      }
      const released = await releaseUntilReady(session);
      setSession((value) => value ? ({ ...value, stage: "released", release: released.release }) : value);
      setNotice({ tone: "success", text: "Credit released on Creditcoin. Replay is blocked onchain." });
    } catch (error) {
      if (error instanceof TemporaryUnavailableError || error?.temporaryUnavailable) {
        setAvailability("temporarily-unavailable");
      }
      setNotice({ tone: "error", text: cleanError(error) });
    } finally {
      setBusy(false);
    }
  }

  async function loadConfig() {
    setAvailability("waking");
    try {
      const next = await wakeConfig({ apiOrigin: API_ORIGIN });
      setConfig(next);
      setAvailability(next.enabled ? "ready" : "paused");
      return next;
    } catch (error) {
      setAvailability("temporarily-unavailable");
      throw error;
    }
  }

  function startAnother() {
    setSession(null);
    setNotice({ tone: "success", text: "Saved browser state cleared. RetryCredit will resume any active onchain recovery or start a new one." });
  }

  return <div className="app-shell">
    <a className="skip-link" href="#start">Skip to recovery</a>
    <header className="topbar">
      <a className="brand" href="#top" aria-label="RetryCredit home"><span className="brand-mark" aria-hidden="true">RC</span><span>RetryCredit</span><small>TESTNET</small></a>
      <nav aria-label="Primary navigation"><a href="#how-it-works">Recovery route</a><a href="#activity">Activity</a><a href="#safety">Limits</a></nav>
      <button className="wallet-button" onClick={() => connect().catch((error) => setNotice({ tone: "error", text: cleanError(error) }))}><Wallet size={16} aria-hidden="true" /> <span>{account ? short(account) : "Connect wallet"}</span></button>
    </header>
    {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
    <main id="top">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow"><span className="live-dot" /> SPONSORED STALE-SWAP RECOVERY</div>
          <h1>The retry pays<br />for the <em>failure.</em></h1>
          <p className="hero-lead"><strong>Finish the swap without funding the retry.</strong> RetryCredit includes the stale route, refreshes it through Uniswap, and releases one fixed service credit after settlement.</p>
          <div className="hero-actions"><a className="hero-action" href="#start"><Zap aria-hidden="true" /> Start a recovery <ArrowRight aria-hidden="true" /></a><a className="hero-activity-link" href="#how-it-works">See the route</a></div>
          <dl className="hero-facts"><div><dt>Wallet cost</dt><dd>No deposit</dd></div><div><dt>Networks</dt><dd>Testnets</dd></div><div><dt>Recovery credit</dt><dd>{config?.creditAmount ? formatEther(config.creditAmount) : "0.01"} tCTC</dd></div></dl>
        </div>
        <div className="action-panel" id="start">
            <div className="console-topline"><div><span className="eyebrow">YOUR RECOVERY</span><span className="console-network">Ethereum Sepolia → Creditcoin</span></div><span className={`availability-chip ${availability}`}>{availabilityShortLabel(availability)}</span></div>
            <h2>{phaseTitle(phase)}</h2>
            {wrongWallet && <div className="inline-warning" id="wrong-wallet-warning" role="alert">This saved run belongs to {short(session.beneficiary)}.</div>}
            <ServiceAvailability availability={availability} hasSession={Boolean(session)} />
            <button className="primary" onClick={act} disabled={busy || wrongWallet} aria-busy={busy} aria-describedby={wrongWallet ? "wrong-wallet-warning service-availability" : "service-availability"}>{busy ? <><LoaderCircle className="spin" aria-hidden="true" /> {busyLabel(phase, availability)}</> : <>{phaseIcon(phase)} {phaseButton(phase, account, availability)}</>}</button>
            <p className="phase-copy">{phaseCopy(phase)}</p>
            <small className="transaction-note"><LockKeyhole aria-hidden="true" /> Your wallet signs the recipient only. The service sends the bounded testnet transactions.</small>
            <RunStatus session={session} account={account} availability={availability} />
            {session && <button className="secondary" onClick={startAnother} disabled={busy}><RefreshCw aria-hidden="true" /> {phase === "released" ? "Clear local receipt" : "Restart saved run"}</button>}
        </div>
      </section>
      <section className="journey" id="how-it-works" aria-labelledby="route-title">
        <div className="section-intro"><div><div className="eyebrow">ONE BOUNDED ROUTE</div><h2 id="route-title">Failure is included. Settlement is earned.</h2></div><p>The stale attempt and refreshed swap are bound to the same funded action. Only a matching settlement can unlock the credit.</p></div>
        <div className="journey-map">
          <JourneyStep number="01" icon={<X aria-hidden="true" />} kicker="EXPECTED FAILURE" title="Stale route is included" copy="No swap output; no credit yet" state={phase === "settled" || phase === "released" ? "done failure" : "current failure"} />
          <ArrowRight aria-hidden="true" />
          <JourneyStep number="02" icon={<Route aria-hidden="true" />} kicker="REFRESHED ROUTE" title="The swap settles" copy="Bound Uniswap output reaches you" state={phase === "settled" || phase === "released" ? "done" : "future"} />
          <ArrowRight aria-hidden="true" />
          <JourneyStep number="03" icon={<CircleDollarSign aria-hidden="true" />} kicker="FIXED RELEASE" title="The credit arrives" copy="Released once on Creditcoin" state={phase === "released" ? "done" : phase === "settled" ? "current" : "future"} />
        </div>
        <div className="route-terms"><span><Check aria-hidden="true" /> No mainnet asset or token approval</span><span><Check aria-hidden="true" /> Gas and testnet input sponsored</span><span><Check aria-hidden="true" /> Replay blocked onchain</span></div>
      </section>
      <section className="activity" id="activity"><div className="section-heading"><div className="eyebrow">COMPLETED RECOVERY</div><h2>From stale route to credit in 552 seconds.</h2><p>This completed run shows the exact progression from included failure to settlement and fixed credit.</p></div><div className="receipt-grid"><Receipt index="01" tone="failure" title="Route did not settle" chain="Ethereum Sepolia" detail="Included · no swap" hash={HISTORICAL.failed} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.failed}`} /><Receipt index="02" tone="settled" title="Refreshed swap completed" chain="Ethereum Sepolia" detail="0.218500 test USDC" hash={HISTORICAL.successful} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.successful}`} /><Receipt index="03" tone="credit" title="Service credit received" chain="Creditcoin · 0.01 tCTC" detail="Released once" hash={HISTORICAL.release} href={`${CREDITCOIN_EXPLORER}/tx/${HISTORICAL.release}`} /></div></section>
      <section className="boundaries" id="safety"><div className="boundary-heading"><div className="eyebrow">THE HARD BOUNDARY</div><h2>A recovery mechanism.<br />Not custody or insurance.</h2><p>RetryCredit verifies transaction receipts and settlement state. It does not determine the human-readable reason a route failed.</p></div><div className="boundary-content"><div className="boundary-grid"><p><ShieldCheck aria-hidden="true" /><span><strong>Same funded action</strong>Both attempts are committed before execution.</span></p><p><ShieldCheck aria-hidden="true" /><span><strong>Settlement first</strong>No credit releases until the refreshed swap settles.</span></p><p><ShieldCheck aria-hidden="true" /><span><strong>Exact output match</strong>The Uniswap swap and test-USDC transfer must match.</span></p><p><ShieldCheck aria-hidden="true" /><span><strong>One release only</strong>The same recovery cannot pay a second credit.</span></p></div><details className="verification-details"><summary>How this recovery is verified</summary><p>The first included route must fail without settlement. The refreshed route must complete through the bound Uniswap pool. RetryCredit checks both receipts together before releasing one credit.</p></details><div className="truth-note"><strong>Current pilot</strong><span>Sepolia, Creditcoin Testnet, test USDC, and tCTC only. No production assets or insurance.</span></div></div></section>
    </main>
    <footer><span>RetryCredit public testnet pilot</span><span>DeFi · Ethereum Sepolia → Creditcoin</span><a href="https://github.com/dolepee/retrycredit" target="_blank" rel="noreferrer">Source <ExternalLink size={13} aria-hidden="true" /></a></footer>
  </div>;
}

function JourneyStep({ number, icon, kicker, title, copy, state }) { return <div className={`journey-step ${state}`}><div className="step-index"><span>{number}</span>{state.includes("done") ? <Check aria-hidden="true" /> : icon}</div><div><small>{kicker}</small><strong>{title}</strong><p>{copy}</p></div></div>; }
function RunStatus({ session, account, availability }) {
  if (!session) return <div className="run-status"><span>Wallet</span><strong>{account ? short(account) : "Not connected"}</strong><span>Allocation</span><strong>{availabilityLabel(availability)}</strong></div>;
  const hasSourceWindow = session.sourceWindow?.startBlock != null && session.sourceWindow?.endBlock != null;
  return <div className="run-status"><span>Service credit</span><strong>#{session.serviceCreditNumber}</strong><span>Recipient</span><strong>{short(session.beneficiary)}</strong>{hasSourceWindow && <><span>Source window</span><strong>{session.sourceWindow.startBlock.toLocaleString()}–{session.sourceWindow.endBlock.toLocaleString()}</strong></>}{session.failedTransactionHash && <><span>Failed route</span><ExplorerHash hash={session.failedTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.successfulTransactionHash && <><span>Settled route</span><ExplorerHash hash={session.successfulTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.release?.transactionHash && <><span>Credit release</span><ExplorerHash hash={session.release.transactionHash} base={CREDITCOIN_EXPLORER} /></>}</div>;
}
function ServiceAvailability({ availability, hasSession }) {
  const copy = {
    idle: hasSession ? "Your saved recovery stays in this browser. Service availability is checked when you resume." : "Service availability is checked when you start.",
    waking: "Waking the proof service — the first start can take up to about 45 seconds.",
    ready: "Proof service ready.",
    paused: hasSession ? "The proof service is paused. Your saved recovery is unchanged; check again later." : "Sponsored service credits are replenishing. Check again shortly.",
    "temporarily-unavailable": hasSession ? "The proof service did not respond yet. Your saved recovery is unchanged; try again." : "The proof service did not respond yet. Wake the service and try again.",
  }[availability];
  return <p className={`service-availability ${availability}`} id="service-availability" role="status" aria-live="polite" aria-atomic="true">{copy}</p>;
}
function Receipt({ index, tone, title, chain, detail, hash, href }) { return <a className={`receipt ${tone}`} href={href} target="_blank" rel="noreferrer" aria-label={`${title} on ${chain}; open transaction`}><span className="receipt-index">{index}</span><div><span>{title}</span><strong>{detail}</strong><small>{chain}</small><code title={hash}>{short(hash, 10)}</code></div><ExternalLink aria-hidden="true" /></a>; }
function ExplorerHash({ hash, base }) { return <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash, 8)} <ExternalLink aria-hidden="true" /></a>; }
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}><span>{tone === "error" ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}{text}</span><button onClick={onClose} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>; }
function currentPhase(session) { if (!session) return "start"; if (session.release) return "released"; if (session.successfulTransactionHash) return "settled"; return "prepared"; }
function phaseTitle(phase) { return ({ start: "Recover a stale testnet swap.", prepared: "Run the sponsored retry.", settled: "Your swap settled. Finish the credit.", released: "Your service credit arrived." })[phase]; }
function phaseCopy(phase) { return ({ start: "Connect your wallet and authorize one bounded testnet recovery. RetryCredit pre-funds the credit and commits both sponsored routes before either is sent.", prepared: "RetryCredit will include the controlled stale route, refresh the quote, and send the settled test-USDC output to your wallet. No transaction is sent from your wallet.", settled: "Your test-USDC arrived on Sepolia. RetryCredit is checking both receipts together and releasing the fixed credit to the same address on Creditcoin Testnet.", released: "The swap output and fixed credit reached your wallet. This recovery cannot be paid twice." })[phase]; }
function availabilityLabel(availability) { return ({ idle: "Checked when you start", waking: "Waking service", ready: "Available while funded", paused: "Replenishing", "temporarily-unavailable": "Temporarily unavailable" })[availability]; }
function availabilityShortLabel(availability) { return ({ idle: "Checked on start", waking: "Waking", ready: "Service ready", paused: "Replenishing", "temporarily-unavailable": "Unavailable" })[availability]; }
function phaseButton(phase, account, availability) { if (phase === "start" && !account) return "Connect wallet to start"; if (availability === "temporarily-unavailable") return phase === "start" ? "Wake service and retry" : "Retry saved recovery"; if (availability === "paused") return phase === "start" ? "Check allocation again" : "Check service again"; if (phase === "start" && availability === "idle") return "Check availability and start"; return ({ start: "Start protected retry", prepared: "Run sponsored retry", settled: "Finish credit release", released: "Credit received" })[phase]; }
function busyLabel(phase, availability) { if (availability === "waking") return "Waking proof service…"; return ({ start: "Preparing your recovery…", prepared: "Running both routes…", settled: "Finalizing your credit…", released: "Checking saved receipt…" })[phase]; }
function phaseIcon(phase) { return phase === "released" ? <Check aria-hidden="true" /> : phase === "settled" ? <ShieldCheck aria-hidden="true" /> : phase === "start" ? <Zap aria-hidden="true" /> : <ArrowRight aria-hidden="true" />; }

async function releaseUntilReady(session) { return releaseWhenReady({ apiOrigin: API_ORIGIN, serviceCreditNumber: session.serviceCreditNumber, failedTransactionHash: session.failedTransactionHash, successfulTransactionHash: session.successfulTransactionHash }); }
async function postJson(path, body) { return requestJson({ apiOrigin: API_ORIGIN, path, options: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } }); }
function readSession() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); return value?.serviceCreditNumber && value?.beneficiary ? value : null; } catch { return null; } }
function short(value, size = 6) { return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : "—"; }
function cleanError(error) { return error?.shortMessage ?? error?.reason ?? error?.message ?? "Request failed"; }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
