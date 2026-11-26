import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";
import { mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "fireants",
  base: "./",
  plugins: [isolationFallback(), mindgrabFromAssetPath()],
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@brainchop/core"] },
});
