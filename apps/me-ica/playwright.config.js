import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server. One worker: runs are CPU-heavy.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  webServer: {
    command: withBrowserBuild("pnpm preview --host 127.0.0.1 --port 4173 --strictPort"),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:4173",
    // page.route cannot see requests the isolation service worker makes; the preview server
    // sends COOP/COEP itself, so the worker is not needed.
    serviceWorkers: "block",
    launchOptions: { args: process.platform === "linux" ? ["--use-angle=swiftshader", "--use-vulkan=swiftshader", "--enable-features=Vulkan", "--disable-vulkan-surface"] : [] },
  },
});
