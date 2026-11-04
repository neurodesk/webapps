import { errorMonitor } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute, sep } from 'node:path';
import { bundlePath } from './bundle.js';

export const mimeType = path => ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain',
}[extname(path)] || 'application/octet-stream');

/**
 * Serves the offline bundle, and the files and directories mounted through it, on its own loopback origin. The desktop
 * starts one per viewer window, so a viewer's mounts are reachable only at that viewer's address.
 */
export async function startOfflineServer(root, { port = 0, resolveFile } = {}) {
  const diagnostic = process.env.NEURODESK_SMOKE_DIAGNOSTICS === '1';
  const log = (event, fields = {}) => {
    if (diagnostic) console.error(JSON.stringify({ time: new Date().toISOString(), diagnostic: 'offline-server', event, ...fields }));
  };
  const mounts = new Map();
  const server = createServer(async (request, response) => {
    const shell = /^\/[^/?]+\/app-shell\.js(?:\?|$)/.test(request.url);
    const record = (event, fields) => { if (shell) log(event, fields); };
    record('request');
    response.on('finish', () => record('response-finish', { status: response.statusCode }));
    response.on('close', () => record('response-close', { finished: response.writableFinished, destroyed: request.socket.destroyed }));
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
        const { directory, file } = mounts.get(token) ?? {};
        if (file) {
          // A single granted file is served under its own name and nothing else.
          if (parts.join('/') !== basename(file) || await realpath(file) !== file) throw new Error('File has not been granted');
          path = file;
        } else {
          if (!directory) throw new Error('Directory has not been granted');
          path = await realpath(bundlePath(directory, parts.join('/')));
          const child = relative(directory, path);
          if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Path escapes selected directory');
        }
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
        else createReadStream(path).on('error', error => { record('stream-error', { code: error.code }); response.destroy(); }).pipe(response);
      }
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('File not included in this offline installation.');
    }
  });
  if (diagnostic) {
    server.on('listening', () => log('listening'));
    server.on('close', () => log('close'));
    const emit = server.emit;
    server.emit = function (event, ...args) {
      if (event === 'clientError') log('clientError', { code: args[0]?.code });
      return emit.call(this, event, ...args);
    };
    // errorMonitor observes without consuming unhandled errors or changing clientError defaults.
    server.on(errorMonitor, error => log('error', { code: error.code }));
    server.on('connection', socket => {
      socket.on('close', hadError => log('socket-close', { hadError }));
      socket.on(errorMonitor, error => log('socket-error', { code: error.code }));
    });
  }
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
      mounts.set(token, { directory });
      return `${origin}/_local/${token}`;
    },
    async mountFile(path) {
      const file = await realpath(path);
      if (!(await stat(file)).isFile()) throw new Error('Choose a file');
      const token = randomUUID();
      mounts.set(token, { file });
      return `${origin}/_local/${token}/${encodeURIComponent(basename(file))}`;
    },
    /** Whether `url` is this server's to answer, as part of the bundle or as a mount granted through this server. */
    owns(value) {
      const url = new URL(value);
      if (url.origin !== origin) return false;
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
      return !pathname.startsWith('/_local/') || mounts.has(pathname.split('/')[2]);
    },
    /** Stops answering, which ends every mount granted through this server. */
    close() {
      mounts.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** Origins of user-named compute servers; only absolute http(s) origins count. */
export function parseComputeOrigins(value) {
  const origins = new Set();
  for (const entry of String(value || '').split(',')) {
    const text = entry.trim();
    if (!text) continue;
    let url;
    try { url = new URL(text); } catch { throw new Error(`NEURODESK_COMPUTE_ORIGINS entry is not a URL: ${text}`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`NEURODESK_COMPUTE_ORIGINS entry must be http or https: ${text}`);
    origins.add(url.origin);
  }
  return origins;
}
