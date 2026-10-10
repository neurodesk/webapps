#!/usr/bin/env node
// Shared local dev server for the static, no-bundler apps. Serves one directory
// with the cross-origin isolation headers SharedArrayBuffer needs, ignores
// conditional request headers so a stale 304 can never bypass fresh cache
// headers, and keeps a per-port PID file so a replacement server stops the
// previous one first (spinalcordtoolbox's test:server pins that takeover
// contract). Node handles concurrent connections natively, so one idle
// browser/devtools socket cannot block other requests.
//
// Run via each app's `dev` script or the `web/run.sh` wrappers:
//   node ../../scripts/dev-server.mjs --dir web [--port 8080]
//     [--cache-policy 'no-store'|'none'] [--staging-route /prefix/] [--build-info]
//
// --cache-policy is sent as the Cache-Control value (with Pragma/Expires for
//   legacy caches); pass `none` to send no cache headers at all.
// --staging-route enables the POST/GET staged-download route CALMaR uses for
//   in-app-browser mask downloads (see apps/calmar/AGENTS.md).
// --build-info writes <dir>/build-info.json from git on startup so the app can
//   show the current commit in its version badge.
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const root = resolve(flagValue('--dir', '.'));
const port = Number.parseInt(flagValue('--port', '8080'), 10);
const cachePolicy = flagValue('--cache-policy', 'no-store');
const stagingRoute = flagValue('--staging-route', '');
const buildInfo = args.includes('--build-info');
if (!Number.isInteger(port) || port <= 0) {
  console.error(`Invalid --port ${flagValue('--port', '8080')}`);
  process.exit(1);
}

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

const pidFile = join(root, `.dev-server-${port}.pid`);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopExistingServer() {
  let recorded;
  try {
    recorded = await readFile(pidFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const pid = Number.parseInt(recorded.trim(), 10);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
    console.log(`Stopping existing dev server on port ${port} (pid ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) await sleep(100);
    if (processAlive(pid)) {
      console.log(`Existing dev server did not stop cleanly; forcing shutdown (pid ${pid})`);
      try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
  await rm(pidFile, { force: true });
}

async function writeBuildInfo() {
  const repo = dirname(root);
  const git = (...gitArgs) => execFileSync('git', ['-C', repo, ...gitArgs], { encoding: 'utf8' }).trim();
  try {
    const sha = git('rev-parse', '--short', 'HEAD');
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    let dirty = true;
    try {
      git('diff-index', '--quiet', 'HEAD', '--');
      dirty = false;
    } catch (error) {
      if (error.status !== 1) throw error;
      // git diff-index exits 1 for an ordinary dirty working tree.
    }
    const payload = { sha, branch, dirty, buildEnv: 'local' };
    await writeFile(join(root, 'build-info.json'), `${JSON.stringify(payload, null, 2)}\n`);
  } catch (error) {
    // Local build metadata is optional; the app can use its packaged version string.
    console.warn('Unable to write local build metadata:', error.message);
  }
}

function applySharedHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  if (cachePolicy !== 'none') {
    res.setHeader('Cache-Control', cachePolicy);
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}

function sendError(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// Staged-download route: POST bodies are kept in memory (and optionally saved
// to a local downloads directory) so the browser can fetch them back as
// same-origin attachments. Mirrors the CALMaR web/run.sh contract.
const STAGED_TTL_MS = 600_000;
const MAX_STAGED_BYTES = 256 * 1024 * 1024;
const staged = new Map();

function pruneStaged() {
  const now = Date.now();
  for (const [key, item] of staged) {
    if (item.expires < now) staged.delete(key);
  }
}

function stagedFilename(pathname) {
  let name = '';
  try {
    name = decodeURIComponent(pathname.replace(/\/+$/, '').split('/').pop() ?? '');
  } catch {
    // Malformed URL escapes receive the safe download.bin name below.
  }
  if (!name) name = 'download.bin';
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function downloadDirectory() {
  const home = join(homedir(), 'Downloads');
  try {
    if ((await stat(home)).isDirectory()) return home;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const local = join(root, 'downloads');
  await mkdir(local, { recursive: true });
  return local;
}

function readBody(req, limit) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', rejectPromise);
  });
}

async function handleStagingPost(req, res, pathname) {
  let data;
  try {
    data = await readBody(req, MAX_STAGED_BYTES);
  } catch (error) {
    if (error.code === 'TOO_LARGE') return sendError(res, 413, 'Download payload too large');
    throw error;
  }
  if (!data.length) return sendError(res, 400, 'Empty download payload');

  const filename = stagedFilename(pathname);
  pruneStaged();
  staged.set(pathname, { data, filename, expires: Date.now() + STAGED_TTL_MS });

  const stageOnly = req.headers['x-lnm-stage-only'] === '1';
  let savedPath;
  if (!stageOnly) {
    const directory = await downloadDirectory();
    savedPath = join(directory, filename);
    const temporary = `${savedPath}.tmp-${process.pid}`;
    await writeFile(temporary, data);
    await rename(temporary, savedPath);
  }
  const payload = JSON.stringify({
    url: pathname,
    saved: !stageOnly,
    ...(savedPath ? { savedPath } : {}),
    byteLength: data.length,
  });
  res.writeHead(201, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function handleStagingGet(res, pathname) {
  pruneStaged();
  const item = staged.get(pathname);
  if (!item) return sendError(res, 404, 'Download expired');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${item.filename}"`,
    'Content-Length': item.data.length,
  });
  res.end(item.data);
}

async function serveStatic(req, res, pathname) {
  let path = normalize(join(root, pathname));
  if (path !== root && !path.startsWith(root + sep)) return sendError(res, 403, 'Forbidden');
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    return sendError(res, 404, 'Not found');
  }
  if (metadata.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${pathname}/` });
      res.end();
      return;
    }
    path = join(path, 'index.html');
    try {
      metadata = await stat(path);
    } catch {
      return sendError(res, 404, 'Not found');
    }
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES.get(extname(path).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': metadata.size,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(path).pipe(res);
}

async function handleRequest(req, res) {
  applySharedHeaders(res);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  } catch {
    return sendError(res, 400, 'Bad request');
  }
  if (stagingRoute && pathname.startsWith(stagingRoute)) {
    if (req.method === 'POST') return handleStagingPost(req, res, pathname);
    if (req.method === 'GET') return handleStagingGet(res, pathname);
    return sendError(res, 405, 'Method not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed');
  return serveStatic(req, res, pathname);
}

await stopExistingServer();
if (buildInfo) await writeBuildInfo();

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendError(res, 500, 'Internal server error');
    else res.destroy();
  });
});

server.on('error', (error) => {
  console.error(`Dev server failed to listen on port ${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, async () => {
  await writeFile(pidFile, `${process.pid}\n`);
  console.log('=== Development Server ===');
  console.log(`Serving ${root}`);
  console.log(`Serving at: http://localhost:${port}`);
  console.log('Press Ctrl+C to stop');
});

// The PID file is deliberately left behind on shutdown: callers (e.g. the sct
// restart test's cleanup trap) read it right after killing the server, and
// deleting it here races that read. Stale files are harmless — the next
// startup's takeover checks liveness and removes them.
function shutdown() {
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
