import { defineConfig } from "@playwright/test";

// Serve the BUILT output so the shared preview headers are exercised, and run
// the protocol's Node reference server (simulated nesvor) beside it so the whole
// workflow from example to download runs without a GPU.
export const COMPUTE_PORT = 8766;
export const COMPUTE_TOKEN = "test-token";

export default defineConfig({
  testDir: "./e2e",
  webServer: [
    {
      command: "pnpm build && pnpm preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `node ../../test-utils/compute-reference-server.mjs --port ${COMPUTE_PORT} --token ${COMPUTE_TOKEN} --stage-delay-ms 300`,
      url: `http://127.0.0.1:${COMPUTE_PORT}/api/v1/info`,
      reuseExistingServer: !process.env.CI,
    },
  ],
  use: { baseURL: "http://localhost:4173" },
});
