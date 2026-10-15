import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';

// The 53 MB ONNX never enters dist. Point SYNTHSEG_ASSET_DIR at a local copy to
// serve it from dev/preview instead of Hugging Face.
function localModel() {
  const serve = (server) => {
    server.middlewares.use((req, res, next) => {
      const name = req.url?.split('?')[0]?.split('/').pop();
      if (!process.env.SYNTHSEG_ASSET_DIR || !req.url?.includes('/model-assets/') || name !== 'synthseg-2.0.onnx') return next();
      const path = resolve(process.env.SYNTHSEG_ASSET_DIR, name);
      if (!existsSync(path)) return next();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', statSync(path).size);
      createReadStream(path).pipe(res);
    });
  };
  return { name: 'synthseg-local-model', configureServer: serve, configurePreviewServer: serve };
}

export default neurodeskViteConfig({
  appId: 'synthseg',
  ...(process.env.SYNTHSEG_ASSET_DIR ? {
    define: {
      'import.meta.env.VITE_SYNTHSEG_ASSET_BASE': JSON.stringify(process.env.VITE_SYNTHSEG_ASSET_BASE || '/synthseg/model-assets/'),
    },
  } : {}),
  plugins: [localModel()],
  server: { host: '127.0.0.1', port: 5175 },
  preview: { host: '127.0.0.1', port: 5175 },
  build: { target: 'esnext' },
});
