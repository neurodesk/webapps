// Per-app static build. Fully static ./dist, no backend.
// Large ONNX/WASM assets are NOT bundled — they live in public/ or are fetched from
// the model host named in models/<app>.manifest.json.
import { defineConfig } from "vite";

export default defineConfig({
  // Every app is served below the composite webapps.neurodesk.org site. The
  // stamped app name is the dev-time default; deploy tooling can override it
  // with the registry path.
  base: "./",
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  worker: { format: "es" },
  // Dev/preview COOP/COEP ONLY. Production isolation comes from the emitted
  // _headers or the COI SW. `credentialless` matches the composite site policy
  // (see scripts/lib/vite-app-config.mjs).
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
