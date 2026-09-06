import { JsonRpcApiProvider } from "ethers";

const READ_METHODS = new Set(["eth_chainId", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_blockNumber"]);

// Optional authenticated Ethereum reads. This provider cannot sign or broadcast,
// and never supplies credentials to the Creditcoin payout provider.
export function createRecoverySourceProvider(env = {}, { fetchImpl = fetch } = {}) {
  const mode = env.RETRYCREDIT_RECOVERY_ETHEREUM_PROVIDER ?? "public";
  if (mode === "public") return null;
  if (mode !== "thirdweb") throw new Error("RECOVERY_SOURCE_PROVIDER_INVALID");
  if (env.ETHEREUM_RPC_URLS?.trim()) throw new Error("RECOVERY_SOURCE_PROVIDER_CONFLICT");
  const clientId = env.THIRDWEB_RPC_CLIENT_ID;
  const secret = env.THIRDWEB_RPC_SECRET;
  if (typeof clientId !== "string" || !/^[a-f0-9]{32}$/.test(clientId)
    || typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)) {
    throw new Error("RECOVERY_SOURCE_CREDENTIALS_INVALID");
  }
  const url = `https://1.rpc.thirdweb.com/${clientId}`;
  return new class extends JsonRpcApiProvider {
    constructor() {
      super(1, { staticNetwork: true, batchMaxCount: 4, batchMaxSize: 16384, cacheTimeout: -1 });
      this._start();
    }
    async _send(payload) {
      try {
        const batch = Array.isArray(payload) ? payload : [payload];
        if (batch.length < 1 || batch.length > 4
          || batch.some(item => !item || item.jsonrpc !== "2.0" || !Number.isSafeInteger(item.id)
            || !READ_METHODS.has(item.method) || !Array.isArray(item.params))) throw new Error();
        const chainId = "recovery-source-chain";
        const body = JSON.stringify([...batch, { jsonrpc: "2.0", id: chainId, method: "eth_chainId", params: [] }]);
        if (body.length > 16384) throw new Error();
        const response = await fetchImpl(url, {
          method: "POST", body,
          headers: { "content-type": "application/json", "x-secret-key": secret },
          signal: AbortSignal.timeout(6000), redirect: "error", credentials: "omit",
        });
        if (!response.ok) throw new Error();
        const results = await response.json();
        if (!Array.isArray(results) || results.length !== batch.length + 1) throw new Error();
        const byId = new Map(results.map(item => [item?.id, item]));
        const chain = byId.get(chainId);
        if (byId.size !== results.length || chain?.jsonrpc !== "2.0" || chain.error || chain.result !== "0x1") throw new Error();
        return batch.map(item => {
          const result = byId.get(item.id);
          if (!result || result.jsonrpc !== "2.0" || result.error || !Object.hasOwn(result, "result")) throw new Error();
          return { jsonrpc: "2.0", id: item.id, result: result.result };
        });
      } catch {
        // RPC errors can echo headers, URLs or provider internals. Discard them.
        throw new Error("RECOVERY_SOURCE_RPC_FAILED");
      }
    }
  }();
}
