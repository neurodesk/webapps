import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

export async function serveSite(dist, { isolationHeaders = true, port = 0 } = {}) {
  const mimeTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
  ]);

  function resolveRequest(pathname) {
    const decoded = decodeURIComponent(pathname);
    const relative = normalize(decoded).replace(/^[/\\]+/, '');
    if (relative.startsWith('..')) return null;
    return join(dist, relative);
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/qsm-nav.js') {
        // QSMbly deliberately selects a local ecosystem-bar script on localhost.
        // Production uses qsmxt.github.io; this fixture keeps the composite smoke
        // focused on the deployed subpath without requiring that external script.
        const body = '/* QSM ecosystem navigation smoke fixture */';
        response.writeHead(200, {
          'content-length': Buffer.byteLength(body),
          'content-type': 'text/javascript; charset=utf-8',
        }).end(body);
        return;
      }
      let path = resolveRequest(url.pathname);
      if (!path) {
        response.writeHead(400).end('Bad request');
        return;
      }

      let metadata;
      try {
        metadata = await stat(path);
      } catch {
        response.writeHead(404).end('Not found');
        return;
      }

      if (metadata.isDirectory()) {
        if (!url.pathname.endsWith('/')) {
          response.writeHead(308, { location: `${url.pathname}/${url.search}` }).end();
          return;
        }
        path = join(path, 'index.html');
        metadata = await stat(path);
      }

      response.writeHead(200, {
        'content-length': metadata.size,
        'content-type': mimeTypes.get(extname(path)) ?? 'application/octet-stream',
        ...(isolationHeaders ? {
          'cross-origin-embedder-policy': 'credentialless',
          'cross-origin-opener-policy': 'same-origin',
        } : {}),
        'x-content-type-options': 'nosniff',
      });
      if (request.method === 'HEAD') response.end();
      else createReadStream(path).pipe(response);
    } catch (error) {
      response.writeHead(500).end(error.message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  return { origin, close: () => new Promise(resolve => server.close(resolve)) };
}
