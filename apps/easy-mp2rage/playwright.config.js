import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: withBrowserBuild('node ../../scripts/dev-server.mjs --dir dist --port 4329', 'node ../../scripts/build-static.mjs && node ../../scripts/theme-app-dist.mjs --app easy-mp2rage'),
    url: 'http://localhost:4329/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4329/' },
});
