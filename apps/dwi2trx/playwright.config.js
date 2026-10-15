import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from "@playwright/test";

// Serve the BUILT output so COOP/COEP headers (public/_headers, applied by the host)
// and worker/wasm asset paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: withBrowserBuild("node_modules/.bin/vite preview --port 4173 --strictPort", "node scripts/copy-brainchop.mjs && node_modules/.bin/vite build && node ../../scripts/theme-app-dist.mjs --app dwi2trx"),
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173" },
});
