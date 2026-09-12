import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { WorkerError } from "../src/proof-worker.mjs";
import { serializeRecoveryPairDiagnostics } from "../src/recovery-pair-diagnostics.mjs";
import {
  RECOVERY_RELEASE_DEFAULTS,
  createAppHandler,
  createRecoveryVerification,
  normalizeDeploymentRevision,
  recoveryV2HealthSnapshot,
  resolveRecoveryContractVersion,
  resolveLegacyWritesEnabled,
  resolveRecoveryBootstrap,
} from "../src/server.mjs";

const origin = "https://retrycredit.example";
const wallet = "0x1111111111111111111111111111111111111111";
const pair = {
  failedTransactionHash: `0x${"11".repeat(32)}`,
  successfulTransactionHash: `0x${"22".repeat(32)}`,
};

test("recovery contract selection is explicit and defaults safely to V1", () => {
  assert.equal(resolveRecoveryContractVersion({}), "v1");
  assert.equal(resolveRecoveryContractVersion({ RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "" }), "v1");
  assert.equal(resolveRecoveryContractVersion({ RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v1" }), "v1");
  assert.equal(resolveRecoveryContractVersion({ RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2" }), "v2");
  for (const value of ["2", "V2", " v2 ", "v3"]) {
    assert.throws(
      () => resolveRecoveryContractVersion({ RETRYCREDIT_RECOVERY_CONTRACT_VERSION: value }),
      /must be exactly v1 or v2/,
    );
  }
});

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

test("V2 bootstrap refuses inherited V1 defaults and partial activation", () => {
  const env = { RETRYCREDIT_RECOVERY_ENABLED: "true", RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2" };
  for (const overrides of [
    {},
    { RETRYCREDIT_RECOVERY_POOL_ADDRESS: wallet },
    { RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "1" },
    { RETRYCREDIT_RECOVERY_POOL_ADDRESS: " ", RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "1" },
  ]) {
    assert.throws(() => resolveRecoveryBootstrap({ ...env, ...overrides }), /explicit pool address and campaign/);
  }
  assert.throws(() => resolveRecoveryBootstrap({
    RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
    RETRYCREDIT_PUBLIC_ENABLED: "true",
    PUBLIC_ORIGIN: RECOVERY_RELEASE_DEFAULTS.publicOrigin,
  }), /explicit pool address and campaign/);
});

test("V2 bootstrap rejects the rollback pool and malformed explicit identities", () => {
  const env = {
    RETRYCREDIT_RECOVERY_ENABLED: "true",
    RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
    RETRYCREDIT_RECOVERY_POOL_ADDRESS: wallet,
    RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: "1",
    RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE: "observation-only",
  };
  for (const pool of [RECOVERY_RELEASE_DEFAULTS.poolAddress, RECOVERY_RELEASE_DEFAULTS.poolAddress.toLowerCase(),
    "0x0000000000000000000000000000000000000000", "not-an-address"]) {
    assert.throws(() => resolveRecoveryBootstrap({ ...env, RETRYCREDIT_RECOVERY_POOL_ADDRESS: pool }), /pool|address/);
  }
  for (const campaign of ["0", "01", "-1", "1.0", "1e2", "9007199254740992"]) {
    assert.throws(() => resolveRecoveryBootstrap({ ...env, RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER: campaign }), /positive campaign/);
  }
  assert.deepEqual(resolveRecoveryBootstrap(env), {
    enabled: true, poolAddress: wallet, campaignNumber: "1", productionDefault: false,
  });
});

test("disabled V2 configuration stays inert without filling activation defaults", () => {
  assert.deepEqual(resolveRecoveryBootstrap({
    RETRYCREDIT_RECOVERY_ENABLED: "false",
    RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
  }), { enabled: false, poolAddress: null, campaignNumber: null, productionDefault: false });
});

test("V2 kill switch skips observation profile validation and preserves server health", async () => {
  const verifier = createRecoveryVerification({
    RETRYCREDIT_RECOVERY_ENABLED: "false", RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
    RETRYCREDIT_RECOVERY_V2_DEPLOYMENT_MODE: "observation-only",
  });
  await verifier.start();
  await withServer({ state: "disabled", service: null }, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const config = await fetch(`${base}/api/recovery/config`);
    assert.equal(config.status, 200);
    assert.equal((await config.json()).enabled, false);
    assert.equal((await fetch(`${base}/api/retry-credit/config`)).status, 200);
  }, { recoveryV2: verifier });
  verifier.stop();
});

test("health exposes only an exact normalized Render revision", async () => {
  const revision = "AB".repeat(20);
  assert.equal(normalizeDeploymentRevision(` ${revision} `), revision.toLowerCase());
  assert.equal(normalizeDeploymentRevision("abc123"), null);
  assert.equal(normalizeDeploymentRevision(undefined), null);

  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.revision, revision.toLowerCase());
      assert.equal(body.recoveryState, "disabled");
      assert.deepEqual(body.recoveryV2, {
        mode: "disabled",
        state: "disabled",
        publicProfile: "v1",
      });
    },
    { deploymentRevision: normalizeDeploymentRevision(revision) },
  );
});

test("health keeps V1 live while the separate V2 readiness route requires exact armed finality", async () => {
  const prepared = {
    contractAddress: "0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8",
    initCodeHash: `0x${"11".repeat(32)}`,
    runtimeCodeHash: `0x${"22".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
  };
  let readinessCalls = 0;
  let startCalls = 0;
  const prepareSupervisor = {
    readiness() {
      readinessCalls += 1;
      return {
        ready: true,
        statusCode: 200,
        mode: "prepare",
        deploymentState: "prepared",
        publicProfile: "v1",
        prepared,
        rawTransaction: "0xsecret",
      };
    },
    async start() { startCalls += 1; },
  };
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.recoveryV2, {
        mode: "prepare",
        state: "prepared",
        publicProfile: "v1",
        prepared,
      });
      assert.doesNotMatch(JSON.stringify(body), /secret|rawTransaction/i);
      const readiness = await fetch(`${base}/health/recovery-v2`);
      assert.equal(readiness.status, 200);
      assert.equal((await readiness.json()).ok, true);
    },
    { recoveryV2: prepareSupervisor },
  );
  assert.equal(readinessCalls, 2);
  assert.equal(startCalls, 0);

  const failedPrepareSupervisor = fixedRecoveryV2Readiness({
    ready: false,
    statusCode: 503,
    mode: "prepare",
    deploymentState: "prepare-failed",
    reason: "RECOVERY_V2_PREPARE_FAILED",
    publicProfile: "v1",
  });
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const liveness = await fetch(`${base}/health`);
      assert.equal(liveness.status, 200);
      assert.equal((await liveness.json()).ok, true);
      const readiness = await fetch(`${base}/health/recovery-v2`);
      assert.equal(readiness.status, 503);
      assert.equal((await readiness.json()).ok, false);
    },
    { recoveryV2: failedPrepareSupervisor },
  );

  const pendingSupervisor = fixedRecoveryV2Readiness({
    ready: false,
    statusCode: 503,
    mode: "armed",
    deploymentState: "pending",
    reason: "EXPECTED_TRANSACTION_PENDING",
    publicProfile: "v1",
  });
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.deepEqual(body.recoveryV2, {
        mode: "armed",
        state: "pending",
        publicProfile: "v1",
        reason: "EXPECTED_TRANSACTION_PENDING",
      });
      const readiness = await fetch(`${base}/health/recovery-v2`);
      assert.equal(readiness.status, 503);
      assert.equal((await readiness.json()).ok, false);
    },
    { recoveryV2: pendingSupervisor },
  );

  const finalizedSupervisor = fixedRecoveryV2Readiness({
    ready: true,
    statusCode: 200,
    mode: "armed",
    deploymentState: "finalized",
    reason: "FINALIZED_PLUS_TWO_VERIFIED",
    publicProfile: "v1",
  });
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).recoveryV2.state, "finalized");
      const readiness = await fetch(`${base}/health/recovery-v2`);
      assert.equal(readiness.status, 200);
      assert.equal((await readiness.json()).ok, true);
    },
    { recoveryV2: finalizedSupervisor },
  );

  assert.deepEqual(recoveryV2HealthSnapshot({
    readiness() {
      return {
        ready: true,
        statusCode: 200,
        mode: "armed",
        deploymentState: "pending",
        reason: "RPC_SECRET_0xfeed",
        publicProfile: "v1",
      };
    },
  }), {
    statusCode: 503,
    publicState: {
      mode: "armed",
      state: "pending",
      publicProfile: "v1",
    },
  });
});

test("archived writes default off and accept only the exact explicit opt-in", () => {
  assert.equal(resolveLegacyWritesEnabled({}), false);
  assert.equal(resolveLegacyWritesEnabled({ RETRYCREDIT_LEGACY_WRITES_ENABLED: "false" }), false);
  assert.equal(resolveLegacyWritesEnabled({ RETRYCREDIT_LEGACY_WRITES_ENABLED: "TRUE" }), false);
  assert.equal(resolveLegacyWritesEnabled({ RETRYCREDIT_LEGACY_WRITES_ENABLED: "true" }), true);
});

test("archived sponsor writes are disabled by default without disabling read-only routes", async () => {
  const calls = [];
  const legacyRetryCreditService = {
    challenge(beneficiary) {
      calls.push("challenge");
      return { beneficiary };
    },
    async prepare() { calls.push("prepare"); return { prepared: true }; },
    async execute() { calls.push("execute"); return { executed: true }; },
    async release() { calls.push("release"); return { released: true }; },
  };
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const configResponse = await fetch(`${base}/api/retry-credit/config`);
      assert.equal(configResponse.status, 200);
      const config = await configResponse.json();
      assert.equal(config.enabled, false);
      assert.equal(config.writesEnabled, false);

      const challengeResponse = await fetch(`${base}/api/retry-credit/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ beneficiary: "0x1111111111111111111111111111111111111111" }),
      });
      assert.equal(challengeResponse.status, 200);

      for (const pathname of [
        "/api/retry-credit/prepare",
        "/api/retry-credit/1/execute",
        "/api/retry-credit/1/release",
      ]) {
        const response = await fetch(`${base}${pathname}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        assert.equal(response.status, 410);
        const body = await response.json();
        assert.equal(body.error.code, "LEGACY_WRITES_DISABLED");
      }
    },
    { legacyRetryCreditService },
  );
  assert.deepEqual(calls, ["challenge"]);
});

test("archived sponsor writes require an explicit server opt-in", async () => {
  let prepareCalls = 0;
  const legacyRetryCreditService = {
    async prepare() {
      prepareCalls += 1;
      return { prepared: true };
    },
  };
  await withServer(
    { state: "disabled", service: null, error: null },
    async (base) => {
      const configResponse = await fetch(`${base}/api/retry-credit/config`);
      const config = await configResponse.json();
      assert.equal(config.enabled, true);
      assert.equal(config.writesEnabled, true);

      const response = await fetch(`${base}/api/retry-credit/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { prepared: true });
    },
    { legacyRetryCreditService, legacyWritesEnabled: true },
  );
  assert.equal(prepareCalls, 1);
});

test("disabled recovery config is shape-stable and CORS applies to GET and preflight", async () => {
  await withServer({ state: "disabled", service: null, error: null }, async (base) => {
    const response = await fetch(`${base}/api/recovery/config`, {
      headers: { origin },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-expose-headers"), "retry-after, x-request-id");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.enabled, false);
    assert.equal(body.waking, false);
    assert.equal(body.publicOrigin, null);
    assert.equal(body.poolAddress, null);
    assert.equal(body.campaign, null);
    assert.equal(body.rule, null);
    assert.equal(body.capacity, null);
    assert.equal(body.discoverySize, 3);
    assert.deepEqual(body.capabilities, { selfServePairIntake: true, walletNativeDiscovery: true });
    assert.deepEqual(body.consent, {
      scope: "hosted-relayer",
      protocolEnforced: false,
      freshReadAdmission: "anonymous-v1",
    });
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
    async configuration(options) {
      calls.push(["configuration", options]);
      return { enabled: true, waking: false, publicOrigin: origin, campaignNumber: 7 };
    },
    async eligibility(input) {
      calls.push(["eligibility", input]);
      return { eligible: true, status: "eligible", wallet: input, campaignNumber: 7 };
    },
    async intakeEligibility(input) {
      calls.push(["intakeEligibility", input]);
      return { eligible: true, status: "eligible", wallet, campaignNumber: 7, pair: input.pair };
    },
    async discover(input) {
      calls.push(["discover", input]);
      return { wallet: input, matches: [pair], authority: "advisory-discovery-only" };
    },
    async intakeChallenge(input) {
      calls.push(["intakeChallenge", input]);
      return { wallet, message: "pair consent", issuedAt: 1, expiresAt: 301, pair: input.pair };
    },
    async intakeRelease(input) {
      calls.push(["intakeRelease", input]);
      return { status: "released", wallet: input.wallet, campaignNumber: 7, pair: input.pair };
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
    const configBody = await config.json();
    assert.equal(configBody.campaignNumber, 7);
    assert.equal(configBody.publicOrigin, origin);

    const freshConfig = await fetch(`${base}/api/recovery/config?fresh=1`);
    assert.equal(freshConfig.status, 200);
    assert.equal((await freshConfig.json()).campaignNumber, 7);

    const intakeEligibilityBody = { pair };
    const discovery = await post(base, "/api/recovery/discover", { wallet });
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).authority, "advisory-discovery-only");
    const intakeEligibility = await post(
      base,
      "/api/recovery/intake/eligibility",
      intakeEligibilityBody,
    );
    assert.equal(intakeEligibility.status, 200);
    assert.equal((await intakeEligibility.json()).wallet, wallet);

    const intakeChallengeBody = { pair };
    const intakeChallenge = await post(base, "/api/recovery/intake/challenge", intakeChallengeBody);
    assert.equal(intakeChallenge.status, 200);
    assert.equal((await intakeChallenge.json()).message, "pair consent");

    const intakeReleaseBody = {
      wallet,
      pair,
      issuedAt: 1,
      expiresAt: 301,
      signature: `0x${"11".repeat(65)}`,
    };
    const intakeRelease = await post(base, "/api/recovery/intake/release", intakeReleaseBody);
    assert.equal(intakeRelease.status, 200);
    assert.equal((await intakeRelease.json()).status, "released");

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
      ["configuration", { fresh: false }],
      ["configuration", { fresh: true }],
      ["discover", wallet],
      ["intakeEligibility", intakeEligibilityBody],
      ["intakeChallenge", intakeChallengeBody],
      ["intakeRelease", intakeReleaseBody],
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

test("intake resource saturation returns explicit 429 state without internal details", async () => {
  const service = {
    async intakeEligibility() {
      throw new WorkerError("RECOVERY_BUSY", "Recovery source intake is busy; retry shortly.", 429);
    },
  };
  await withServer({ state: "ready", service, error: null }, async (base) => {
    const response = await post(base, "/api/recovery/intake/eligibility", { pair });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("access-control-expose-headers"), "retry-after, x-request-id");
    assert.ok(response.headers.get("x-request-id"));
    const body = await response.json();
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
    assert.equal(body.error.code, "RECOVERY_BUSY");
    assert.equal(body.error.message, "Recovery source intake is busy; retry shortly.");
  });
});

test("only pair-inspection semantic errors expose sanitized advisory diagnostics", async () => {
  const diagnostic = diagnosticReportFixture();
  const fail = async () => {
    const error = new WorkerError("RECOVERY_PAIR_INVALID", "Both exact Ethereum transactions and receipts must form the funded retry rule.", 422, new Error("SECRET_PROVIDER_CAUSE"));
    error.diagnostics = {
      ...diagnostic,
      rawTransaction: "SECRET_RAW_TRANSACTION",
      checks: diagnostic.checks.map(check => ({ ...check, message: "SECRET_PROVIDER_MESSAGE" })),
    };
    throw error;
  };
  await withServer({ state: "ready", service: { intakeEligibility: fail, intakeChallenge: fail, intakeRelease: fail } }, async base => {
    const response = await post(base, "/api/recovery/intake/eligibility", { pair });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "RECOVERY_PAIR_INVALID");
    assert.deepEqual(body.error.diagnostics, serializeRecoveryPairDiagnostics(diagnostic));
    assert.doesNotMatch(JSON.stringify(body), /SECRET|rawTransaction|cause/);
    for (const path of ["/api/recovery/intake/challenge", "/api/recovery/intake/release"]) {
      const rejected = await post(base, path, { pair });
      assert.equal(rejected.status, 422);
      assert.equal((await rejected.json()).error.diagnostics, undefined);
    }
  });
});

test("malformed diagnostics and unavailable providers retain the existing error response", async () => {
  for (const [code, status, diagnostic] of [
    ["RECOVERY_PAIR_INVALID", 422, { ...diagnosticReportFixture(), attestationVerified: true }],
    ["RECOVERY_SOURCE_UNAVAILABLE", 503, diagnosticReportFixture()],
  ]) {
    await withServer({ state: "ready", service: { async intakeEligibility() {
      const error = new WorkerError(code, "Safe public error", status);
      error.diagnostics = diagnostic;
      throw error;
    } } }, async base => {
      const response = await post(base, "/api/recovery/intake/eligibility", { pair });
      const body = await response.json();
      assert.equal(response.status, status);
      assert.equal(body.error.code, code);
      assert.equal(body.error.diagnostics, undefined);
      assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "requestId"]);
    });
  }
});

test("the 16 KB JSON boundary counts bytes before intake dispatch", async () => {
  let calls = 0;
  const service = {
    async intakeEligibility() {
      calls += 1;
      throw new Error("must not dispatch");
    },
  };
  await withServer({ state: "ready", service, error: null }, async (base) => {
    const response = await fetch(`${base}/api/recovery/intake/eligibility`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ pair, padding: "🔒".repeat(4_200) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "BODY_TOO_LARGE");
    assert.equal(calls, 0);
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

    const intake = await post(base, "/api/recovery/intake/release", { wallet, pair });
    assert.equal(intake.status, 503);
    assert.equal((await intake.json()).error.code, "RECOVERY_DISABLED");
  });
});

test("V2 endpoints require fresh read-only verification and health reports the selected profile", async () => {
  let calls = 0;
  let ready = true;
  const recoveryV2 = { readiness() { return {
    ready, statusCode: ready ? 200 : 503, mode: "observation-only",
    deploymentState: ready ? "observed" : "blocked", publicProfile: "v2",
    reason: ready ? "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO" : "RECOVERY_V2_OBSERVATION_FAILED",
    observers: ready ? 2 : 0,
  }; } };
  const service = { contractVersion: "v2",
    async configuration() { calls++; return { contractVersion: "v2" }; },
    async intakeRelease() { calls++; return { released: true }; },
    async release() { calls++; return { released: true }; },
  };
  await withServer({ state: "ready", service }, async base => {
    const health = await fetch(`${base}/health/recovery-v2`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).recoveryV2.publicProfile, "v2");
    assert.equal((await fetch(`${base}/api/recovery/config`)).status, 200);
    assert.equal((await post(base, "/api/recovery/intake/release", {})).status, 200);
    assert.equal(calls, 2);
    ready = false;
    for (const path of ["/api/recovery/intake/release", "/api/recovery/release", "/api/recovery/challenge",
      "/api/recovery/intake/challenge", "/api/recovery/discover", "/api/recovery/eligibility"]) {
      const response = await post(base, path, {});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "RECOVERY_V2_NOT_VERIFIED");
    }
    assert.equal((await fetch(`${base}/api/recovery/config`)).status, 503);
    assert.equal((await fetch(`${base}/health/recovery-v2`)).status, 503);
    assert.equal(calls, 2);
  }, { recoveryV2 });
});

test("helper routes preserve public read, challenge and async release contracts", async () => {
  const operationId = `0x${"ab".repeat(32)}`;
  const operation = { operationId, state: "admitted", mode: "community-helper-v1", requester: wallet };
  const calls = [];
  const service = {
    async helperDiscover(body) { calls.push(["discover", body]); return { status: "found", match: { pair } }; },
    async helperChallenge(body) { calls.push(["challenge", body]); return { operationId, pair }; },
    async helperRelease(body) { calls.push(["release", body]); return operation; },
    async helperOperation(id) { calls.push(["operation", id]); return operation; },
  };
  await withServer({ state: "ready", service }, async base => {
    const discovery = await post(base, "/api/recovery/helper/discover", {});
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).status, "found");
    const challenge = await post(base, "/api/recovery/helper/challenge", { requester: wallet, pair });
    assert.equal(challenge.status, 200);
    const release = await post(base, "/api/recovery/helper/release", { operationId, pair });
    assert.equal(release.status, 202);
    assert.deepEqual(await release.json(), operation);
    const read = await fetch(`${base}/api/recovery/helper/operations/${operationId}`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.get("cache-control"), "no-store");
    assert.equal(read.headers.get("access-control-allow-origin"), origin);
    assert.deepEqual(await read.json(), operation);
    assert.deepEqual(calls, [["discover", {}], ["challenge", { requester: wallet, pair }],
      ["release", { operationId, pair }], ["operation", operationId]]);
    assert.equal((await fetch(`${base}/api/recovery/helper/operations/not-an-operation`)).status, 404);
    assert.equal(calls.length, 4);
  });
});

test("a helper runtime blocks archived proof and payment work even under injected legacy write flags", async () => {
  let reads = 0;
  const forbidden = () => assert.fail("archived paid work bypassed helper budget");
  const campaignWorker = { prepareClaim: forbidden, async getCampaign() { reads++; return { id: 1 }; } };
  const legacyRetryCreditService = { prepare: forbidden, execute: forbidden, release: forbidden };
  for (const runtime of [
    { state: "error", service: null },
    { state: "ready", service: { helperLedger: {} } },
  ]) await withServer(runtime, async base => {
    const proof = await post(base, "/api/campaigns/1/prepare-claim", {});
    assert.equal(proof.status, 503);
    assert.equal((await proof.json()).error.code, "LEGACY_PROOF_DISABLED");
    for (const path of ["/api/retry-credit/prepare", "/api/retry-credit/1/execute", "/api/retry-credit/1/release"]) {
      const response = await post(base, path, {});
      assert.equal(response.status, 410);
    }
    assert.equal((await fetch(`${base}/api/retry-credit/config`).then(r => r.json())).writesEnabled, false);
    assert.equal((await fetch(`${base}/api/campaigns/1`)).status, 200);
  }, { campaignWorker, legacyRetryCreditService, legacyWritesEnabled: true, helperModeConfigured: true });
  assert.equal(reads, 2);
});

test("helper actions and public operation reads inherit disabled, waking and V2 verification guards", async () => {
  const operationId = `0x${"ab".repeat(32)}`;
  for (const state of ["disabled", "waking", "unverified-v2"]) {
    const fail = () => assert.fail("guarded helper work must not dispatch");
    const service = { helperDiscover: fail, helperChallenge: fail, helperRelease: fail, helperOperation: fail,
      ...(state === "unverified-v2" ? { contractVersion: "v2" } : {}) };
    const recovery = { state: state === "unverified-v2" ? "ready" : state, service: state === "disabled" ? null : service };
    const options = state === "unverified-v2" ? { recoveryV2: fixedRecoveryV2Readiness({ ready: false, statusCode: 503 }) } : {};
    await withServer(recovery, async base => {
      for (const method of ["discover", "challenge", "release"]) {
        const response = await post(base, `/api/recovery/helper/${method}`, {});
        assert.equal(response.status, state === "waking" ? 425 : 503);
      }
      assert.equal((await fetch(`${base}/api/recovery/helper/operations/${operationId}`)).status, state === "waking" ? 425 : 503);
    }, options);
  }
});

test("V1 deployment proof cannot authorize a V2 service", async () => {
  const recoveryV2 = fixedRecoveryV2Readiness({ ready: true, statusCode: 200, mode: "armed",
    deploymentState: "finalized", publicProfile: "v1", reason: "FINALIZED_PLUS_TWO_VERIFIED" });
  await withServer({ state: "ready", service: { contractVersion: "v2", release() { assert.fail("dispatched"); } } },
    async base => assert.equal((await post(base, "/api/recovery/release", {})).status, 503), { recoveryV2 });
});

function diagnosticReportFixture() {
  return {
    schema: "retrycredit.pair-diagnostics/1",
    authority: "advisory-source-check",
    attestationVerified: false,
    sourceChainId: 1,
    checkedAt: "2026-09-12T08:00:00.000Z",
    pair,
    campaign: { poolAddress: wallet, campaignNumber: 1, termsHash: `0x${"33".repeat(32)}`, startBlock: 90, endBlock: 101, maxBlockGap: 5, maxQuantity: 2, creditAmount: "100000000000000000", deadline: 2000000000 },
    facts: { failed: { blockNumber: 100, nonce: 1, status: 0 }, successful: { blockNumber: 102, nonce: 2, status: 1 } },
    checks: ["source-network", "transaction-type", "action-family", "same-wallet", "receipt-status", "nonce-order", "block-gap", "campaign-window", "paid-mint", "mint-identity", "mint-outcome", "campaign-fee-recipient", "campaign-quantity"]
      .map(id => ({ id, status: id === "campaign-window" ? "fail" : "pass" })),
  };
}

async function withServer(recovery, callback, handlerOptions = {}) {
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
    ...handlerOptions,
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

function fixedRecoveryV2Readiness(value) {
  return { readiness() { return value; } };
}
