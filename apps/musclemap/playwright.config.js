import { defineConfig } from "@playwright/test";

// Serve web/ with COOP/COEP (via run.sh) after vendoring the shared components, so the
// harness exercises the real import map + vendored files in a browser.
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "pnpm vendor && bash web/run.sh 4318",
    url: "http://localhost:4318/harness.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://localhost:4318",
    // Optional escape hatch when the preinstalled browser doesn't match the runner version
    // (e.g. sandboxed CI): set PW_EXECUTABLE_PATH to the local Chromium. Unset by default.
    ...(process.env.PW_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
      : {}),
  },
});
