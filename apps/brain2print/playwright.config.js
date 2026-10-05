import { defineConfig } from "@playwright/test";
import { gpuBrowser } from "../../test-utils/hardware-gpu.mjs";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  // MindGrab is WebGPU-only; on SwiftShader it does not finish, so the inference
  // tests need NEURODESK_HARDWARE_GPU=1 on a Mac.
  use: { baseURL: "http://localhost:4173", ...gpuBrowser },
});
