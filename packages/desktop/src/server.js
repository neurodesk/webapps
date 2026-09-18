import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { extname, join, relative, isAbsolute, sep } from 'node:path';
import { bundlePath } from './bundle.js';

export const mimeType = path => ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain',
}[extname(path)] || 'application/octet-stream');

export async function startOfflineServer(root, { port = 0, resolveFile } = {}) {
  const mounts = new Map();
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      let path;
      if (pathname.startsWith('/_local/')) {
        const [, , token, ...parts] = pathname.split('/');
        const directory = mounts.get(token);
        if (!directory) throw new Error('Directory has not been granted');
        path = await realpath(bundlePath(directory, parts.join('/')));
        const child = relative(directory, path);
        if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Path escapes selected directory');
      } else {
        const file = `site/${pathname.replace(/^\/+/, '')}${pathname.endsWith('/') ? 'index.html' : ''}`;
        path = resolveFile ? await resolveFile(file) : bundlePath(root, file);
      }
      const details = await stat(path);
      if (!details.isFile()) throw new Error('Not a file');
      const headers = {
        'Content-Type': mimeType(path),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      };
      if (path.endsWith('.html')) {
        const html = (await readFile(path, 'utf8')).replace(/<html\b/, '<html data-neurodesk-offline');
        response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : html);
      } else {
        headers['Content-Length'] = details.size;
        response.writeHead(200, headers);
        if (request.method === 'HEAD') response.end();
        else createReadStream(path).on('error', () => response.destroy()).pipe(response);
      }
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('File not included in this offline installation.');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    origin,
    async mountDirectory(path) {
      const directory = await realpath(path);
      if (!(await stat(directory)).isDirectory()) throw new Error('Choose a directory');
      const token = randomUUID();
      mounts.set(token, directory);
      return `${origin}/_local/${token}`;
    },
  };
}
