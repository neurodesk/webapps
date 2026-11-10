import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

export default neurodeskViteConfig({
  appId: "gliomoda",
  plugins: [isolationFallback()],
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
