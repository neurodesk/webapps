import { readFile, access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';
import { isolationFallback } from '../../scripts/lib/isolation-fallback-plugin.mjs';

const require = createRequire(new URL('../../packages/brain-extraction/package.json', import.meta.url));
const mindgrabRoot = dirname(require.resolve('@brainchop/mindgrab/package.json'));
const qsmRoot = new URL('../qsmbly/', import.meta.url);
const assets = new Map([
  ['bet/LICENSE', new URL('LICENSE', qsmRoot)],
  ...['qsm_wasm.js', 'qsm_wasm_bg.wasm'].map(name => [`bet/${name}`, new URL(`wasm/${name}`, qsmRoot)]),
  ...['brainchop-mindgrab-gpu.js', 'brainchop-mindgrab-gpu.wasm', 'brainchop-mindgrab-gl.js', 'brainchop-mindgrab-gl.wasm', 'brainchop-mindgrab.js', 'brainchop-mindgrab.wasm']
    .map(name => [`mindgrab/${name}`, join(mindgrabRoot, 'dist', name)]),
  ['mindgrab/LICENSE', join(mindgrabRoot, 'LICENSE')],
]);
async function ensureBet() {
  try {
    await Promise.all(['qsm_wasm.js', 'qsm_wasm_bg.wasm'].map(name => access(new URL(`wasm/${name}`, qsmRoot))));
  } catch {
    execFileSync('bash', ['build.sh'], { cwd: qsmRoot, stdio: 'inherit' });
  }
  const snippets = new URL('wasm/snippets/', qsmRoot);
  try {
    for (const name of await readdir(snippets, { recursive: true })) {
      if (name.endsWith('.js')) assets.set(`bet/snippets/${name}`, new URL(name, snippets));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function extractionAssets() {
  let base;
  return {
    name: 'brain-extraction-assets',
    configResolved(config) { base = config.base; },
    buildStart: ensureBet,
    async generateBundle() {
      for (const [fileName, path] of assets) this.emitFile({ type: 'asset', fileName, source: await readFile(path) });
    },
    async configureServer(server) {
      await ensureBet();
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0];
        const key = pathname?.startsWith(base) ? pathname.slice(base.length) : '';
        const path = assets.get(key);
        if (!path) return next();
        try {
          response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          response.end(await readFile(path));
        } catch (error) { next(error); }
      });
    },
  };
}
// The worker always passes assetPath, so MindGrab loads its modules from the mindgrab/ copies above.
// Its fallback imports name every model's module for every backend and would bundle all twelve.
function mindgrabFromAssetPath() {
  const prefix = '\0mindgrab-from-asset-path:';
  return {
    name: 'mindgrab-from-asset-path',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.includes('@brainchop/mindgrab') || !/^\.\/brainchop-[\w-]+\.js$/.test(source)) return null;
      return prefix + source;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `throw new Error(${JSON.stringify(`${id.slice(prefix.length)} is not bundled; pass assetPath to MindGrab.`)});`;
    },
  };
}
export default neurodeskViteConfig({
  appId: 'brain-extraction',
  plugins: [extractionAssets(), isolationFallback()],
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  build: { target: 'esnext', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['onnxruntime-web', '@brainchop/mindgrab'] },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
