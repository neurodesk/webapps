import { defineConfig } from "@playwright/test";

// The viewer is WebGPU-only, so every run needs an adapter. By default that is Chromium's
// software adapter (SwiftShader), which is what a hosted runner with no GPU has; it lacks
// shader-f16, so MindGrab cannot use WebGPU there and the specs name the threaded CPU backend.
// BRAIN2PRINT_HARDWARE_GPU=1 hands Chromium the real GPU (macOS/Metal) for the hardware variants.
const hardwareGpu = Boolean(process.env.BRAIN2PRINT_HARDWARE_GPU);
const softwareAdapter = [
  "--use-webgpu-adapter=swiftshader",
  "--use-angle=swiftshader",
  ...(process.platform === "linux" ? ["--use-vulkan=swiftshader", "--enable-features=Vulkan", "--disable-vulkan-surface"] : []),
];

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: { args: ["--enable-unsafe-webgpu", ...(hardwareGpu ? ["--use-angle=metal", "--enable-features=Metal"] : softwareAdapter)] },
  },
});
