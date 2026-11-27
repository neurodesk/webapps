import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

export default neurodeskViteConfig({
  appId: "brkraw",
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
