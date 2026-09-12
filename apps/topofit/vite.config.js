import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';

function localModels() {
  const serve = (server) => {
    server.middlewares.use((request, response, next) => {
      const name = request.url?.split('?')[0]?.split('/').pop();
      if (!process.env.TOPOFIT_ASSET_DIR || !request.url?.includes('/model-assets/') || !name) return next();
      const path = resolve(process.env.TOPOFIT_ASSET_DIR, name);
      if (!existsSync(path) || !statSync(path).isFile()) return next();
      response.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      response.setHeader('Content-Length', statSync(path).size);
      createReadStream(path).pipe(response);
    });
  };
  return {
    name: 'topofit-local-models',
    configureServer: serve,
    configurePreviewServer: serve,
  };
}

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
export default neurodeskViteConfig({
  appId: 'topofit',
  plugins: [localModels()],
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
});
