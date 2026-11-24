import { readFile } from "node:fs/promises";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

function notices() {
  return {
    name: "medsam2-notices",
    async generateBundle() {
      for (const fileName of ["LICENSE", "NOTICE"]) {
        this.emitFile({ type: "asset", fileName, source: await readFile(new URL(fileName, import.meta.url)) });
      }
    },
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "medsam2",
  plugins: [isolationFallback(), notices()],
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["onnxruntime-web", "@niivue/dcm2niix"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
