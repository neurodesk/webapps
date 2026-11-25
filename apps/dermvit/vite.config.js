import { readFile } from "node:fs/promises";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// Ship the MIT, Apache-2.0 and model quantization/attribution notices with the built app.
function notices() {
  return {
    name: "dermvit-notices",
    async generateBundle() {
      for (const fileName of ["LICENSE", "NOTICE", "LICENSE-APACHE-2.0"]) {
        this.emitFile({ type: "asset", fileName, source: await readFile(new URL(fileName, import.meta.url)) });
      }
    },
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "dermvit",
  plugins: [isolationFallback(), notices()],
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
