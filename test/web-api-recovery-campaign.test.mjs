import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { WorkerError } from "../src/proof-worker.mjs";
import {
  RECOVERY_RELEASE_DEFAULTS,
  createAppHandler,
  resolveRecoveryBootstrap,
} from "../src/server.mjs";

const origin = "https://retrycredit.example";
const wallet = "0x1111111111111111111111111111111111111111";

test("production public mode selects the reviewed recovery release without dashboard drift", () => {
  assert.deepEqual(
    resolveRecoveryBootstrap({
      RETRYCREDIT_PUBLIC_ENABLED: "true",
      PUBLIC_ORIGIN: RECOVERY_RELEASE_DEFAULTS.publicOrigin,
    }),
    {
      enabled: true,
      poolAddress: RECOVERY_RELEASE_DEFAULTS.poolAddress,
      campaignNumber: RECOVERY_RELEASE_DEFAULTS.campaignNumber,
      productionDefault: true,
    },
  );

  assert.deepEqual(
    resolveRecoveryBootstrap({
      RETRYCREDIT_PUBLIC_ENABLED: "true",
      PUBLIC_ORIGIN: RECOVERY_RELEASE_DEFAULTS.publicOrigin,
      RETRYCREDIT_RECOVERY_ENABLED: "false",
    }),
    { enabled: false, poolAddress: null, campaignNumber: null, productionDefault: false },
  );

  assert.deepEqual(
    resolveRecoveryBootstrap({ RETRYCREDIT_RECOVERY_ENABLED: "true" }),
    {
      enabled: true,
      poolAddress: RECOVERY_RELEASE_DEFAULTS.poolAddress,
      campaignNumber: RECOVERY_RELEASE_DEFAULTS.campaignNumber,
      productionDefault: false,
    },
  );

  assert.deepEqual(
    resolveRecoveryBootstrap({
      RETRYCREDIT_RECOVERY_ENABLED: "true",
      RETRYCREDIT_RECOVERY_POOL_ADDRESS: "",
      RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "   ",
    }),
    {
      enabled: true,
      poolAddress: RECOVERY_RELEASE_DEFAULTS.poolAddress,
      campaignNumber: RECOVERY_RELEASE_DEFAULTS.campaignNumber,
      productionDefault: false,
    },
  );

  assert.deepEqual(
    resolveRecoveryBootstrap({
      RETRYCREDIT_PUBLIC_ENABLED: "true",
      PUBLIC_ORIGIN: RECOVERY_RELEASE_DEFAULTS.publicOrigin,
      RETRYCREDIT_RECOVERY_ENABLED: " ",
      RETRYCREDIT_RECOVERY_POOL_ADDRESS: "",
      RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "   ",
    }),
    {
      enabled: true,
      poolAddress: RECOVERY_RELEASE_DEFAULTS.poolAddress,
      campaignNumber: RECOVERY_RELEASE_DEFAULTS.campaignNumber,
      productionDefault: true,
    },
  );

  assert.deepEqual(
    resolveRecoveryBootstrap({
      RETRYCREDIT_RECOVERY_ENABLED: "true",
      RETRYCREDIT_RECOVERY_POOL_ADDRESS: wallet,
    }),
    { enabled: true, poolAddress: wallet, campaignNumber: null, productionDefault: false },
  );
});

test("disabled recovery config is shape-stable and CORS applies to GET and preflight", async () => {
  await withServer({ state: "disabled", service: null, error: null }, async (base) => {
    const response = await fetch(`${base}/api/recovery/config`, {
      headers: { origin },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.waking, false);
    assert.equal(body.poolAddress, null);
    assert.equal(body.campaign, null);
    assert.equal(body.rule, null);
    assert.equal(body.capacity, null);
    assert.equal(body.discoverySize, 3);
    assert.deepEqual(body.source, { name: "Ethereum Mainnet", chainId: 1, chainKey: 3 });

    const preflight = await fetch(`${base}/api/recovery/release`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  });
});

test("waking recovery exposes config without blocking and returns 425 for actions", async () => {
  const service = { poolAddress: wallet, campaignNumber: 7 };
  await withServer({ state: "waking", service, error: null }, async (base) => {
    const configResponse = await fetch(`${base}/api/recovery/config`);
    const config = await configResponse.json();
    assert.equal(configResponse.status, 200);
    assert.equal(config.enabled, true);
    assert.equal(config.waking, true);
    assert.equal(config.poolAddress, wallet);
    assert.equal(config.campaignNumber, 7);

    const response = await post(base, "/api/recovery/eligibility", { wallet });
    assert.equal(response.status, 425);
    const body = await response.json();
    assert.equal(body.error.code, "RECOVERY_WAKING");
    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
  });
});

test("ready API routes preserve the fixed recovery response contract", async () => {
  const calls = [];
  const service = {
    async configuration() {
      calls.push(["configuration"]);
      return { enabled: true, waking: false, campaignNumber: 7 };
    },
    async eligibility(input) {
      calls.push(["eligibility", input]);
      return { eligible: true, status: "eligible", wallet: input, campaignNumber: 7 };
    },
    async challenge(input) {
      calls.push(["challenge", input]);
      return { wallet: input, message: "consent", issuedAt: 1, expiresAt: 301 };
    },
    async release(input) {
      calls.push(["release", input]);
      return { status: "released", wallet: input.wallet, campaignNumber: 7 };
    },
  };

  await withServer({ state: "ready", service, error: null }, async (base) => {
    const config = await fetch(`${base}/api/recovery/config`);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).campaignNumber, 7);

    const eligibility = await post(base, "/api/recovery/eligibility", { wallet });
    assert.equal(eligibility.status, 200);
    assert.equal((await eligibility.json()).status, "eligible");

    const challenge = await post(base, "/api/recovery/challenge", { wallet });
    assert.equal(challenge.status, 200);
    assert.equal((await challenge.json()).message, "consent");

    const releaseRequest = {
      wallet,
      message: "consent",
      issuedAt: 1,
      expiresAt: 301,
      signature: `0x${"11".repeat(65)}`,
    };
    const release = await post(base, "/api/recovery/release", releaseRequest);
    assert.equal(release.status, 200);
    assert.equal((await release.json()).status, "released");
    assert.deepEqual(calls, [
      ["configuration"],
      ["eligibility", wallet],
      ["challenge", wallet],
      ["release", releaseRequest],
    ]);
  });
});

test("recovery domain errors retain status, safe code/message, CORS, and request ID", async () => {
  const service = {
    async eligibility() {
      throw new WorkerError("RECOVERY_REPLAYED", "This exact recovery action was consumed.", 409);
    },
  };
  await withServer({ state: "ready", service, error: null }, async (base) => {
    const response = await post(base, "/api/recovery/eligibility", { wallet });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(body.error.code, "RECOVERY_REPLAYED");
    assert.equal(body.error.message, "This exact recovery action was consumed.");
  });
});

test("invalid JSON and disabled release never become internal errors", async () => {
  const service = { async release() { throw new Error("must not run"); } };
  await withServer({ state: "ready", service, error: null }, async (base) => {
    const invalid = await fetch(`${base}/api/recovery/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_JSON");
  });

  await withServer({ state: "disabled", service: null, error: null }, async (base) => {
    const response = await post(base, "/api/recovery/release", { wallet });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "RECOVERY_DISABLED");
  });
});

async function withServer(recovery, callback) {
  const campaignWorker = {
    async getLatestCampaign() { throw new Error("legacy route should not run"); },
    async getCampaign() { throw new Error("legacy route should not run"); },
    async prepareClaim() { throw new Error("legacy route should not run"); },
  };
  const server = createServer(createAppHandler({
    campaignWorker,
    legacyRetryCreditService: null,
    recovery,
    allowedOrigin: origin,
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}
