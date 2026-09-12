import assert from "node:assert/strict";
import test from "node:test";
import {
  createRecoveryPairLink,
  normalizeRecoveryInspectionAddress,
  readRecoveryPairLink,
} from "../web/src/recovery-pair-handoff.mjs";

const pair = { failedTransactionHash: `0x${"a".repeat(64)}`, successfulTransactionHash: `0x${"b".repeat(64)}` };

test("handoff serializes only two public hashes in a fragment, never server query parameters", () => {
  const url = new URL(createRecoveryPairLink({ ...pair, destination: "attacker", signature: "secret", eligible: true }, "https://retrycredit.example/cases?secret=discard#discard"));
  assert.equal(url.origin, "https://retrycredit.example");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.deepEqual(readRecoveryPairLink(url.hash), pair);
  assert.doesNotMatch(url.href, /attacker|secret|eligible|signature/);
});

test("handoff rejects malformed, duplicate, extended, equal or partial inputs", () => {
  const valid = new URL(createRecoveryPairLink(pair, "https://retrycredit.example")).hash;
  for (const fragment of [null, "", "#main-content", valid.slice(1), valid + "&signature=secret", valid + "&failed=x", `#failed=${pair.failedTransactionHash}`, valid.replace(pair.successfulTransactionHash, pair.failedTransactionHash), valid.replace("0xaaaa", "0xzzzz")]) {
    assert.equal(readRecoveryPairLink(fragment), null);
  }
  assert.equal(createRecoveryPairLink({ ...pair, successfulTransactionHash: pair.failedTransactionHash }, "https://retrycredit.example"), null);
});

test("handoff accepts canonical explorer input but strips source URL metadata", () => {
  const link = createRecoveryPairLink({ ...pair, failedTransactionHash: `https://etherscan.io/tx/${pair.failedTransactionHash}` }, "https://retrycredit.example");
  assert.deepEqual(readRecoveryPairLink(new URL(link).hash), pair);
});

test("handoff refuses credential-bearing and non-web origins, permits local preview", () => {
  for (const origin of ["javascript:alert(1)", "data:text/plain,a", "https://user:secret@example.com", "http://example.com", "broken"]) {
    assert.equal(createRecoveryPairLink(pair, origin), null);
  }
  assert.ok(createRecoveryPairLink(pair, "http://localhost:4173"));
});

test("public address inspection validates without requesting ownership", () => {
  assert.equal(normalizeRecoveryInspectionAddress(" 0x30eb112e646e26739d6d271da3e283270b15c25a ")?.toLowerCase(), "0x30eb112e646e26739d6d271da3e283270b15c25a");
  for (const value of [null, "", "qdee.eth", `0x${"0".repeat(40)}`, "0x123", "https://etherscan.io/address/0x30eb112e646e26739d6d271da3e283270b15c25a", "0x30EB112e646e26739d6d271da3e283270b15c25a"]) {
    assert.equal(normalizeRecoveryInspectionAddress(value), null);
  }
});
