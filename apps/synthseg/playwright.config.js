import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 600000, workers: 1,
  webServer: {
    env: process.env.SYNTHSEG_ASSET_DIR ? { VITE_SYNTHSEG_ASSET_BASE: '/synthseg/model-assets/' } : {},
    command: 'node node_modules/vite/bin/vite.js build && node ../../scripts/theme-app-dist.mjs --app synthseg && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175/synthseg/',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4175/synthseg/',
    // Headless Chromium only exposes a SwiftShader WebGPU adapter; SYNTHSEG_HARDWARE_GPU
    // switches to the real GPU (macOS/Metal), which the full-model run needs.
    launchOptions: { args: ['--enable-unsafe-webgpu', ...(process.env.SYNTHSEG_HARDWARE_GPU ? ['--use-angle=metal', '--enable-features=Metal'] : ['--use-angle=swiftshader', '--enable-features=Vulkan', '--use-vulkan=swiftshader'])] },
    screenshot: 'only-on-failure',
  },
});
