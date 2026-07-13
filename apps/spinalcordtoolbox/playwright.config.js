import { defineConfig } from "@playwright/test";

// Serve web/ with COOP/COEP (run.sh) after vendoring shared components, so the harness
// exercises the real import map + vendored files in a browser.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm vendor && bash web/run.sh 4320",
    url: "http://localhost:4320/harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://localhost:4320",
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : {}),
  },
});
