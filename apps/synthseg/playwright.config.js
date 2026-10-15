import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';
import { e2eTier } from '../../test-utils/e2e-tier.mjs';
import { gpuBrowser } from '../../test-utils/hardware-gpu.mjs';

export default defineConfig({
  ...e2eTier,
  testDir: './e2e', timeout: 600000, workers: 1,
  webServer: {
    command: withBrowserBuild('node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4175 --strictPort', 'node node_modules/vite/bin/vite.js build && node ../../scripts/theme-app-dist.mjs --app synthseg'),
    url: 'http://127.0.0.1:4175/synthseg/',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://127.0.0.1:4175/synthseg/',
    // The full-model run needs NEURODESK_HARDWARE_GPU=1 (Metal, or Vulkan on Linux); SwiftShader is too slow.
    ...gpuBrowser,
    screenshot: 'only-on-failure',
  },
});
