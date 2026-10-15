import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';
import { gpuBrowser } from '../../test-utils/hardware-gpu.mjs';
export default defineConfig({
  testDir:'./e2e', timeout:300000, workers:1,
  webServer:{
    command: withBrowserBuild('node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4174 --strictPort', 'node node_modules/vite/bin/vite.js build && node ../../scripts/theme-app-dist.mjs --app synthsr'),
    url:'http://127.0.0.1:4174/synthsr/',reuseExistingServer:!process.env.CI,
  },
  use:{baseURL:'http://127.0.0.1:4174/synthsr/',...gpuBrowser,screenshot:'only-on-failure'},
});
