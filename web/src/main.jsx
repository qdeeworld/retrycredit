import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { formatEther, getAddress, hexlify, toUtf8Bytes } from "ethers";
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FileCheck2,
  LoaderCircle,
  LockKeyhole,
  Radio,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import {
  checkRecoveryEligibility,
  releaseRecoveryWhenReady,
  recoveryClockNow,
  recoveryWallClockNow,
  requestRecoveryChallenge,
  TemporaryUnavailableError,
  wakeRecoveryConfig,
} from "./api.mjs";
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
} from "./recovery-ui-state.mjs";
import "./styles.css";

const ETHEREUM_EXPLORER = "https://etherscan.io";
const CREDITCOIN_EXPLORER = "https://creditcoin-testnet.blockscout.com";
const REPOSITORY = "https://github.com/dolepee/retrycredit";
const API_ORIGIN = (import.meta.env.VITE_RETRYCREDIT_API_ORIGIN ?? "").replace(/\/+$/, "");
const OPEN_SEA_ATTRIBUTION_SUFFIX = "0x3d958fe2";
const CONTROLLED_LAB = Object.freeze({
  failedTransactionHash: "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
  successfulTransactionHash: "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
  releaseTransactionHash: "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
});

const ROUTES = Object.freeze([
  { path: "/", label: "Recovery", icon: Radio },
  { path: "/cases", label: "Cases", icon: FileCheck2 },
  { path: "/protocol", label: "Protocol", icon: BookOpen },
]);

function App() {
  const path = usePathname();
  const previousPath = useRef(path);
  const checkedWallet = useRef("");
  const configRef = useRef(null);
  const walletOperations = useRef(null);
  if (!walletOperations.current) walletOperations.current = createWalletOperationGuard();
  const [account, setAccount] = useState("");
  const [config, setConfig] = useState(null);
  const [configState, setConfigState] = useState("loading");
  const [flow, setFlow] = useState("disconnected");
  const [eligibility, setEligibility] = useState(null);
  const [featuredEligibility, setFeaturedEligibility] = useState(null);
  const [releaseResult, setReleaseResult] = useState(null);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);

  const route = normalizeRoute(path);
  const busy = ["checking", "authorizing", "proof-pending"].includes(flow);
  const visibleRelease = selectVisibleRelease({ account, config, eligibility, releaseResult });

  useEffect(() => {
    let active = true;
    setConfigState("loading");
    wakeRecoveryConfig({ apiOrigin: API_ORIGIN })
      .then((next) => {
        if (!active) return;
        const validated = validateRecoveryConfigResponse(next);
        applyRecoveryConfig(validated);
        setConfigState(validated.enabled ? "ready" : "unavailable");
      })
      .catch(() => {
        if (active) setConfigState("unavailable");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    window.ethereum.request({ method: "eth_accounts" }).then((items) => {
      const next = safeAddress(items?.[0]);
      if (next && !walletOperations.current.currentAccount()) {
        updateConnectedAccount(next, { resetFlow: true });
      }
    }).catch(() => undefined);

    const changed = (items) => {
      const next = safeAddress(items?.[0]);
      updateConnectedAccount(next, { resetFlow: true });
    };
    window.ethereum.on?.("accountsChanged", changed);
    return () => window.ethereum.removeListener?.("accountsChanged", changed);
  }, []);

  useEffect(() => {
    const liveConfig = config;
    const wallet = liveConfig?.enabled ? liveConfig.featuredCase?.wallet : "";
    if (!wallet) {
      setFeaturedEligibility(null);
      return undefined;
    }
    setFeaturedEligibility(null);
    let active = true;
    checkRecoveryEligibility({ apiOrigin: API_ORIGIN, wallet })
      .then((result) => {
        const validated = validateEligibilityResponse({
          response: result,
          requestedWallet: wallet,
          config: liveConfig,
          expectedPair: liveConfig.featuredCase,
        });
        if (active && recoveryConfigsMatch(liveConfig, configRef.current)) {
          setFeaturedEligibility(validated);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [
    config?.enabled,
    config?.poolAddress,
    config?.campaignNumber,
    config?.publicOrigin,
    config?.settlement?.chainId,
    config?.campaign?.creditAmount,
    config?.featuredCase?.wallet,
    config?.featuredCase?.failedTransactionHash,
    config?.featuredCase?.successfulTransactionHash,
  ]);

  useEffect(() => {
    if (previousPath.current === path) return;
    previousPath.current = path;
    document.getElementById("main-content")?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [path]);

  async function refreshConfig() {
    if (!navigator.onLine) {
      setOnline(false);
      return null;
    }
    setConfigState("loading");
    setError("");
    try {
      const next = await wakeRecoveryConfig({ apiOrigin: API_ORIGIN });
      const validated = validateRecoveryConfigResponse(next);
      applyRecoveryConfig(validated);
      setConfigState(validated.enabled ? "ready" : "unavailable");
      return validated;
    } catch (nextError) {
      setConfigState("unavailable");
      setError(cleanError(nextError));
      return null;
    }
  }

  async function refreshAfterResponseMismatch(nextError, operation) {
    const next = await refreshConfig();
    if (!walletOperations.current.isCurrent(operation)) return;
    if (!next?.enabled) {
      setFlow("service-unavailable");
      return;
    }
    setError(cleanError(nextError));
    setFlow("retryable-error");
  }

  function applyRecoveryConfig(next) {
    const previous = configRef.current;
    const campaignChanged = Boolean(previous && !recoveryCampaignsMatch(previous, next));
    const featuredChanged = Boolean(previous && !recoveryConfigsMatch(previous, next));
    configRef.current = next;
    setConfig(next);
    if (featuredChanged) setFeaturedEligibility(null);
    if (!campaignChanged) return;

    const connected = walletOperations.current.currentAccount();
    walletOperations.current.begin(connected);
    checkedWallet.current = "";
    setEligibility(null);
    setReleaseResult(null);
    setError("");
    setFlow(connected ? "campaign-changed" : "disconnected");
  }

  function updateConnectedAccount(next, { resetFlow = false } = {}) {
    const guard = walletOperations.current;
    const previous = guard.currentAccount();
    const didChange = guard.setAccount(next);
    setAccount(next);
    if (!didChange || !resetFlow) return didChange;

    checkedWallet.current = "";
    setEligibility(null);
    setReleaseResult(null);
    setError("");
    setFlow(next ? (previous ? "account-changed" : "connected") : "disconnected");
    return didChange;
  }

  async function connectWallet() {
    if (!window.ethereum) throw new Error("Install an EVM wallet to check this Ethereum address.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const next = safeAddress(accounts?.[0]);
    if (!next) throw new Error("The wallet did not return an Ethereum address.");
    updateConnectedAccount(next, { resetFlow: true });
    return next;
  }

  async function checkWallet(wallet) {
    if (!online) return;
    const operation = walletOperations.current.begin(wallet);
    if (!walletOperations.current.isCurrent(operation)) return;
    setFlow("checking");
    setError("");
    try {
      const liveConfig = configState === "ready" ? config : await refreshConfig();
      if (!walletOperations.current.isCurrent(operation)) return;
      if (!liveConfig?.enabled) throw new TemporaryUnavailableError();
      const response = await checkRecoveryEligibility({ apiOrigin: API_ORIGIN, wallet });
      if (!walletOperations.current.isCurrent(operation)) return;
      const result = validateEligibilityResponse({ response, requestedWallet: wallet, config: liveConfig });
      checkedWallet.current = result.wallet;
      setEligibility(result);
      if (result.status === "claimed") {
        setReleaseResult(result);
        setFlow("already-claimed");
      } else if (result.eligible && result.status === "eligible") {
        setReleaseResult(null);
        setFlow("eligible");
      } else {
        setReleaseResult(null);
        setFlow("ineligible");
      }
    } catch (nextError) {
      if (!walletOperations.current.isCurrent(operation)) return;
      if (isRecoveryResponseMismatch(nextError)) {
        await refreshAfterResponseMismatch(nextError, operation);
        return;
      }
      setFlow(nextError instanceof TemporaryUnavailableError ? "service-unavailable" : "retryable-error");
      setError(cleanError(nextError));
    }
  }

  async function authorizeAndRelease() {
    if (!account || !eligibility?.eligible) return;
    if (checkedWallet.current.toLowerCase() !== account.toLowerCase()) {
      setEligibility(null);
      setFlow("account-changed");
      return;
    }
    const liveConfig = configRef.current;
    const liveEligibility = eligibility;
    if (!liveConfig?.enabled) {
      setFlow("service-unavailable");
      return;
    }
    if (!recoveryRecordMatchesConfig(liveEligibility, liveConfig)) {
      setEligibility(null);
      setReleaseResult(null);
      setFlow("campaign-changed");
      return;
    }
    const operation = walletOperations.current.begin(account);
    if (!walletOperations.current.isCurrent(operation)) return;
    setError("");
    try {
      setFlow("authorizing");
      const authorizationStartedAtMs = recoveryClockNow();
      const authorizationStartedAtWallMs = recoveryWallClockNow();
      const challengeResponse = await requestRecoveryChallenge({ apiOrigin: API_ORIGIN, wallet: account });
      if (!walletOperations.current.isCurrent(operation)) return;
      const challenge = validateChallengeResponse({
        response: challengeResponse,
        wallet: account,
        eligibility: liveEligibility,
        config: liveConfig,
        currentOrigin: window.location.origin,
      });
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [hexlify(toUtf8Bytes(challenge.message)), account],
      });
      if (!walletOperations.current.isCurrent(operation)) return;
      setFlow("proof-pending");
      const releaseResponse = await releaseRecoveryWhenReady({
        apiOrigin: API_ORIGIN,
        authorizationStartedAtMs,
        authorizationStartedAtWallMs,
        wallet: account,
        message: challenge.message,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        signature,
        onPending: () => {
          if (walletOperations.current.isCurrent(operation)) setFlow("proof-pending");
        },
      });
      if (!walletOperations.current.isCurrent(operation)) return;
      const released = validateReleaseResponse({
        response: releaseResponse,
        wallet: account,
        eligibility: liveEligibility,
        config: liveConfig,
      });
      setReleaseResult(released);
      setEligibility((value) => value ? { ...value, ...released, eligible: false } : released);
      setFlow(released.status === "claimed" ? "already-claimed" : "released");
      refreshConfig();
    } catch (nextError) {
      if (!walletOperations.current.isCurrent(operation)) return;
      if (isRecoveryResponseMismatch(nextError)) {
        await refreshAfterResponseMismatch(nextError, operation);
        return;
      } else if (isRecoveryChallengeExpired(nextError)) {
        setError(cleanError(nextError));
        setFlow("eligible");
        return;
      } else if (nextError?.code === 4001 || nextError?.code === "ACTION_REJECTED") {
        setError("The signature request was closed. Nothing was released; you can authorize again.");
      } else {
        setError(cleanError(nextError));
      }
      setFlow(nextError instanceof TemporaryUnavailableError ? "service-unavailable" : "retryable-error");
    }
  }

  async function primaryAction() {
    if (!online || busy || flow === "released" || flow === "already-claimed") return;
    if (configState === "loading") return;
    if (configState === "unavailable" || flow === "service-unavailable") {
      const next = await refreshConfig();
      if (!next?.enabled) return;
    }
    const wallet = account || await connectWallet().catch((nextError) => {
      setFlow("retryable-error");
      setError(cleanError(nextError));
      return "";
    });
    if (!wallet) return;
    if (flow === "eligible" && eligibility?.eligible) await authorizeAndRelease();
    else await checkWallet(wallet);
  }

  const effectiveFlow = !online
    ? "offline"
    : configState === "loading" && !["released", "already-claimed"].includes(flow)
      ? "loading-config"
      : configState === "unavailable" && !["released", "already-claimed"].includes(flow)
        ? "service-unavailable"
        : flow;

  const context = useMemo(() => ({
    account,
    busy,
    config,
    configState,
    eligibility,
    error,
    featuredEligibility,
    flow: effectiveFlow,
    online,
    releaseResult: visibleRelease,
  }), [account, busy, config, configState, effectiveFlow, eligibility, error, featuredEligibility, online, visibleRelease]);

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <AppHeader
      account={account}
      config={config}
      configState={configState}
      online={online}
      route={route}
      onConnect={() => connectWallet().catch((nextError) => {
        setFlow("retryable-error");
        setError(cleanError(nextError));
      })}
    />
    <main id="main-content" tabIndex="-1">
      {route === "/" && <RecoveryPage {...context} onPrimary={primaryAction} />}
      {route === "/cases" && <CasesPage {...context} />}
      {route === "/protocol" && <ProtocolPage config={config} />}
    </main>
    <footer className="app-footer">
      <span>Bounded public recovery pilot</span>
      <a href={REPOSITORY} target="_blank" rel="noreferrer">Open source <ExternalLink aria-hidden="true" /></a>
    </footer>
  </div>;
}

function AppHeader({ account, config, configState, online, route, onConnect }) {
  const service = !online ? "offline" : configState;
  return <header className="app-header">
    <div className="brand-line">
      <a className="brand" href="/" onClick={(event) => navigate(event, "/")}>
        <span aria-hidden="true">RC</span>
        <strong>RetryCredit</strong>
      </a>
      <div className="network-path" aria-label="Source and settlement networks">
        <span>{config?.source?.name ?? "Ethereum Mainnet"}</span>
        <ArrowRight aria-hidden="true" />
        <span>{config?.settlement?.name ?? "Creditcoin Testnet"}</span>
      </div>
      <div className={`service-state ${service}`} role="status" aria-live="polite">
        <i aria-hidden="true" /> {serviceLabel(service)}
      </div>
      <button className="wallet-button" type="button" onClick={onConnect}>
        <Wallet aria-hidden="true" />
        <span>{account ? short(account) : "Connect wallet"}</span>
      </button>
    </div>
    <nav aria-label="Primary">
      {ROUTES.map(({ path, label, icon: Icon }) => <a
        key={path}
        className={route === path ? "active" : ""}
        href={path}
        aria-current={route === path ? "page" : undefined}
        onClick={(event) => navigate(event, path)}
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </a>)}
    </nav>
  </header>;
}

function RecoveryPage(props) {
  const { config, eligibility, featuredEligibility, releaseResult } = props;
  return <div className="route-page recovery-page">
    <div className="campaign-layout">
      <CampaignFile config={config} />
      <EligibilityDesk {...props} />
    </div>
    <EvidenceBand config={config} eligibility={eligibility} featuredEligibility={featuredEligibility} releaseResult={releaseResult} />
    <section className="plain-boundary" aria-labelledby="boundary-heading">
      <h2 id="boundary-heading">The source wallet stays in control of the destination.</h2>
      <p>RetryCredit checks an already-public Ethereum pair. If it qualifies, the contract derives the payout wallet from that pair; the relayer cannot substitute another address.</p>
      <div className="boundary-line" aria-label="Recovery boundary">
        <span><Search aria-hidden="true" /> Match the pair</span>
        <ArrowRight aria-hidden="true" />
        <span><LockKeyhole aria-hidden="true" /> Sign bounded intent</span>
        <ArrowRight aria-hidden="true" />
        <span><ShieldCheck aria-hidden="true" /> Release once</span>
      </div>
    </section>
  </div>;
}

function CampaignFile({ config }) {
  const campaign = config?.campaign;
  const capacity = config?.capacity;
  return <section className="campaign-file" aria-labelledby="campaign-heading">
    <div className="file-registration" aria-hidden="true"><span /><span /><span /></div>
    <h1 id="campaign-heading">A completed mint can unlock one fixed credit.</h1>
    <p className="campaign-summary">This live campaign recognizes the same Ethereum wallet moving from a failed paid SeaDrop mint to its completed mint. RetryCredit pre-funds the bounded Creditcoin release.</p>
    <dl className="campaign-facts">
      <div>
        <dt>Fixed amount</dt>
        <dd>{formatCredit(campaign?.creditAmount)}</dd>
      </div>
      <div>
        <dt>Capacity</dt>
        <dd>{formatCapacity(capacity)}</dd>
      </div>
      <div>
        <dt>Source window</dt>
        <dd>{formatWindow(config?.rule)}</dd>
      </div>
      <div>
        <dt>Claim deadline</dt>
        <dd>{formatDeadline(campaign?.deadline)}</dd>
      </div>
    </dl>
    <p className="funding-note"><CircleDot aria-hidden="true" /> Campaign {config?.campaignNumber ? `#${config.campaignNumber}` : "awaiting publication"}. SeaDrop, OpenSea, and the NFT collection do not sponsor or endorse this pilot.</p>
  </section>;
}

function EligibilityDesk({ account, busy, configState, eligibility, error, flow, onPrimary, releaseResult }) {
  const copy = deskCopy(flow, eligibility, releaseResult);
  const isTerminal = flow === "released" || flow === "already-claimed";
  const disabled = busy || flow === "offline" || isTerminal || configState === "loading";
  return <section className={`eligibility-desk state-${flow}`} aria-labelledby="eligibility-heading" aria-busy={busy}>
    <div className="desk-heading">
      <span className="state-mark" aria-hidden="true">{stateIcon(flow)}</span>
      <div>
        <h2 id="eligibility-heading">{copy.title}</h2>
        <p role="status" aria-live="polite" aria-atomic="true">{copy.body}</p>
      </div>
    </div>

    <div className="wallet-readout">
      <span>Wallet under review</span>
      <code>{account || "No wallet connected"}</code>
    </div>

    {error && <div className="inline-notice" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{error}</span>
    </div>}

    {releaseResult?.release && <ReleaseReceipt result={releaseResult} />}

    <button className="primary-action" type="button" onClick={onPrimary} disabled={disabled} aria-busy={busy}>
      <span>{primaryLabel(flow, configState)}</span>
      {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : isTerminal ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
    </button>

    {flow === "ineligible" && <a className="secondary-action" href="/cases" onClick={(event) => navigate(event, "/cases")}>
      Inspect the public case <ChevronRight aria-hidden="true" />
    </a>}

    <p className="destination-note"><LockKeyhole aria-hidden="true" /> No destination field and no network switch. A qualifying source wallet receives the fixed tCTC release at that same address.</p>
  </section>;
}

function ReleaseReceipt({ result }) {
  return <div className="release-receipt">
    <strong>{formatCredit(result.creditAmount)} released</strong>
    <span>Beneficiary</span>
    <code>{result.wallet}</code>
    {result.release.transactionHash && <ExplorerLink chain="creditcoin" hash={result.release.transactionHash}>Open release receipt</ExplorerLink>}
  </div>;
}

function EvidenceBand({ config, eligibility, featuredEligibility, releaseResult }) {
  const evidence = selectRecoveryEvidence({
    config,
    eligibility,
    releaseResult,
    featuredEligibility,
    featuredCase: config?.featuredCase,
  });
  const { pair, release, wallet } = evidence;
  const paymentValue = formatEthValue(pair?.valueWei);
  const mintPrice = formatEthValue(pair?.mintPriceWei);
  return <section className="evidence-band" aria-labelledby="evidence-heading">
    <header>
      <h2 id="evidence-heading">One wallet. One ordered source pair. One fixed release.</h2>
      <p>Human result first; receipts stay attached to the result they establish.</p>
    </header>
    {!pair ? <div className="evidence-empty">
      <Radio aria-hidden="true" />
      <div>
        <strong>{eligibility ? "No qualifying pair is attached to this wallet result." : "No public source pair is available yet."}</strong>
        <p>{eligibility ? "RetryCredit does not borrow another wallet’s receipts. Inspect the separate public case from the eligibility desk." : "The evidence sequence will appear when the recovery service publishes a verified pair."}</p>
      </div>
    </div> : <div className="evidence-sequence">
      <EvidenceStep
        kind="failed"
        number="A"
        title="Mint did not complete"
        subtitle="Ethereum Mainnet · failed receipt"
        hash={pair.failedTransactionHash}
        chain="ethereum"
        facts={[
          pair.failed?.blockNumber !== undefined && `Block ${pair.failed.blockNumber}`,
          pair.failed?.nonce !== undefined && `Nonce ${pair.failed.nonce}`,
          paymentValue && `Payment value ${paymentValue}`,
          wallet && `Source ${short(wallet)}`,
        ]}
      />
      <div className="sequence-link" aria-hidden="true"><ArrowRight /></div>
      <EvidenceStep
        kind="completed"
        number="B"
        title="NFT mint completed"
        subtitle="Ethereum Mainnet · successful receipt"
        hash={pair.successfulTransactionHash}
        chain="ethereum"
        facts={[
          pair.successful?.blockNumber !== undefined && `Block ${pair.successful.blockNumber}`,
          pair.successful?.nonce !== undefined && `Nonce ${pair.successful.nonce}`,
          pair.quantity !== undefined && `Quantity ${pair.quantity}`,
          mintPrice && `Unit price ${mintPrice}`,
          pair.nftContract && `Collection ${pair.nftContract}`,
          formatMintOutcome(pair),
        ]}
      />
      <div className="sequence-link" aria-hidden="true"><ArrowRight /></div>
      <EvidenceStep
        kind={release ? "released" : "funded"}
        number="C"
        title={release ? "Fixed credit released" : "Fixed release is funded"}
        subtitle="Creditcoin Testnet · source-derived payout"
        hash={release?.transactionHash}
        chain="creditcoin"
        facts={[
          formatCredit(evidence.creditAmount ?? config?.campaign?.creditAmount),
          release?.blockNumber !== undefined && `Block ${release.blockNumber}`,
          release ? "Replay consumed" : "Eligibility required",
        ]}
      />
    </div>}
  </section>;
}

function EvidenceStep({ chain, facts, hash, kind, number, subtitle, title }) {
  return <article className={`evidence-step ${kind}`}>
    <div className="step-status"><span>{number}</span><b>{title}</b></div>
    <p>{subtitle}</p>
    <ul>{facts.filter(Boolean).map((fact) => <li key={fact}>{fact}</li>)}</ul>
    {hash
      ? <ExplorerLink chain={chain} hash={hash}>Open transaction</ExplorerLink>
      : <span className="receipt-pending">Receipt appears when this state exists</span>}
  </article>;
}

function CasesPage({ config, eligibility, featuredEligibility, releaseResult }) {
  const featured = config?.featuredCase;
  const featuredRelease = selectFeaturedRelease({
    config,
    eligibility,
    releaseResult,
    featuredEligibility,
  });
  return <div className="route-page cases-page">
    <PageHeading
      title="Cases stay separated by what they actually prove."
      body="A public source pair, broader eligible observations, and the earlier controlled lab are different evidence. RetryCredit does not turn an observed address into a customer claim."
    />

    <section className="case-register" aria-labelledby="public-case-heading">
      <header>
        <h2 id="public-case-heading">{featuredRelease ? "Public recovered case" : "Public recovery case"}</h2>
        <span className={featuredRelease ? "case-state released" : "case-state observed"}>{featuredRelease ? "Released" : "Source pair verified"}</span>
      </header>
      {featured ? <div className={`expanded-case${featuredRelease ? " has-release" : ""}`}>
        <div className="case-result">
          <strong>{featuredRelease ? "The source wallet received its fixed Creditcoin release." : "This wallet has a public failed-to-completed SeaDrop pair."}</strong>
          <p>{featuredRelease ? "The release transaction is bound to the same Ethereum source address." : "Eligibility and any release remain separate service states; the source facts alone are not adoption."}</p>
        </div>
        <CaseField label="Source wallet" value={featured.wallet} />
        <CaseField label="Failed mint" value={featured.failedTransactionHash} chain="ethereum" />
        <CaseField label="Completed mint" value={featured.successfulTransactionHash} chain="ethereum" />
        {featuredRelease?.transactionHash && <CaseField label="Credit release" value={featuredRelease.transactionHash} chain="creditcoin" />}
      </div> : <EmptyCase text="No public source case is published in the live configuration yet." />}
    </section>

    <section className="case-register" aria-labelledby="observations-heading">
      <header>
        <h2 id="observations-heading">Eligible observations</h2>
        <span className="case-state observed">Onchain records, not users</span>
      </header>
      <div className="observation-row">
        <Search aria-hidden="true" />
        <div>
          <strong>{formatDiscovery(config?.discoverySize)}</strong>
          <p>The bounded discovery set counts matching public transaction histories. It does not establish customers, demand, identity, or sponsorship.</p>
        </div>
      </div>
    </section>

    <section className="case-register controlled-lab" aria-labelledby="lab-heading">
      <header>
        <h2 id="lab-heading">Earlier Uniswap controlled lab</h2>
        <span className="case-state lab">Founder-operated testnet run</span>
      </header>
      <div className="lab-copy">
        <p>The previous route deliberately included a stale Uniswap transaction, settled a refreshed route, and released 0.01 tCTC. It remains expansion evidence, not a user or mainnet incident.</p>
        <div className="receipt-links">
          <ExplorerLink chain="sepolia" hash={CONTROLLED_LAB.failedTransactionHash}>Failed testnet route</ExplorerLink>
          <ExplorerLink chain="sepolia" hash={CONTROLLED_LAB.successfulTransactionHash}>Completed testnet route</ExplorerLink>
          <ExplorerLink chain="creditcoin" hash={CONTROLLED_LAB.releaseTransactionHash}>Testnet credit release</ExplorerLink>
        </div>
      </div>
    </section>
  </div>;
}

function ProtocolPage({ config }) {
  return <div className="route-page protocol-page">
    <PageHeading
      title="The predicate accepts one narrow kind of recovery."
      body="The campaign does not reward any failure and any later success. It verifies a dedicated paid SeaDrop pair, binds the source wallet, and consumes the exact evidence once."
    />
    <div className="protocol-layout">
      <article className="protocol-copy">
        <section>
          <h2>Exact paid SeaDrop action</h2>
          <p>Both Ethereum transactions must call canonical <code>mintSigned</code> on SeaDrop. The source wallet, collection, fee recipient, quantity, value, and stable mint parameters must match. Only the refreshed salt and signature may change.</p>
          <p>The OpenSea attribution suffix <code>{OPEN_SEA_ATTRIBUTION_SUFFIX}</code> is preserved and checked rather than discarded as arbitrary trailing calldata.</p>
        </section>
        <section>
          <h2>Failure before completion</h2>
          <p>The first receipt must fail without logs. The next source nonce must complete within the campaign’s block-gap limit, emit the exact SeaDrop mint event, and mint the expected token quantity to the payer.</p>
        </section>
        <section>
          <h2>Native batch, derived payout</h2>
          <p>Attestcoin verifies both Ethereum receipts as one native batch on Creditcoin using source chain key 3. The recovery contract derives the only beneficiary from the proven source wallet; neither the browser nor the relayer supplies a destination.</p>
        </section>
        <section>
          <h2>Fixed pool and replay boundary</h2>
          <p>Campaign funding, credit amount, slot count, source rule, and deadline are fixed at creation. Each wallet, transaction query, and pair can release once. After the deadline, only the unused campaign remainder can return to its sponsor.</p>
        </section>
        <section className="truth-limits">
          <h2>What the proof does not say</h2>
          <p>Attestcoin proves transaction inclusion and continuity. It does not prove a human-readable revert reason, the wallet owner’s identity, market demand, platform endorsement, insurance coverage, or an exact gas refund.</p>
        </section>
      </article>
      <aside className="protocol-register" aria-labelledby="register-heading">
        <h2 id="register-heading">Live boundary</h2>
        <dl>
          <ProtocolField label="Source" value={`${config?.source?.name ?? "Ethereum Mainnet"} · key ${config?.source?.chainKey ?? 3}`} />
          <ProtocolField label="Settlement" value={config?.settlement?.name ?? "Creditcoin Testnet"} />
          <ProtocolField label="Campaign" value={config?.campaignNumber ? `#${config.campaignNumber}` : "Not published"} />
          <ProtocolField label="Recovery pool" value={config?.poolAddress} />
          <ProtocolField label="Pair verifier" value={config?.verifierAddress} />
          <ProtocolField label="Predicate" value={config?.predicateAddress} />
          <ProtocolField label="Fee recipient" value={config?.rule?.feeRecipient} />
          <ProtocolField label="Terms hash" value={config?.campaign?.termsHash} />
        </dl>
      </aside>
    </div>
  </div>;
}

function PageHeading({ body, title }) {
  return <header className="page-heading">
    <h1>{title}</h1>
    <p>{body}</p>
  </header>;
}

function CaseField({ chain, label, value }) {
  return <div className="case-field">
    <span>{label}</span>
    <code>{value}</code>
    {chain && value && <ExplorerLink chain={chain} hash={value}>Inspect</ExplorerLink>}
  </div>;
}

function EmptyCase({ text }) {
  return <div className="empty-case"><Radio aria-hidden="true" /><p>{text}</p></div>;
}

function ProtocolField({ label, value }) {
  return <div><dt>{label}</dt><dd>{value ? <code>{value}</code> : "Awaiting live configuration"}</dd></div>;
}

function ExplorerLink({ chain, children, hash }) {
  const origins = {
    ethereum: ETHEREUM_EXPLORER,
    sepolia: "https://sepolia.etherscan.io",
    creditcoin: CREDITCOIN_EXPLORER,
  };
  return <a href={`${origins[chain]}/tx/${hash}`} target="_blank" rel="noreferrer">
    <span>{children}</span><ExternalLink aria-hidden="true" />
  </a>;
}

function deskCopy(flow, eligibility, releaseResult) {
  const copies = {
    "loading-config": ["Opening the campaign file", "Loading funding, capacity, and claim-window terms from the recovery service."],
    disconnected: ["Check this wallet", "Connect the Ethereum wallet that made both mint attempts. Checking is read-only."],
    connected: ["Wallet connected", "Check this Ethereum address against the live campaign. The eligibility check is read-only."],
    checking: ["Reading the source history", "RetryCredit is looking for the exact failed-to-completed pair inside the fixed campaign window."],
    ineligible: ["This wallet is outside this campaign", eligibility?.reason || "No qualifying pair was found in the bounded source window. The public case remains available to inspect."],
    eligible: ["This wallet can recover", `The source pair qualifies for ${formatCredit(eligibility?.creditAmount)}. One personal signature authorizes this fixed campaign release.`],
    authorizing: ["Authorization requested", "Confirm the bounded personal signature in your wallet. It cannot move Ethereum assets or choose another recipient."],
    "proof-pending": ["Building the native batch", "Attestcoin is proving the ordered Ethereum pair. RetryCredit will relay the fixed release when it is ready."],
    released: ["Credit reached the source wallet", `${formatCredit(releaseResult?.creditAmount)} was released once on Creditcoin Testnet.`],
    "already-claimed": ["This wallet already recovered", "The campaign recognizes the prior release and will not pay the same wallet or pair again."],
    "service-unavailable": ["The recovery service is unavailable", "Your wallet has not lost eligibility. Retry the service without reconnecting or changing networks."],
    "retryable-error": ["The action did not finish", "Your connected wallet and eligibility state are preserved. Read the notice, then retry the same step."],
    "account-changed": ["The connected wallet changed", "Check the new address before authorizing. RetryCredit will never reuse another wallet’s eligibility result."],
    "campaign-changed": ["The live campaign changed", "RetryCredit refreshed the campaign context. Check this wallet again before authorizing."],
    offline: ["You are offline", "Reconnect to the internet, then retry. No release request was sent while this browser was offline."],
  };
  const [title, body] = copies[flow] ?? copies.disconnected;
  return { title, body };
}

function primaryLabel(flow, configState) {
  if (configState === "loading") return "Loading live campaign";
  const labels = {
    disconnected: "Connect wallet and check",
    connected: "Check wallet eligibility",
    checking: "Checking Ethereum history",
    ineligible: "Check this wallet again",
    eligible: "Authorize fixed recovery",
    authorizing: "Confirm in your wallet",
    "proof-pending": "Building native proof",
    released: "Credit released",
    "already-claimed": "Already claimed",
    "service-unavailable": "Retry recovery service",
    "retryable-error": "Try the same step again",
    "account-changed": "Check this wallet",
    "campaign-changed": "Check against new campaign",
    offline: "Offline",
  };
  return labels[flow] ?? "Check wallet eligibility";
}

function stateIcon(flow) {
  if (flow === "released" || flow === "already-claimed") return <Check />;
  if (flow === "eligible") return <ShieldCheck />;
  if (["checking", "authorizing", "proof-pending", "loading-config"].includes(flow)) return <LoaderCircle className="spin" />;
  if (["ineligible", "retryable-error", "service-unavailable", "offline", "campaign-changed"].includes(flow)) return <AlertCircle />;
  return <Wallet />;
}

function formatCredit(value) {
  if (value === undefined || value === null || value === "") return "Amount pending";
  try {
    const formatted = formatEther(BigInt(value));
    return `${trimDecimal(formatted)} tCTC`;
  } catch {
    return `${value} tCTC`;
  }
}

function formatEthValue(value) {
  if (value === undefined || value === null || value === "") return null;
  try {
    return `${trimDecimal(formatEther(BigInt(value)))} ETH`;
  } catch {
    return null;
  }
}

function formatMintOutcome(pair) {
  const tokenIds = pair?.successful?.mintedTokenIds;
  if (tokenIds?.length) return `NFT outcome · ${tokenIds.length === 1 ? "token" : "tokens"} ${tokenIds.join(", ")}`;
  if (pair?.quantity !== undefined) {
    return `NFT outcome · ${pair.quantity} ${String(pair.quantity) === "1" ? "token" : "tokens"} minted`;
  }
  return "NFT outcome · mint event verified";
}

function formatCapacity(capacity) {
  if (!capacity) return "Capacity pending";
  return `${capacity.remaining} of ${capacity.total} slots remain`;
}

function formatWindow(rule) {
  if (!rule?.startBlock || !rule?.endBlock) return "Block window pending";
  return `${Number(rule.startBlock).toLocaleString()}–${Number(rule.endBlock).toLocaleString()}`;
}

function formatDeadline(value) {
  if (!value) return "Deadline pending";
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  const date = new Date(typeof numeric === "number" && numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  if (Number.isNaN(date.getTime())) return "Deadline pending";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function formatDiscovery(value) {
  if (!Number.isFinite(Number(value))) return "No discovery count is published yet.";
  return `${Number(value).toLocaleString()} matching source ${Number(value) === 1 ? "pair" : "pairs"} observed.`;
}

function trimDecimal(value) {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function serviceLabel(state) {
  return ({
    loading: "Loading campaign",
    ready: "Recovery live",
    unavailable: "Service unavailable",
    offline: "Browser offline",
  })[state] ?? "Checking service";
}

function cleanError(error) {
  if (error instanceof TemporaryUnavailableError || error?.temporaryUnavailable) {
    return "The recovery service did not answer in time. Retry without reconnecting your wallet.";
  }
  const message = String(error?.message ?? "The request could not be completed.");
  if (/ECONN|fetch|network|socket|127\.0\.0\.1/i.test(message)) {
    return "The recovery service could not be reached. Check your connection and try again.";
  }
  return message.length > 220 ? `${message.slice(0, 217)}…` : message;
}

function short(value) {
  if (!value || value.length < 14) return value || "—";
  return `${value.slice(0, 7)}…${value.slice(-5)}`;
}

function safeAddress(value) {
  if (!value) return "";
  try { return getAddress(value); } catch { return ""; }
}

function normalizeRoute(path) {
  if (path === "/activity") return "/cases";
  return ROUTES.some((item) => item.path === path) ? path : "/";
}

function navigate(event, path) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

function usePathname() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return path;
}

createRoot(document.getElementById("root")).render(<App />);
