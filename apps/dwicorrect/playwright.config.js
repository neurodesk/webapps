import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";
import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.mjs",
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4173 --strictPort"),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173" },
});
