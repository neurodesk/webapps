import { createRequire } from "node:module";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { mindgrabAssets, mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

// Resolve MindGrab through the package that pins it, as hmc and noddi do.
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("@neurodesk/runtime-support/mindgrab"));
const mindgrabPackage = runtimeRequire.resolve("@brainchop/mindgrab/package.json");

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "sdc",
  plugins: [mindgrabAssets({ packageJson: mindgrabPackage, models: ["mindgrab"] })],
  // The MindGrab worker always passes assetPath, so its modules load from the mindgrab/ copies.
  worker: { format: "es", plugins: () => [mindgrabFromAssetPath()] },
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["@brainchop/mindgrab"] },
});
