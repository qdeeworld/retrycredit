import { DurableObject } from "cloudflare:workers";

import { createSignedFreshReadControl } from "../src/cloudflare-fresh-read-admission.mjs";
import { createRecoveryV2ObservationCache } from "../src/cloudflare-v2-observation-cache.mjs";
import { FRESH_READ_NOT_BEFORE_KEY } from "../src/cloudflare-worker-core.mjs";

const OBSERVATION_LOAD_COUNT_KEY = "test:recovery-v2-observation-load-count";

export class FreshReadTestCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.storage = ctx.storage;
    const fixedNowMs = Number(env.TEST_NOW_MS);
    this.control = createSignedFreshReadControl({
      storage: ctx.storage,
      now: () => fixedNowMs,
      publicOrigin: env.TEST_PUBLIC_ORIGIN,
      poolAddress: env.TEST_POOL_ADDRESS,
      campaignNumber: env.TEST_CAMPAIGN_NUMBER,
    });
    this.observationNowMs = fixedNowMs;
    this.observationStatus = 200;
    this.observationCache = createRecoveryV2ObservationCache({
      storage: ctx.storage,
      identity: env.TEST_OBSERVATION_IDENTITY,
      revision: env.TEST_REVISION,
      now: () => this.observationNowMs,
      observe: async () => {
        await this.storage.transaction(async (transaction) => {
          const count = await transaction.get(OBSERVATION_LOAD_COUNT_KEY) ?? 0;
          await transaction.put(OBSERVATION_LOAD_COUNT_KEY, count + 1);
        });
        return observationResult(this.observationStatus, env.TEST_REVISION);
      },
    });
  }

  async issueReceipt(challenge) {
    return this.control.issueReceipt(challenge);
  }

  async admitFresh(credential) {
    try {
      await this.control.admit(credential);
      return { status: 200 };
    } catch (error) {
      return {
        status: error?.status,
        code: error?.code,
        retryAfter: error?.retryAfter,
      };
    }
  }

  async setLegacyNotBefore(value) {
    await this.storage.put(FRESH_READ_NOT_BEFORE_KEY, value);
  }

  async observeV2() {
    return this.observationCache.read();
  }

  async observationLoadCount() {
    return await this.storage.get(OBSERVATION_LOAD_COUNT_KEY) ?? 0;
  }

  setObservationNow(value) {
    this.observationNowMs = value;
  }

  setObservationStatus(value) {
    this.observationStatus = value;
  }
}

export default {
  fetch() {
    return new Response("test-only");
  },
};

function observationResult(status, revision) {
  const success = status === 200;
  return {
    status: success ? 200 : 503,
    body: {
      ok: success,
      service: "retrycredit",
      network: 102031,
      recoveryV2: success
        ? {
            mode: "observation-only",
            state: "observed",
            publicProfile: "v1",
            reason: "CANONICAL_DEPLOYMENT_OBSERVED_PLUS_TWO",
            observers: 2,
          }
        : {
            mode: "observation-only",
            state: "blocked",
            publicProfile: "v1",
            reason: "RECOVERY_V2_OBSERVATION_FAILED",
          },
      revision,
    },
  };
}
