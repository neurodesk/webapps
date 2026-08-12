// Per-app static build. Fully static ./dist, no backend.
// Large ONNX/WASM assets are NOT bundled — they live in public/ or are fetched from
// the model host named in models/<app>.manifest.json.
import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";

const appThemeUrl = new URL("../../site/app-theme.css", import.meta.url);

function neurodeskDevTheme() {
  return {
    name: "neurodesk-dev-theme",
    apply: "serve",
    async transformIndexHtml(html) {
      const theme = await readFile(appThemeUrl, "utf8");
      return {
        html: html.replace(
          /<html\b/i,
          '<html data-neurodesk-app="zarro" data-neurodesk-theme="dark"',
        ),
        tags: [{
          tag: "style",
          attrs: { "data-neurodesk-app-theme": "" },
          children: theme,
          injectTo: "head",
        }],
      };
    },
  };
}

const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Every app is served below the composite webapps.neurodesk.org site.
  base: "/zarro/",
  // Production gets this palette from theme-app-dist.mjs. Inject the same
  // shared tokens in Vite so the live-development entrypoint is not blue.
  plugins: [neurodeskDevTheme()],
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  worker: { format: "es" },
  // Dev-server COOP/COEP ONLY. Production isolation comes from public/_headers or the COI SW.
  server: {
    headers: isolationHeaders,
  },
  preview: { headers: isolationHeaders },
});
