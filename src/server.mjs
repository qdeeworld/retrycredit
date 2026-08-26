import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider } from "ethers";
import { proofProvider } from "@gluwa/usc-sdk";
import { RuleDropWorker, WorkerError, createEthereumProviders } from "./proof-worker.mjs";
import { selectPoolAbi } from "./pool-abi.mjs";
import { PUBLIC_DEMO_DEFAULTS, UniswapRetryCreditDemoService } from "./uniswap-demo-service.mjs";
import {
  RECOVERY_DEFAULTS,
  RECOVERY_DISCOVERY_INDEX,
  RecoveryCampaignService,
} from "./recovery-campaign-service.mjs";

const POOL_ADDRESS = process.env.RULEDROP_POOL_ADDRESS ?? "0x6f8dE7e1599A0c8D38eB25996cB841a4920ed999";
const CREDITCOIN_RPC = process.env.CREDITCOIN_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const PROOF_BUILDER_URL = process.env.ATTESTCOIN_PROOF_BUILDER ?? "https://prover.cc3-testnet.creditcoin.network";
const PORT = Number(process.env.PORT ?? 4179);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "http://localhost:3000";
const POOL_VERSION = process.env.RULEDROP_POOL_VERSION ?? "1";
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? ALLOWED_ORIGIN;
const RETRY_CREDIT_ENABLED = process.env.RETRYCREDIT_PUBLIC_ENABLED === "true";
const RETRY_CREDIT_POOL_ADDRESS = process.env.RETRYCREDIT_POOL_ADDRESS ?? "0x81b5d955F4EbfaE02FF6346cf368A2c4347248A1";
const RETRY_CREDIT_VERIFIER_ADDRESS = process.env.RETRYCREDIT_VERIFIER_ADDRESS ?? "0x97Fa88CfCaeE1a5D4Ae749b9b5698F2147b986fC";
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ethereumRpcUrls = (process.env.ETHEREUM_RPC_URLS ?? "").split(",").map((value) => value.trim());
export const RECOVERY_RELEASE_DEFAULTS = Object.freeze({
  publicOrigin: "https://retrycredit.dolepee.com",
  poolAddress: "0x646c5c766Ce3B6058B44F41e89fE716f54E3dF66",
  campaignNumber: "1",
});
const recoveryBootstrap = resolveRecoveryBootstrap(process.env);
const staticRoot = fileURLToPath(new URL("../dist", import.meta.url));

const worker = new RuleDropWorker({
  poolAddress: POOL_ADDRESS,
  poolAbi: selectPoolAbi(POOL_VERSION),
  creditcoinRpc: CREDITCOIN_RPC,
  proofBuilderUrl: PROOF_BUILDER_URL,
  ethereumProviders: createEthereumProviders(ethereumRpcUrls),
});

let retryCreditService = null;
if (RETRY_CREDIT_ENABLED) {
  const privateKey = process.env.RETRYCREDIT_DEMO_PRIVATE_KEY;
  if (!privateKey || !RETRY_CREDIT_POOL_ADDRESS || !RETRY_CREDIT_VERIFIER_ADDRESS) {
    throw new Error("RetryCredit public mode requires its private key, pool, and verifier configuration");
  }
  const ccProvider = new JsonRpcProvider(CREDITCOIN_RPC, 102031, { staticNetwork: true });
  const sepoliaProvider = new JsonRpcProvider(SEPOLIA_RPC_URL, 11155111, { staticNetwork: true });
  retryCreditService = UniswapRetryCreditDemoService.fromPrivateKey({
    privateKey,
    ccProvider,
    sepoliaProvider,
    poolAddress: RETRY_CREDIT_POOL_ADDRESS,
    verifierAddress: RETRY_CREDIT_VERIFIER_ADDRESS,
    proofBuilder: new proofProvider.service.ProofBuilder(1, PROOF_BUILDER_URL, 120_000),
    publicOrigin: PUBLIC_ORIGIN,
  });
  await retryCreditService.readiness();
}

let recoveryLifecycle = { state: "disabled", service: null, error: null };
if (recoveryBootstrap.enabled) {
  const privateKey = process.env.RETRYCREDIT_DEMO_PRIVATE_KEY;
  if (!privateKey || !recoveryBootstrap.poolAddress || !recoveryBootstrap.campaignNumber) {
    recoveryLifecycle = {
      state: "error",
      service: null,
      error: new WorkerError(
        "RECOVERY_MISCONFIGURED",
        "Recovery mode requires its relayer key, pool, and campaign configuration",
        503,
      ),
    };
  } else {
    try {
      const service = RecoveryCampaignService.fromPrivateKey({
        privateKey,
        poolAddress: recoveryBootstrap.poolAddress,
        campaignNumber: recoveryBootstrap.campaignNumber,
        creditcoinRpc: CREDITCOIN_RPC,
        proofBuilderUrl: PROOF_BUILDER_URL,
        ...(ethereumRpcUrls.filter(Boolean).length > 0
          ? { ethereumRpcUrls: ethereumRpcUrls.filter(Boolean) }
          : {}),
        publicOrigin: PUBLIC_ORIGIN,
      });
      recoveryLifecycle = { state: "waking", service, error: null };
      service.readiness().then(
        () => { Object.assign(recoveryLifecycle, { state: "ready", service, error: null }); },
        (error) => { Object.assign(recoveryLifecycle, { state: "error", service, error }); },
      );
    } catch (error) {
      recoveryLifecycle = {
        state: "error",
        service: null,
        error: error instanceof WorkerError
          ? error
          : new WorkerError("RECOVERY_MISCONFIGURED", "Recovery mode could not start", 503, error),
      };
    }
  }
}

export function resolveRecoveryBootstrap(env = {}) {
  const mode = optionalEnvironmentValue(env.RETRYCREDIT_RECOVERY_ENABLED);
  const publicOrigin = env.PUBLIC_ORIGIN ?? env.ALLOWED_ORIGIN ?? "http://localhost:3000";
  const configuredPoolAddress = optionalEnvironmentValue(env.RETRYCREDIT_RECOVERY_POOL_ADDRESS);
  const configuredCampaignNumber = optionalEnvironmentValue(env.RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER);
  const hasConfiguredAddress = Boolean(configuredPoolAddress || configuredCampaignNumber);
  const productionDefault = mode === null
    && env.RETRYCREDIT_PUBLIC_ENABLED === "true"
    && publicOrigin === RECOVERY_RELEASE_DEFAULTS.publicOrigin
    && !hasConfiguredAddress;
  const releaseDefaultsRequested = (mode === "true" && !hasConfiguredAddress) || productionDefault;
  const poolAddress = configuredPoolAddress
    ?? (releaseDefaultsRequested ? RECOVERY_RELEASE_DEFAULTS.poolAddress : null);
  const campaignNumber = configuredCampaignNumber
    ?? (releaseDefaultsRequested ? RECOVERY_RELEASE_DEFAULTS.campaignNumber : null);
  const enabled = mode !== "false"
    && (mode === "true" || Boolean(poolAddress) || Boolean(campaignNumber));

  return Object.freeze({ enabled, poolAddress, campaignNumber, productionDefault });
}

function optionalEnvironmentValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

export function createAppHandler({
  campaignWorker = worker,
  legacyRetryCreditService = retryCreditService,
  recovery = recoveryLifecycle,
  allowedOrigin = ALLOWED_ORIGIN,
} = {}) {
  return async (request, response) => {
  const requestId = crypto.randomUUID();
  try {
    setHeaders(response, requestId, allowedOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "retrycredit",
        network: 102031,
        publicDemoConfigured: Boolean(legacyRetryCreditService),
        recoveryState: recovery.state,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/recovery/config") {
      if (recovery.state === "disabled") {
        sendJson(response, 200, unavailableRecoveryConfig(false));
        return;
      }
      if (recovery.state === "waking") {
        sendJson(response, 200, unavailableRecoveryConfig(true, recovery.service));
        return;
      }
      requireRecoveryService(recovery);
      sendJson(response, 200, await recovery.service.configuration());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/recovery/eligibility") {
      requireRecoveryService(recovery);
      const body = await readJson(request);
      sendJson(response, 200, await recovery.service.eligibility(body?.wallet));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/recovery/challenge") {
      requireRecoveryService(recovery);
      const body = await readJson(request);
      sendJson(response, 200, await recovery.service.challenge(body?.wallet));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/recovery/release") {
      requireRecoveryService(recovery);
      const body = await readJson(request);
      sendJson(response, 200, await recovery.service.release(body));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/retry-credit/config") {
      sendJson(response, 200, {
        enabled: Boolean(legacyRetryCreditService),
        source: { name: "Ethereum Sepolia", chainId: 11155111 },
        settlement: { name: "Creditcoin Testnet", chainId: 102031 },
        creditAmount: PUBLIC_DEMO_DEFAULTS.creditAmount.toString(),
        amountIn: PUBLIC_DEMO_DEFAULTS.amountIn.toString(),
        maxSponsoredCredits: PUBLIC_DEMO_DEFAULTS.maxSponsoredCredits,
        poolAddress: RETRY_CREDIT_POOL_ADDRESS ?? null,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/retry-credit/challenge") {
      requireRetryCreditService(legacyRetryCreditService);
      const body = await readJson(request);
      sendJson(response, 200, legacyRetryCreditService.challenge(body.beneficiary));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/retry-credit/prepare") {
      requireRetryCreditService(legacyRetryCreditService);
      const body = await readJson(request);
      sendJson(response, 200, await legacyRetryCreditService.prepare(body));
      return;
    }

    const retryStatusMatch = url.pathname.match(/^\/api\/retry-credit\/(\d+)\/status$/);
    if (request.method === "GET" && retryStatusMatch) {
      requireRetryCreditService(legacyRetryCreditService);
      sendJson(response, 200, await legacyRetryCreditService.status(retryStatusMatch[1]));
      return;
    }

    const retryExecuteMatch = url.pathname.match(/^\/api\/retry-credit\/(\d+)\/execute$/);
    if (request.method === "POST" && retryExecuteMatch) {
      requireRetryCreditService(legacyRetryCreditService);
      sendJson(response, 200, await legacyRetryCreditService.execute(retryExecuteMatch[1]));
      return;
    }

    const retryReleaseMatch = url.pathname.match(/^\/api\/retry-credit\/(\d+)\/release$/);
    if (request.method === "POST" && retryReleaseMatch) {
      requireRetryCreditService(legacyRetryCreditService);
      const body = await readJson(request);
      sendJson(response, 200, await legacyRetryCreditService.release({
        serviceCreditNumber: retryReleaseMatch[1],
        failedTransactionHash: body.failedTransactionHash,
        successfulTransactionHash: body.successfulTransactionHash,
      }));
      return;
    }

    const campaignMatch = url.pathname.match(/^\/api\/campaigns\/(\d+)$/);
    if (request.method === "GET" && url.pathname === "/api/campaigns/latest") {
      const campaign = await campaignWorker.getLatestCampaign(url.searchParams.get("claimant"));
      sendJson(response, 200, campaign);
      return;
    }
    if (request.method === "GET" && campaignMatch) {
      const campaign = await campaignWorker.getCampaign(campaignMatch[1], url.searchParams.get("claimant"));
      sendJson(response, 200, campaign);
      return;
    }

    const claimMatch = url.pathname.match(/^\/api\/campaigns\/(\d+)\/prepare-claim$/);
    if (request.method === "POST" && claimMatch) {
      const body = await readJson(request);
      const prepared = await campaignWorker.prepareClaim({ campaignId: claimMatch[1], ...body });
      sendJson(response, 200, prepared);
      return;
    }

    if (request.method === "GET" || request.method === "HEAD") {
      await sendStatic(response, url.pathname, request.method === "HEAD");
      return;
    }

    throw new WorkerError("NOT_FOUND", "Route not found", 404);
  } catch (error) {
    const handled = error instanceof WorkerError
      ? error
      : new WorkerError("INTERNAL_ERROR", "The worker could not process this request", 500, error);
    sendJson(response, handled.status, { error: { code: handled.code, message: handled.message, requestId } });
  }
  };
}

export function startServer(options = {}) {
  const server = createServer(createAppHandler(options));
  server.listen(PORT, HOST, () => {
    console.log(`RetryCredit service listening on http://${HOST}:${PORT}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer();
}

function setHeaders(response, requestId, allowedOrigin = ALLOWED_ORIGIN) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("access-control-allow-origin", allowedOrigin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("x-request-id", requestId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new WorkerError("BODY_TOO_LARGE", "Request body exceeds 16 KB", 413);
  }
  try {
    return JSON.parse(body || "{}");
  } catch (error) {
    throw new WorkerError("INVALID_JSON", "Request body must be valid JSON", 400, error);
  }
}

function sendJson(response, status, body) {
  response.writeHead(status);
  response.end(JSON.stringify(body));
}

function requireRetryCreditService(service) {
  if (!service) {
    throw new WorkerError("PUBLIC_DEMO_UNAVAILABLE", "The bounded RetryCredit public demo is not configured", 503);
  }
}

function requireRecoveryService(recovery) {
  if (recovery.state === "waking") {
    throw new WorkerError(
      "RECOVERY_WAKING",
      "The recovery proof service is waking; retry shortly",
      425,
    );
  }
  if (recovery.state === "error") {
    throw recovery.error instanceof WorkerError
      ? recovery.error
      : new WorkerError("RECOVERY_UNAVAILABLE", "The recovery service is unavailable", 503, recovery.error);
  }
  if (recovery.state !== "ready" || !recovery.service) {
    throw new WorkerError("RECOVERY_DISABLED", "The funded recovery campaign is not configured", 503);
  }
}

function unavailableRecoveryConfig(waking, service = null) {
  return {
    enabled: Boolean(service),
    waking,
    source: {
      name: "Ethereum Mainnet",
      chainId: RECOVERY_DEFAULTS.sourceChainId,
      chainKey: RECOVERY_DEFAULTS.sourceChainKey,
    },
    settlement: {
      name: "Creditcoin Testnet",
      chainId: RECOVERY_DEFAULTS.settlementChainId,
    },
    publicOrigin: service?.publicOrigin ?? null,
    poolAddress: service?.poolAddress ?? null,
    verifierAddress: null,
    predicateAddress: null,
    campaignNumber: service?.campaignNumber ?? null,
    campaign: null,
    rule: null,
    capacity: null,
    featuredCase: {
      wallet: RECOVERY_DISCOVERY_INDEX[0].wallet,
      failedTransactionHash: RECOVERY_DISCOVERY_INDEX[0].failedTransactionHash,
      successfulTransactionHash: RECOVERY_DISCOVERY_INDEX[0].successfulTransactionHash,
    },
    discoverySize: RECOVERY_DISCOVERY_INDEX.length,
  };
}

async function sendStatic(response, pathname, headOnly = false) {
  const requested = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/, "");
  if (requested.startsWith("..")) throw new WorkerError("NOT_FOUND", "Route not found", 404);
  let body;
  let file = join(staticRoot, requested);
  try {
    body = await readFile(file);
  } catch {
    file = join(staticRoot, "index.html");
    body = await readFile(file);
  }
  response.setHeader("content-type", mimeType(extname(file)));
  response.setHeader("cache-control", file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable");
  response.writeHead(200);
  response.end(headOnly ? undefined : body);
}

function mimeType(extension) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" })[extension]
    ?? "application/octet-stream";
}
