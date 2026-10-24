import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";

// Serves the BUILT output so the shared preview headers and the worker and kernel paths are
// exercised. BISON_ASSET_DIR (a local copy of the held model files) is served by the preview
// server at /bison/bison-assets/ (vite.config.js) for the full-pipeline test.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  timeout: 120000,
  workers: 1,
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4197 --strictPort"),
    url: "http://127.0.0.1:4197/bison/",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  use: {
    baseURL: "http://127.0.0.1:4197/bison/",
    // The isolation service worker hides requests from page.route; the preview server sends COOP/COEP itself.
    serviceWorkers: "block",
    launchOptions: { args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"] },
  },
});
