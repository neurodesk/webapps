import { defineConfig } from "@playwright/test";

// Serve the BUILT output so COOP/COEP headers (public/_headers, applied by the host)
// and worker/wasm asset paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:4173" },
});
