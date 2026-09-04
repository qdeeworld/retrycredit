import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const INITIAL_NOW_MS = 1_800_000_000_000;

describe("V2 observation Durable Object cache", () => {
  it("coalesces 100 callers and survives eviction until the exact TTL boundary", async () => {
    const id = env.FRESH_READ_TEST.idFromName("v2-observation-success-cache");
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const first = await Promise.all(stubs.map((stub) => stub.observeV2()));
    expect(first.every(({ status }) => status === 200)).toBe(true);
    expect(await stubs[0].observationLoadCount()).toBe(1);

    await evictDurableObject(stubs[0]);
    const recreated = env.FRESH_READ_TEST.get(id);
    expect((await recreated.observeV2()).status).toBe(200);
    expect(await recreated.observationLoadCount()).toBe(1);

    await recreated.setObservationNow(INITIAL_NOW_MS + 30_000);
    const boundaryStubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const refreshed = await Promise.all(boundaryStubs.map((stub) => stub.observeV2()));
    expect(refreshed.every(({ status }) => status === 200)).toBe(true);
    expect(await recreated.observationLoadCount()).toBe(2);
  });

  it("caches provider failure instead of creating a retry storm", async () => {
    const id = env.FRESH_READ_TEST.idFromName("v2-observation-failure-cache");
    const stub = env.FRESH_READ_TEST.get(id);
    await stub.setObservationStatus(503);
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const results = await Promise.all(stubs.map((candidate) => candidate.observeV2()));
    expect(results.every(({ status, body }) => (
      status === 503 && body.recoveryV2.reason === "RECOVERY_V2_OBSERVATION_FAILED"
    ))).toBe(true);
    expect(await stub.observationLoadCount()).toBe(1);
    expect((await stub.observeV2()).status).toBe(503);
    expect(await stub.observationLoadCount()).toBe(1);
  });

  it("replaces an expired success with a coalesced failed refresh and never serves it stale", async () => {
    const id = env.FRESH_READ_TEST.idFromName("v2-observation-expired-success");
    const stub = env.FRESH_READ_TEST.get(id);
    expect((await stub.observeV2()).status).toBe(200);
    expect(await stub.observationLoadCount()).toBe(1);

    await stub.setObservationNow(INITIAL_NOW_MS + 30_000);
    await stub.setObservationStatus(503);
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const refreshed = await Promise.all(stubs.map((candidate) => candidate.observeV2()));
    expect(refreshed.every(({ status }) => status === 503)).toBe(true);
    expect(await stub.observationLoadCount()).toBe(2);
    expect((await stub.observeV2()).status).toBe(503);
    expect(await stub.observationLoadCount()).toBe(2);
  });
});
