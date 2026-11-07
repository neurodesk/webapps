import { readFile } from "node:fs/promises";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// The MIT, MIT-CMU (Pillow), CC BY 4.0 and Apache-2.0 notices and the full Apache-2.0 text ship with the build.
function notices() {
  return {
    name: "microsam-notices",
    async generateBundle() {
      for (const fileName of ["LICENSE", "NOTICE", "LICENSE-APACHE-2.0"]) {
        this.emitFile({ type: "asset", fileName, source: await readFile(new URL(fileName, import.meta.url)) });
      }
    },
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: "microsam",
  plugins: [isolationFallback(), notices()],
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
