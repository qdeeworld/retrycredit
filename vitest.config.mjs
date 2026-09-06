import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./cloudflare-test/wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["cloudflare-test/**/*.spec.mjs"],
  },
});
