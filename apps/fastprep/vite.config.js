import { createRequire } from "node:module";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";
import { mindgrabAssets, mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

const require = createRequire(import.meta.url);
const mindgrabPackage = require.resolve("@brainchop/core/package.json");

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
// Threaded WASM (Greedy, ONNX Runtime, MindGrab CPU) needs cross-origin isolation.
export default neurodeskViteConfig({
  appId: "fastprep",
  base: "./",
  plugins: [isolationFallback(), mindgrabAssets({ packageJson: mindgrabPackage, models: ["mindgrab", "mindmap"] })],
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  // Dev pre-bundling targets es2020; MindGrab's Emscripten glue uses top-level await and ORT loads its own WASM.
  optimizeDeps: { exclude: ["onnxruntime-web", "@brainchop/core"] },
});
