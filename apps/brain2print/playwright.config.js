import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";
import { gpuBrowser } from "../../test-utils/hardware-gpu.mjs";

// The viewer is WebGPU-only, so every run needs an adapter. Without NEURODESK_HARDWARE_GPU=1 that
// is Chromium's software adapter (SwiftShader), what a hosted runner with no GPU has; it lacks
// shader-f16, so MindGrab cannot use WebGPU there and segmentation runs on the threaded CPU module.

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4173 --strictPort"),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173", ...gpuBrowser },
});
