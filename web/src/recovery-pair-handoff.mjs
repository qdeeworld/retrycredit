import { getAddress } from "ethers";
import { validateRecoveryPairDraft } from "./recovery-ui-state.mjs";

// Public inputs only. A link is never an eligibility verdict or authorization.
const HASH = /^0x[0-9a-f]{64}$/i;
const LINK_KEYS = ["failed", "successful"];

export function readRecoveryPairLink(fragment) {
  if (typeof fragment !== "string" || fragment.length > 180 || !fragment.startsWith("#")) return null;
  const params = new URLSearchParams(fragment.slice(1));
  if ([...params.keys()].length !== 2 || LINK_KEYS.some((key) => params.getAll(key).length !== 1)) return null;
  const failed = params.get("failed");
  const successful = params.get("successful");
  if (!HASH.test(failed) || !HASH.test(successful) || failed.toLowerCase() === successful.toLowerCase()) return null;
  return { failedTransactionHash: failed.toLowerCase(), successfulTransactionHash: successful.toLowerCase() };
}

export function createRecoveryPairLink(pair, origin) {
  const validated = validateRecoveryPairDraft(pair);
  if (!validated.valid) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return null;
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  url = new URL("/", url.origin);
  url.hash = new URLSearchParams({
    failed: validated.pair.failedTransactionHash.toLowerCase(),
    successful: validated.pair.successfulTransactionHash.toLowerCase(),
  }).toString();
  return url.href;
}

export function normalizeRecoveryInspectionAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/i.test(value.trim())) return null;
  try {
    const address = getAddress(value.trim());
    return /^0x0{40}$/i.test(address) ? null : address;
  } catch { return null; }
}
