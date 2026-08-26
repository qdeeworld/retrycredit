import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildEmbeddedRecoveryV2Artifact,
  serializeEmbeddedRecoveryV2Artifact,
} from "../scripts/generate-recovery-v2-artifact.mjs";

const forgeArtifactUrl = new URL(
  "../out/RetryCreditRecoveryCampaignV2.sol/RetryCreditRecoveryCampaignV2.json",
  import.meta.url,
);
const embeddedArtifactUrl = new URL(
  "../src/deployment-artifacts/RetryCreditRecoveryCampaignV2.json",
  import.meta.url,
);

test("embedded Recovery V2 artifact is an exact deterministic projection of Forge output", async () => {
  const forgeArtifact = JSON.parse(await readFile(forgeArtifactUrl, "utf8"));
  const embeddedText = await readFile(embeddedArtifactUrl, "utf8");
  const expected = buildEmbeddedRecoveryV2Artifact(forgeArtifact);

  assert.equal(embeddedText, serializeEmbeddedRecoveryV2Artifact(expected));
  assert.equal(expected.compiler.version, "0.8.23+commit.f704f362");
  assert.equal(expected.compiler.evmVersion, "shanghai");
  assert.deepEqual(expected.compiler.optimizer, { enabled: true, runs: 200 });
  assert.equal(expected.initCodeBytes, 15_517);
  assert.equal(expected.runtimeTemplateBytes, 9_139);
  assert.ok(expected.initCodeBytes < 49_152);
  assert.ok(expected.runtimeTemplateBytes < 24_576);
  assert.match(
    expected.sourceDigests["contracts/src/RetryCreditRecoveryCampaignV2.sol"],
    /^0x[0-9a-f]{64}$/,
  );
  assert.doesNotMatch(expected.creationBytecode, /__\$/);
});

test("artifact projection rejects compiler drift and linked bytecode", async () => {
  const forgeArtifact = JSON.parse(await readFile(forgeArtifactUrl, "utf8"));

  const compilerDrift = structuredClone(forgeArtifact);
  compilerDrift.metadata.compiler.version = "0.8.24+commit.e11b9ed9";
  assert.throws(
    () => buildEmbeddedRecoveryV2Artifact(compilerDrift),
    /pinned solc 0\.8\.23/,
  );

  const linked = structuredClone(forgeArtifact);
  linked.bytecode.linkReferences = {
    "contracts/src/Library.sol": { Library: [{ start: 1, length: 20 }] },
  };
  assert.throws(
    () => buildEmbeddedRecoveryV2Artifact(linked),
    /must not require library linking/,
  );
});
