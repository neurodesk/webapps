import { withBrowserBuild } from '../../test-utils/playwright-build.mjs';
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";
import { gpuBrowser } from "../../test-utils/hardware-gpu.mjs";
const port=Number(process.env.SYNCRO_TEST_PORT||4176),baseURL=`http://127.0.0.1:${port}/syncro/`;

// Serve the BUILT output so COOP/COEP headers (public/_headers, applied by the host)
// and worker/wasm asset paths are exercised — not just the dev server.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  workers: 1,
  // The viewer and the real pipeline both run on software rendering in CI; allow for a busy machine.
  timeout: 120000,
  expect: { timeout: 20000 },
  webServer: {
    timeout: 120000,
    command: withBrowserBuild(`pnpm preview --host 127.0.0.1 --port ${port} --strictPort`),
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL, ...gpuBrowser },
});
