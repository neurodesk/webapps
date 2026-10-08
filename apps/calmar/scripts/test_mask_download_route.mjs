#!/usr/bin/env node --no-warnings
// The staged mask-download route, executed end to end.
//
// Mask downloads avoid blob URLs: the app stages the NIfTI bytes under
// /__lnm_downloads/ and then triggers a normal same-origin attachment
// download. Two hosts serve that route:
//   1. localhost: the dev server started by `bash web/run.sh`;
//   2. static hosting: the generated COI service worker, from Cache Storage.
// This test runs the real app methods against the real server and the real
// generated service worker, so the route, header and cache names the three
// sides share are exercised rather than text-matched.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The server's direct-save mode writes into ~/Downloads. The app must never
// use it, but if a regression made it do so, the file lands in this
// throwaway home directory instead of the developer's.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'calmar-download-home-'));
fs.mkdirSync(path.join(sandboxHome, 'Downloads'));

function startDevServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(ROOT, 'web/run.sh'), String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome }
    });
    let output = '';
    const onData = chunk => {
      output += chunk;
      if (output.includes(`Serving at: http://localhost:${port}`)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', code => reject(new Error(`dev server exited early (${code}): ${output}`)));
    setTimeout(() => reject(new Error(`dev server did not start: ${output}`)), 20000).unref();
  });
}

// ---- the app, on a jsdom copy of the real page ----
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8'), { url: 'http://localhost/' });
for (const name of ['window', 'document', 'HTMLElement', 'customElements', 'Event', 'Node', 'MutationObserver']) {
  globalThis[name] = dom.window[name];
}
globalThis.niivue = {
  SHOW_RENDER: { NEVER: 0, AUTO: 2 },
  Niivue: class {}
};
globalThis.Worker = class {
  postMessage() {}
  terminate() {}
};
const { LesionNetworkMappingApp } = await import(path.join(ROOT, 'web/js/lnm-app.js'));
const app = new LesionNetworkMappingApp();
const messages = [];
app.updateOutput = message => messages.push(message);

const maskBytes = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 251);

// ---- 1. localhost: the dev server stages and serves the download ----
const port = await freePort();
const server = await startDevServer(port);
try {
  globalThis.location = { href: `http://localhost:${port}/` };
  const staged = await app.createServerDownload(maskBytes, 'lesion mask (edited).nii');
  assert.deepEqual(messages, [], 'the local route is available');
  assert.deepEqual(
    fs.readdirSync(path.join(sandboxHome, 'Downloads')),
    [],
    'the app only stages the download; the server writes nothing into ~/Downloads'
  );
  assert.match(
    staged.url,
    new RegExp(`^http://localhost:${port}/__lnm_downloads/[^/]+/lesion_mask_edited_\\.nii$`),
    'the staged URL is same-origin, under the download route, with a filesystem-safe name'
  );

  const response = await fetch(staged.url);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="lesion_mask_edited_.nii"',
    'served as an attachment so the browser saves it'
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), maskBytes, 'the saved file is the staged mask, byte for byte');

  // Staging only: nothing is written into ~/Downloads by the server.
  const direct = await fetch(`http://localhost:${port}/__lnm_downloads/t/x.nii`, {
    method: 'POST',
    headers: { 'X-LNM-Stage-Only': '1' },
    body: maskBytes
  });
  assert.equal(direct.status, 201);
  assert.deepEqual(await direct.json(), { url: '/__lnm_downloads/t/x.nii', saved: false, byteLength: 4096 });

  assert.equal((await fetch(`http://localhost:${port}/__lnm_downloads/none/missing.nii`)).status, 404, 'unknown downloads are 404');
  const empty = await fetch(`http://localhost:${port}/__lnm_downloads/t/empty.nii`, {
    method: 'POST',
    headers: { 'X-LNM-Stage-Only': '1' },
    body: new Uint8Array(0)
  });
  assert.equal(empty.status, 400, 'an empty payload is refused instead of producing a zero-byte file');

  // The dev server also serves the app with cross-origin isolation.
  const page = await fetch(`http://localhost:${port}/index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
} finally {
  server.removeAllListeners('exit');
  server.kill('SIGTERM');
  fs.rmSync(path.join(ROOT, 'web', `.dev-server-${port}.pid`), { force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
}

// A remote host has no local route; the app does not even try.
globalThis.location = { href: 'https://neurodesk.org/webapps/calmar/' };
assert.equal(await app.createServerDownload(maskBytes, 'mask.nii'), null);

// ---- 2. static hosting: Cache Storage + the generated service worker ----
const workerPath = path.join(ROOT, 'web/coi-serviceworker.js');
assert.ok(fs.existsSync(workerPath), 'web/coi-serviceworker.js is generated by `pnpm runtime-support` (the pretest step)');

class FakeCache {
  constructor() {
    this.entries = new Map();
  }
  async put(url, response) {
    this.entries.set(String(url), response);
  }
  async match(url) {
    return this.entries.get(String(url));
  }
  async delete(url) {
    return this.entries.delete(String(url));
  }
}
const cacheStorage = {
  buckets: new Map(),
  async open(name) {
    if (!this.buckets.has(name)) this.buckets.set(name, new FakeCache());
    return this.buckets.get(name);
  }
};

// Service-worker global scope: no `window`, real Response/Headers/Request.
const listeners = {};
const networkRequests = [];
const workerScope = {
  self: {
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    }
  },
  caches: cacheStorage,
  fetch: async request => {
    networkRequests.push(`${request.method} ${request.url}`);
    return new Response('from network', { status: 200 });
  },
  Response,
  Headers,
  Request,
  URL,
  console
};
vm.runInNewContext(fs.readFileSync(workerPath, 'utf8'), workerScope);
assert.equal(typeof listeners.fetch, 'function', 'the service worker handles fetch events');

async function workerFetch(url, init) {
  let responded;
  listeners.fetch({
    request: new Request(url, init),
    respondWith: promise => {
      responded = promise;
    }
  });
  return responded;
}

// The app stages into Cache Storage only when a service worker controls the page.
globalThis.caches = cacheStorage;
assert.equal(await app.createCachedDownloadUrl(maskBytes, 'mask.nii'), null, 'no controller, no cached download');
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { serviceWorker: { controller: {} } }
});
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;
const cachedUrl = await app.createCachedDownloadUrl(maskBytes, 'lesion mask.nii');
globalThis.setTimeout = realSetTimeout;
const cachedHref = typeof cachedUrl === 'string' ? cachedUrl : cachedUrl.url;
assert.match(cachedHref, /^https:\/\/neurodesk\.org\/webapps\/calmar\/__lnm_downloads\/[^/]+\/lesion_mask\.nii$/);

// The worker serves exactly what the app staged, as an attachment, and keeps
// the page cross-origin isolated.
const served = await workerFetch(cachedHref);
assert.equal(served.status, 200);
assert.deepEqual(new Uint8Array(await served.arrayBuffer()), maskBytes, 'the service worker returns the staged mask');
assert.equal(served.headers.get('content-disposition'), 'attachment; filename="lesion_mask.nii"');
assert.equal(served.headers.get('cross-origin-opener-policy'), 'same-origin');
assert.deepEqual(networkRequests, [], 'a staged download never touches the network');

// On localhost the same route belongs to the dev server: POSTs and GETs that
// are not in the cache go to the network.
await workerFetch('http://localhost:8080/__lnm_downloads/t/mask.nii', { method: 'POST', body: 'x' });
const uncached = await workerFetch('http://localhost:8080/__lnm_downloads/t/other.nii');
assert.equal(await uncached.text(), 'from network');
assert.deepEqual(networkRequests, [
  'POST http://localhost:8080/__lnm_downloads/t/mask.nii',
  'GET http://localhost:8080/__lnm_downloads/t/other.nii'
]);

// ---- 3. configuration lint ----
// `pnpm dev` and `bash web/run.sh` must start the dev server the same way;
// the flags are compared as data, not searched for as text.
const flags = command => command.match(/--(?:cache-policy '[^']*'|staging-route \S+|build-info)/g);
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const runScript = fs.readFileSync(path.join(ROOT, 'web/run.sh'), 'utf8');
assert.deepEqual(
  flags(packageJson.scripts.dev),
  ["--cache-policy 'no-store, must-revalidate'", '--staging-route /__lnm_downloads/', '--build-info']
);
assert.deepEqual(flags(runScript.split('\n').filter(line => !line.startsWith('#')).join(' ')), flags(packageJson.scripts.dev));
assert.deepEqual(packageJson.neurodeskWebapp.static.coiServiceWorker, {
  cacheRoute: '/__lnm_downloads/',
  cacheName: 'lnm-mask-downloads-v1',
  alwaysRegister: true
});

console.log('mask download route OK: dev server and service worker both deliver the staged mask as an attachment.');
process.exit(0);
