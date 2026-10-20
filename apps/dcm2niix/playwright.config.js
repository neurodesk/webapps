import { defineConfig } from '@playwright/test';
import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { e2eTier } from '../../test-utils/e2e-tier.mjs';

// Exercise the production worker/WASM URLs and shell, including when CI supplies
// a prebuilt bundle. Keep this port distinct from the other catalog previews.
export default defineConfig({
  ...e2eTier,
  testDir: './e2e',
  workers: 1,
  webServer: {
    command: withBrowserBuild('pnpm preview --host 127.0.0.1 --port 4241 --strictPort'),
    url: 'http://127.0.0.1:4241/dcm2niix/',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
  use: { baseURL: 'http://127.0.0.1:4241/dcm2niix/' },
});
