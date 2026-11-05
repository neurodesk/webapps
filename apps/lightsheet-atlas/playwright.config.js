import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4291 --strictPort"),
    url: "http://localhost:4291",
    reuseExistingServer: !process.env.CI,
  },
  // The cross-origin isolation service worker hides requests from page.route; the preview
  // server sends COOP/COEP itself.
  use: { baseURL: "http://localhost:4291", serviceWorkers: "block" },
});
