import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const [html, app, styles, api, gitignore, redirects] = await Promise.all([
  readFile(new URL("web/index.html", root), "utf8"),
  readFile(new URL("web/src/main.jsx", root), "utf8"),
  readFile(new URL("web/src/styles.css", root), "utf8"),
  readFile(new URL("web/src/api.mjs", root), "utf8"),
  readFile(new URL(".gitignore", root), "utf8"),
  readFile(new URL("web/public/_redirects", root), "utf8"),
]);

test("the public shell is a multi-route Recovery Dispatch, not the old cockpit", () => {
  assert.match(html, /<title>RetryCredit \| Check a paid retry for recovery<\/title>/);
  assert.match(html, /Ethereum Mainnet → Creditcoin Testnet/);
  assert.match(app, /path: "\/", label: "Recovery"/);
  assert.match(app, /path: "\/cases", label: "Cases"/);
  assert.match(app, /path: "\/protocol", label: "Protocol"/);
  assert.match(app, /className="app-header"/);
  assert.match(app, /className="campaign-layout"/);
  assert.match(app, /className="campaign-file"/);
  assert.match(app, /className=\{`eligibility-desk state-\$\{flow\}`\}/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /aria-current=\{route === path \? "page"/);
  assert.match(redirects, /^\/\* \/index\.html 200$/m);

  assert.doesNotMatch(app, /recovery-cockpit|route-spine|action-bay|app-rail|Five checks\. One release\./);
  assert.doesNotMatch(app, /The retry pays for the failure/);
  assert.doesNotMatch(styles, /\.recovery-cockpit|\.route-spine|\.app-rail|\.mobile-nav/);
  assert.doesNotMatch(styles, /\.hero\b|linear-gradient|radial-gradient|backdrop-filter|box-shadow/);
});

test("Recovery leads with campaign truth and one source-wallet action", () => {
  assert.match(app, /A completed mint can unlock one fixed credit\./);
  for (const label of ["Fixed amount", "Capacity", "Source window", "Claim deadline"]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(app, /RetryCredit pre-funds the bounded Creditcoin release/);
  assert.match(app, /SeaDrop, OpenSea, and the NFT collection do not sponsor or endorse this pilot/);
  assert.match(app, /Connect wallet and check/);
  assert.match(app, /Authorize fixed recovery/);
  assert.match(app, /No destination field and no network switch/);
  assert.match(app, /contract derives the payout wallet from that pair/);
  assert.doesNotMatch(app, /wallet_switchEthereumChain|wallet_addEthereumChain/);
  assert.doesNotMatch(app, /<input/);

  assert.match(app, /One wallet\. One ordered source pair\. One fixed release\./);
  assert.match(app, /Mint did not complete/);
  assert.match(app, /NFT mint completed/);
  assert.match(app, /Fixed credit released/);
  assert.match(app, /config\?\.featuredCase/);
  assert.match(app, /eligibility\?\.pair/);
});

test("the wallet desk includes every required resilient state", () => {
  for (const state of [
    "loading-config",
    "disconnected",
    "checking",
    "ineligible",
    "eligible",
    "authorizing",
    "proof-pending",
    "relay-pending",
    "released",
    "already-claimed",
    "service-unavailable",
    "retryable-error",
    "account-changed",
    "offline",
  ]) assert.match(app, new RegExp(`"${state}"`));

  assert.match(app, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(app, /role="alert"/);
  assert.match(app, /checkedWallet\.current\.toLowerCase\(\) !== account\.toLowerCase\(\)/);
  assert.match(app, /disabled=\{disabled\} aria-busy=\{busy\}/);
  assert.match(app, /Inspect the public case/);
  assert.match(app, /Your connected wallet and eligibility state are preserved/);
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
});

test("the V2 API surface is bounded and the V3 helpers remain available", () => {
  for (const route of [
    "/api/recovery/config",
    "/api/recovery/eligibility",
    "/api/recovery/challenge",
    "/api/recovery/release",
  ]) assert.match(api, new RegExp(route.replaceAll("/", "\\/")));
  assert.match(api, /body: \{ wallet, message, issuedAt, expiresAt, signature \}/);
  assert.match(api, /error\?\.status !== 425/);
  assert.match(api, /onPending\?\./);
  assert.match(api, /RECOVERY_ACTION_REQUEST_TIMEOUT_MS = 30_000/);
  assert.match(api, /RELEASE_REQUEST_TIMEOUT_MS = 150_000/);
  assert.match(api, /export async function wakeConfig/);
  assert.match(api, /export async function releaseWhenReady/);
  assert.doesNotMatch(api, /ECONNREFUSED|127\.0\.0\.1:4179/);
});

test("the interface keeps the public accessibility and responsive floor", () => {
  assert.match(app, /className="skip-link"/);
  assert.match(app, /document\.getElementById\("main-content"\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /:focus-visible \{ outline:3px solid var\(--focus\)/);
  assert.match(styles, /\.wallet-button \{[^}]*min-height:44px/s);
  assert.match(styles, /\.secondary-action \{[^}]*min-height:44px/s);
  assert.match(styles, /@media\(max-width:420px\)/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(styles, /@media\(forced-colors:active\)/);
  assert.match(styles, /overflow-wrap:anywhere/);
  assert.match(styles, /min-width:320px/);
});

test("private demo and submission preparation stays out of the repository", async () => {
  await assert.rejects(access(new URL(".github/workflows/keep-render-warm.yml", root)), { code: "ENOENT" });
  await assert.rejects(access(new URL("docs/PRODUCT_DIRECTION_2026-08-14.md", root)), { code: "ENOENT" });
  assert.match(gitignore, /demo-script\.\*/);
  assert.match(gitignore, /docs\/\*SUBMISSION\*\.md/);
  assert.match(gitignore, /submission-checklist\.\*/);
  assert.doesNotMatch(app, /judge page|submission checklist|demo script/i);
});
