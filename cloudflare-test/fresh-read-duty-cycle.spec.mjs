import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("fresh-read Durable Object persistence", () => {
  it("admits one concurrent caller and retains the checkpoint after eviction", async () => {
    const id = env.FRESH_READ_TEST.idFromName("fresh-duty-cycle-eviction");
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));

    const decisions = await Promise.all(stubs.map((stub) => stub.admitFresh()));

    expect(decisions.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === 429)).toHaveLength(99);
    expect(decisions.filter(({ status }) => status === 429)).toEqual(
      Array(99).fill({
        status: 429,
        code: "RECOVERY_FRESH_READ_THROTTLED",
        retryAfter: "5",
      }),
    );

    await evictDurableObject(stubs[0]);

    const afterEviction = await env.FRESH_READ_TEST.get(id).admitFresh();
    expect(afterEviction).toEqual({
      status: 429,
      code: "RECOVERY_FRESH_READ_THROTTLED",
      retryAfter: "5",
    });
  });
});
