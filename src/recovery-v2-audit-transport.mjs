const PRIMARY = "https://rpc.cc3-testnet.creditcoin.network";
const DEFAULT_AUDIT = "https://creditcoin-testnet.blockscout.com/api/eth-rpc";
const READ_METHODS = new Set([
  "eth_getTransactionReceipt", "eth_getCode", "eth_blockNumber", "eth_chainId",
  "eth_getTransactionByHash", "eth_getBlockByNumber",
]);

// RPC credentials never enter observation results, errors or the signer transport.
// Distinct provider URLs do not by themselves prove independent upstream nodes.
export function createRecoveryV2AuditTransport(env = {}, fetchImpl = fetch) {
  const provider = env.RETRYCREDIT_RECOVERY_V2_AUDIT_PROVIDER ?? "blockscout";
  if (provider === "blockscout") return Object.freeze({ auditUrl: DEFAULT_AUDIT });
  if (provider !== "thirdweb") throw new Error("RECOVERY_V2_AUDIT_PROVIDER_INVALID");
  const clientId = env.THIRDWEB_RPC_CLIENT_ID;
  const secret = env.THIRDWEB_RPC_SECRET;
  if (typeof clientId !== "string" || !/^[a-f0-9]{32}$/.test(clientId)
    || typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error("RECOVERY_V2_AUDIT_CREDENTIALS_INVALID");
  }
  const auditUrl = `https://102031.rpc.thirdweb.com/${clientId}`;
  return Object.freeze({ auditUrl, fetchImpl: async (url, init) => {
    try {
      if (url !== PRIMARY && url !== `${PRIMARY}/` && url !== auditUrl) throw new Error();
      if (init?.method !== "POST" || typeof init.body !== "string" || init.body.length > 16384) throw new Error();
      const batch = JSON.parse(init.body);
      if (!Array.isArray(batch) || batch.length < 1 || batch.length > 3
        || batch.some(item => !item || item.jsonrpc !== "2.0" || !READ_METHODS.has(item.method) || !Array.isArray(item.params))) throw new Error();
      // Construct headers rather than inheriting any caller-supplied credentials.
      const headers = { "content-type": "application/json" };
      if (url === auditUrl) headers["x-secret-key"] = secret;
      return await fetchImpl(url, {
        method: "POST", body: init.body, signal: init.signal,
        headers, redirect: "error", credentials: "omit",
      });
    } catch {
      // Provider exceptions may include URL paths or headers; discard their cause.
      throw new Error("RECOVERY_V2_AUDIT_REQUEST_FAILED");
    }
  } });
}
