import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./helper-ledger-test/wrangler.jsonc" } })],
  test: { include: ["helper-ledger-test/**/*.spec.mjs"] },
});
