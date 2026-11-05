import { readFileSync } from "node:fs";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";

// The Big-FISH BSD-3-Clause licence and the fdlibm notice travel with the built app.
const legalFiles = {
  name: "spot-detection-legal-files",
  generateBundle() {
    for (const fileName of ["LICENSE", "NOTICE"]) {
      this.emitFile({ type: "asset", fileName, source: readFileSync(new URL(fileName, import.meta.url), "utf8") });
    }
  },
};

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "spot-detection",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  plugins: [legalFiles],
});
