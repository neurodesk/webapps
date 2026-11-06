import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";

// Serves the built output so the shared preview headers and worker/wasm asset paths are exercised.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  timeout: 120000,
  workers: 1,
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4231 --strictPort"),
    url: "http://127.0.0.1:4231/gliomoda/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://127.0.0.1:4231/gliomoda/",
    // The isolation service worker hides requests from page.route; the preview server sends COOP/COEP itself.
    serviceWorkers: "block",
    launchOptions: { args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"] },
  },
});
