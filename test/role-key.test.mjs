import assert from "node:assert/strict";
import test from "node:test";

import { Wallet } from "ethers";

import { deriveRoleKey } from "../src/role-key.mjs";

test("role keys are deterministic and domain-separated", () => {
  const root = `0x${"11".repeat(32)}`;
  const first = deriveRoleKey(root, "RETRYCREDIT_ROLE_A");
  assert.equal(first, deriveRoleKey(root, "RETRYCREDIT_ROLE_A"));
  assert.notEqual(first, deriveRoleKey(root, "RETRYCREDIT_ROLE_B"));
  assert.notEqual(new Wallet(first).address, new Wallet(root).address);
});

test("role derivation rejects malformed roots and empty domains", () => {
  for (const root of [undefined, "", "0x12", `0x${"00".repeat(32)}`]) {
    assert.throws(() => deriveRoleKey(root, "RETRYCREDIT_ROLE"), /nonzero 32-byte/);
  }
  const root = `0x${"11".repeat(32)}`;
  for (const label of [undefined, "", "   "]) {
    assert.throws(() => deriveRoleKey(root, label), /domain label/);
  }
});
