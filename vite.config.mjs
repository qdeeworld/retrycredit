import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  cloudflareHeadersForApiOrigin,
  SAME_ORIGIN_API_ORIGIN,
} from "./scripts/cloudflare-headers.mjs";

const CLOUDFLARE_HEADERS_PATH = fileURLToPath(new URL("./dist/_headers", import.meta.url));
const WEB_ROOT = fileURLToPath(new URL("./web", import.meta.url));

function cloudflareHeadersPlugin(apiOrigin) {
  const headers = cloudflareHeadersForApiOrigin(apiOrigin);
  return {
    name: "retrycredit-cloudflare-headers",
    apply: "build",
    async closeBundle() {
      await writeFile(CLOUDFLARE_HEADERS_PATH, headers, "utf8");
    },
  };
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, WEB_ROOT, "VITE_");
  const apiOrigin = process.env.VITE_RETRYCREDIT_API_ORIGIN
    ?? fileEnv.VITE_RETRYCREDIT_API_ORIGIN
    ?? SAME_ORIGIN_API_ORIGIN;
  return {
    root: "web",
    plugins: [react(), cloudflareHeadersPlugin(apiOrigin)],
    define: {
      "import.meta.env.VITE_RETRYCREDIT_API_ORIGIN": JSON.stringify(apiOrigin),
    },
    build: {
      outDir: "../dist",
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      proxy: {
        "/api": "http://127.0.0.1:4179",
        "/health": "http://127.0.0.1:4179",
      },
    },
  };
});
