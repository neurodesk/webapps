// Per-app static build. Fully static ./dist, no backend.
// Large ONNX/WASM assets are NOT bundled — they live in public/ or are fetched from
// the model host named in models/<app>.manifest.json.
import { defineConfig } from "vite";

export default defineConfig({
  // Every app is served below the composite webapps.neurodesk.org site.
  base: "/APP_NAME/",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  worker: { format: "es" },
  // Dev-server COOP/COEP ONLY. Production isolation comes from public/_headers or the COI SW.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
