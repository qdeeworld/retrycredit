import { DurableObject } from "cloudflare:workers";

import { createFreshReadDutyCycle } from "../src/cloudflare-worker-core.mjs";

export class FreshReadTestCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const fixedNowMs = Number(env.TEST_NOW_MS);
    this.admit = createFreshReadDutyCycle({
      storage: ctx.storage,
      now: () => fixedNowMs,
    });
  }

  async admitFresh() {
    try {
      await this.admit();
      return { status: 200 };
    } catch (error) {
      return {
        status: error?.status,
        code: error?.code,
        retryAfter: error?.retryAfter,
      };
    }
  }
}

export default {
  fetch() {
    return new Response("test-only");
  },
};
