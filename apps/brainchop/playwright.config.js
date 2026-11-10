import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { gpuBrowser } from '../../test-utils/hardware-gpu.mjs';
import { defineConfig } from "@playwright/test";

const browser = process.env.BRAINCHOP_MESA === '1'
  ? { channel: 'chromium', headless: false, launchOptions: { args: ['--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist'] } }
  : gpuBrowser;

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4173 --strictPort"),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173", ...browser },
});
