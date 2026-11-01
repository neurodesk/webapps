import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
// @niivue/reproin and its bundled dcm2niix locate their worker and WASM by import.meta.url, which pre-bundling breaks.
export default neurodeskViteConfig({
  appId: "reproin",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@niivue/reproin"] },
});
