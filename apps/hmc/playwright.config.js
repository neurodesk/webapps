import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("node node_modules/vite/bin/vite.js preview --port 4288 --strictPort"),
    url: "http://localhost:4288/hmc/",
    reuseExistingServer: !process.env.CI,
  },
  use: { serviceWorkers: "block", baseURL: "http://localhost:4288/hmc/" },
});
