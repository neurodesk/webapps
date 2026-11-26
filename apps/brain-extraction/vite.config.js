import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';
import { isolationFallback } from '../../scripts/lib/isolation-fallback-plugin.mjs';
import { mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs';

// Resolve MindGrab through the package that pins it, not the app's own install.
const require = createRequire(import.meta.resolve('@neurodesk/brain-extraction/mindgrab'));
const mindgrabRoot = dirname(require.resolve('@brainchop/core/package.json'));
const betRoot = new URL('../../packages/brain-extraction/wasm/', import.meta.url);
const assets = new Map([
  ...['LICENSE', 'bet.wasm'].map(name => [`bet/${name}`, new URL(name, betRoot)]),
  ...['models/mindgrab.bin', 'brainchop-mindgrab-gl.js', 'brainchop-mindgrab-gl.wasm', 'brainchop-mindgrab.js', 'brainchop-mindgrab.wasm']
    .map(name => [`mindgrab/${name}`, join(mindgrabRoot, 'dist', name)]),
  ['mindgrab/LICENSE', join(mindgrabRoot, 'LICENSE')],
]);
function extractionAssets() {
  let base;
  return {
    name: 'brain-extraction-assets',
    configResolved(config) { base = config.base; },
    async generateBundle() {
      for (const [fileName, path] of assets) this.emitFile({ type: 'asset', fileName, source: await readFile(path) });
    },
    async configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0];
        const key = pathname?.startsWith(base) ? pathname.slice(base.length) : '';
        const path = assets.get(key);
        if (!path) return next();
        try {
          response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm' : key.endsWith('.bin') ? 'application/octet-stream' : 'text/javascript');
          response.end(await readFile(path));
        } catch (error) { next(error); }
      });
    },
  };
}
export default neurodeskViteConfig({
  appId: 'brain-extraction',
  plugins: [extractionAssets(), isolationFallback()],
  // The worker always passes assetPath, so MindGrab loads its modules from the mindgrab/ copies above.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  build: { target: 'esnext', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['onnxruntime-web', '@brainchop/core'] },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
