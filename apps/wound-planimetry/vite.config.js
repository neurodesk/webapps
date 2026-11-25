import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "wound-planimetry",
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
