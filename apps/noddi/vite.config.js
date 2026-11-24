import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { mindgrabAssets, mindgrabFromAssetPath } from "../../scripts/lib/mindgrab-asset-path-plugin.mjs";

// Resolve MindGrab and niimath through the packages that pin them, as deface does.
const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(require.resolve("@neurodesk/runtime-support/mindgrab"));
const mindgrabPackage = runtimeRequire.resolve("@brainchop/core/package.json");
const dwi2trxRequire = createRequire(require.resolve("@neurodesk/dwi2trx/niimath-version"));
const niimathLicensePath = join(dirname(dwi2trxRequire.resolve("@niivue/niimath/package.json")), "LICENSE");

function niimathLicense() {
  return {
    name: "niimath-license",
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "niimath/LICENSE", source: await readFile(niimathLicensePath) });
    },
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "noddi",
  plugins: [mindgrabAssets({ packageJson: mindgrabPackage, models: ["mindgrab"] }), niimathLicense()],
  // The MindGrab worker always passes assetPath, so its modules load from the mindgrab/ copies.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  // Both load WASM through module URLs, which Vite's development prebundler cannot process.
  optimizeDeps: { exclude: ["@brainchop/core", "@niivue/niimath"] },
});
