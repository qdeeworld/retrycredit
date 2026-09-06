import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import {
  cloudflareHeadersForApiOrigin,
  PRODUCTION_API_ORIGIN,
  SAME_ORIGIN_API_ORIGIN,
  STAGING_API_ORIGIN,
} from "../scripts/cloudflare-headers.mjs";

const root = new URL("../", import.meta.url);
const [html, app, styles, api, uiState, resumeState, gitignore, redirects, headers, license, readme, viteConfig, dockerfile] = await Promise.all([
  readFile(new URL("web/index.html", root), "utf8"),
  readFile(new URL("web/src/main.jsx", root), "utf8"),
  readFile(new URL("web/src/styles.css", root), "utf8"),
  readFile(new URL("web/src/api.mjs", root), "utf8"),
  readFile(new URL("web/src/recovery-ui-state.mjs", root), "utf8"),
  readFile(new URL("web/src/recovery-resume-state.mjs", root), "utf8"),
  readFile(new URL(".gitignore", root), "utf8"),
  readFile(new URL("web/public/_redirects", root), "utf8"),
  readFile(new URL("web/public/_headers", root), "utf8"),
  readFile(new URL("LICENSE", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("vite.config.mjs", root), "utf8"),
  readFile(new URL("Dockerfile", root), "utf8"),
]);

test("the public shell is a multi-route Recovery Dispatch, not the old cockpit", () => {
  assert.match(html, /<title>RetryCredit \| Check a paid retry for recovery<\/title>/);
  assert.match(html, /Ethereum Mainnet → Creditcoin Testnet/);
  assert.match(app, /path: "\/",\s+label: "Recovery"/);
  assert.match(app, /path: "\/cases",\s+label: "Cases"/);
  assert.match(app, /path: "\/protocol",\s+label: "Protocol"/);
  assert.match(app, /className="app-header"/);
  assert.match(app, /className="campaign-layout"/);
  assert.match(app, /className="campaign-file"/);
  assert.match(app, /className=\{`eligibility-desk state-\$\{flow\}`\}/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /aria-current=\{route === path \? "page"/);
  assert.match(redirects, /^\/\* \/index\.html 200$/m);
  assert.match(app, /https:\/\/github\.com\/qdeeworld\/retrycredit/);
  assert.doesNotMatch(app, /github\.com\/dolepee\/retrycredit/);

  assert.doesNotMatch(app, /recovery-cockpit|route-spine|action-bay|app-rail|Five checks\. One release\./);
  assert.doesNotMatch(app, /The retry pays for the failure/);
  assert.doesNotMatch(styles, /\.recovery-cockpit|\.route-spine|\.app-rail|\.mobile-nav/);
  assert.doesNotMatch(styles, /\.hero\b|linear-gradient|radial-gradient|backdrop-filter|box-shadow/);
});

test("Recovery leads with campaign truth and wallet-native discovery with pair fallback", () => {
  assert.match(app, /manifest\?\.promise\.label \?\? "Campaign terms unavailable"/);
  assert.match(app, /function recoveryManifest\(config\) \{\s+if \(!isRecoveryConfigReadable\(config\)\) return null;/);
  assert.match(app, /manifest\.promise\.disclosure/);
  assert.match(app, /Campaign sponsor/);
  assert.match(app, /A completed mint can unlock one fixed credit\./);
  for (const label of ["Fixed amount", "Capacity", "Source window", "Claim deadline"]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /RetryCredit pre-funds the bounded Creditcoin release/);
  assert.match(app, /SeaDrop, OpenSea, and the NFT collection do not sponsor or endorse this pilot/);
  assert.match(app, /Connect wallet and find my retry/);
  assert.match(app, /or enter the exact pair/);
  assert.match(app, /Check exact pair/);
  assert.match(app, /Authorize exact recovery/);
  assert.match(app, /Load published example/);
  assert.match(app, /No destination field and no network switch/);
  assert.match(app, /contract derives the payout wallet from that pair/);
  assert.doesNotMatch(app, /wallet_switchEthereumChain|wallet_addEthereumChain/);
  assert.match(app, /<input/);
  assert.match(app, /Failed paid mint/);
  assert.match(app, /Completed retry/);
  assert.match(app, /Connection reveals only the selected public address/);
  assert.match(app, /independently rechecks any match before it can qualify/);
  assert.match(app, /<DiscoveryReceipt result=\{discoveryResult\} \/>/);
  assert.match(app, /selectDiscoveryAttribution\(result\?\.attribution\)/);
  assert.match(app, /className="discovery-attribution"[\s\S]*target="_blank"[\s\S]*rel="noreferrer"/);
  assert.match(uiState, /Powered by Routescan\.io APIs/);
  assert.match(uiState, /https:\/\/routescan\.io\//);
  assert.match(styles, /\.discovery-attribution \{[^}]*min-height:44px/s);
  assert.doesNotMatch(app, /Connect wallet and check/);

  assert.match(app, /One wallet\. One ordered source pair\. One fixed release\./);
  assert.match(app, /Mint did not complete/);
  assert.match(app, /NFT mint completed/);
  assert.match(app, /Fixed credit released/);
  assert.match(app, /Continuation funded — releases begin after the predecessor campaign fills or passes its deadline/);
  assert.match(app, /Unused across RetryCredit-sponsored history/);
  assert.match(app, /Already recovered in an earlier RetryCredit campaign/);
  assert.match(app, /Recovery remains recorded across future campaigns from this sponsor/);
  assert.match(app, /An unrelated pool cannot mark this retry as used/);
  assert.match(app, /config\?\.featuredCase/);
  assert.match(app, /selectRecoveryEvidence\(\{/);
  assert.match(app, /pair\?\.valueWei/);
  assert.match(app, /pair\?\.mintPriceWei/);
  assert.match(app, /pair\.quantity/);
  assert.match(app, /pair\.nftContract/);
  assert.match(app, /formatMintOutcome\(pair\)/);
  assert.match(uiState, /if \(currentEligibility !== null && currentEligibility !== undefined\)/);
  assert.match(uiState, /if \(!hasPairIdentity\(record\?\.pair\)\) return emptyEvidence\(source\)/);
  assert.match(app, /featured case stays isolated on Cases/);
});

test("the pair desk includes every required resilient state", () => {
  for (const state of [
    "loading-config",
    "empty",
    "editing",
    "malformed",
    "checking",
    "discovering",
    "discovery-empty",
    "discovery-unavailable",
    "semantic-mismatch",
    "qualifying",
    "continuation-waiting",
    "wrong-wallet",
    "wallet-connecting",
    "authorization-requested",
    "proof-queued",
    "proof-building",
    "release-relaying",
    "release-processing",
    "release-uncertain",
    "released",
    "already-claimed",
    "campaign-closed",
    "campaign-full",
    "pair-changed",
    "service-unavailable",
    "rate-limited",
    "fresh-authorization-used",
    "retryable-error",
    "account-changed",
    "campaign-changed",
    "offline",
  ]) assert.match(app, new RegExp(`"${state}"`));

  assert.match(app, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(app, /role="note"/);
  assert.match(app, /Live checks, no signing/);
  assert.match(app, /config\?\.readOnly[\s\S]*cannot request a signature or release credit/);
  assert.match(app, /hasQualifyingResult && !needsStatusCheck && !config\?\.readOnly/);
  assert.match(app, /Pair qualifies; release disabled here/);
  assert.match(app, /Read-only staging stops before signing/);
  assert.match(app, /const compactReadOnlyResult = readOnly && eligibility\?\.eligible === true/);
  assert.match(app, /plain-boundary\$\{compactReadOnlyResult \? " compact-read-only-result" : ""\}/);
  assert.match(app, /Stop before signing/);
  assert.match(app, /Release disabled here/);
  assert.match(styles, /@media\(max-width:820px\)[\s\S]*\.compact-read-only-result \.boundary-line \{ display:none; \}/);
  assert.match(app, /role="alert"/);
  assert.match(app, /pairOperations\.current\.invalidate\(\)/);
  assert.match(app, /operationIsCurrent\(operation, walletOperation\)/);
  assert.match(app, /walletOperations\.current\.isCurrent\(walletOperation\)/);
  assert.match(app, /externalChange && flowRef\.current === "discovering"[\s\S]*updateFlow\("empty"\)/);
  assert.match(app, /authorizationInFlight\.current[\s\S]*isBusyFlow\(flowRef\.current\)[\s\S]*needsReleaseStatusCheck\(flowRef\.current\)[\s\S]*\) return;/);
  assert.match(app, /!config\?\.capabilities\?\.walletNativeDiscovery[\s\S]*\|\| needsStatusCheck/);
  assert.match(app, /if \(needsReleaseStatusCheck\(currentFlow\)\) \{[\s\S]*updateFlow\(currentFlow\);[\s\S]*return true;/);
  assert.match(app, /isBusyFlow\(flowRef\.current\)[\s\S]*needsReleaseStatusCheck\(flowRef\.current\)/);
  assert.match(app, /config\?\.capabilities\?\.walletNativeDiscovery/);
  assert.match(app, /eligibility\?\.eligible && campaignAvailability === "open" && !continuationWaiting/);
  assert.match(app, /!needsReleaseStatusCheck\(flow\)/);
  assert.doesNotMatch(app, /knownAvailability !== "open"/);
  assert.match(app, /const checkDisabled = busy\s+\|\| !online\s+\|\| flow === "offline"\s+\|\| configState === "loading";/);
  assert.match(app, /validateRecoveryPairDraft\(pairDraftRef\.current\)/);
  assert.match(app, /validatePairEligibilityResponse\(\{/);
  assert.match(app, /validateChallengeResponse\(\{/);
  assert.match(app, /validatePairReleaseResponse\(\{/);
  assert.match(app, /validateRecoveryConfigResponse\(next\)/);
  assert.match(app, /currentOrigin: window\.location\.origin/);
  assert.match(app, /selectFeaturedRelease\(\{/);
  assert.match(app, /recoveryCampaignsMatch\(previous, next\)/);
  assert.match(app, /recoveryConfigsMatch\(liveConfig, configRef\.current\)/);
  assert.doesNotMatch(app, /RELEASE_STORAGE_KEY|readSavedRelease|localStorage\.setItem/);
  assert.match(app, /const authorizationStartedAtMs = recoveryClockNow\(\);/);
  assert.match(app, /const authorizationStartedAtWallMs = recoveryWallClockNow\(\);/);
  assert.match(app, /authorizationStartedAtMs,\s+authorizationStartedAtWallMs,\s+wallet,\s+pair,/s);
  assert.match(app, /if \(isRecoveryChallengeExpired\(nextError\)\) \{\s+setError\(cleanError\(nextError\)\);\s+updateFlow\("qualifying"\);/s);
  assert.match(app, /if \(isRecoveryResponseMismatch\(nextError\)\) \{\s+await refreshAfterResponseMismatch\(nextError, operation/);
  assert.match(app, /aria-busy=\{busy\}/);
  assert.match(app, /Inspect the public case/);
  assert.match(app, /The submitted pair and any still-valid live verdict are preserved/);
  assert.match(app, /const campaignAvailability = recoveryCampaignAvailability\(config\)/);
  assert.match(app, /campaignAvailability !== "open"/);
});

test("submitted recovery resumes through public read-only reconciliation only", () => {
  assert.match(app, /loadRecoveryResumeCandidate\(\{/);
  assert.match(app, /loadRecoveryResumeState\(\{/);
  assert.match(app, /checkRecoveryPairEligibility\(\{ apiOrigin: API_ORIGIN, pair \}\)/);
  assert.match(app, /No signature or release is being replayed/);
  assert.match(app, /persistSubmittedRecovery\("proof-queued", liveEligibility\)/);
  assert.match(app, /clearSubmittedRecovery\(\);\s+const next = \{ \.\.\.pairDraftRef\.current/s);
  assert.match(resumeState, /RECOVERY_RESUME_TTL_MS = 15 \* 60 \* 1_000/);
  assert.match(resumeState, /globalThis\.sessionStorage/);
  assert.doesNotMatch(resumeState, /localStorage|indexedDB|state\?\.(?:signature|rawTransaction|privateKey)|record\.(?:signature|rawTransaction|privateKey)/);
});

test("Cases keeps recovered, observed, and controlled evidence distinct", () => {
  assert.match(app, /Public recovery case/);
  assert.match(app, /Eligible observations/);
  assert.match(app, /Onchain records, not users/);
  assert.match(app, /It does not establish customers, demand, identity, or sponsorship/);
  assert.match(app, /Earlier Uniswap controlled lab/);
  assert.match(app, /Founder-operated testnet run/);
  assert.match(app, /not a user or mainnet incident/);
  assert.match(app, /0\.01 tCTC/);
});

test("Protocol states the exact predicate, payout, and truth limits", () => {
  assert.match(app, /dedicated paid SeaDrop pair/);
  assert.match(app, /canonical <code>mintSigned<\/code>/);
  assert.match(app, /0x3d958fe2/);
  assert.match(app, /source chain key 3/);
  assert.match(app, /neither the browser nor the relayer supplies a destination/);
  assert.match(app, /Each wallet, transaction query, and pair can release once/);
  assert.match(app, /only the unused campaign remainder can return to its sponsor/);
  assert.match(app, /does not prove a human-readable revert reason/);
  assert.match(app, /market demand/);
  assert.match(app, /exact gas refund/);
  assert.match(app, /One recovery boundary, two reference adapters/);
  assert.match(app, /organic mainnet evidence/);
  assert.match(app, /archived controlled lab/);
});

test("the open-pair API surface is bounded and archived helpers remain available", () => {
  for (const route of [
    "/api/recovery/config",
    "/api/recovery/intake/eligibility",
    "/api/recovery/intake/challenge",
    "/api/recovery/intake/release",
  ]) assert.match(api, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(api, /body: \{ pair \}/);
  assert.match(api, /body: \{ wallet, pair, issuedAt, expiresAt, signature \}/);
  assert.match(api, /body: \{ wallet, message, issuedAt, expiresAt, signature \}/);
  assert.match(api, /error\?\.status !== 425/);
  assert.match(api, /onSubmitting\?\.\(\)/);
  assert.match(api, /onPending\?\./);
  assert.match(api, /onRetrying\?\./);
  assert.match(api, /class RateLimitedError extends Error/);
  assert.match(api, /RECOVERY_ACTION_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(api, /RELEASE_REQUEST_TIMEOUT_MS = 150_000/);
  assert.match(api, /export async function wakeConfig/);
  assert.match(api, /export async function releaseWhenReady/);
  assert.doesNotMatch(api, /ECONNREFUSED|127\.0\.0\.1:4179/);
});

test("the interface keeps the public accessibility and responsive floor", () => {
  assert.match(app, /className="skip-link"/);
  assert.match(app, /document\.title = routeRecord\.documentTitle/);
  assert.match(app, /document\.getElementById\(routeRecord\.headingId\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /id="campaign-heading" tabIndex="-1"/);
  assert.match(app, /<h1 id=\{id\} tabIndex="-1">/);
  assert.match(styles, /:focus-visible \{ outline:3px solid var\(--focus\)/);
  assert.match(styles, /\.wallet-button \{[^}]*min-height:44px/s);
  assert.match(styles, /\.secondary-action \{[^}]*min-height:44px/s);
  assert.match(styles, /\.example-action \{[^}]*min-height:44px/s);
  assert.match(styles, /\.transaction-field input \{[^}]*min-height:52px/s);
  assert.match(app, /<label htmlFor=\{id\}>\{label\}<\/label>/);
  assert.match(app, /className="hash-readout"/);
  assert.match(app, /href=\{`\$\{ETHEREUM_EXPLORER\}\/tx\/\$\{canonicalHash\}`\}/);
  assert.match(app, /aria-label=\{`Open transaction \$\{canonicalHash\} on Etherscan`\}/);
  assert.match(app, /compactHash\(canonicalHash\)/);
  assert.match(styles, /\.hash-readout \{[^}]*min-height:44px/s);
  assert.match(styles, /\.campaign-file \{[^}]*align-self:stretch/s);
  assert.match(app, /className="file-registration" aria-hidden="true">Campaign file<\/div>/);
  assert.doesNotMatch(app, /className="file-registration"[^>]*><span/);
  assert.match(styles, /\.evidence-step ul \{[^}]*font-size:12px/s);
  assert.match(styles, /@media\(max-width:480px\)[\s\S]*\.service-state \{ grid-row:3;/);
  assert.match(app, /aria-invalid=\{error \? "true" : "false"\}/);
  assert.match(app, /aria-describedby=\{`\$\{helperId\}/);
  assert.match(app, /<form className="pair-intake" onSubmit=\{onCheckPair\} noValidate aria-busy=\{busy\}>/);
  assert.match(app, /id="eligibility-heading" tabIndex="-1"/);
  assert.match(app, /document\.getElementById\("eligibility-heading"\)\?\.focus/);
  assert.match(styles, /@media\(max-width:480px\)/);
  assert.match(styles, /\.service-state \{ grid-row:2; grid-column:2;/);
  assert.doesNotMatch(styles, /\.service-state \{ display:none;/);
  assert.match(styles, /\.step-status > span \{[^}]*font:700 19px/s);
  assert.match(styles, /\.expanded-case\.has-release/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(styles, /@media\(forced-colors:active\)/);
  assert.match(styles, /overflow-wrap:anywhere/);
  assert.match(styles, /min-width:320px/);
  assert.doesNotMatch(app, /"relay-pending"/);
  assert.doesNotMatch(styles, /state-relay-pending/);
  assert.doesNotMatch(styles, /#main-content \{[^}]*outline:none/s);
});

test("the public release carries a license and Cloudflare security policy", () => {
  assert.match(license, /^MIT License/m);
  assert.match(readme, /searches a bounded slice of its public transaction history/);
  assert.match(readme, /Every discovered candidate is advisory/);
  assert.match(readme, /Manual pair checking remains available without connecting a wallet/);
  assert.match(readme, /npm run verify:recovery-gate/);
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /connect-src 'self' https:\/\/retrycredit-api\.onrender\.com/);
  assert.doesNotMatch(headers, /https:\/\/retrycredit-api-staging\.qdworld001\.workers\.dev/);
  const productionHeaders = cloudflareHeadersForApiOrigin(PRODUCTION_API_ORIGIN);
  const sameOriginHeaders = cloudflareHeadersForApiOrigin(SAME_ORIGIN_API_ORIGIN);
  const stagingHeaders = cloudflareHeadersForApiOrigin(STAGING_API_ORIGIN);
  assert.equal(headers, productionHeaders);
  assert.match(productionHeaders, new RegExp(PRODUCTION_API_ORIGIN.replaceAll(".", "\\.")));
  assert.doesNotMatch(productionHeaders, new RegExp(STAGING_API_ORIGIN.replaceAll(".", "\\.")));
  assert.match(stagingHeaders, new RegExp(STAGING_API_ORIGIN.replaceAll(".", "\\.")));
  assert.doesNotMatch(stagingHeaders, new RegExp(PRODUCTION_API_ORIGIN.replaceAll(".", "\\.")));
  assert.match(sameOriginHeaders, /connect-src 'self';/);
  assert.doesNotMatch(sameOriginHeaders, /https:\/\/retrycredit-api/);
  assert.throws(() => cloudflareHeadersForApiOrigin("https://example.invalid"), /unapproved API origin/);
  assert.match(viteConfig, /const headers = cloudflareHeadersForApiOrigin\(apiOrigin\)/);
  assert.match(viteConfig, /loadEnv\(mode, WEB_ROOT, "VITE_"\)/);
  assert.match(viteConfig, /process\.env\.VITE_RETRYCREDIT_API_ORIGIN[\s\S]*\?\? fileEnv\.VITE_RETRYCREDIT_API_ORIGIN[\s\S]*\?\? SAME_ORIGIN_API_ORIGIN/);
  assert.match(viteConfig, /cloudflareHeadersPlugin\(apiOrigin\)/);
  assert.match(viteConfig, /"import\.meta\.env\.VITE_RETRYCREDIT_API_ORIGIN": JSON\.stringify\(apiOrigin\)/);
  const dockerOriginScripts = dockerfile.indexOf("COPY scripts/cloudflare-headers.mjs scripts/verify-web-build-origin.mjs ./scripts/");
  const dockerWebBuild = dockerfile.indexOf("RUN npm run build:web");
  assert.ok(dockerOriginScripts >= 0);
  assert.ok(dockerWebBuild > dockerOriginScripts);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /X-Frame-Options: DENY/);
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
  assert.match(headers, /Permissions-Policy:/);
});

test("self-serve rollout fails closed and live campaign availability changes every action surface", () => {
  assert.match(uiState, /response\?\.capabilities\?\.selfServePairIntake !== true/);
  assert.match(uiState, /response\?\.consent\?\.scope === "hosted-relayer"/);
  assert.match(uiState, /RECOVERY_FRESH_READ_ADMISSION_MODES\.has\(response\?\.consent\?\.freshReadAdmission\)/);
  assert.match(uiState, /config\.campaign\.open === true && remaining > 0/);
  assert.match(app, /campaignFull \? "This recovery campaign has filled\." : "This recovery campaign has closed\."/);
  assert.match(app, /\["campaign-closed", "campaign-full"\]\.includes\(flow\)/);
  assert.match(app, /"campaign-closed": "Inspect exact pair"/);
  assert.match(app, /"campaign-full": "Inspect exact pair"/);
  assert.match(app, /walletActionEnabled/);
  assert.match(app, /disabled=\{!walletActionEnabled\}/);
});

test("open tabs refresh campaign truth and never overstate unfinished browser checks", () => {
  assert.match(app, /CONFIG_REFRESH_INTERVAL_MS = 30_000/);
  assert.match(app, /window\.setInterval\(refreshVisible, CONFIG_REFRESH_INTERVAL_MS\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", refreshVisible\)/);
  assert.match(app, /setCampaignClock\(Date\.now\(\)\)/);
  assert.match(app, /if \(!forceFresh && configFlight\.current\) return configFlight\.current/);
  assert.match(app, /const previousFlight = configFlight\.current/);
  assert.match(app, /previousFlight\.catch\(\(\) => undefined\)\.then\(requestConfig\)/);
  assert.match(app, /configFlight\.current = flight/);
  assert.match(app, /const busy = isBusyFlow\(flow\) \|\| authorizationPending/);
  assert.match(app, /setAuthorizationPending\(true\)/);
  assert.match(app, /setAuthorizationPending\(false\)/);
  const challengeRequest = app.indexOf("await requestRecoveryIntakeChallenge");
  const liveModeRecheck = app.indexOf("canContinueRecoveryAuthorization", challengeRequest);
  const signatureRequest = app.indexOf('method: "personal_sign"', challengeRequest);
  const preFreshRecheck = app.indexOf("const postSignatureAuthorizationConfig", signatureRequest);
  const freshAuthorizationBuild = app.indexOf("createRecoveryFreshReadAuthorization", preFreshRecheck);
  const postSignatureRefresh = app.indexOf("postSignatureConfig = await fetchRecoveryConfig({", freshAuthorizationBuild);
  const usedAuthorizationBranch = app.indexOf("isRecoveryFreshAuthorizationUsed(nextError)", postSignatureRefresh);
  const postSignatureApply = app.indexOf("applyRecoveryConfig(postSignatureConfig)", postSignatureRefresh);
  const postApplyOperationRecheck = app.indexOf("const postSignatureOperationCurrent", postSignatureApply);
  const postSignatureRecheck = app.indexOf("canContinueRecoveryAuthorization", postApplyOperationRecheck);
  const releaseRequest = app.indexOf("await releaseRecoveryPairWhenReady", signatureRequest);
  const onSubmittingCallback = app.indexOf("onSubmitting: () => {", releaseRequest);
  const submittedAtMarker = app.indexOf("submittedRecoveryStartedAt.current = Date.now()", signatureRequest);
  const proofQueuedMarker = app.indexOf('updateFlow("proof-queued")', submittedAtMarker);
  const releaseSubmittedMarker = app.indexOf("releaseSubmitted = true", proofQueuedMarker);
  const persistenceMarker = app.indexOf('persistSubmittedRecovery("proof-queued"', releaseSubmittedMarker);
  const onPendingCallback = app.indexOf("onPending: () => {", onSubmittingCallback);
  assert.ok(challengeRequest >= 0);
  assert.ok(liveModeRecheck > challengeRequest);
  assert.ok(signatureRequest > liveModeRecheck);
  assert.ok(preFreshRecheck > signatureRequest);
  assert.ok(freshAuthorizationBuild > preFreshRecheck);
  assert.ok(postSignatureRefresh > freshAuthorizationBuild);
  assert.ok(usedAuthorizationBranch > postSignatureRefresh);
  assert.ok(postSignatureApply > postSignatureRefresh);
  assert.ok(postApplyOperationRecheck > postSignatureApply);
  assert.ok(postSignatureRecheck > postApplyOperationRecheck);
  assert.ok(releaseRequest > postSignatureRecheck);
  assert.ok(onSubmittingCallback > releaseRequest);
  assert.ok(submittedAtMarker > onSubmittingCallback);
  assert.ok(proofQueuedMarker > submittedAtMarker);
  assert.ok(releaseSubmittedMarker > proofQueuedMarker);
  assert.ok(persistenceMarker > releaseSubmittedMarker);
  assert.ok(onPendingCallback > persistenceMarker);
  const postChallengeGuard = app.slice(liveModeRecheck, signatureRequest);
  assert.match(postChallengeGuard, /initialConfig: liveConfig/);
  assert.match(postChallengeGuard, /currentConfig: currentAuthorizationConfig/);
  assert.match(postChallengeGuard, /recoveryAuthorizationInterruptionFlow/);
  assert.match(postChallengeGuard, /updateFlow\(interruptionFlow\)/);
  const postSignatureFetch = app.slice(postSignatureRefresh, postSignatureApply);
  assert.match(postSignatureFetch, /catch \(nextError\)[\s\S]*operationIsCurrent\(operation, walletOperation\)/);
  assert.match(postSignatureFetch, /canAttempt: \(\) => operationIsCurrent\(operation, walletOperation\)/);
  assert.match(postSignatureFetch, /freshAuthorization/);
  assert.match(postSignatureFetch, /setConfigState\("unavailable"\)/);
  assert.match(postSignatureFetch, /updateEligibility\(null\)/);
  assert.match(postSignatureFetch, /setReleaseResult\(null\)/);
  assert.match(postSignatureFetch, /updateFlow\(isRecoveryRateLimited\(nextError\) \? "rate-limited" : "service-unavailable"\)/);
  assert.match(postSignatureFetch, /return/);
  const usedAuthorizationHandling = app.slice(
    app.indexOf("} else if (isRecoveryFreshAuthorizationUsed(nextError))", postSignatureRefresh),
    app.indexOf("} else if (isRecoveryFreshAuthorizationRejected(nextError))", postSignatureRefresh),
  );
  assert.match(usedAuthorizationHandling, /updateEligibility\(null\)/);
  assert.match(usedAuthorizationHandling, /setReleaseResult\(null\)/);
  assert.match(usedAuthorizationHandling, /updateFlow\("fresh-authorization-used"\)/);
  assert.match(usedAuthorizationHandling, /getElementById\("eligibility-heading"\)/);
  assert.doesNotMatch(
    usedAuthorizationHandling,
    /releaseSubmitted|persistSubmittedRecovery|saveRecoveryResumeState|setPairDraft|pairDraftRef/,
  );
  assert.equal((app.match(/method: "personal_sign"/g) ?? []).length, 1);
  assert.match(app, /configState === "unavailable" && flow !== "rate-limited"/);
  const postSignatureGuard = app.slice(postSignatureRecheck, releaseRequest);
  assert.match(postSignatureGuard, /initialConfig: liveConfig/);
  assert.match(postSignatureGuard, /currentConfig: postSignatureConfig/);
  assert.match(postSignatureGuard, /recoveryAuthorizationInterruptionFlow/);
  assert.match(postSignatureGuard, /updateFlow\(interruptionFlow\)/);
  assert.doesNotMatch(postSignatureGuard, /submittedRecoveryStartedAt|proof-queued|releaseSubmitted = true|persistSubmittedRecovery/);
  const onSubmittingBody = app.slice(onSubmittingCallback, onPendingCallback);
  assert.match(onSubmittingBody, /submittedRecoveryStartedAt\.current = Date\.now\(\)/);
  assert.match(onSubmittingBody, /updateFlow\("proof-queued"\)/);
  assert.match(onSubmittingBody, /releaseSubmitted = true/);
  assert.match(onSubmittingBody, /persistSubmittedRecovery\("proof-queued"/);
  assert.match(app, /recoveryEligibleInspectionFlow\(\{[\s\S]*config: liveConfig,[\s\S]*sourceWallet: result\.wallet/);
  const accountUpdateStart = app.indexOf("function updateConnectedAccount");
  const connectWalletStart = app.indexOf("async function connectWallet", accountUpdateStart);
  const accountUpdate = app.slice(accountUpdateStart, connectWalletStart);
  assert.ok(accountUpdateStart >= 0);
  assert.ok(connectWalletStart > accountUpdateStart);
  assert.match(accountUpdate, /recoveryEligibleAccountUpdateFlow\(\{/);
  assert.match(accountUpdate, /config: configRef\.current/);
  assert.match(accountUpdate, /connectedAccount: next/);
  assert.match(accountUpdate, /sourceWallet: liveEligibility\.wallet/);
  assert.match(accountUpdate, /currentFlow/);
  assert.match(accountUpdate, /externalChange/);
  assert.match(accountUpdate, /previousAccount: previous/);
  const initialAccountsStart = app.indexOf('method: "eth_accounts"');
  const accountListenerStart = app.indexOf('window.ethereum.on?.("accountsChanged"', initialAccountsStart);
  const walletAccountCallbacks = app.slice(initialAccountsStart, accountListenerStart);
  assert.ok(initialAccountsStart >= 0);
  assert.ok(accountListenerStart > initialAccountsStart);
  assert.match(walletAccountCallbacks, /updateConnectedAccount\(next\)/);
  assert.match(walletAccountCallbacks, /updateConnectedAccount\(next, \{ externalChange: true \}\)/);
  assert.match(app, /if \(flowRef\.current === "account-changed"\)/);
  assert.match(app, /featuredState === "ready"/);
  assert.match(app, /Verifying source pair/);
  assert.match(app, /Verification unavailable/);
  assert.match(app, /role="status" aria-live="polite">\{featuredLabel\}/);
  assert.match(uiState, /Math\.floor\(Date\.now\(\) \/ 1_000\) > deadline/);
});

test("private demo and submission preparation stays out of the repository", async () => {
  await assert.rejects(access(new URL(".github/workflows/keep-render-warm.yml", root)), { code: "ENOENT" });
  await assert.rejects(access(new URL("docs/PRODUCT_DIRECTION_2026-08-14.md", root)), { code: "ENOENT" });
  assert.match(gitignore, /demo-script\.\*/);
  assert.match(gitignore, /docs\/\*SUBMISSION\*\.md/);
  assert.match(gitignore, /submission-checklist\.\*/);
  assert.doesNotMatch(app, /judge page|submission checklist|demo script/i);
});
