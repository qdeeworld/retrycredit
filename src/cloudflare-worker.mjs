import { DurableObject } from "cloudflare:workers";

import { RecoveryCampaignService } from "./recovery-campaign-service.mjs";
import { discoverWalletSeaDropPairsResilient } from "./seadrop-wallet-discovery.mjs";
import { observeRecoveryV2 } from "./recovery-v2-observer.mjs";
import { createSignedFreshReadControl } from "./cloudflare-fresh-read-admission.mjs";
import {
  CloudflareApiError,
  createCloudflareApiHandler,
  createCoordinatorRuntime,
} from "./cloudflare-worker-core.mjs";

export class RecoveryCampaignCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.runtime = createCoordinatorRuntime({
      env,
      serviceFactory: createRecoveryService,
      freshReadControl: createSignedFreshReadControl({
        storage: ctx.storage,
        publicOrigin: env.PUBLIC_ORIGIN,
        poolAddress: env.RETRYCREDIT_RECOVERY_POOL_ADDRESS,
        campaignNumber: env.RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER,
      }),
    });
  }

  async health() {
    return this.runtime.health();
  }

  async execute(input) {
    return this.runtime.execute(input);
  }
}

function coordinatorFor(env) {
  if (!env?.RECOVERY_CAMPAIGN?.getByName) {
    throw new CloudflareApiError(
      "RECOVERY_MISCONFIGURED",
      "The recovery coordinator binding is unavailable",
      503,
    );
  }
  const pool = requiredString(env.RETRYCREDIT_RECOVERY_POOL_ADDRESS, "recovery pool").toLowerCase();
  const campaign = requiredString(env.RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER, "recovery campaign");
  return env.RECOVERY_CAMPAIGN.getByName(`${pool}:${campaign}`);
}

function createRecoveryService(env) {
  const relayerAddress = requiredString(
    env.RETRYCREDIT_RECOVERY_RELAYER_ADDRESS,
    "recovery relayer address",
  );
  const poolAddress = requiredString(env.RETRYCREDIT_RECOVERY_POOL_ADDRESS, "recovery pool");
  const campaignNumber = requiredString(env.RETRYCREDIT_RECOVERY_CAMPAIGN_NUMBER, "recovery campaign");
  const publicOrigin = requiredString(env.PUBLIC_ORIGIN, "public origin");
  const creditcoinRpc = requiredString(env.CREDITCOIN_RPC, "Creditcoin RPC");
  const releaseReceiptRpc = requiredString(env.CREDITCOIN_LOG_RPC, "Creditcoin log RPC");
  const proofBuilderUrl = requiredString(env.ATTESTCOIN_PROOF_BUILDER, "Attestcoin proof builder");
  const ethereumRpcUrls = requiredString(env.ETHEREUM_RPC_URLS, "Ethereum RPC list")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ethereumRpcUrls.length === 0 || ethereumRpcUrls.length > 3) {
    throw new CloudflareApiError(
      "RECOVERY_MISCONFIGURED",
      "Ethereum RPC list must contain one to three URLs",
      503,
    );
  }
  return RecoveryCampaignService.fromReadOnly({
    relayerAddress,
    poolAddress,
    campaignNumber,
    creditcoinRpc,
    releaseReceiptRpc,
    proofBuilderUrl,
    ethereumRpcUrls,
    publicOrigin,
    // Discovery is advisory. RouteScan supplies an exact block-bounded history
    // query, Blockscout is the independent fallback, and every candidate still
    // has to pass the authoritative Ethereum RPC checks below.
    walletDiscovery: (options) => discoverWalletSeaDropPairsResilient({
      ...options,
      // Two bounded history attempts plus one 20-second live-validation budget
      // must remain inside the service's 35-second discovery deadline.
      timeoutMs: 6_000,
      maxPages: 6,
    }),
    config: {
      contractVersion: requiredString(
        env.RETRYCREDIT_RECOVERY_CONTRACT_VERSION,
        "recovery contract version",
      ),
      sourceRpcBatchMaxCount: 1,
      settlementRpcBatchMaxCount: 3,
      releaseRpcBatchMaxCount: 1,
      releaseLogConcurrency: 4,
      // Two sequential candidates across two providers keep the worst-case
      // read path below Workers Free's 50-subrequest ceiling and four-open-
      // connection peak. A user can always enter the exact pair manually.
      discoveryCandidateLimit: 2,
      discoverySourceLookupConcurrency: 1,
      sourceProviderAttempts: 2,
    },
  });
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CloudflareApiError("RECOVERY_MISCONFIGURED", `${name} is missing`, 503);
  }
  return value.trim();
}

const handler = createCloudflareApiHandler({ coordinatorFor, observeRecoveryV2 });

export default {
  fetch(request, env) {
    return handler(request, env);
  },
};
