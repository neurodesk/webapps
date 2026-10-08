import { defineConfig } from '@playwright/test';
import { gpuBrowser } from '../../test-utils/hardware-gpu.mjs';

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
    // The full-model run needs NEURODESK_HARDWARE_GPU=1 (Metal); SwiftShader is too slow.
    ...gpuBrowser,
    screenshot: 'only-on-failure',
  },
});
