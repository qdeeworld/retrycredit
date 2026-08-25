import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const files = await Promise.all([
  readFile(new URL("web/index.html", root), "utf8"),
  readFile(new URL("web/src/main.jsx", root), "utf8"),
  readFile(new URL("web/src/styles.css", root), "utf8"),
  readFile(new URL("web/src/api.mjs", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("docs/DEPLOYMENTS.md", root), "utf8"),
  readFile(new URL("docs/WORKER_API.md", root), "utf8"),
  readFile(new URL(".env.example", root), "utf8"),
  readFile(new URL(".gitignore", root), "utf8"),
  readFile(new URL("render.yaml", root), "utf8"),
  readFile(new URL("src/server.mjs", root), "utf8"),
  readFile(new URL("package.json", root), "utf8"),
  readFile(new URL("web/public/_redirects", root), "utf8"),
]);
const [html, app, styles, api, readme, deployments, workerDoc, envExample, gitignore, render, server, packageJson, redirects] = files;

test("public brand and primary action describe one recoverable RetryCredit journey", () => {
  assert.match(html, /<title>RetryCredit \| The retry pays for the failure<\/title>/);
  assert.match(html, /https:\/\/retrycredit\.dolepee\.com\/retrycredit-og-v1\.png/);
  assert.match(app, /https:\/\/github\.com\/dolepee\/retrycredit/);
  assert.doesNotMatch(html, /github\.com\/dolepee\/ruledrop/);
  assert.doesNotMatch(html, /RuleDrop/);

  assert.match(app, /Finish the swap/);
  assert.match(app, /Clear one funded recovery/);
  assert.match(app, /path: "\/activity"/);
  assert.match(app, /path: "\/protocol"/);
  assert.match(app, /className="action-bay" id="start"/);
  assert.match(app, /window\.history\.pushState/);
  assert.match(app, /aria-current=\{route === path \? "page"/);
  assert.match(redirects, /^\/\* \/index\.html 200$/m);
  assert.match(app, /Connect wallet to start/);
  assert.match(app, /hexlify\(toUtf8Bytes\(challenge\.message\)\)/);
  assert.match(app, /The release boundary/);
  assert.match(app, /Restart saved run/);
  assert.match(app, /session && <button className="reset-action" onClick=\{onReset\} disabled=\{busy\}/);
  assert.doesNotMatch(app, /href="#proof"/);
  assert.doesNotMatch(app, />Proof</);
  assert.doesNotMatch(app, /judge/i);
  assert.match(app, /no mainnet asset or token approval/i);

  assert.match(app, /useState\("idle"\)/);
  for (const state of ["waking", "ready", "paused", "temporarily-unavailable"]) {
    assert.match(app, new RegExp(`"${state}"`));
  }
  assert.match(app, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(app, /Waking the proof service — the first start can take up to about 45 seconds/);
  assert.match(app, /Wake service and retry/);
  assert.match(app, /Your saved recovery is unchanged; try again/);
  assert.match(app, /disabled=\{busy \|\| wrongWallet \|\| phase === "released"\}/);
  assert.match(app, /className="primary-action"[^>]*aria-busy=\{busy\}/);
  assert.doesNotMatch(app, /className="action-bay" id="start" aria-busy/);
  assert.match(app, /The proof service is paused\. Your saved recovery is unchanged; check again later\./);
  assert.match(app, /Check service again/);
  assert.doesNotMatch(app, /className="wallet-button" disabled=/);
  assert.match(app, /session\?\.beneficiary && session\.beneficiary\.toLowerCase\(\) !== wallet\.toLowerCase\(\)/);
  assert.match(app, /const beneficiary = session\?\.beneficiary \|\| account/);
  assert.match(app, /Saved recovery receipts/);
  assert.match(app, /session\.failedTransactionHash && <SavedReceipt/);
  assert.match(app, /session\.successfulTransactionHash && <SavedReceipt/);
  assert.match(app, /session\.release\?\.transactionHash && <SavedReceipt/);
  assert.match(app, /document\.getElementById\("main-content"\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(app, /}, \[path\]\)/);

  assert.match(styles, /\.wallet-button \{ min-height:44px/);
  assert.doesNotMatch(styles, /\.wallet-button\s*\{[^}]*font-size:0/);
  assert.match(styles, /\.primary-action \{[^}]*min-height:84px/);
  assert.match(styles, /\.mobile-nav a \{[^}]*min-height:60px/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(styles, /\.hero\b/);
  assert.doesNotMatch(styles, /\.action-panel\b/);

  assert.match(api, /CONFIG_WAKE_TOTAL_TIMEOUT_MS = 45_000/);
  assert.match(api, /CONFIG_WAKE_REQUEST_TIMEOUT_MS = 38_000/);
  assert.match(api, /CONFIG_WAKE_ATTEMPT_OFFSETS_MS = \[0, 3_000, 8_000\]/);
  assert.match(api, /RELEASE_REQUEST_TIMEOUT_MS = 150_000/);
  assert.match(api, /RetryCredit is temporarily unavailable\. Please try again shortly\./);
  assert.doesNotMatch(api, /ECONNREFUSED|127\.0\.0\.1:4179/);
});

test("public evidence links bind the exact fresh lifecycle", () => {
  const hashes = [
    "0x9cb81e134e33f32b702786589510948d097ae98d0ef3ffec4c631a1288a0ee07",
    "0x81e96116c5b3e050a1b4ac6d1cea611817e7d028636003e7aa6d12f5c412f9b0",
    "0xb787581b58bab15bc4e8e78389c6d0d4bb362896d265bdbe2263df7d7eb77cdf",
  ];
  for (const hash of hashes) {
    assert.match(app, new RegExp(hash));
    assert.match(readme, new RegExp(hash));
    assert.match(deployments, new RegExp(hash));
  }
  assert.match(readme, /founder-funded service credit/);
  assert.match(readme, /not independent adoption or customer demand/);
  assert.match(app, /From stale route to credit in 552 seconds/);
  assert.match(app, /0\.218500 test USDC/);
  assert.match(app, /Creditcoin · 0\.01 tCTC/);
  assert.match(readme, /reviewed V3 pilot/);
  assert.match(deployments, /controlled stale-route test/);
});

test("deployment and API docs describe the active V3 release", () => {
  const addresses = [
    "0xFB6E577ED8B472AC4aC99fA0Dbc0e3BF904BAFE3",
    "0x6AF76Af54861f9F6E9F38cfD02A1002dc650bc86",
    "0x97Fa88CfCaeE1a5D4Ae749b9b5698F2147b986fC",
    "0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1",
    "0x0000000000000000000000000000000000000FD2",
  ];
  for (const address of addresses) assert.match(deployments, new RegExp(address));
  assert.match(deployments, /Attestcoin `chainKey 1`/);
  assert.match(deployments, /V3.*release marker/i);
  assert.match(deployments, /archived proof-engine predecessor evidence/i);
  assert.doesNotMatch(deployments, /live V1 deployment|judge-facing/i);

  const routes = [
    "GET /health",
    "GET /api/retry-credit/config",
    "POST /api/retry-credit/challenge",
    "POST /api/retry-credit/prepare",
    "GET /api/retry-credit/:serviceCreditNumber/status",
    "POST /api/retry-credit/:serviceCreditNumber/execute",
    "POST /api/retry-credit/:serviceCreditNumber/release",
  ];
  for (const route of routes) assert.match(workerDoc, new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workerDoc, /HTTP `425`/);
  assert.match(workerDoc, /x-request-id/);
  assert.match(workerDoc, /CORS is not authentication/);
  assert.match(workerDoc, /fail fast.*not payout authority/is);
  assert.doesNotMatch(workerDoc, /^# RuleDrop Worker API/m);

  for (const name of [
    "ALLOWED_ORIGIN",
    "PUBLIC_ORIGIN",
    "RETRYCREDIT_PUBLIC_ENABLED",
    "RETRYCREDIT_DEMO_PRIVATE_KEY",
    "RETRYCREDIT_POOL_ADDRESS",
    "RETRYCREDIT_VERIFIER_ADDRESS",
    "SEPOLIA_RPC_URL",
    "CREDITCOIN_RPC",
    "ATTESTCOIN_PROOF_BUILDER",
  ]) assert.match(envExample, new RegExp(`^${name}=`, "m"));
  assert.match(envExample, /^RETRYCREDIT_DEMO_PRIVATE_KEY=$/m);

  assert.match(render, /RETRYCREDIT_PUBLIC_ENABLED\n\s+value: "true"/);
  assert.match(render, /RETRYCREDIT_DEMO_PRIVATE_KEY\n\s+sync: false/);
  assert.match(render, /name: retrycredit-api/);
  assert.match(server, /0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1/);
  assert.match(render, /https:\/\/retrycredit\.dolepee\.com/);
  assert.match(packageJson, /"build:web:cloudflare": "VITE_RETRYCREDIT_API_ORIGIN=https:\/\/retrycredit-api\.onrender\.com vite build"/);
});

test("private demo and submission preparation stays out of the repository", async () => {
  await assert.rejects(access(new URL(".github/workflows/keep-render-warm.yml", root)), { code: "ENOENT" });
  await assert.rejects(access(new URL("docs/PRODUCT_DIRECTION_2026-08-14.md", root)), { code: "ENOENT" });
  assert.match(gitignore, /demo-script\.\*/);
  assert.match(gitignore, /docs\/\*SUBMISSION\*\.md/);
  assert.match(gitignore, /submission-checklist\.\*/);
});
