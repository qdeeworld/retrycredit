import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { isHexString, keccak256 } from "ethers";

const CONTRACT_NAME = "RetryCreditRecoveryCampaignV2";
const SOURCE_NAME = "contracts/src/RetryCreditRecoveryCampaignV2.sol";
const forgeArtifactUrl = new URL(
  `../out/${CONTRACT_NAME}.sol/${CONTRACT_NAME}.json`,
  import.meta.url,
);
const embeddedArtifactUrl = new URL(
  `../src/deployment-artifacts/${CONTRACT_NAME}.json`,
  import.meta.url,
);
const embeddedArtifactDirectoryUrl = new URL("../src/deployment-artifacts/", import.meta.url);

export function buildEmbeddedRecoveryV2Artifact(forgeArtifact) {
  if (!forgeArtifact || typeof forgeArtifact !== "object") {
    throw new Error("Forge artifact must be an object");
  }

  const metadata = requireObject(forgeArtifact.metadata, "metadata");
  const settings = requireObject(metadata.settings, "metadata settings");
  const optimizer = requireObject(settings.optimizer, "optimizer settings");
  const metadataSettings = requireObject(settings.metadata, "bytecode metadata settings");
  if (metadata.compiler?.version !== "0.8.23+commit.f704f362") {
    throw new Error("Recovery V2 must use the pinned solc 0.8.23 compiler");
  }
  if (settings.evmVersion !== "shanghai") {
    throw new Error("Recovery V2 must target the Shanghai EVM");
  }
  if (optimizer.enabled !== true || optimizer.runs !== 200) {
    throw new Error("Recovery V2 must use the pinned optimizer settings");
  }
  if (metadataSettings.bytecodeHash !== "ipfs") {
    throw new Error("Recovery V2 must retain the pinned IPFS bytecode metadata hash");
  }
  if (settings.compilationTarget?.[SOURCE_NAME] !== CONTRACT_NAME) {
    throw new Error("Forge artifact compilation target does not match Recovery V2");
  }

  const creationBytecode = requireBytecode(
    forgeArtifact.bytecode?.object,
    "creation bytecode",
  );
  const deployedBytecode = requireBytecode(
    forgeArtifact.deployedBytecode?.object,
    "deployed bytecode",
  );
  requireNoLinks(forgeArtifact.bytecode?.linkReferences, "creation bytecode");
  requireNoLinks(forgeArtifact.deployedBytecode?.linkReferences, "deployed bytecode");

  const initCodeBytes = (creationBytecode.length - 2) / 2;
  const runtimeTemplateBytes = (deployedBytecode.length - 2) / 2;
  if (initCodeBytes >= 49_152) {
    throw new Error("Recovery V2 init code exceeds the EIP-3860 size limit");
  }
  if (runtimeTemplateBytes >= 24_576) {
    throw new Error("Recovery V2 runtime exceeds the EIP-170 size limit");
  }

  const payload = {
    schemaVersion: "retrycredit.recovery-v2-forge-artifact.v1",
    contractName: CONTRACT_NAME,
    sourceName: SOURCE_NAME,
    compiler: {
      version: metadata.compiler.version,
      evmVersion: settings.evmVersion,
      optimizer: { enabled: optimizer.enabled, runs: optimizer.runs },
      metadataBytecodeHash: metadataSettings.bytecodeHash,
      remappings: [...(settings.remappings ?? [])].sort(),
    },
    sourceDigests: Object.fromEntries(
      Object.entries(requireObject(metadata.sources, "metadata sources"))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([source, record]) => [source, requireHash(record?.keccak256, `${source} digest`)]),
    ),
    abi: forgeArtifact.abi,
    creationBytecode,
    deployedBytecode,
    immutableReferences: normalizeImmutableReferences(
      forgeArtifact.deployedBytecode?.immutableReferences,
      runtimeTemplateBytes,
    ),
    creationBytecodeHash: keccak256(creationBytecode),
    deployedBytecodeTemplateHash: keccak256(deployedBytecode),
    initCodeBytes,
    runtimeTemplateBytes,
  };

  return Object.freeze({
    ...payload,
    payloadSha256: sha256Hex(JSON.stringify(payload)),
  });
}

export function serializeEmbeddedRecoveryV2Artifact(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

async function main() {
  const command = process.argv[2];
  if (!["--write", "--check"].includes(command) || process.argv.length !== 3) {
    throw new Error(
      "usage: node scripts/generate-recovery-v2-artifact.mjs <--write|--check>",
    );
  }

  const forgeArtifact = JSON.parse(await readFile(forgeArtifactUrl, "utf8"));
  const expected = serializeEmbeddedRecoveryV2Artifact(
    buildEmbeddedRecoveryV2Artifact(forgeArtifact),
  );
  if (command === "--write") {
    await mkdir(embeddedArtifactDirectoryUrl, { recursive: true });
    await writeFile(embeddedArtifactUrl, expected, { encoding: "utf8", flag: "w" });
    return;
  }

  const actual = await readFile(embeddedArtifactUrl, "utf8");
  if (actual !== expected) {
    throw new Error(
      "Embedded Recovery V2 artifact is stale; regenerate it with --write and review the diff",
    );
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireBytecode(value, label) {
  if (typeof value !== "string" || !isHexString(value) || value.length <= 2) {
    throw new Error(`${label} must be nonempty hex`);
  }
  if (value.includes("__$")) throw new Error(`${label} contains an unresolved link placeholder`);
  return value.toLowerCase();
}

function requireHash(value, label) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new Error(`${label} must be bytes32 hex`);
  }
  return value.toLowerCase();
}

function requireNoLinks(value, label) {
  const links = requireObject(value ?? {}, `${label} link references`);
  if (Object.keys(links).length !== 0) {
    throw new Error(`${label} must not require library linking`);
  }
}

function normalizeImmutableReferences(value, runtimeTemplateBytes) {
  const references = requireObject(value ?? {}, "immutable references");
  const groups = Object.values(references)
    .map((positions) => {
      if (!Array.isArray(positions) || positions.length === 0) {
        throw new Error("immutable positions must be a nonempty array");
      }
      return positions
        .map((position) => {
          if (
            !Number.isSafeInteger(position?.start)
            || position.start < 0
            || !Number.isSafeInteger(position?.length)
            || position.length <= 0
            || position.start + position.length > runtimeTemplateBytes
          ) {
            throw new Error("immutable position is invalid");
          }
          return { start: position.start, length: position.length };
        })
        .sort(compareImmutablePositions);
    })
    .sort(compareImmutableGroups);

  const ranges = groups.flat().sort(compareImmutablePositions);
  for (let index = 1; index < ranges.length; index += 1) {
    const previousEnd = ranges[index - 1].start + ranges[index - 1].length;
    if (ranges[index].start < previousEnd) {
      throw new Error("immutable positions must not overlap");
    }
  }
  return groups;
}

function compareImmutablePositions(left, right) {
  return left.start - right.start || left.length - right.length;
}

function compareImmutableGroups(left, right) {
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    const comparison = compareImmutablePositions(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function sha256Hex(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
