import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import { ArrowRight, Check, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, Wallet, X, Zap } from "lucide-react";
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
    <header className="topbar">
      <a className="brand" href="#top" aria-label="RetryCredit home"><span className="brand-mark">R</span><span>RetryCredit</span></a>
      <nav aria-label="Primary navigation"><a href="#how-it-works">How it works</a><a href="#activity">Activity</a><a href="#safety">Safety</a></nav>
      <button className="wallet-button" onClick={() => connect().catch((error) => setNotice({ tone: "error", text: cleanError(error) }))}><Wallet size={16} aria-hidden="true" /> <span>{account ? short(account) : "Connect wallet"}</span></button>
    </header>
    {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
    <main id="top">
      <section className="hero">
        <div className="hero-copy"><div className="eyebrow"><span className="live-dot" /> STALE-SWAP RECOVERY · TESTNET</div><h1>Finish the swap.<br /><span>The retry earns the credit.</span></h1><p>RetryCredit completes a stale Uniswap swap to your wallet, then releases a fixed service credit after the refreshed route settles. Connect once; the testnet input and gas are sponsored.</p><div className="hero-actions"><a className="hero-action" href="#start"><Zap aria-hidden="true" /> Start a recovery</a><a className="hero-activity-link" href="#activity">See recent activity</a></div><div className="hero-tags"><span>Official Uniswap route</span><span>Fixed recovery credit</span><span>One wallet · no deposit</span></div></div>
        <div className="credit-card"><span>Sponsored recovery credit</span><strong>{config?.creditAmount ? formatEther(config.creditAmount) : "0.01"} <small>tCTC</small></strong><div><ShieldCheck size={16} aria-hidden="true" /> Pre-funded before your routes execute</div></div>
      </section>
      <section className="journey" id="how-it-works">
        <div className="journey-map">
          <JourneyStep number="01" title="Route goes stale" copy="Included · no swap" state={phaseIndex(phase) >= 1 ? "done" : "current"} /><ArrowRight aria-hidden="true" />
          <JourneyStep number="02" title="Quote refreshes" copy="Swap completes" state={phaseIndex(phase) >= 2 ? "done" : "future"} /><ArrowRight aria-hidden="true" />
          <JourneyStep number="03" title="Receipts confirm" copy="Both attempts checked" state={phaseIndex(phase) >= 3 ? "done" : phaseIndex(phase) === 2 ? "current" : "future"} /><ArrowRight aria-hidden="true" />
          <JourneyStep number="04" title="Credit arrives" copy="Released once" state={phase === "released" ? "done" : "future"} />
        </div>
        <div className="action-grid">
          <div className="action-copy"><div className="eyebrow">YOUR RECOVERY</div><h2>{phaseTitle(phase)}</h2><p>{phaseCopy(phase)}</p><ul><li><Check aria-hidden="true" /> Testnets only; no mainnet asset or token approval</li><li><Check aria-hidden="true" /> Gas, swap input, and one fixed credit are sponsored</li><li><Check aria-hidden="true" /> One wallet signature names the credit recipient</li></ul></div>
          <div className="action-panel" id="start">
            {wrongWallet && <div className="inline-warning" id="wrong-wallet-warning" role="alert">This saved run belongs to {short(session.beneficiary)}.</div>}
            <RunStatus session={session} account={account} availability={availability} />
            <ServiceAvailability availability={availability} hasSession={Boolean(session)} />
            <details className="verification-details"><summary>How this recovery is verified</summary><p>The first included route must fail without settlement. The refreshed route must complete through the bound Uniswap pool. RetryCredit then checks both receipts together before releasing one credit.</p></details>
            <button className="primary" onClick={act} disabled={busy || wrongWallet} aria-busy={busy} aria-describedby={wrongWallet ? "wrong-wallet-warning service-availability" : "service-availability"}>{busy ? <><LoaderCircle className="spin" aria-hidden="true" /> {busyLabel(phase, availability)}</> : <>{phaseIcon(phase)} {phaseButton(phase, account, availability)}</>}</button>
            <small className="transaction-note">The service sends two bounded Sepolia transactions from its own test wallet. The first is expected to fail after inclusion; your wallet never deposits funds or approves a token.</small>
            {session && <button className="secondary" onClick={startAnother} disabled={busy}><RefreshCw aria-hidden="true" /> {phase === "released" ? "Clear local receipt" : "Restart saved run"}</button>}
          </div>
        </div>
      </section>
      <section className="activity" id="activity"><div className="section-heading"><div className="eyebrow">RECENT RECOVERY</div><h2>From stale route to credit in 552 seconds.</h2><p>Every completed recovery leaves a simple activity trail you can open on the relevant network.</p></div><div className="receipt-grid"><Receipt title="Route did not settle" chain="Ethereum Sepolia" hash={HISTORICAL.failed} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.failed}`} /><Receipt title="Refreshed swap completed" chain="Sepolia · 0.218500 test USDC" hash={HISTORICAL.successful} href={`${SEPOLIA_EXPLORER}/tx/${HISTORICAL.successful}`} /><Receipt title="Service credit received" chain="Creditcoin · 0.01 tCTC" hash={HISTORICAL.release} href={`${CREDITCOIN_EXPLORER}/tx/${HISTORICAL.release}`} /></div></section>
      <section className="boundaries" id="safety"><div><div className="eyebrow">SAFETY AND LIMITS</div><h2>A bounded testnet recovery—not custody or insurance.</h2></div><div className="boundary-grid"><p><Check aria-hidden="true" /> The same wallet and funded action bind both routes.</p><p><Check aria-hidden="true" /> No credit is released until the refreshed swap settles.</p><p><Check aria-hidden="true" /> The exact Uniswap swap and test-USDC transfer must match.</p><p><Check aria-hidden="true" /> The same recovery cannot release a second credit.</p></div><div className="truth-note"><strong>Current pilot.</strong> RetryCredit verifies receipt state and settlement, not the human-readable reason a route failed. It uses Sepolia, Creditcoin Testnet, test USDC, and tCTC—not production assets or insurance.</div></section>
    </main>
    <footer><span>RetryCredit public testnet pilot</span><span>DeFi · Ethereum Sepolia → Creditcoin</span><a href="https://github.com/dolepee/retrycredit" target="_blank" rel="noreferrer">Source <ExternalLink size={13} aria-hidden="true" /></a></footer>
  </div>;
}

function JourneyStep({ number, title, copy, state }) { return <div className={`journey-step ${state}`}><span>{state === "done" ? <Check aria-hidden="true" /> : number}</span><div><strong>{title}</strong><small>{copy}</small></div></div>; }
function RunStatus({ session, account, availability }) {
  if (!session) return <div className="run-status"><span>Wallet</span><strong>{account ? short(account) : "Not connected"}</strong><span>Allocation</span><strong>{availabilityLabel(availability)}</strong></div>;
  return <div className="run-status"><span>Service credit</span><strong>#{session.serviceCreditNumber}</strong><span>Recipient</span><strong>{short(session.beneficiary)}</strong><span>Source window</span><strong>{session.sourceWindow.startBlock.toLocaleString()}–{session.sourceWindow.endBlock.toLocaleString()}</strong>{session.failedTransactionHash && <><span>Failed route</span><ExplorerHash hash={session.failedTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.successfulTransactionHash && <><span>Settled route</span><ExplorerHash hash={session.successfulTransactionHash} base={SEPOLIA_EXPLORER} /></>}{session.release?.transactionHash && <><span>Credit release</span><ExplorerHash hash={session.release.transactionHash} base={CREDITCOIN_EXPLORER} /></>}</div>;
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
function Receipt({ title, chain, hash, href }) { return <a className="receipt" href={href} target="_blank" rel="noreferrer"><div><span>{title}</span><strong>{chain}</strong><code>{short(hash, 10)}</code></div><ExternalLink aria-hidden="true" /></a>; }
function ExplorerHash({ hash, base }) { return <a href={`${base}/tx/${hash}`} target="_blank" rel="noreferrer">{short(hash, 8)} <ExternalLink aria-hidden="true" /></a>; }
function Notice({ tone, text, onClose }) { return <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}><span>{tone === "error" ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}{text}</span><button onClick={onClose} aria-label="Dismiss message"><X aria-hidden="true" /></button></div>; }
function currentPhase(session) { if (!session) return "start"; if (session.release) return "released"; if (session.successfulTransactionHash) return "settled"; return "prepared"; }
function phaseIndex(phase) { return ({ start: 0, prepared: 0, settled: 2, released: 4 })[phase] ?? 0; }
function phaseTitle(phase) { return ({ start: "Recover a stale testnet swap.", prepared: "Run the sponsored retry.", settled: "Your swap settled. Finish the credit.", released: "Your service credit arrived." })[phase]; }
function phaseCopy(phase) { return ({ start: "Connect your wallet and authorize one bounded testnet recovery. RetryCredit pre-funds the credit and commits both sponsored routes before either is sent.", prepared: "RetryCredit will include the controlled stale route, refresh the quote, and send the settled test-USDC output to your wallet. No transaction is sent from your wallet.", settled: "Your test-USDC arrived on Sepolia. RetryCredit is checking both receipts together and releasing the fixed credit to the same address on Creditcoin Testnet.", released: "The swap output and fixed credit reached your wallet. This recovery cannot be paid twice." })[phase]; }
function availabilityLabel(availability) { return ({ idle: "Checked when you start", waking: "Waking service", ready: "Available while funded", paused: "Replenishing", "temporarily-unavailable": "Temporarily unavailable" })[availability]; }
function phaseButton(phase, account, availability) { if (phase === "start" && !account) return "Connect wallet to start"; if (availability === "temporarily-unavailable") return phase === "start" ? "Wake service and retry" : "Retry saved recovery"; if (availability === "paused") return phase === "start" ? "Check allocation again" : "Check service again"; if (phase === "start" && availability === "idle") return "Check availability and start"; return ({ start: "Start protected retry", prepared: "Run sponsored retry", settled: "Finish credit release", released: "Credit received" })[phase]; }
function busyLabel(phase, availability) { if (availability === "waking") return "Waking proof service…"; return ({ start: "Preparing your recovery…", prepared: "Running both routes…", settled: "Finalizing your credit…", released: "Checking saved receipt…" })[phase]; }
function phaseIcon(phase) { return phase === "released" ? <Check aria-hidden="true" /> : phase === "settled" ? <ShieldCheck aria-hidden="true" /> : phase === "start" ? <Zap aria-hidden="true" /> : <ArrowRight aria-hidden="true" />; }

async function releaseUntilReady(session) { return releaseWhenReady({ apiOrigin: API_ORIGIN, serviceCreditNumber: session.serviceCreditNumber, failedTransactionHash: session.failedTransactionHash, successfulTransactionHash: session.successfulTransactionHash }); }
async function postJson(path, body) { return requestJson({ apiOrigin: API_ORIGIN, path, options: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } }); }
function readSession() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY)); return value?.serviceCreditNumber && value?.beneficiary ? value : null; } catch { return null; } }
function short(value, size = 6) { return value ? `${value.slice(0, size + 2)}…${value.slice(-4)}` : "—"; }
function cleanError(error) { return error?.shortMessage ?? error?.reason ?? error?.message ?? "Request failed"; }

createRoot(document.getElementById("root")).render(<React.StrictMode><App /></React.StrictMode>);
