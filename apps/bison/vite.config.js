import { createReadStream, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { neurodeskViteConfig } from "../../scripts/lib/vite-app-config.mjs";
import { isolationFallback } from "../../scripts/lib/isolation-fallback-plugin.mjs";

// The BISON model files are held until their authors allow publication, so the page has no URL
// for them. BISON_ASSET_DIR (a local copy laid out as the manifest's filenames) is served at
// <base>bison-assets/ by the dev and preview servers only; its files never enter dist. The build
// then names that URL in VITE_BISON_ASSET_BASE. Without it, Run refuses with a clear message.
const ASSET_DIR = process.env.BISON_ASSET_DIR ? resolve(process.env.BISON_ASSET_DIR) : null;

function heldAssets() {
  let prefix = "/bison-assets/";
  const serve = (server) => {
    if (!ASSET_DIR) return;
    server.middlewares.use((request, response, next) => {
      const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      if (!path.startsWith(prefix)) return next();
      const file = resolve(ASSET_DIR, path.slice(prefix.length));
      const inside = relative(ASSET_DIR, file);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) return next();
      let size;
      try {
        const stats = statSync(file);
        if (!stats.isFile()) return next();
        size = stats.size;
      } catch {
        return next();
      }
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader("Content-Length", size);
      createReadStream(file).pipe(response);
    });
  };
  return {
    name: "bison-held-assets",
    configResolved(config) {
      prefix = `${config.base}bison-assets/`;
    },
    configureServer: serve,
    configurePreviewServer: serve,
  };
}

export default neurodeskViteConfig({
  appId: "bison",
  ...(ASSET_DIR && !process.env.VITE_BISON_ASSET_BASE ? {
    define: { "import.meta.env.VITE_BISON_ASSET_BASE": JSON.stringify(`${process.env.WEBAPPS_BASE_PATH || "/bison/"}bison-assets/`) },
  } : {}),
  plugins: [isolationFallback(), heldAssets()],
  build: { target: "esnext", outDir: "dist", assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ["onnxruntime-web", "@niivue/niimath"] },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});
