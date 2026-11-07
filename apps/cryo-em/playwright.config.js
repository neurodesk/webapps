import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";

// Serve the BUILT output, and beside it the protocol's Node reference server in
// single-owner mode with its simulated relion tool, an `examples` data root of
// placeholder tutorial files and a data directory the tests can inspect.
export const PREVIEW_PORT = 4447;
export const COMPUTE_PORT = 8771;
export const COMPUTE_TOKEN = "test-token";
export const E2E_ROOT = join(process.env.TMPDIR || tmpdir(), "cryo-em-e2e");

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.js",
  workers: 1,
  webServer: [
    {
      command: withBrowserBuild(`pnpm preview --port ${PREVIEW_PORT} --strictPort`),
      url: `http://localhost:${PREVIEW_PORT}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node e2e/compute-server.mjs --port ${COMPUTE_PORT} --token ${COMPUTE_TOKEN} --root ${E2E_ROOT}`,
      url: `http://127.0.0.1:${COMPUTE_PORT}/api/v1/info`,
      reuseExistingServer: false,
    },
  ],
  // page.route must see every request; a service worker would hide them.
  use: { baseURL: `http://localhost:${PREVIEW_PORT}`, serviceWorkers: "block" },
});
