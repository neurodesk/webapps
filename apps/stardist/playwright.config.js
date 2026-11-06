import { withBrowserBuild } from "../../test-utils/playwright-build.mjs";
import { defineConfig } from "@playwright/test";
import { e2eTier } from "../../test-utils/e2e-tier.mjs";

// Serves the BUILT output so the shared preview headers and worker/wasm asset paths are exercised.
export default defineConfig({
  ...e2eTier,
  testDir: "./e2e",
  timeout: 120000,
  workers: 2,
  webServer: {
    command: withBrowserBuild("pnpm preview --port 4213 --strictPort"),
    url: "http://127.0.0.1:4213/stardist/",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
  use: {
    baseURL: "http://127.0.0.1:4213/stardist/",
    // The COI service worker would hide requests from page.route; vite preview sends COOP/COEP itself.
    serviceWorkers: "block",
    launchOptions: { args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"] },
  },
});
