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
  checkRecoveryPairEligibility,
  createRecoveryFreshReadAuthorization,
  discoverRecoveryWallet,
  releaseRecoveryPairWhenReady,
  recoveryClockNow,
  recoveryWallClockNow,
  requestRecoveryIntakeChallenge,
  TemporaryUnavailableError,
  wakeRecoveryConfig,
} from "./api.mjs";
import {
  canContinueRecoveryAuthorization,
  createPairOperationGuard,
  createWalletOperationGuard,
  isRecoveryConfigReadable,
  isRecoveryChallengeExpired,
  isRecoveryFreshAuthorizationRejected,
  isRecoveryFreshAuthorizationUsed,
  isRecoveryPairInvalid,
  isRecoveryRateLimited,
  isRecoveryResponseMismatch,
  normalizeEthereumTransactionReference,
  recoveryCampaignAvailability,
  recoveryCampaignsMatch,
  recoveryAuthorizationInterruptionFlow,
  recoveryEligibleAccountUpdateFlow,
  recoveryEligibleInspectionFlow,
  recoveryRecordMatchesConfig,
  recoveryConfigsMatch,
  selectDiscoveryAttribution,
  selectFeaturedRelease,
  selectRecoveryEvidence,
  validateChallengeResponse,
  validatePairEligibilityResponse,
  validatePairReleaseResponse,
  validateRecoveryPairDraft,
  validateRecoveryConfigResponse,
  walletsMatch,
} from "./recovery-ui-state.mjs";
import {
  clearRecoveryResumeState,
  loadRecoveryResumeCandidate,
  loadRecoveryResumeState,
  saveRecoveryResumeState,
} from "./recovery-resume-state.mjs";
import { buildRecoveryCampaignManifest, RECOVERY_ADAPTERS } from "./recovery-campaign-manifest.mjs";
import "./styles.css";

const ETHEREUM_EXPLORER = "https://etherscan.io";
const CREDITCOIN_EXPLORER = "https://creditcoin-testnet.blockscout.com";
const REPOSITORY = "https://github.com/qdeeworld/retrycredit";
const API_ORIGIN = (import.meta.env.VITE_RETRYCREDIT_API_ORIGIN ?? "").replace(/\/+$/, "");
const OPEN_SEA_ATTRIBUTION_SUFFIX = "0x3d958fe2";
const CONFIG_REFRESH_INTERVAL_MS = 30_000;
const CONTROLLED_LAB = Object.freeze({
  failedTransactionHash: "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
  successfulTransactionHash: "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
  releaseTransactionHash: "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
});
const EMPTY_PAIR_DRAFT = Object.freeze({ failedTransactionHash: "", successfulTransactionHash: "" });

const ROUTES = Object.freeze([
  {
    path: "/",
    label: "Recovery",
    icon: Radio,
    documentTitle: "RetryCredit | Check a paid retry for recovery",
    headingId: "eligibility-heading",
  },
  {
    path: "/cases",
    label: "Cases",
    icon: FileCheck2,
    documentTitle: "RetryCredit | Public recovery cases",
    headingId: "cases-heading",
  },
  {
    path: "/protocol",
    label: "Protocol",
    icon: BookOpen,
    documentTitle: "RetryCredit | Recovery protocol",
    headingId: "protocol-heading",
  },
]);

function App() {
  const path = usePathname();
  const previousRoute = useRef(null);
  const configRef = useRef(null);
  const configFlight = useRef(null);
  const eligibilityRef = useRef(null);
  const flowRef = useRef("empty");
  const pairDraftRef = useRef(EMPTY_PAIR_DRAFT);
  const pairOperations = useRef(null);
  const walletOperations = useRef(null);
  const authorizationInFlight = useRef(false);
  const resumeReconciliation = useRef("");
  const submittedRecoveryStartedAt = useRef(null);
  const previousDeskFlow = useRef("empty");
  if (!pairOperations.current) pairOperations.current = createPairOperationGuard();
  if (!walletOperations.current) walletOperations.current = createWalletOperationGuard();
  const [account, setAccount] = useState("");
  const [config, setConfig] = useState(null);
  const [configState, setConfigState] = useState("loading");
  const [flow, setFlow] = useState("empty");
  const [pairDraft, setPairDraft] = useState(EMPTY_PAIR_DRAFT);
  const [pairErrors, setPairErrors] = useState({});
  const [eligibility, setEligibility] = useState(null);
  const [featuredEligibility, setFeaturedEligibility] = useState(null);
  const [featuredState, setFeaturedState] = useState("idle");
  const [releaseResult, setReleaseResult] = useState(null);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [discoveryResult, setDiscoveryResult] = useState(null);
  const [, setCampaignClock] = useState(() => Date.now());

  const route = normalizeRoute(path);
  const busy = isBusyFlow(flow) || authorizationPending;
  const visibleRelease = releaseResult?.release
    ? releaseResult
    : eligibility?.release
      ? { ...eligibility, status: "claimed" }
      : null;

  function updateFlow(next) {
    flowRef.current = next;
    setFlow(next);
  }

  function updateEligibility(next) {
    eligibilityRef.current = next;
    setEligibility(next);
  }

  function persistSubmittedRecovery(status, record = eligibilityRef.current) {
    const liveConfig = configRef.current;
    const release = record?.release;
    if (!liveConfig?.enabled || !record?.wallet || !record?.pair) return null;
    return saveRecoveryResumeState({
      status,
      createdAt: submittedRecoveryStartedAt.current ?? undefined,
      poolAddress: liveConfig.poolAddress,
      campaignNumber: liveConfig.campaignNumber,
      wallet: record.wallet,
      failedTransactionHash: record.pair.failedTransactionHash,
      successfulTransactionHash: record.pair.successfulTransactionHash,
      failureQueryId: release?.failureQueryId ?? null,
      successQueryId: release?.successQueryId ?? null,
      pairId: release?.pairId ?? null,
      releaseTransactionHash: release?.transactionHash ?? null,
    });
  }

  function clearSubmittedRecovery() {
    resumeReconciliation.current = "";
    submittedRecoveryStartedAt.current = null;
    clearRecoveryResumeState();
  }

  function fetchRecoveryConfig({ forceFresh = false, canAttempt, freshAuthorization } = {}) {
    if (!forceFresh && configFlight.current) return configFlight.current;
    const previousFlight = configFlight.current;
    const requestConfig = () => wakeRecoveryConfig({
      apiOrigin: API_ORIGIN,
      fresh: forceFresh,
      freshAuthorization,
      canAttempt,
    }).then((next) => validateRecoveryConfigResponse(next));
    let flight;
    flight = (forceFresh && previousFlight
      ? previousFlight.catch(() => undefined).then(requestConfig)
      : requestConfig())
      .finally(() => {
        if (configFlight.current === flight) configFlight.current = null;
      });
    configFlight.current = flight;
    return flight;
  }

  useEffect(() => {
    let active = true;
    setConfigState("loading");
    fetchRecoveryConfig()
      .then((validated) => {
        if (!active) return;
        applyRecoveryConfig(validated);
        setConfigState(isRecoveryConfigReadable(validated) ? "ready" : "unavailable");
      })
      .catch(() => {
        if (active) setConfigState("unavailable");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let refreshInFlight = false;
    const refreshLiveConfig = async () => {
      if (!navigator.onLine || document.visibilityState === "hidden" || refreshInFlight) return;
      refreshInFlight = true;
      try {
        const validated = await fetchRecoveryConfig();
        if (!active) return;
        applyRecoveryConfig(validated);
        setConfigState(isRecoveryConfigReadable(validated) ? "ready" : "unavailable");
      } catch {
        if (active && !isRecoveryConfigReadable(configRef.current)) setConfigState("unavailable");
      } finally {
        refreshInFlight = false;
      }
    };
    const markOnline = () => {
      setOnline(true);
      void refreshLiveConfig();
    };
    const markOffline = () => setOnline(false);
    const refreshVisible = () => {
      if (document.visibilityState !== "visible") return;
      setCampaignClock(Date.now());
      void refreshLiveConfig();
    };
    const interval = window.setInterval(refreshVisible, CONFIG_REFRESH_INTERVAL_MS);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);

  useEffect(() => {
    const liveConfig = config;
    if (!online || configState !== "ready" || !liveConfig?.enabled) return undefined;
    const candidate = loadRecoveryResumeCandidate({
      poolAddress: liveConfig.poolAddress,
      campaignNumber: liveConfig.campaignNumber,
    });
    if (!candidate) return undefined;
    submittedRecoveryStartedAt.current = candidate.createdAt;
    const reconciliationKey = [
      candidate.poolAddress,
      candidate.campaignNumber,
      candidate.wallet,
      candidate.failedTransactionHash,
      candidate.successfulTransactionHash,
      candidate.updatedAt,
      liveConfig.contractVersion,
      liveConfig.publicOrigin,
      liveConfig.campaign?.creditAmount,
      liveConfig.lineage?.releasesUnlocked,
    ].join(":");
    if (resumeReconciliation.current === reconciliationKey) return undefined;
    resumeReconciliation.current = reconciliationKey;

    const pair = {
      failedTransactionHash: candidate.failedTransactionHash,
      successfulTransactionHash: candidate.successfulTransactionHash,
    };
    pairDraftRef.current = pair;
    setPairDraft(pair);
    setPairErrors({});
    setReleaseResult(null);
    setError("Rechecking the submitted pair from public recovery state. No signature or release is being replayed.");
    updateFlow("release-uncertain");
    const operation = pairOperations.current.begin(pair);
    let active = true;

    checkRecoveryPairEligibility({ apiOrigin: API_ORIGIN, pair })
      .then((response) => {
        if (!active || !pairOperations.current.isCurrent(operation)) return;
        if (!recoveryCampaignsMatch(liveConfig, configRef.current)) return;
        const result = validatePairEligibilityResponse({
          response,
          requestedPair: pair,
          config: liveConfig,
        });
        const exactResume = loadRecoveryResumeState({
          poolAddress: liveConfig.poolAddress,
          campaignNumber: liveConfig.campaignNumber,
          wallet: result.wallet,
          failedTransactionHash: pair.failedTransactionHash,
          successfulTransactionHash: pair.successfulTransactionHash,
        });
        if (!exactResume || !walletsMatch(result.wallet, candidate.wallet)) {
          clearSubmittedRecovery();
          updateEligibility(null);
          setError("The stored recovery identity no longer matches the live-derived source wallet. Check the pair again.");
          updateFlow("pair-changed");
          return;
        }

        updateEligibility(result);
        if (result.status === "claimed") {
          setReleaseResult(result.release ? result : null);
          setError("");
          updateFlow("already-claimed");
          persistSubmittedRecovery("already-claimed", result);
        } else if (result.status === "processing") {
          setError("The submitted release is still processing. RetryCredit will not request another signature.");
          updateFlow("release-processing");
          persistSubmittedRecovery("release-processing", result);
        } else if (result.status === "eligible") {
          setError("No release receipt is visible yet. RetryCredit will keep this submitted pair locked for its original fifteen-minute reconciliation window.");
          updateFlow("release-uncertain");
          persistSubmittedRecovery("release-uncertain", result);
        } else {
          clearSubmittedRecovery();
          setError("");
          updateFlow(result.status === "full"
            ? "campaign-full"
            : result.status === "closed"
              ? "campaign-closed"
              : "continuation-waiting");
        }
      })
      .catch((nextError) => {
        if (!active || !pairOperations.current.isCurrent(operation)) return;
        resumeReconciliation.current = "";
        setError(`The submitted pair could not be reconciled yet. ${cleanError(nextError)}`);
        updateFlow("release-uncertain");
      });

    return () => { active = false; };
  }, [
    config?.enabled,
    config?.poolAddress,
    config?.campaignNumber,
    config?.contractVersion,
    config?.publicOrigin,
    config?.campaign?.creditAmount,
    config?.lineage?.releasesUnlocked,
    configState,
    online,
  ]);

  useEffect(() => {
    if (!window.ethereum) return undefined;
    window.ethereum.request({ method: "eth_accounts" }).then((items) => {
      const next = safeAddress(items?.[0]);
      if (next && !walletOperations.current.currentAccount()) {
        updateConnectedAccount(next);
      }
    }).catch(() => undefined);

    const changed = (items) => {
      const next = safeAddress(items?.[0]);
      updateConnectedAccount(next, { externalChange: true });
    };
    window.ethereum.on?.("accountsChanged", changed);
    return () => window.ethereum.removeListener?.("accountsChanged", changed);
  }, []);

  useEffect(() => {
    const liveConfig = config;
    const featuredPair = isRecoveryConfigReadable(liveConfig) && liveConfig.featuredCase
      ? {
          failedTransactionHash: liveConfig.featuredCase.failedTransactionHash,
          successfulTransactionHash: liveConfig.featuredCase.successfulTransactionHash,
        }
      : null;
    if (!featuredPair) {
      setFeaturedEligibility(null);
      setFeaturedState("idle");
      return undefined;
    }
    setFeaturedEligibility(null);
    setFeaturedState("checking");
    let active = true;
    checkRecoveryPairEligibility({ apiOrigin: API_ORIGIN, pair: featuredPair })
      .then((result) => {
        const validated = validatePairEligibilityResponse({
          response: result,
          requestedPair: featuredPair,
          config: liveConfig,
        });
        if (active && recoveryConfigsMatch(liveConfig, configRef.current)) {
          setFeaturedEligibility(validated);
          setFeaturedState("ready");
        }
      })
      .catch(() => {
        if (active && recoveryConfigsMatch(liveConfig, configRef.current)) {
          setFeaturedState("unavailable");
        }
      });
    return () => { active = false; };
  }, [
    config?.enabled,
    config?.readOnly,
    config?.readOnlyReason,
    config?.poolAddress,
    config?.campaignNumber,
    config?.publicOrigin,
    config?.settlement?.chainId,
    config?.campaign?.creditAmount,
    config?.campaign?.claimCount,
    config?.campaign?.deadline,
    config?.campaign?.open,
    config?.capacity?.remaining,
    config?.featuredCase?.wallet,
    config?.featuredCase?.failedTransactionHash,
    config?.featuredCase?.successfulTransactionHash,
  ]);

  useEffect(() => {
    const routeRecord = ROUTES.find((item) => item.path === route) ?? ROUTES[0];
    document.title = routeRecord.documentTitle;
    if (previousRoute.current === null) {
      previousRoute.current = route;
      return;
    }
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    requestAnimationFrame(() => {
      document.getElementById(routeRecord.headingId)?.focus({ preventScroll: true });
    });
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [route]);

  useEffect(() => {
    const previous = previousDeskFlow.current;
    previousDeskFlow.current = flow;
    if (previous !== "checking" || flow === "checking") return;
    requestAnimationFrame(() => {
      document.getElementById("eligibility-heading")?.focus({ preventScroll: true });
    });
  }, [flow]);

  async function refreshConfig() {
    if (!navigator.onLine) {
      setOnline(false);
      return null;
    }
    setConfigState("loading");
    setError("");
    try {
      const validated = await fetchRecoveryConfig();
      applyRecoveryConfig(validated);
      setConfigState(isRecoveryConfigReadable(validated) ? "ready" : "unavailable");
      return validated;
    } catch (nextError) {
      setConfigState("unavailable");
      setError(cleanError(nextError));
      return null;
    }
  }

  async function refreshAfterResponseMismatch(nextError, operation, walletOperation) {
    const next = await refreshConfig();
    if (!operationIsCurrent(operation, walletOperation)) return;
    if (!isRecoveryConfigReadable(next)) {
      updateFlow("service-unavailable");
      return;
    }
    setError(cleanError(nextError));
    updateFlow("retryable-error");
  }

  function applyRecoveryConfig(next) {
    const previous = configRef.current;
    const campaignChanged = Boolean(previous && !recoveryCampaignsMatch(previous, next));
    const featuredChanged = Boolean(previous && !recoveryConfigsMatch(previous, next));
    configRef.current = next;
    setConfig(next);
    if (featuredChanged) setFeaturedEligibility(null);
    if (!campaignChanged) return;

    clearSubmittedRecovery();
    const connected = walletOperations.current.currentAccount();
    walletOperations.current.begin(connected);
    pairOperations.current.invalidate();
    updateEligibility(null);
    setReleaseResult(null);
    setError("");
    updateFlow(hasPairDraft(pairDraftRef.current) ? "campaign-changed" : "empty");
  }

  function updateConnectedAccount(next, { externalChange = false } = {}) {
    const guard = walletOperations.current;
    const previous = guard.currentAccount();
    const didChange = guard.setAccount(next);
    setAccount(next);
    if (!didChange) return false;

    setError("");
    if (externalChange && flowRef.current === "discovering") {
      setDiscoveryResult(null);
      setError("The connected account changed before wallet discovery finished. Search the newly selected wallet when ready.");
      updateFlow("empty");
    }
    const liveEligibility = eligibilityRef.current;
    if (!liveEligibility?.eligible) return true;
    const currentFlow = flowRef.current;
    if (needsReleaseStatusCheck(currentFlow)) {
      if (externalChange) {
        setError("The connected account changed after submission. Check the exact pair before authorizing anything again.");
      }
      updateFlow(currentFlow);
      return true;
    }
    if (flowRef.current === "wallet-connecting") {
      updateFlow("wallet-connecting");
      return true;
    }
    const interruptedRelease = externalChange && previous && [
      "proof-queued",
      "proof-building",
      "release-relaying",
    ].includes(flowRef.current);
    if (interruptedRelease) {
      setError("The connected account changed after submission. Check the exact pair before authorizing anything again.");
      updateFlow("release-uncertain");
      persistSubmittedRecovery("release-uncertain", liveEligibility);
      return true;
    }
    updateFlow(recoveryEligibleAccountUpdateFlow({
      config: configRef.current,
      connectedAccount: next,
      sourceWallet: liveEligibility.wallet,
      currentFlow,
      externalChange,
      previousAccount: previous,
    }));
    return true;
  }

  async function connectWallet({ discovery = false } = {}) {
    if (!discovery && !eligibilityRef.current?.eligible) return "";
    if (!window.ethereum) throw new Error(discovery
      ? "Install an EVM wallet to search its public Ethereum history."
      : "Install an EVM wallet to authorize this qualifying source pair.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const next = safeAddress(accounts?.[0]);
    if (!next) throw new Error("The wallet did not return an Ethereum address.");
    updateConnectedAccount(next);
    return next;
  }

  async function discoverConnectedWallet() {
    if (
      !online
      || authorizationInFlight.current
      || isBusyFlow(flowRef.current)
      || needsReleaseStatusCheck(flowRef.current)
    ) return;
    let walletOperation;
    updateFlow("discovering");
    setError("");
    setDiscoveryResult(null);
    updateEligibility(null);
    setReleaseResult(null);
    pairOperations.current.invalidate();
    try {
      const wallet = await connectWallet({ discovery: true });
      if (!wallet) throw new Error("The wallet did not return an Ethereum address.");
      walletOperation = walletOperations.current.begin(wallet);
      const liveConfig = configState === "ready" ? config : await refreshConfig();
      if (!walletOperations.current.isCurrent(walletOperation)) return;
      if (!isRecoveryConfigReadable(liveConfig)) throw new TemporaryUnavailableError();
      const response = await discoverRecoveryWallet({ apiOrigin: API_ORIGIN, wallet });
      if (!walletOperations.current.isCurrent(walletOperation)) return;
      if (
        response?.authority !== "advisory-discovery-only"
        || !walletsMatch(response?.wallet, wallet)
        || !Array.isArray(response?.matches)
      ) throw new Error("Wallet discovery returned an invalid response.");
      setDiscoveryResult(response);
      const match = response.matches.find((item) => item?.eligible)
        ?? response.matches.find((item) => ["claimed", "processing", "continuation-waiting"].includes(item?.status))
        ?? response.matches[0];
      if (!match?.pair) {
        setError(response.historyTruncated
          ? `No matching retry appeared in the ${response.historyRowsInspected ?? "bounded"} most recent transactions. Older history may still qualify; use the exact hashes below.`
          : "No matching paid retry was found in this wallet's bounded campaign history. You can still enter exact transaction hashes below.");
        updateFlow("discovery-empty");
        return;
      }
      const pair = {
        failedTransactionHash: match.pair.failedTransactionHash,
        successfulTransactionHash: match.pair.successfulTransactionHash,
      };
      const validated = validatePairEligibilityResponse({ response: match, requestedPair: pair, config: liveConfig });
      if (!walletsMatch(validated.wallet, wallet)) throw new Error("The discovered pair belongs to a different source wallet.");
      pairDraftRef.current = pair;
      pairOperations.current.begin(pair);
      setPairDraft(pair);
      setPairErrors({});
      updateEligibility(validated);
      if (validated.status === "claimed") {
        setReleaseResult(validated.release ? validated : null);
        updateFlow("already-claimed");
      } else if (validated.status === "processing") {
        updateFlow("release-processing");
      } else if (validated.status === "continuation-waiting") {
        updateFlow("continuation-waiting");
      } else if (validated.status === "closed") {
        updateFlow("campaign-closed");
      } else if (validated.status === "full") {
        updateFlow("campaign-full");
      } else if (validated.eligible) {
        updateFlow(walletsMatch(walletOperations.current.currentAccount(), validated.wallet) ? "qualifying" : "wrong-wallet");
      } else {
        updateFlow("semantic-mismatch");
      }
    } catch (nextError) {
      if (walletOperation && !walletOperations.current.isCurrent(walletOperation)) return;
      if (nextError?.code === 4001 || nextError?.code === "ACTION_REJECTED") {
        setError("The wallet request was closed. No history was searched and nothing was submitted.");
        updateFlow("empty");
        return;
      }
      setError(cleanError(nextError));
      updateFlow(nextError instanceof TemporaryUnavailableError ? "service-unavailable" : "discovery-unavailable");
    }
  }

  function changePairField(field, value) {
    clearSubmittedRecovery();
    const next = { ...pairDraftRef.current, [field]: value };
    const hadDerivedState = Boolean(eligibilityRef.current || releaseResult || busy);
    pairDraftRef.current = next;
    pairOperations.current.invalidate();
    setPairDraft(next);
    setPairErrors((current) => ({ ...current, [field]: undefined }));
    updateEligibility(null);
    setReleaseResult(null);
    setError("");
    setDiscoveryResult(null);
    updateFlow(hasPairDraft(next) ? (hadDerivedState ? "pair-changed" : "editing") : "empty");
  }

  function loadRecoveredExample() {
    const featured = configRef.current?.featuredCase;
    if (!featured) return;
    clearSubmittedRecovery();
    const next = {
      failedTransactionHash: featured.failedTransactionHash,
      successfulTransactionHash: featured.successfulTransactionHash,
    };
    pairDraftRef.current = next;
    pairOperations.current.invalidate();
    setPairDraft(next);
    setPairErrors({});
    updateEligibility(null);
    setReleaseResult(null);
    setError("");
    setDiscoveryResult(null);
    updateFlow("editing");
  }

  async function checkPair(event) {
    event?.preventDefault?.();
    if (!online || authorizationInFlight.current || isBusyFlow(flowRef.current)) return;
    const validation = validateRecoveryPairDraft(pairDraftRef.current);
    setPairErrors(validation.errors);
    if (!validation.valid) {
      updateEligibility(null);
      setReleaseResult(null);
      setError("");
      updateFlow("malformed");
      return;
    }

    const pair = validation.pair;
    const operation = pairOperations.current.begin(pair);
    updateFlow("checking");
    setError("");
    updateEligibility(null);
    setReleaseResult(null);
    try {
      const liveConfig = configState === "ready" ? config : await refreshConfig();
      if (!operationIsCurrent(operation)) return;
      if (!isRecoveryConfigReadable(liveConfig)) throw new TemporaryUnavailableError();
      const response = await checkRecoveryPairEligibility({ apiOrigin: API_ORIGIN, pair });
      if (!operationIsCurrent(operation)) return;
      const result = validatePairEligibilityResponse({ response, requestedPair: pair, config: liveConfig });
      const resumedSubmission = loadRecoveryResumeState({
        poolAddress: liveConfig.poolAddress,
        campaignNumber: liveConfig.campaignNumber,
        wallet: result.wallet,
        failedTransactionHash: pair.failedTransactionHash,
        successfulTransactionHash: pair.successfulTransactionHash,
      });
      if (resumedSubmission) submittedRecoveryStartedAt.current = resumedSubmission.createdAt;
      updateEligibility(result);
      if (result.status === "claimed") {
        setReleaseResult(result.release ? result : null);
        if (resumedSubmission) persistSubmittedRecovery("already-claimed", result);
        updateFlow("already-claimed");
      } else if (result.eligible && result.status === "eligible") {
        setReleaseResult(null);
        if (resumedSubmission) {
          setError("No release receipt is visible yet. The submitted pair remains locked for its original fifteen-minute reconciliation window.");
          updateFlow("release-uncertain");
          persistSubmittedRecovery("release-uncertain", result);
        } else {
          const currentAccount = walletOperations.current.currentAccount();
          updateFlow(recoveryEligibleInspectionFlow({
            config: liveConfig,
            connectedAccount: currentAccount,
            sourceWallet: result.wallet,
          }));
        }
      } else if (result.status === "processing") {
        setReleaseResult(null);
        if (resumedSubmission) persistSubmittedRecovery("release-processing", result);
        updateFlow("release-processing");
      } else if (result.status === "continuation-waiting") {
        clearSubmittedRecovery();
        setReleaseResult(null);
        updateFlow("continuation-waiting");
      } else if (result.status === "closed") {
        clearSubmittedRecovery();
        updateFlow("campaign-closed");
        void refreshConfig();
      } else if (result.status === "full") {
        clearSubmittedRecovery();
        updateFlow("campaign-full");
        void refreshConfig();
      }
    } catch (nextError) {
      if (!operationIsCurrent(operation)) return;
      if (isRecoveryResponseMismatch(nextError)) {
        await refreshAfterResponseMismatch(nextError, operation);
        return;
      }
      setError(cleanError(nextError));
      if (isRecoveryPairInvalid(nextError)) updateFlow("semantic-mismatch");
      else if (isRecoveryRateLimited(nextError)) updateFlow("rate-limited");
      else updateFlow(nextError instanceof TemporaryUnavailableError ? "service-unavailable" : "retryable-error");
    }
  }

  async function authorizeAndRelease() {
    if (
      authorizationInFlight.current
      || isBusyFlow(flowRef.current)
      || ["release-processing", "release-uncertain", "continuation-waiting", "campaign-closed", "campaign-full"].includes(flowRef.current)
    ) return;
    const liveEligibility = eligibilityRef.current;
    if (!liveEligibility?.eligible) return;
    const liveConfig = configRef.current;
    if (!liveConfig?.enabled) {
      updateFlow("service-unavailable");
      return;
    }
    if (isContinuationWaiting(liveConfig)) {
      updateFlow("continuation-waiting");
      return;
    }
    const liveAvailability = recoveryCampaignAvailability(liveConfig);
    if (liveAvailability !== "open") {
      updateFlow(liveAvailability === "full" ? "campaign-full" : "campaign-closed");
      return;
    }
    if (!recoveryRecordMatchesConfig(liveEligibility, liveConfig)) {
      updateEligibility(null);
      setReleaseResult(null);
      updateFlow("campaign-changed");
      return;
    }
    const pair = {
      failedTransactionHash: liveEligibility.pair.failedTransactionHash,
      successfulTransactionHash: liveEligibility.pair.successfulTransactionHash,
    };
    const operation = pairOperations.current.begin(pair);
    let walletOperation;
    let releaseSubmitted = false;
    authorizationInFlight.current = true;
    setAuthorizationPending(true);
    setError("");
    updateFlow("wallet-connecting");
    try {
      let wallet = walletOperations.current.currentAccount();
      if (!walletsMatch(wallet, liveEligibility.wallet)) {
        try {
          wallet = await connectWallet();
        } catch (nextError) {
          if (operationIsCurrent(operation)) {
            setError(cleanError(nextError));
            updateFlow("qualifying");
          }
          return;
        }
      }
      if (!operationIsCurrent(operation)) return;
      if (!walletsMatch(wallet, liveEligibility.wallet)) {
        setError(`Connect ${short(liveEligibility.wallet)}, the source wallet derived from this pair.`);
        updateFlow("wrong-wallet");
        return;
      }
      walletOperation = walletOperations.current.begin(wallet);
      if (!operationIsCurrent(operation, walletOperation)) return;
      updateFlow("authorization-requested");
      const authorizationStartedAtMs = recoveryClockNow();
      const authorizationStartedAtWallMs = recoveryWallClockNow();
      const challengeResponse = await requestRecoveryIntakeChallenge({ apiOrigin: API_ORIGIN, pair });
      const currentAuthorizationConfig = configRef.current;
      const authorizationOperationCurrent = operationIsCurrent(operation, walletOperation);
      if (!canContinueRecoveryAuthorization({
        operationCurrent: authorizationOperationCurrent,
        initialConfig: liveConfig,
        currentConfig: currentAuthorizationConfig,
      })) {
        const interruptionFlow = recoveryAuthorizationInterruptionFlow({
          operationCurrent: authorizationOperationCurrent,
          currentConfig: currentAuthorizationConfig,
        });
        if (interruptionFlow) {
          if (["campaign-changed", "service-unavailable"].includes(interruptionFlow)) {
            updateEligibility(null);
            setReleaseResult(null);
          }
          updateFlow(interruptionFlow);
        }
        return;
      }
      const challenge = validateChallengeResponse({
        response: challengeResponse,
        wallet,
        eligibility: liveEligibility,
        config: liveConfig,
        currentOrigin: window.location.origin,
      });
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [hexlify(toUtf8Bytes(challenge.message)), wallet],
      });
      const postSignatureAuthorizationConfig = configRef.current;
      const postSignatureAuthorizationCurrent = operationIsCurrent(operation, walletOperation);
      if (!canContinueRecoveryAuthorization({
        operationCurrent: postSignatureAuthorizationCurrent,
        initialConfig: liveConfig,
        currentConfig: postSignatureAuthorizationConfig,
      })) {
        const interruptionFlow = recoveryAuthorizationInterruptionFlow({
          operationCurrent: postSignatureAuthorizationCurrent,
          currentConfig: postSignatureAuthorizationConfig,
        });
        if (interruptionFlow) {
          if (["campaign-changed", "service-unavailable"].includes(interruptionFlow)) {
            updateEligibility(null);
            setReleaseResult(null);
          }
          updateFlow(interruptionFlow);
        }
        return;
      }
      const freshAuthorization = liveConfig.consent.freshReadAdmission === "pair-signature-v1"
        ? createRecoveryFreshReadAuthorization({ challenge, signature })
        : undefined;
      let postSignatureConfig;
      try {
        postSignatureConfig = await fetchRecoveryConfig({
          forceFresh: true,
          freshAuthorization,
          canAttempt: () => operationIsCurrent(operation, walletOperation),
        });
      } catch (nextError) {
        if (
          isRecoveryChallengeExpired(nextError)
          || isRecoveryFreshAuthorizationUsed(nextError)
          || isRecoveryFreshAuthorizationRejected(nextError)
        ) throw nextError;
        if (operationIsCurrent(operation, walletOperation)) {
          setConfigState("unavailable");
          setError(cleanError(nextError));
          updateEligibility(null);
          setReleaseResult(null);
          updateFlow(isRecoveryRateLimited(nextError) ? "rate-limited" : "service-unavailable");
        }
        return;
      }
      const postSignatureOperationWasCurrent = operationIsCurrent(operation, walletOperation);
      if (postSignatureOperationWasCurrent) {
        applyRecoveryConfig(postSignatureConfig);
        setConfigState(isRecoveryConfigReadable(postSignatureConfig) ? "ready" : "unavailable");
      }
      const postSignatureOperationCurrent = operationIsCurrent(operation, walletOperation);
      if (!canContinueRecoveryAuthorization({
        operationCurrent: postSignatureOperationCurrent,
        initialConfig: liveConfig,
        currentConfig: postSignatureConfig,
      })) {
        const interruptionFlow = recoveryAuthorizationInterruptionFlow({
          operationCurrent: postSignatureOperationWasCurrent,
          currentConfig: postSignatureConfig,
        });
        if (interruptionFlow) {
          if (["campaign-changed", "service-unavailable"].includes(interruptionFlow)) {
            updateEligibility(null);
            setReleaseResult(null);
          }
          updateFlow(interruptionFlow);
        }
        return;
      }
      const releaseResponse = await releaseRecoveryPairWhenReady({
        apiOrigin: API_ORIGIN,
        authorizationStartedAtMs,
        authorizationStartedAtWallMs,
        wallet,
        pair,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        signature,
        onSubmitting: () => {
          submittedRecoveryStartedAt.current = Date.now();
          updateFlow("proof-queued");
          releaseSubmitted = true;
          persistSubmittedRecovery("proof-queued", liveEligibility);
        },
        onPending: () => {
          if (operationIsCurrent(operation, walletOperation)) {
            updateFlow("proof-building");
            persistSubmittedRecovery("proof-building", liveEligibility);
          }
        },
        onRetrying: () => {
          if (operationIsCurrent(operation, walletOperation)) {
            updateFlow("release-relaying");
            persistSubmittedRecovery("release-relaying", liveEligibility);
          }
        },
      });
      if (!operationIsCurrent(operation, walletOperation)) {
        setError("The browser state changed after submission. Check the exact pair before authorizing anything again.");
        updateFlow("release-uncertain");
        persistSubmittedRecovery("release-uncertain", liveEligibility);
        return;
      }
      const released = validatePairReleaseResponse({
        response: releaseResponse,
        wallet,
        eligibility: liveEligibility,
        config: liveConfig,
      });
      setReleaseResult(released);
      updateEligibility({ ...liveEligibility, ...released, eligible: false });
      updateFlow(released.status === "claimed" ? "already-claimed" : "released");
      persistSubmittedRecovery(
        released.status === "claimed" ? "already-claimed" : "released",
        { ...liveEligibility, ...released, eligible: false },
      );
      refreshConfig();
    } catch (nextError) {
      if (!operationIsCurrent(operation, walletOperation)) {
        if (releaseSubmitted) {
          setError("The browser state changed after submission. Check the exact pair before authorizing anything again.");
          updateFlow("release-uncertain");
          persistSubmittedRecovery("release-uncertain", liveEligibility);
        }
        return;
      }
      if (["RECOVERY_CLOSED", "RECOVERY_FULL"].includes(nextError?.code)) {
        clearSubmittedRecovery();
        const status = nextError.code === "RECOVERY_FULL" ? "full" : "closed";
        updateEligibility({ ...liveEligibility, eligible: false, status, reason: cleanError(nextError) });
        setError(cleanError(nextError));
        updateFlow(status === "full" ? "campaign-full" : "campaign-closed");
        void refreshConfig();
        return;
      } else if (releaseSubmitted) {
        setError("The browser did not confirm the submitted release. Check this exact pair before signing again; the server may still finish it.");
        updateFlow("release-uncertain");
        persistSubmittedRecovery("release-uncertain", liveEligibility);
        return;
      } else if (isRecoveryResponseMismatch(nextError)) {
        await refreshAfterResponseMismatch(nextError, operation, walletOperation);
        return;
      } else if (isRecoveryChallengeExpired(nextError)) {
        setError(cleanError(nextError));
        updateFlow("qualifying");
        return;
      } else if (isRecoveryFreshAuthorizationUsed(nextError)) {
        updateEligibility(null);
        setReleaseResult(null);
        setError("No release request was sent. Check the preserved pair before signing again.");
        updateFlow("fresh-authorization-used");
        requestAnimationFrame(() => {
          document.getElementById("eligibility-heading")?.focus({ preventScroll: true });
        });
        return;
      } else if (isRecoveryFreshAuthorizationRejected(nextError)) {
        updateEligibility(null);
        setReleaseResult(null);
        setError(cleanError(nextError));
        updateFlow("retryable-error");
        return;
      } else if (nextError?.code === 4001 || nextError?.code === "ACTION_REJECTED") {
        setError("The signature request was closed. Nothing was released; you can authorize again.");
        updateFlow("qualifying");
        return;
      } else if (nextError?.code === "RECOVERY_PAIR_WALLET_MISMATCH") {
        updateEligibility(null);
        setReleaseResult(null);
        setError(cleanError(nextError));
        updateFlow("pair-changed");
        return;
      } else {
        setError(cleanError(nextError));
      }
      if (isRecoveryRateLimited(nextError)) updateFlow("rate-limited");
      else updateFlow(nextError instanceof TemporaryUnavailableError ? "service-unavailable" : "retryable-error");
    } finally {
      authorizationInFlight.current = false;
      setAuthorizationPending(false);
      if (flowRef.current === "account-changed") {
        const currentAccount = walletOperations.current.currentAccount();
        updateFlow(
          !currentAccount || walletsMatch(currentAccount, liveEligibility.wallet)
            ? "qualifying"
            : "wrong-wallet",
        );
      }
    }
  }

  async function walletControl() {
    const expectedEligibility = eligibilityRef.current;
    if (
      !expectedEligibility?.eligible
      || authorizationInFlight.current
      || isBusyFlow(flowRef.current)
      || needsReleaseStatusCheck(flowRef.current)
      || flowRef.current === "continuation-waiting"
      || isContinuationWaiting(configRef.current)
    ) return;
    const operation = pairOperations.current.begin(expectedEligibility.pair);
    updateFlow("wallet-connecting");
    setError("");
    const next = await connectWallet().catch((nextError) => {
      setError(cleanError(nextError));
      updateFlow("qualifying");
      return "";
    });
    if (!operationIsCurrent(operation) || eligibilityRef.current !== expectedEligibility) return;
    if (next && !walletsMatch(next, expectedEligibility.wallet)) {
      setError(`Switch to ${short(expectedEligibility.wallet)} inside your wallet, then try again.`);
      updateFlow("wrong-wallet");
    } else if (next) {
      updateFlow("qualifying");
    }
  }

  function operationIsCurrent(operation, walletOperation) {
    return pairOperations.current.isCurrent(operation)
      && (!walletOperation || walletOperations.current.isCurrent(walletOperation));
  }

  const terminal = ["released", "already-claimed"].includes(flow);
  const preserveSubmittedFlow = ["proof-queued", "proof-building", "release-relaying", "release-processing", "release-uncertain"].includes(flow);
  const campaignAvailability = recoveryCampaignAvailability(config);
  const continuationWaiting = isContinuationWaiting(config);
  const campaignUnavailable = configState === "ready"
    && !["open", "continuation-waiting"].includes(campaignAvailability)
    && !terminal
    && !busy
    && !preserveSubmittedFlow;
  const showContinuationBaseline = continuationWaiting
    && ["empty", "editing"].includes(flow)
    && !terminal
    && !busy
    && !preserveSubmittedFlow;
  const effectiveFlow = !online && !terminal && !preserveSubmittedFlow
    ? "offline"
    : configState === "loading" && !terminal && !preserveSubmittedFlow
      ? "loading-config"
      : configState === "unavailable" && flow !== "rate-limited" && !terminal && !preserveSubmittedFlow
        ? "service-unavailable"
        : campaignUnavailable
          ? campaignAvailability === "full"
            ? "campaign-full"
            : "campaign-closed"
          : showContinuationBaseline
            ? "continuation-waiting"
            : flow;

  const context = useMemo(() => ({
    account,
    busy,
    config,
    configState,
    eligibility,
    error,
    featuredEligibility,
    featuredState,
    flow: effectiveFlow,
    online,
    pairDraft,
    pairErrors,
    releaseResult: visibleRelease,
    discoveryResult,
  }), [account, busy, config, configState, effectiveFlow, eligibility, error, featuredEligibility, featuredState, online, pairDraft, pairErrors, visibleRelease, discoveryResult]);

  const walletActionEnabled = Boolean(
    online
    && configState === "ready"
    && !busy
    && !needsReleaseStatusCheck(flow)
    && (
      config?.capabilities?.walletNativeDiscovery
      || (eligibility?.eligible && campaignAvailability === "open" && !continuationWaiting)
    )
  );

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <AppHeader
      account={account}
      config={config}
      configState={configState}
      online={online}
      route={route}
      walletActionEnabled={walletActionEnabled}
      onConnect={eligibility?.eligible && config?.enabled === true ? walletControl : discoverConnectedWallet}
    />
    <main id="main-content" tabIndex="-1">
      {route === "/" && <RecoveryPage
        {...context}
        onAuthorize={authorizeAndRelease}
        onCheckPair={checkPair}
        onDiscover={discoverConnectedWallet}
        onLoadExample={loadRecoveredExample}
        onPairChange={changePairField}
      />}
      {route === "/cases" && <CasesPage {...context} />}
      {route === "/protocol" && <ProtocolPage config={config} />}
    </main>
    <footer className="app-footer">
      <span>Bounded public recovery pilot</span>
      <a href={REPOSITORY} target="_blank" rel="noreferrer">Open source <ExternalLink aria-hidden="true" /></a>
    </footer>
  </div>;
}

function AppHeader({ account, config, configState, online, route, onConnect, walletActionEnabled }) {
  const campaignAvailability = recoveryCampaignAvailability(config);
  const continuationWaiting = isContinuationWaiting(config);
  const service = !online
    ? "offline"
    : configState === "ready" && config?.readOnly
      ? "read-only"
    : configState === "ready" && continuationWaiting
      ? "continuation-waiting"
    : configState === "ready" && campaignAvailability !== "open"
      ? campaignAvailability === "full" ? "campaign-full" : "campaign-closed"
      : configState;
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
      <button
        className="wallet-button"
        type="button"
        onClick={onConnect}
        disabled={!walletActionEnabled}
        aria-describedby={!account && !walletActionEnabled ? "wallet-gate-note" : undefined}
        title={!account && !walletActionEnabled ? "Wallet discovery is unavailable while the recovery service is loading." : undefined}
      >
        <Wallet aria-hidden="true" />
        <span>{account ? short(account) : walletActionEnabled ? "Find my retry" : "Wallet unavailable"}</span>
      </button>
      {!account && !walletActionEnabled && <span id="wallet-gate-note" className="visually-hidden">Wallet discovery becomes available when the recovery service is ready.</span>}
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
  const { config, configState, eligibility, flow, releaseResult } = props;
  const readOnly = config?.readOnly === true;
  const compactReadOnlyResult = readOnly && eligibility?.eligible === true;
  return <div className="route-page recovery-page">
    <div className="campaign-layout">
      <EligibilityDesk {...props} />
      <CampaignFile config={config} configState={configState} />
    </div>
    <EvidenceBand config={config} eligibility={eligibility} flow={flow} releaseResult={releaseResult} />
    <section className={`plain-boundary${compactReadOnlyResult ? " compact-read-only-result" : ""}`} aria-labelledby="boundary-heading">
      <h2 id="boundary-heading">The source pair fixes the only destination.</h2>
      <p>{readOnly
        ? "This staging surface stops after live pair inspection. In a write-enabled release, the contract—not the browser or relayer—derives the only payout wallet from that pair."
        : "RetryCredit checks an already-public Ethereum pair. If it qualifies, the contract derives the payout wallet from that pair; neither the hosted relayer nor its consent screen can substitute another address."}</p>
      <div className="boundary-line" aria-label="Recovery boundary">
        <span><Search aria-hidden="true" /> Match the pair</span>
        <ArrowRight aria-hidden="true" />
        <span><LockKeyhole aria-hidden="true" /> {readOnly ? "Stop before signing" : "Authorize hosted relay"}</span>
        <ArrowRight aria-hidden="true" />
        <span><ShieldCheck aria-hidden="true" /> {readOnly ? "Release disabled here" : "Release once"}</span>
      </div>
    </section>
  </div>;
}

function CampaignFile({ config, configState }) {
  const campaign = config?.campaign;
  const capacity = config?.capacity;
  const manifest = recoveryManifest(config);
  const campaignReady = configState === "ready" && isRecoveryConfigReadable(config);
  const campaignAvailability = recoveryCampaignAvailability(config);
  const continuationWaiting = isContinuationWaiting(config);
  const campaignFull = campaignAvailability === "full";
  const campaignClosed = campaignReady && ["closed", "full"].includes(campaignAvailability);
  return <section className="campaign-file" aria-labelledby="campaign-heading">
    <div className="file-registration" aria-hidden="true">Campaign file</div>
    <p className="promise-kicker">{manifest?.promise.label ?? "Campaign terms unavailable"}</p>
    <h2 id="campaign-heading" tabIndex="-1">{!campaignReady
      ? "The recovery campaign is being verified."
      : campaignClosed
      ? campaignFull ? "This recovery campaign has filled." : "This recovery campaign has closed."
      : continuationWaiting
      ? "This funded continuation is waiting to release."
      : "A completed mint can unlock one fixed credit."}</h2>
    <p className="campaign-summary">{!campaignReady
      ? "Funding, capacity, rule, and deadline facts will appear only after the recovery service returns one complete authenticated configuration."
      : campaignClosed
      ? "The public source-pair record remains inspectable, but this campaign is not accepting another fixed release."
      : continuationWaiting
      ? "Continuation funded — releases begin after the predecessor campaign fills or passes its deadline. Pair checks remain available while prior wallet and proof use stays excluded."
      : "This funded campaign recognizes the same Ethereum wallet moving from a failed paid SeaDrop mint to its completed mint. RetryCredit pre-funds the bounded Creditcoin release."}</p>
    {manifest && <p className="promise-disclosure">{manifest.promise.disclosure}</p>}
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
    <CampaignTerms config={config} />
    <p className="funding-note"><CircleDot aria-hidden="true" /> Campaign {config?.campaignNumber ? `#${config.campaignNumber}` : "awaiting publication"}. SeaDrop, OpenSea, and the NFT collection do not sponsor or endorse this pilot.</p>
  </section>;
}

function CampaignTerms({ config }) {
  const campaign = config?.campaign;
  const predecessor = isLineageV2(config) ? config.lineage.predecessor : null;
  return <details className="campaign-terms">
    <summary>
      <span>Expand campaign terms</span>
      <ChevronRight aria-hidden="true" />
    </summary>
    <dl>
      <ProtocolField label="Funded reserve" value={campaign?.fundedAmount ? formatCredit(campaign.fundedAmount) : null} />
      <ProtocolField label="Campaign sponsor" value={campaign?.sponsor} />
      <ProtocolField label="Recovery pool" value={config?.poolAddress} />
      <ProtocolField label="Fee recipient" value={config?.rule?.feeRecipient} />
      <ProtocolField label="Terms hash" value={campaign?.termsHash} />
      {predecessor && <ProtocolField label="Predecessor" value={`${short(predecessor.poolAddress)} · campaign #${predecessor.campaignNumber}`} />}
      {predecessor && <ProtocolField label="Continuation gate" value={config.lineage.releasesUnlocked
        ? "Predecessor boundary satisfied"
        : `Predecessor fills or passes ${formatDeadline(predecessor.deadline)}`} />}
    </dl>
  </details>;
}

function EligibilityDesk({
  account,
  busy,
  config,
  configState,
  eligibility,
  error,
  flow,
  online,
  onAuthorize,
  onCheckPair,
  onDiscover,
  onLoadExample,
  onPairChange,
  pairDraft,
  pairErrors,
  releaseResult,
  discoveryResult,
}) {
  const copy = deskCopy(flow, eligibility, releaseResult, config);
  const isTerminal = flow === "released" || flow === "already-claimed";
  const hasQualifyingResult = Boolean(eligibility?.eligible);
  const needsStatusCheck = needsReleaseStatusCheck(flow);
  const pairLocked = busy || needsStatusCheck;
  const checkDisabled = busy
    || !online
    || flow === "offline"
    || configState === "loading";
  const authorizationDisabled = busy
    || flow === "offline"
    || flow === "continuation-waiting"
    || ["campaign-closed", "campaign-full"].includes(flow)
    || needsStatusCheck
    || !hasQualifyingResult;
  const campaignAcceptsAuthorization = configState === "ready"
    && config?.enabled === true
    && config?.readOnly !== true
    && recoveryCampaignAvailability(config) === "open"
    && !isContinuationWaiting(config);
  return <section className={`eligibility-desk state-${flow}`} aria-labelledby="eligibility-heading">
    <div className="desk-heading">
      <span className="state-mark" aria-hidden="true">{stateIcon(flow)}</span>
      <div>
        <h1 id="eligibility-heading" tabIndex="-1">{copy.title}</h1>
        <p role="status" aria-live="polite" aria-atomic="true">{copy.body}</p>
      </div>
    </div>

    {config?.readOnly && <div className="read-only-note" role="note">
      <LockKeyhole aria-hidden="true" />
      <div>
        <strong>Live checks, no signing</strong>
        <p>This staging release can discover and inspect exact pairs, but it cannot request a signature or release credit.</p>
      </div>
    </div>}

    {!hasQualifyingResult && !isTerminal && <div className="wallet-discovery">
      <button
        className="primary-action discovery-action"
        type="button"
        onClick={onDiscover}
        disabled={busy
          || !online
          || configState !== "ready"
          || !config?.capabilities?.walletNativeDiscovery
          || needsStatusCheck}
        aria-busy={flow === "discovering"}
      >
        <span>{flow === "discovering" ? "Searching wallet history" : account ? "Search this wallet's retries" : "Connect wallet and find my retry"}</span>
        {flow === "discovering" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
      </button>
      <p>Connection reveals only the selected public address. RetryCredit searches a bounded history, then independently rechecks any match before it can qualify.</p>
    </div>}

    {discoveryResult && <DiscoveryReceipt result={discoveryResult} />}

    {!hasQualifyingResult && !isTerminal && <div className="manual-divider"><span>or enter the exact pair</span></div>}

    <form className="pair-intake" onSubmit={onCheckPair} noValidate aria-busy={busy}>
      <fieldset>
        <legend>Ordered Ethereum pair</legend>
        <TransactionField
          disabled={pairLocked}
          id="failed-transaction"
          marker="A"
          label="Failed paid mint"
          helper="Paste the failed transaction hash or its canonical etherscan.io URL."
          value={pairDraft.failedTransactionHash}
          error={pairErrors.failedTransactionHash}
          onChange={(value) => onPairChange("failedTransactionHash", value)}
        />
        <div className="pair-order" aria-hidden="true"><ArrowRight /></div>
        <TransactionField
          disabled={pairLocked}
          id="successful-transaction"
          marker="B"
          label="Completed retry"
          helper="Paste the later successful transaction from the same paid SeaDrop action."
          value={pairDraft.successfulTransactionHash}
          error={pairErrors.successfulTransactionHash}
          onChange={(value) => onPairChange("successfulTransactionHash", value)}
        />
      </fieldset>

      {(!hasQualifyingResult || needsStatusCheck) && !isTerminal && <button
        id="pair-primary-action"
        className="primary-action"
        type="submit"
        disabled={checkDisabled}
        aria-busy={flow === "checking"}
      >
        <span>{pairCheckLabel(flow, configState)}</span>
        {flow === "checking" ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
      </button>}

      <button
        className="example-action"
        type="button"
        onClick={onLoadExample}
        disabled={!config?.featuredCase || pairLocked}
      >
        Load published example <ChevronRight aria-hidden="true" />
      </button>

      <details className="transaction-help">
        <summary>
          <span>How to find these transactions</span>
          <ChevronRight aria-hidden="true" />
        </summary>
        <ol>
          <li>Open the source wallet&apos;s activity on Etherscan.</li>
          <li>Choose the failed paid SeaDrop mint, then the later completed retry for the same mint.</li>
          <li>Paste each transaction hash or its full etherscan.io transaction URL above.</li>
        </ol>
      </details>
    </form>

    {eligibility?.wallet && <div className="wallet-readout">
      <span>Source wallet derived from live pair</span>
      <code>{eligibility.wallet}</code>
      <small>{account ? `Connected: ${short(account)}` : "No wallet requested during the check"}</small>
    </div>}

    <LineageAssurance config={config} eligibility={eligibility} />

    {error && <div className="inline-notice" role="alert">
      <AlertCircle aria-hidden="true" />
      <span>{error}</span>
    </div>}

    {releaseResult?.release && <ReleaseReceipt result={releaseResult} />}

    {hasQualifyingResult && !needsStatusCheck && !config?.readOnly && <button
      id="authorization-action"
      className="primary-action authorization-action"
      type="button"
      onClick={onAuthorize}
      disabled={authorizationDisabled || !campaignAcceptsAuthorization}
      aria-busy={busy}
      aria-describedby="authorization-scope-note"
    >
      <span>{authorizationLabel(flow, account, eligibility.wallet)}</span>
      {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wallet aria-hidden="true" />}
    </button>}

    {["semantic-mismatch", "continuation-waiting", "campaign-closed", "campaign-full"].includes(flow) && <a className="secondary-action" href="/cases" onClick={(event) => navigate(event, "/cases")}>
      Inspect the public case <ChevronRight aria-hidden="true" />
    </a>}

    <p id="authorization-scope-note" className="destination-note"><LockKeyhole aria-hidden="true" /> {config?.readOnly
      ? "No signature, destination, network switch, or transaction is requested in read-only staging."
      : "No destination field and no network switch. The signature gates RetryCredit's hosted relayer for this exact pair; the contract independently derives the source-wallet recipient."}</p>
  </section>;
}

function DiscoveryReceipt({ result }) {
  const attribution = selectDiscoveryAttribution(result?.attribution);
  return <div className="discovery-receipt">
    <small>{result.historyRowsInspected} transactions checked{result.historyTruncated ? " · older history not included" : " · complete bounded history"}</small>
    {attribution && <a
      className="discovery-attribution"
      href={attribution.url}
      target="_blank"
      rel="noreferrer"
    >
      <span>{attribution.label}</span>
      <ExternalLink aria-hidden="true" />
    </a>}
  </div>;
}

function LineageAssurance({ config, eligibility }) {
  if (!isLineageV2(config)) return null;
  const predecessor = config.lineage.predecessor;
  const status = eligibility?.lineage?.status;
  const copy = lineageEligibilityCopy(status, config.lineage.releasesUnlocked);
  return <aside className={`lineage-assurance lineage-${status ?? "pending"}`} aria-label="Continuation replay protection">
    <div>
      <ShieldCheck aria-hidden="true" />
      <span>
        <small>Continuation lineage</small>
        <strong>{copy.title}</strong>
      </span>
    </div>
    <p role={status ? "status" : undefined}>{copy.body}</p>
    <ul>
      <li>Predecessor campaign #{predecessor.campaignNumber} checked</li>
      <li>Sponsor-wide wallet, query, and pair replay guard</li>
      <li>An unrelated pool cannot mark this retry as used</li>
      <li>Source-derived payout only</li>
    </ul>
  </aside>;
}

function TransactionField({ disabled, error, helper, id, label, marker, onChange, value }) {
  const helperId = `${id}-helper`;
  const errorId = `${id}-error`;
  const canonicalHash = canonicalTransactionHash(value);
  return <div className={`transaction-field${error ? " invalid" : ""}`}>
    <div className="transaction-label">
      <span aria-hidden="true">{marker}</span>
      <label htmlFor={id}>{label}</label>
      <b>Required</b>
    </div>
    <input
      id={id}
      name={id}
      type="text"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      required
      autoComplete="off"
      autoCapitalize="none"
      spellCheck="false"
      inputMode="url"
      maxLength="160"
      aria-invalid={error ? "true" : "false"}
      aria-describedby={`${helperId}${error ? ` ${errorId}` : ""}`}
    />
    <div className="field-support">
      <p id={helperId} className="field-helper">{helper}</p>
      {canonicalHash && <a
        className="hash-readout"
        href={`${ETHEREUM_EXPLORER}/tx/${canonicalHash}`}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open transaction ${canonicalHash} on Etherscan`}
      >
        <code>{compactHash(canonicalHash)}</code>
        <ExternalLink aria-hidden="true" />
      </a>}
    </div>
    {error && <p id={errorId} className="field-error" role="alert">{error}</p>}
  </div>;
}

function ReleaseReceipt({ result }) {
  return <div className="release-receipt">
    <strong>{formatCredit(result.creditAmount)} released</strong>
    <span>Beneficiary</span>
    <code>{result.wallet}</code>
    {result.release.transactionHash && <ExplorerLink chain="creditcoin" hash={result.release.transactionHash}>Open release receipt</ExplorerLink>}
  </div>;
}

function EvidenceBand({ config, eligibility, flow, releaseResult }) {
  const evidence = selectRecoveryEvidence({
    config,
    eligibility,
    releaseResult,
  });
  const { pair, release, wallet } = evidence;
  const paymentValue = formatEthValue(pair?.valueWei);
  const mintPrice = formatEthValue(pair?.mintPriceWei);
  const continuationWaiting = isContinuationWaiting(config);
  const readOnly = config?.readOnly === true;
  const releaseAvailable = eligibility?.eligible === true
    && config?.enabled === true
    && !readOnly
    && recoveryRecordMatchesConfig(eligibility, config)
    && recoveryCampaignAvailability(config) === "open"
    && !continuationWaiting;
  const releaseProcessing = ["release-processing", "release-uncertain"].includes(flow)
    || eligibility?.status === "processing";
  return <section className="evidence-band" aria-labelledby="evidence-heading">
    <header>
      <h2 id="evidence-heading">One wallet. One ordered source pair. One fixed release.</h2>
      <p>Human result first; receipts stay attached to the result they establish.</p>
    </header>
    {!pair ? <div className="evidence-empty">
      <Radio aria-hidden="true" />
      <div>
        <strong>No analyzed source pair is attached to this recovery yet.</strong>
        <p>Submit an exact failed and completed transaction pair. This band only uses facts returned by that live analysis; the featured case stays isolated on Cases.</p>
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
        kind={release ? "released" : continuationWaiting ? "waiting" : "funded"}
        number="C"
        title={release
          ? "Fixed credit released"
          : releaseProcessing
            ? "Release status needs confirmation"
            : continuationWaiting
              ? "Continuation release is waiting"
              : readOnly && eligibility?.eligible
                ? "Pair qualifies; release disabled here"
                : releaseAvailable ? "Fixed release awaits authorization" : "No new release available"}
        subtitle="Creditcoin Testnet · source-derived payout"
        hash={release?.transactionHash}
        chain="creditcoin"
        facts={[
          formatCredit(evidence.creditAmount ?? config?.campaign?.creditAmount),
          release?.blockNumber !== undefined && `Block ${release.blockNumber}`,
          release
            ? "Replay consumed"
            : releaseProcessing
              ? "Check exact pair before any new signature"
              : continuationWaiting
                ? "Predecessor must fill or pass its deadline"
                : readOnly && eligibility?.eligible
                  ? "Read-only staging stops before signing"
                  : releaseAvailable ? "Hosted-relayer authorization available" : "Campaign closed or full",
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

function CasesPage({ config, eligibility, featuredEligibility, featuredState, releaseResult }) {
  const featured = config?.featuredCase;
  const featuredRelease = selectFeaturedRelease({
    config,
    eligibility,
    releaseResult,
    featuredEligibility,
  });
  const featuredVerified = featuredState === "ready" && Boolean(featuredEligibility?.pair);
  const featuredLabel = featuredRelease
    ? "Released"
    : featuredVerified
      ? "Source pair verified"
      : featuredState === "checking"
        ? "Verifying source pair"
        : "Verification unavailable";
  const featuredResult = featuredRelease
    ? "The source wallet received its fixed Creditcoin release."
    : featuredVerified
      ? "This wallet has a live-verified failed-to-completed SeaDrop pair."
      : featuredState === "checking"
        ? "RetryCredit is re-reading the published source pair from Ethereum."
        : "The published source pair could not be reverified right now.";
  const featuredDetail = featuredRelease
    ? "The release transaction is bound to the same Ethereum source address."
    : featuredVerified
      ? "Eligibility and any release remain separate service states; the source facts alone are not adoption."
      : "Its published identifiers remain visible, but RetryCredit will not label the pair verified until the live check succeeds.";
  return <div className="route-page cases-page">
    <PageHeading
      id="cases-heading"
      title="Cases stay separated by what they actually prove."
      body="A public source pair, broader eligible observations, and the earlier controlled lab are different evidence. RetryCredit does not turn an observed address into a customer claim."
    />

    <section className="case-register" aria-labelledby="public-case-heading">
      <header>
        <h2 id="public-case-heading">{featuredRelease ? "Public recovered case" : "Public recovery case"}</h2>
        <span className={featuredRelease ? "case-state released" : "case-state observed"} role="status" aria-live="polite">{featuredLabel}</span>
      </header>
      {featured ? <div className={`expanded-case${featuredRelease ? " has-release" : ""}`}>
        <div className="case-result">
          <strong>{featuredResult}</strong>
          <p>{featuredDetail}</p>
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
  const lineageV2 = isLineageV2(config);
  return <div className="route-page protocol-page">
    <PageHeading
      id="protocol-heading"
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
          <p>{lineageV2
            ? "Campaign funding, credit amount, slot count, source rule, and deadline are fixed at creation. The continuation checks the predecessor and prevents wallet, transaction-query, or pair reuse across campaigns from the same sponsor. After the deadline, only the unused campaign remainder can return to its sponsor."
            : "Campaign funding, credit amount, slot count, source rule, and deadline are fixed at creation. Each wallet, transaction query, and pair can release once. After the deadline, only the unused campaign remainder can return to its sponsor."}</p>
        </section>
        <section>
          <h2>One recovery boundary, two reference adapters</h2>
          <p>The product boundary can describe more than one action family without pretending every failure is equivalent. The paid-mint campaign is organic mainnet evidence. The Universal Router implementation is an archived controlled lab that proves a second strict predicate family, not user demand.</p>
          <AdapterRegister adapters={RECOVERY_ADAPTERS} />
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
          {lineageV2 && <ProtocolField label="Replay scope" value="Predecessor + sponsor lineage" />}
          {lineageV2 && <ProtocolField label="Predecessor" value={`${short(config.lineage.predecessor.poolAddress)} · campaign #${config.lineage.predecessor.campaignNumber}`} />}
        </dl>
      </aside>
    </div>
  </div>;
}

function AdapterRegister({ adapters }) {
  return <div className="adapter-register" aria-label="Recovery adapter evidence">
    {adapters.map((adapter) => <article key={adapter.id}>
      <div>
        <strong>{adapter.name}</strong>
        <span>{adapter.source}</span>
      </div>
      <div>
        <span>{adapter.evidence}</span>
        <em>{adapter.availability}</em>
      </div>
    </article>)}
  </div>;
}

function PageHeading({ body, id, title }) {
  return <header className="page-heading">
    <h1 id={id} tabIndex="-1">{title}</h1>
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

function recoveryManifest(config) {
  if (!isRecoveryConfigReadable(config)) return null;
  try {
    return buildRecoveryCampaignManifest(config);
  } catch {
    return null;
  }
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

function deskCopy(flow, eligibility, releaseResult, config) {
  const copies = {
    "loading-config": ["Opening the campaign file", "Loading funding, capacity, and claim-window terms from the recovery service."],
    empty: ["Find a paid retry", "Connect the source wallet to search its public history, or enter the exact failed and completed transactions yourself."],
    discovering: ["Searching public wallet history", "RetryCredit is looking for a paid SeaDrop failure followed by the matching completed retry. Discovery alone cannot authorize a credit."],
    "discovery-empty": ["No retry found in the checked history", "Try the exact transaction hashes below, especially if the wallet has older activity outside the bounded search."],
    "discovery-unavailable": ["Wallet search is temporarily unavailable", "Manual pair checking still works and remains the authority path for live Ethereum facts."],
    editing: ["Complete the ordered pair", "Both transactions must belong to the same source wallet and paid SeaDrop action."],
    malformed: ["Fix the transaction references", "Each field needs a full transaction hash or canonical etherscan.io transaction URL."],
    checking: ["Checking the live pair", "RetryCredit is deriving the wallet, receipts, mint facts, order, and campaign fit from Ethereum."],
    "semantic-mismatch": ["This pair does not meet the campaign rule", eligibility?.reason || "The references are valid, but the live transactions do not form the required failed-to-completed paid SeaDrop retry."],
    qualifying: config?.readOnly
      ? ["This pair qualifies in read-only staging", `The live-derived source wallet matches one ${formatCredit(eligibility?.creditAmount)} campaign slot. Signing and release stay disabled here.`]
      : ["This pair qualifies", `The live-derived source wallet can authorize one ${formatCredit(eligibility?.creditAmount)} release. Connect only that wallet to continue.`],
    "wrong-wallet": ["Switch to the derived source wallet", "The connected account is not the wallet established by this pair. Switch accounts inside your wallet extension, then try again. No proof or release request was sent."],
    "wallet-connecting": ["Connecting the source wallet", "Approve the account request. RetryCredit will continue only if it matches the wallet derived from this exact pair."],
    "authorization-requested": ["Authorization requested", "Confirm the exact-pair, campaign, origin, and five-minute consent in the source wallet."],
    "proof-queued": ["Proof request queued", "The signed pair is queued for Attestcoin native-batch work. Keep this pair unchanged."],
    "proof-building": ["Building the native batch", "Attestcoin is proving the ordered Ethereum receipts. The submitted pair remains visible while it finalizes."],
    "release-relaying": ["Relaying the fixed release", "RetryCredit is checking the finalized proof and submitting the source-derived Creditcoin release."],
    "release-processing": ["A signed release is still processing", "The server has an active request for this exact pair. Check its status here; do not sign another authorization."],
    "release-uncertain": ["Confirm the submitted release", "The browser lost a definitive result after submission. Check this exact pair before signing again; it may still be processing or already released."],
    "continuation-waiting": ["Check the pair while settlement waits", lineageEligibilityCopy(eligibility?.lineage?.status, false).body],
    released: ["Credit reached the source wallet", `${formatCredit(releaseResult?.creditAmount)} was released once on Creditcoin Testnet.`],
    "already-claimed": ["This pair already recovered", "The live campaign recognizes the prior release and will not pay the same wallet or pair again."],
    "campaign-closed": ["This campaign is closed", eligibility?.reason || "Its public records remain inspectable, but it cannot accept another recovery release."],
    "campaign-full": ["This campaign is full", eligibility?.reason || "Every funded recovery slot has been used. No additional release can be authorized."],
    "pair-changed": ["The submitted pair changed", "Every earlier verdict and pending browser action was discarded. Check the complete pair again."],
    "account-changed": ["The connected account changed", "The wallet request is still settling, so actions remain locked. When it closes, connect the source wallet derived from this pair to continue."],
    "campaign-changed": ["The live campaign changed", "The previous pair verdict was discarded against the new pool or campaign boundary. Check the pair again."],
    "service-unavailable": ["The recovery service is unavailable", "The submitted pair is preserved. Retry the service without connecting a wallet."],
    "rate-limited": ["Recovery checks are busy", "Your pair is still here. Wait briefly, then retry the same check."],
    "fresh-authorization-used": ["Check the pair before authorizing again", "The campaign refresh may have completed, but its response did not reach this browser. No release request was sent. Your pair is preserved—check it again, then sign a fresh authorization."],
    "retryable-error": ["The action did not finish", "The submitted pair and any still-valid live verdict are preserved. Read the notice, then retry the same step."],
    offline: ["You are offline", "Reconnect to the internet, then retry. No release request was sent while this browser was offline."],
  };
  const [title, body] = copies[flow] ?? copies.empty;
  return { title, body };
}

function pairCheckLabel(flow, configState) {
  if (configState === "loading") return "Loading live campaign";
  const labels = {
    "wallet-connecting": "Connecting source wallet",
    "release-processing": "Check processing status",
    "release-uncertain": "Check release status",
    "continuation-waiting": "Check lineage eligibility",
    empty: "Check exact pair",
    editing: "Check exact pair",
    malformed: "Fix fields and check again",
    checking: "Checking live Ethereum facts",
    "semantic-mismatch": "Check pair again",
    "campaign-closed": "Inspect exact pair",
    "campaign-full": "Inspect exact pair",
    "pair-changed": "Check changed pair",
    "campaign-changed": "Check against new campaign",
    "service-unavailable": "Retry pair check",
    "rate-limited": "Retry after waiting",
    "fresh-authorization-used": "Check same pair again",
    "retryable-error": "Try the same pair again",
    offline: "Offline",
  };
  return labels[flow] ?? "Check exact pair";
}

function authorizationLabel(flow, account, derivedWallet) {
  const labels = {
    "wallet-connecting": "Connecting source wallet",
    "authorization-requested": "Confirm in source wallet",
    "proof-queued": "Proof request queued",
    "proof-building": "Building native proof",
    "release-relaying": "Relaying fixed release",
  };
  if (labels[flow]) return labels[flow];
  if (!account) return "Connect source wallet";
  if (!walletsMatch(account, derivedWallet)) return "Switch account in wallet";
  return "Authorize exact recovery";
}

function stateIcon(flow) {
  if (flow === "released" || flow === "already-claimed") return <Check />;
  if (flow === "qualifying") return <ShieldCheck />;
  if (["checking", "discovering", "wallet-connecting", "authorization-requested", "proof-queued", "proof-building", "release-relaying", "loading-config"].includes(flow)) return <LoaderCircle className="spin" />;
  if (["malformed", "semantic-mismatch", "discovery-empty", "discovery-unavailable", "retryable-error", "service-unavailable", "rate-limited", "fresh-authorization-used", "offline", "campaign-changed", "campaign-closed", "campaign-full", "pair-changed", "release-uncertain"].includes(flow)) return <AlertCircle />;
  if (flow === "continuation-waiting") return <LockKeyhole />;
  if (flow === "release-processing") return <LoaderCircle className="spin" />;
  if (["wrong-wallet", "account-changed"].includes(flow)) return <Wallet />;
  return <Search />;
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
  if (rule?.startBlock === undefined || rule?.startBlock === null || !rule?.endBlock) {
    return "Block window pending";
  }
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

function isLineageV2(config) {
  return Boolean(
    config?.contractVersion === "v2"
    && config?.lineage
    && typeof config.lineage === "object"
    && config.lineage.predecessor
    && typeof config.lineage.predecessor === "object"
  );
}

function isContinuationWaiting(config) {
  return isLineageV2(config)
    && config.lineage.releasesUnlocked === false
    && config.campaign?.releaseState === "continuation-waiting";
}

function lineageEligibilityCopy(status, releasesUnlocked) {
  const copies = {
    unused: {
      title: "Unused across RetryCredit-sponsored history",
      body: releasesUnlocked
        ? "Recovery history carries forward across campaigns this sponsor funds. An unrelated pool cannot mark this retry as used."
        : "Recovery history carries forward across campaigns this sponsor funds. This pair is unused, but settlement still waits for the predecessor boundary.",
    },
    "claimed-current": {
      title: "Already used in this campaign",
      body: "The current campaign has already consumed this wallet or its exact evidence and cannot release it again.",
    },
    "claimed-predecessor": {
      title: "Already recovered in an earlier RetryCredit campaign",
      body: "The bound predecessor already consumed this wallet or evidence. Recovery remains recorded across future campaigns from this sponsor.",
    },
    "claimed-sponsor": {
      title: "Already recovered in this sponsor lineage",
      body: "Another campaign from the same sponsor already consumed this wallet or evidence. Recovery remains recorded across future campaigns from this sponsor.",
    },
  };
  return copies[status] ?? {
    title: releasesUnlocked ? "Lineage checks apply" : "Predecessor boundary still waiting",
    body: releasesUnlocked
      ? "Every release checks predecessor history and sponsor-wide wallet, query, and pair use."
      : "You can check a pair now. Settlement opens only after the predecessor campaign fills or passes its deadline.",
  };
}

function serviceLabel(state) {
  return ({
    loading: "Loading campaign",
    ready: "Recovery live",
    "read-only": "Read-only staging",
    "continuation-waiting": "Continuation waiting",
    "campaign-closed": "Campaign closed",
    "campaign-full": "Campaign full",
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

function canonicalTransactionHash(value) {
  try {
    return normalizeEthereumTransactionReference(value);
  } catch {
    return "";
  }
}

function compactHash(value) {
  if (!value || value.length < 24) return value || "—";
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function safeAddress(value) {
  if (!value) return "";
  try { return getAddress(value); } catch { return ""; }
}

function hasPairDraft(pair) {
  return Boolean(pair?.failedTransactionHash || pair?.successfulTransactionHash);
}

function isBusyFlow(flow) {
  return ["checking", "discovering", "wallet-connecting", "authorization-requested", "proof-queued", "proof-building", "release-relaying"].includes(flow);
}

function needsReleaseStatusCheck(flow) {
  return ["release-processing", "release-uncertain"].includes(flow);
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
