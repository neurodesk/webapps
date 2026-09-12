import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeReleaseVersion, standalonePackage } from './scripts/package-plugin.mjs';
import { isolationFallback } from '../../scripts/lib/isolation-fallback-plugin.mjs';

// Large weights stay outside dist. A local asset store can serve dev/preview.
function localModels() {
  const serve = (server) => { server.middlewares.use((req, res, next) => {
    const name = req.url?.split('?')[0]?.split('/').pop();
    if (!process.env.SYNTHSR_ASSET_DIR || !req.url?.includes('/model-assets/') ||
        !['synthsr-v2.onnx', 'example.nii.gz', 'validation.nii.gz', 'conv3d-probe.onnx', 'reference.json'].includes(name)) return next();
    const path = resolve(process.env.SYNTHSR_ASSET_DIR, name);
    if (!existsSync(path)) return next();
    res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
    res.setHeader('Content-Length', statSync(path).size);
    createReadStream(path).pipe(res);
  }); };
  return { name: 'synthsr-local-models', configureServer: serve, configurePreviewServer: serve };
}
export default neurodeskViteConfig({
  appId: 'synthsr', plugins: [localModels(), nativeReleaseVersion(), standalonePackage(), isolationFallback()],
  server: { host: '127.0.0.1', port: 5174 },
  preview: { host: '127.0.0.1', port: 5174 },
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
