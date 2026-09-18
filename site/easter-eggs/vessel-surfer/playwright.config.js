import { defineConfig } from "@playwright/test";

// Serve the BUILT output so COOP/COEP headers (public/_headers, applied by the host)
// and worker/wasm asset paths are exercised — not just the dev server.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  webServer: {
    command:
      "pnpm build && pnpm preview --host 127.0.0.1 --port 4178 --strictPort",
    url: "http://127.0.0.1:4178/",
    reuseExistingServer: !process.env.CI,
  },
  use: {
    launchOptions: {
      args: ["--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader"],
    },
    baseURL: "http://127.0.0.1:4178/",
  },
});
