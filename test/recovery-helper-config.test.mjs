import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { assertRecoveryHelperIsolation, createRecoveryHelperOptions, RECOVERY_HELPER_PILOT_CEILINGS } from "../src/recovery-helper-config.mjs";
import { RECOVERY_HELPER_CANDIDATES } from "../src/recovery-helper-candidates.mjs";

const poolAddress = "0x3Eee179eDD6Fe6e40D7d23f0110ea639f2DA82B8";
const bootstrap = { enabled: true, poolAddress, campaignNumber: "1" };
const policy = {
  identity: { chainId: 102031, poolAddress, campaignNumber: 1,
    relayerAddress: "0x15f3C7E126C9b4968dcC8cf00e7DCb74CC13D4Ae" },
  limits: { ...RECOVERY_HELPER_PILOT_CEILINGS, expiresAt: 1789704000 },
};
const environment = (overrides = {}) => ({
  RETRYCREDIT_HELPER_ENABLED: "true",
  RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v2",
  RETRYCREDIT_HELPER_LEDGER_URL: "https://ledger.example",
  RETRYCREDIT_HELPER_LEDGER_TOKEN: "test-only-token-never-used-to-contact-an-endpoint",
  RETRYCREDIT_HELPER_LEDGER_POLICY: JSON.stringify(policy),
  ...overrides,
});

test("helper mode is inert unless explicitly enabled", () => {
  for (const value of [undefined, "", "false"]) {
    assert.deepEqual(createRecoveryHelperOptions({ RETRYCREDIT_HELPER_ENABLED: value }), {});
  }
  for (const value of [true, "TRUE", " true ", "1"]) {
    assert.throws(() => createRecoveryHelperOptions(environment({ RETRYCREDIT_HELPER_ENABLED: value }), bootstrap));
  }
});

test("helper configuration requires V2 recovery without archived paid paths", () => {
  for (const overrides of [
    { RETRYCREDIT_RECOVERY_CONTRACT_VERSION: "v1" },
    { RETRYCREDIT_PUBLIC_ENABLED: "true" },
    { RETRYCREDIT_LEGACY_WRITES_ENABLED: "true" },
  ]) assert.throws(() => createRecoveryHelperOptions(environment(overrides), bootstrap));
  assert.throws(() => createRecoveryHelperOptions(environment(), { ...bootstrap, enabled: false }));
});

test("an installed coordinator cannot be downgraded into an unbudgeted owner writer", () => {
  for (const value of [undefined, "", "false"]) {
    assert.throws(() => createRecoveryHelperOptions(environment({ RETRYCREDIT_HELPER_ENABLED: value }), bootstrap), /cannot be bypassed/);
  }
  assert.doesNotThrow(() => assertRecoveryHelperIsolation({ RETRYCREDIT_HELPER_ENABLED: "false", RETRYCREDIT_HELPER_LEDGER_TOKEN: "" }));
});

test("conflicting helper activation stops server startup before any legacy signer is constructed", () => {
  for (const flags of [
    { RETRYCREDIT_HELPER_ENABLED: "true", RETRYCREDIT_PUBLIC_ENABLED: "true" },
    { RETRYCREDIT_HELPER_ENABLED: "true", RETRYCREDIT_LEGACY_WRITES_ENABLED: "true" },
    { RETRYCREDIT_HELPER_ENABLED: "TRUE", RETRYCREDIT_PUBLIC_ENABLED: "true" },
  ]) {
    assert.throws(() => assertRecoveryHelperIsolation(flags), /forbids legacy/);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("../src/server.mjs", import.meta.url).href)})`], {
      env: flags, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Community helper activation forbids legacy\/public writers/);
    assert.doesNotMatch(result.stderr, /private key|ECONN|fetch failed/);
  }
});

test("missing or mismatched durable policy cannot silently fall back to unbudgeted recovery", () => {
  for (const value of [undefined, "", "{}", "null", "not-json"]) {
    assert.throws(() => createRecoveryHelperOptions(environment({ RETRYCREDIT_HELPER_LEDGER_POLICY: value }), bootstrap));
  }
  for (const identity of [
    { ...policy.identity, chainId: 1 },
    { ...policy.identity, poolAddress: "0x1111111111111111111111111111111111111111" },
    { ...policy.identity, campaignNumber: 2 },
  ]) assert.throws(() => createRecoveryHelperOptions(environment({
    RETRYCREDIT_HELPER_LEDGER_POLICY: JSON.stringify({ ...policy, identity }),
  }), bootstrap));
});

test("every pilot spending ceiling is independently enforced before any transport call", () => {
  for (const [key, value] of Object.entries({
    maxAttempts: 10, maxPayouts: 10, maxFeeWei: "2000000000000001",
    maxTotalFeeWei: "18000000000000001", creditWei: "100000000000000001",
  })) assert.throws(() => createRecoveryHelperOptions(environment({
    RETRYCREDIT_HELPER_LEDGER_POLICY: JSON.stringify({ ...policy, limits: { ...policy.limits, [key]: value } }),
  }), bootstrap));
});

test("a complete lower-budget policy creates a deeply immutable secret-free public policy", () => {
  const options = createRecoveryHelperOptions(environment({
    RETRYCREDIT_HELPER_LEDGER_POLICY: JSON.stringify({ ...policy, limits: { ...policy.limits, maxAttempts: 2, maxPayouts: 2 } }),
  }), bootstrap);
  assert.equal(options.helperMaxFeeWei, "2000000000000000");
  assert.equal(options.helperLedger.policy.limits.maxPayouts, 2);
  assert.ok(Object.isFrozen(options.helperLedger.policy));
  assert.ok(Object.isFrozen(options.helperLedger.policy.identity));
  assert.ok(Object.isFrozen(options.helperLedger.policy.limits));
  assert.equal(JSON.stringify(options).includes("test-only-token"), false);
  assert.equal(options.helperCandidates, RECOVERY_HELPER_CANDIDATES);
});

test("durable endpoint and token must be explicitly safe before enabling helpers", () => {
  for (const value of [undefined, "http://ledger.example", "https://name:secret@ledger.example", "https://ledger.example?token=value", "https://ledger.example/path"]) {
    assert.throws(() => createRecoveryHelperOptions(environment({ RETRYCREDIT_HELPER_LEDGER_URL: value }), bootstrap));
  }
  for (const value of [undefined, "short", " ".repeat(40)]) {
    assert.throws(() => createRecoveryHelperOptions(environment({ RETRYCREDIT_HELPER_LEDGER_TOKEN: value }), bootstrap));
  }
});

test("advisory catalog exposes only frozen distinct ordered transaction pairs", () => {
  assert.equal(RECOVERY_HELPER_CANDIDATES.length, 89);
  assert.ok(Object.isFrozen(RECOVERY_HELPER_CANDIDATES));
  const seen = new Set();
  for (const pair of RECOVERY_HELPER_CANDIDATES) {
    assert.ok(Object.isFrozen(pair));
    assert.deepEqual(Object.keys(pair), ["failedTransactionHash", "successfulTransactionHash"]);
    for (const value of Object.values(pair)) assert.match(value, /^0x[0-9a-f]{64}$/);
    assert.notEqual(pair.failedTransactionHash, pair.successfulTransactionHash);
    const key = JSON.stringify(pair);
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
});
