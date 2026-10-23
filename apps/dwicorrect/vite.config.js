import { createRequire } from "node:module";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { mindgrabAssets, mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

// Resolve MindGrab through the package that pins it, as noddi does.
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("@neurodesk/runtime-support/mindgrab"));
const mindgrabPackage = runtimeRequire.resolve("@brainchop/mindgrab/package.json");

// One shared owner supplies the app path, dev shell, theme, and isolation policy: the
// threaded shoreline module needs cross-origin isolation.
export default neurodeskViteConfig({
  appId: "dwicorrect",
  plugins: [mindgrabAssets({ packageJson: mindgrabPackage, models: ["mindgrab"] })],
  worker: { format: "es", plugins: () => [mindgrabFromAssetPath()] },
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@brainchop/mindgrab"] },
});
