import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "lcmodel",
  plugins: [isolationFallback()],
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  // The tissue worker always passes assetPath to the versioned MindMap runtime.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
});
