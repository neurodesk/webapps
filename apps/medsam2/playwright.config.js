import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";
import { gpuBrowser, hardwareGpu } from "../../test-utils/hardware-gpu.mjs";

// Serves the BUILT output so the shared preview headers and worker/wasm asset paths are exercised.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  timeout: 180000,
  workers: hardwareGpu ? 1 : 2,
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4238 --strictPort"),
    url: "http://127.0.0.1:4238/medsam2/",
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  use: {
    baseURL: "http://127.0.0.1:4238/medsam2/",
    // The COI service worker would hide requests from page.route; vite preview sends COOP/COEP itself.
    serviceWorkers: "block",
    ...(hardwareGpu ? gpuBrowser : {}),
  },
});
