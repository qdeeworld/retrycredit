import { concat, getBytes, isHexString, keccak256, toUtf8Bytes } from "ethers";

export const PUBLIC_CC3_RELAYER_ROLE = "RETRYCREDIT_PUBLIC_CC3_RELAYER_V2";

/**
 * Derive a deterministic, domain-separated testnet role key from the one
 * server-held root secret. Distinct roles do not share an EVM nonce domain.
 */
export function deriveRoleKey(privateKey, label) {
  if (!isHexString(privateKey, 32) || /^0x0+$/.test(privateKey)) {
    throw new Error("role-key root must be a nonzero 32-byte secret");
  }
  if (typeof label !== "string" || label.trim() === "") {
    throw new Error("role-key domain label is required");
  }
  const value = keccak256(concat([getBytes(privateKey), toUtf8Bytes(label)]));
  if (/^0x0+$/.test(value)) throw new Error(`derived an invalid ${label} key`);
  return value;
}
