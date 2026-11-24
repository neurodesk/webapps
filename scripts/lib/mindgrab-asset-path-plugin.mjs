import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Apps that always pass `assetPath` to MindGrab load its model modules from their own staged copies.
// MindGrab's fallback imports name every model's module for every backend, so without this plugin
// Vite bundles all of them (and @brainchop/core's models/*.bin and worker.js) a second time. Use it
// in the bundle that imports MindGrab.
export function mindgrabFromAssetPath() {
  const prefix = '\0mindgrab-from-asset-path:';
  const unbundled = (specifier) => `(() => { throw new Error(${JSON.stringify(`${specifier} is not bundled; pass assetPath to MindGrab.`)}); })()`;
  return {
    name: 'mindgrab-from-asset-path',
    enforce: 'pre',
    resolveId(source, importer) {
      const fromBrainchop = importer?.includes('@brainchop/mindgrab') || importer?.includes('@brainchop/core');
      if (!fromBrainchop || !/^\.\/brainchop-[\w-]+\.js$/.test(source)) return null;
      return prefix + source;
    },
    load(id) {
      if (!id.startsWith(prefix)) return null;
      return `throw new Error(${JSON.stringify(`${id.slice(prefix.length)} is not bundled; pass assetPath to MindGrab.`)});`;
    },
    transform(code, id) {
      if (!id.includes('@brainchop/core')) return null;
      const rewritten = code.replace(
        /new URL\((["'])(\.\/(?:models\/[\w-]+\.bin|worker(?:-[\w-]+)?\.js))\1\s*,\s*import\.meta\.url\)/g,
        (_match, _quote, specifier) => unbundled(specifier),
      );
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}

// MindGrab's module suffix for each backend it can run (legacy @brainchop/mindgrab).
const LEGACY_BACKEND_SUFFIX = { webgpu: '-gpu', webgl2: '-gl', cpu: '' };
const CANONICAL_MODEL = { '16chan18cls': 'mindmap-fast' };

// Serves and emits the named models' MindGrab modules (WebGPU, WebGL2 and threaded CPU builds)
// under `directory`/, for an app that passes assetPath = BASE_URL + `directory`/ to the shared
// runtime (@neurodesk/runtime-support/mindgrab), which runs MindGrab inside its own worker.
// `packageJson` is the path of the @brainchop/core or @brainchop/mindgrab package.json the app pins.
// An app that always requests one backend (`backend: 'cpu'`) stages only that backend's modules.
export function mindgrabAssets({ packageJson, models, directory = 'mindgrab', backends = ['webgpu', 'webgl2', 'cpu'] }) {
  const root = dirname(packageJson);
  const pkg = JSON.parse(readFileSync(packageJson, 'utf8'));
  const isCore = pkg.name === '@brainchop/core';
  const assets = [];
  for (const backend of backends) {
    if (!(backend in LEGACY_BACKEND_SUFFIX)) throw new Error(`Unknown MindGrab backend ${backend}`);
  }
  for (const model of models) {
    const canonical = isCore ? (CANONICAL_MODEL[model] ?? model) : model;
    for (const backend of backends) {
      if (isCore && backend === 'webgpu') {
        assets.push(`models/${canonical}.bin`);
      } else {
        const suffix = LEGACY_BACKEND_SUFFIX[backend];
        assets.push(`brainchop-${canonical}${suffix}.js`, `brainchop-${canonical}${suffix}.wasm`);
      }
    }
  }
  const files = new Map([
    ...assets.map((name) => [`${directory}/${name}`, join(root, 'dist', name)]),
    [`${directory}/LICENSE`, join(root, 'LICENSE')],
  ]);
  const contentType = (path) => (
    path.endsWith('.wasm') ? 'application/wasm'
      : path.endsWith('.bin') ? 'application/octet-stream'
        : 'text/javascript'
  );
  let base = '/';
  return {
    name: 'mindgrab-assets',
    configResolved(config) {
      base = config.base;
    },
    async generateBundle() {
      for (const [fileName, path] of files) this.emitFile({ type: 'asset', fileName, source: await readFile(path) });
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split('?')[0] ?? '';
        const path = pathname.startsWith(base) ? files.get(pathname.slice(base.length)) : undefined;
        if (!path) return next();
        try {
          response.setHeader('Content-Type', contentType(path));
          response.end(await readFile(path));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
