import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "brain2print",
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  // MindGrab loads its modules from the staged public/brainchop/<version>/ (assetPath);
  // its fallback imports of the same files would otherwise be bundled a second time.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  optimizeDeps: {
    exclude: ["@niivue/dcm2niix", "@niivue/niimath", "@brainchop/core"],
  },
});
