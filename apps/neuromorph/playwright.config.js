import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";

// Serve the BUILT output so the shared preview headers and asset paths are exercised.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4377 --strictPort"),
    url: "http://localhost:4377",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:4377",
    // page.route cannot see requests the isolation service worker makes; the preview server
    // sends COOP/COEP itself, so the worker is not needed.
    serviceWorkers: "block",
  },
});
