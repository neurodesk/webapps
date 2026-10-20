import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "dcm2niix",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  // Vite's dev prebundler moves @niivue/dcm2niix under .vite/deps, where its
  // worker and WASM siblings do not exist. Keep that package as source in dev.
  optimizeDeps: {
    exclude: ["@niivue/dcm2niix"],
  },
});
