import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "edgereg",
  base: "./",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@niivue/niimath"] },
});
