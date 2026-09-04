import { DurableObject } from "cloudflare:workers";

import { createSignedFreshReadControl } from "../src/cloudflare-fresh-read-admission.mjs";
import { FRESH_READ_NOT_BEFORE_KEY } from "../src/cloudflare-worker-core.mjs";

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
}

export default {
  fetch() {
    return new Response("test-only");
  },
};
