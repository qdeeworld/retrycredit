// Account access only: never requests a signature or a network switch.
const pendingConnections = new WeakMap();

export async function requestRecoveryAccounts(provider, { timeoutMs = 45_000 } = {}) {
  if (!provider || typeof provider.request !== "function") throw new Error("An EVM wallet is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid wallet connection timeout.");
  if (pendingConnections.has(provider)) {
    const error = new Error("A wallet connection is still pending. Finish or dismiss it in your wallet, or use manual transaction entry.");
    error.code = -32002;
    throw error;
  }
  const pending = Promise.resolve().then(() => provider.request({ method: "eth_requestAccounts" }));
  pendingConnections.set(provider, pending);
  const clearPending = () => { if (pendingConnections.get(provider) === pending) pendingConnections.delete(provider); };
  pending.then(clearPending, clearPending);
  let timer;
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("Wallet connection is still waiting. Open your wallet to finish or dismiss the request. You can use manual transaction entry now; no history was searched or transaction sent.");
          error.code = "RECOVERY_WALLET_CONNECTION_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
