import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 120000, workers: 1,
  webServer: {
    command: withBrowserBuild('pnpm preview --host 127.0.0.1 --port 4187 --strictPort'),
    url: 'http://127.0.0.1:4187/', reuseExistingServer: !process.env.CI, timeout: 180000,
  },
  use: { baseURL: 'http://127.0.0.1:4187/' },
});
