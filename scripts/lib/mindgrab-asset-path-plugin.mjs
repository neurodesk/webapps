import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Apps that always pass `assetPath` to MindGrab load its model modules from their own staged copies.
// MindGrab's fallback imports name every model's module for every backend, so without this plugin
// Vite bundles all twelve (about 11 MB) a second time. Use it in the bundle that imports MindGrab.
export function mindgrabFromAssetPath() {
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

// MindGrab's module suffix for each backend it can run.
const BACKEND_SUFFIX = { webgpu: '-gpu', webgl2: '-gl', cpu: '' };

// Serves and emits the named models' MindGrab modules (WebGPU, WebGL2 and threaded CPU builds)
// under `directory`/, for an app that passes assetPath = BASE_URL + `directory`/ to the shared
// runtime (@neurodesk/runtime-support/mindgrab), which runs MindGrab inside its own worker.
// `packageJson` is the path of the @brainchop/mindgrab package.json the app pins. An app that
// always requests one backend (`backend: 'cpu'`) stages only that backend's modules.
export function mindgrabAssets({ packageJson, models, directory = 'mindgrab', backends = ['webgpu', 'webgl2', 'cpu'] }) {
  const root = dirname(packageJson);
  const suffixes = backends.map((backend) => {
    if (!(backend in BACKEND_SUFFIX)) throw new Error(`Unknown MindGrab backend ${backend}`);
    return BACKEND_SUFFIX[backend];
  });
  const modules = models.flatMap((model) => suffixes.flatMap((suffix) => ['js', 'wasm'].map((ext) => `brainchop-${model}${suffix}.${ext}`)));
  const files = new Map([
    ...modules.map((name) => [`${directory}/${name}`, join(root, 'dist', name)]),
    [`${directory}/LICENSE`, join(root, 'LICENSE')],
  ]);
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
          response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
          response.end(await readFile(path));
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
