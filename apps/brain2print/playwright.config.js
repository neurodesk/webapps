import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  // MindGrab is WebGPU-only; headless Chromium needs these to expose an adapter.
  use: { baseURL: "http://localhost:4173", launchOptions: { args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] } },
});
