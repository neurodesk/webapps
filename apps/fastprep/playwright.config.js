import { defineConfig } from "@playwright/test";
import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { gpuBrowser } from "../../test-utils/hardware-gpu.mjs";

// Serve the BUILT output so the shared preview headers and worker/wasm asset paths are exercised.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  webServer: {
    command: withBrowserBuild(
      "node node_modules/vite/bin/vite.js preview --port 4173 --strictPort",
      "node scripts/copy-runtime.mjs && node node_modules/vite/bin/vite.js build && node ../../scripts/theme-app-dist.mjs --app fastprep",
    ),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173", ...gpuBrowser, screenshot: "only-on-failure" },
});
