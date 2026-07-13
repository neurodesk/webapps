import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const requestedPort = Number(process.argv[2] || process.env.PORT || 8080);
const host = process.env.HOST || '127.0.0.1';

listen(requestedPort);

function listen(port) {
  const server = createShowcaseServer(port);
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && port < requestedPort + 20) {
      listen(port + 1);
      return;
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`Neurodesk webapp components showcase: http://${host}:${port}/`);
  });
}

function createShowcaseServer(port) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);
      const filePath = await resolveRequestPath(url.pathname);
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cache-Control': 'no-store'
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp'
      });
      response.end(error.code === 'ENOENT' ? 'Not found' : error.message);
    }
  });
}

async function resolveRequestPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(root, normalize(relative));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    const error = new Error('Forbidden');
    error.code = 'EACCES';
    throw error;
  }
  const stats = await stat(candidate);
  return stats.isDirectory() ? join(candidate, 'index.html') : candidate;
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.md': return 'text/markdown; charset=utf-8';
    case '.wasm': return 'application/wasm';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}
