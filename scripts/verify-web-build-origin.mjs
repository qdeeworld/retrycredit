import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  cloudflareHeadersForApiOrigin,
  PRODUCTION_API_ORIGIN,
  SAME_ORIGIN_API_ORIGIN,
  STAGING_API_ORIGIN,
} from "./cloudflare-headers.mjs";

const profiles = Object.freeze({
  "same-origin": SAME_ORIGIN_API_ORIGIN,
  production: PRODUCTION_API_ORIGIN,
  staging: STAGING_API_ORIGIN,
});
const profile = process.argv[2];
assert.ok(Object.hasOwn(profiles, profile), "Expected same-origin, production, or staging build profile.");
const expectedOrigin = profiles[profile];
const dist = new URL("../dist/", import.meta.url);
const headers = await readFile(new URL("_headers", dist), "utf8");
assert.equal(headers, cloudflareHeadersForApiOrigin(expectedOrigin));

const assetNames = await readdir(new URL("assets/", dist));
const javascript = (await Promise.all(assetNames
  .filter((name) => name.endsWith(".js"))
  .map((name) => readFile(new URL(`assets/${name}`, dist), "utf8"))))
  .join("\n");
for (const origin of [PRODUCTION_API_ORIGIN, STAGING_API_ORIGIN]) {
  assert.equal(
    javascript.includes(origin),
    origin === expectedOrigin,
    `${profile} JavaScript API origin does not match its generated CSP.`,
  );
}

console.log(`Verified ${profile} bundle and Cloudflare CSP origin parity.`);
