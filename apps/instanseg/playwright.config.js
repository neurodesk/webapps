import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";

// Serves the built output so shared preview headers, isolation, and worker/wasm paths are exercised.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  timeout: 120000,
  workers: 1,
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4173 --strictPort"),
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "block",
    launchOptions: { args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"] },
  },
});
