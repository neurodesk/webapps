import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', timeout: 60000, workers: 1,
  webServer: {
    command: withBrowserBuild('python3 -m http.server 4186 --bind 127.0.0.1 --directory dist', 'node ../../scripts/vendor-components.mjs && pnpm build'),
    url: 'http://127.0.0.1:4186/', reuseExistingServer: !process.env.CI, timeout: 180000,
  },
  use: { baseURL: 'http://127.0.0.1:4186/' },
});
