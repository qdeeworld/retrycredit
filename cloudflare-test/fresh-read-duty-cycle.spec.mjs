import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { encodeFreshReadCredential } from "../src/cloudflare-fresh-read-admission.mjs";
import { formatRecoveryChallengeMessage } from "../src/recovery-consent.mjs";

const PRIVATE_KEY = "0x" + "11".repeat(32);
const WALLET = new Wallet(PRIVATE_KEY);
const ORIGIN = "https://retrycredit.example";
const POOL = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const CAMPAIGN = 7;
const ISSUED_AT = 1_800_000_000;

describe("fresh-read Durable Object persistence", () => {
  it("admits one signed caller and retains key, replay, and cadence state after eviction", async () => {
    const id = env.FRESH_READ_TEST.idFromName("fresh-duty-cycle-eviction");
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const firstChallenge = challengeFor(1);
    const firstReceipt = await stubs[0].issueReceipt(firstChallenge);
    const firstCredential = encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair: firstChallenge.pair,
      issuedAt: firstChallenge.issuedAt,
      expiresAt: firstChallenge.expiresAt,
      signature: await WALLET.signMessage(firstChallenge.message),
      receipt: firstReceipt,
    });

    const decisions = await Promise.all(stubs.map((stub) => stub.admitFresh(firstCredential)));

    expect(decisions.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === 409)).toHaveLength(99);
    expect(decisions.filter(({ status }) => status === 409)).toEqual(
      Array(99).fill({
        status: 409,
        code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
        retryAfter: null,
      }),
    );

    await evictDurableObject(stubs[0]);

    const recreated = env.FRESH_READ_TEST.get(id);
    expect(await recreated.admitFresh(firstCredential)).toEqual({
      status: 409,
      code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
      retryAfter: null,
    });

    const secondChallenge = challengeFor(2);
    const secondReceipt = await recreated.issueReceipt(secondChallenge);
    const secondCredential = encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair: secondChallenge.pair,
      issuedAt: secondChallenge.issuedAt,
      expiresAt: secondChallenge.expiresAt,
      signature: await WALLET.signMessage(secondChallenge.message),
      receipt: secondReceipt,
    });
    expect(await recreated.admitFresh(secondCredential)).toEqual({
      status: 429,
      code: "RECOVERY_FRESH_READ_THROTTLED",
      retryAfter: "5",
    });
  });

  it("honors the legacy persisted window without consuming the signed grant across eviction", async () => {
    const id = env.FRESH_READ_TEST.idFromName("fresh-duty-cycle-upgrade");
    const stub = env.FRESH_READ_TEST.get(id);
    const challenge = challengeFor(20);
    const receipt = await stub.issueReceipt(challenge);
    const credential = encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair: challenge.pair,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature: await WALLET.signMessage(challenge.message),
      receipt,
    });
    await stub.setLegacyNotBefore(1_800_000_005_000);
    expect(await stub.admitFresh(credential)).toEqual({
      status: 429,
      code: "RECOVERY_FRESH_READ_THROTTLED",
      retryAfter: "5",
    });

    await evictDurableObject(stub);
    const recreated = env.FRESH_READ_TEST.get(id);
    await recreated.setLegacyNotBefore(1_800_000_000_000);
    expect(await recreated.admitFresh(credential)).toEqual({ status: 200 });
    expect(await recreated.admitFresh(credential)).toEqual({
      status: 409,
      code: "RECOVERY_FRESH_READ_AUTHORIZATION_USED",
      retryAfter: null,
    });
  });

  it("admits one of 100 distinct grants and preserves a throttled grant across eviction", async () => {
    const id = env.FRESH_READ_TEST.idFromName("fresh-duty-cycle-distinct-concurrency");
    const stubs = Array.from({ length: 100 }, () => env.FRESH_READ_TEST.get(id));
    const challenges = stubs.map((_stub, index) => challengeFor(100 + index));
    const receipts = await Promise.all(challenges.map((challenge, index) => (
      stubs[index].issueReceipt(challenge)
    )));
    const credentials = await Promise.all(challenges.map(async (challenge, index) => (
      encodeFreshReadCredential({
        v: 1,
        wallet: WALLET.address,
        pair: challenge.pair,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        signature: await WALLET.signMessage(challenge.message),
        receipt: receipts[index],
      })
    )));

    const decisions = await Promise.all(credentials.map((credential, index) => (
      stubs[index].admitFresh(credential)
    )));
    expect(decisions.filter(({ status }) => status === 200)).toHaveLength(1);
    expect(decisions.filter(({ status }) => status === 429)).toHaveLength(99);
    const throttledIndex = decisions.findIndex(({ status }) => status === 429);
    expect(decisions[throttledIndex]).toEqual({
      status: 429,
      code: "RECOVERY_FRESH_READ_THROTTLED",
      retryAfter: "5",
    });

    await evictDurableObject(stubs[0]);
    const recreated = env.FRESH_READ_TEST.get(id);
    await recreated.setLegacyNotBefore(1_800_000_000_000);
    expect(await recreated.admitFresh(credentials[throttledIndex])).toEqual({ status: 200 });
  });

  it("fails closed on a corrupt legacy persisted window", async () => {
    const id = env.FRESH_READ_TEST.idFromName("fresh-duty-cycle-corrupt-upgrade");
    const stub = env.FRESH_READ_TEST.get(id);
    const challenge = challengeFor(30);
    const receipt = await stub.issueReceipt(challenge);
    const credential = encodeFreshReadCredential({
      v: 1,
      wallet: WALLET.address,
      pair: challenge.pair,
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt,
      signature: await WALLET.signMessage(challenge.message),
      receipt,
    });
    await stub.setLegacyNotBefore("corrupt");
    expect(await stub.admitFresh(credential)).toEqual({
      status: 503,
      code: "RECOVERY_FRESH_READ_STATE_INVALID",
      retryAfter: null,
    });
  });
});

function challengeFor(index) {
  const pair = {
    failedTransactionHash: hashFor(index * 2 + 1),
    successfulTransactionHash: hashFor(index * 2 + 2),
  };
  return {
    wallet: WALLET.address,
    poolAddress: POOL,
    campaignNumber: CAMPAIGN,
    pair,
    issuedAt: ISSUED_AT,
    expiresAt: ISSUED_AT + 300,
    message: formatRecoveryChallengeMessage({
      origin: ORIGIN,
      poolAddress: POOL,
      campaignNumber: CAMPAIGN,
      wallet: WALLET.address,
      failedTransactionHash: pair.failedTransactionHash,
      successfulTransactionHash: pair.successfulTransactionHash,
      issuedAt: ISSUED_AT,
      expiresAt: ISSUED_AT + 300,
    }),
  };
}

function hashFor(value) {
  return "0x" + value.toString(16).padStart(64, "0");
}
