import { readFile } from 'node:fs/promises';

// GitHub Pages cannot set COOP/COEP headers. Add a scoped service-worker fallback.
export function isolationFallback() {
  let base;
  let serviceWorkerPath;
  const source = () => readFile(new URL('../../packages/runtime-support/src/coi-serviceworker.js', import.meta.url), 'utf8');
  return {
    name: 'neurodesk-isolation-fallback',
    configResolved(config) {
      base = config.base;
      serviceWorkerPath = new URL(`${base}coi-serviceworker.js`, 'http://localhost').pathname;
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'coi-serviceworker.js', source: await source() });
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [{ tag: 'script', attrs: { src: `${base}coi-serviceworker.js` }, injectTo: 'head-prepend' }],
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== serviceWorkerPath) return next();
        try {
          response.setHeader('Content-Type', 'application/javascript');
          response.end(await source());
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
