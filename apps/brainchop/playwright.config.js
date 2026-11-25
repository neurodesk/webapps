import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.BRAINCHOP_E2E_PORT || 4198);
const baseURL = `http://localhost:${port}`;

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: withBrowserBuild(`pnpm preview --port ${port} --strictPort`),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL },
});
