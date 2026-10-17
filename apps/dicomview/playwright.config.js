import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';

// Serve the built output so the shared preview headers and worker/wasm asset paths are
// exercised, not just the dev server.
export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: withBrowserBuild('pnpm preview --host 127.0.0.1 --port 4193 --strictPort'),
    url: 'http://127.0.0.1:4193/dicomview/',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
  use: { baseURL: 'http://127.0.0.1:4193/dicomview/' },
});
