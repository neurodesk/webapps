#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { writeRuntimeCacheManifest } from '../scripts/lib/runtime-cache.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(join(tmpdir(), 'neurodesk-resource-cache-'));
const profile = join(scratch, 'profile');
const runtimeDist = join(scratch, 'runtime');
await mkdir(join(runtimeDist, 'assets'), { recursive: true });
const model = Buffer.from('CAcSDGJhY2tlbmQtdGVzdDpBCgsKAXgSAXkiA05lZxIQdGVzdF9uZWdfZXhhbXBsZVoPCgF4EgoKCAgBEgQKAggCYg8KAXkSCgoICAESBAoCCAJCBAoAEA0=', 'base64');
const example = Buffer.from('pinned example input fixture');
const failureModel = Buffer.concat([model, Buffer.from([0xa2, 0x06, 0x01, 0x78])]);
const updatedModel = Buffer.concat([model, Buffer.from([0xa2, 0x06, 0x00])]);
const wasm = await readFile(join(repoRoot, 'packages/nii2tvx/wasm/nii2tvx.wasm'));
const updatedWasm = Buffer.concat([wasm, Buffer.from([0, 4, 3, 110, 101, 119])]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
const transferred = new Map();
const resources = new Map([
  ['/models/first.onnx', model],
  ['/examples/input.nii', example],
  ['/deployment-two/model.onnx', model],
  ['/models/updated.onnx', updatedModel],
  ['/models/cancel.onnx', failureModel],
  ['/models/broken.onnx', failureModel],
]);
const bundle = async entry => (await build({
  entryPoints: [join(repoRoot, entry)],
  bundle: true,
  format: 'esm',
  write: false,
})).outputFiles[0].text;
const loaderSource = await bundle('packages/components/src/worker/fetchModel.js');
const selectorSource = await bundle('packages/components/src/elements/example-selector.js');
const slowResponses = new Set();
let deployOnRuntimeNavigation;
let cacheRuntimeHttp = false;
const workerFetchSource = `
self.onmessage = async () => {
  try {
    const response = await fetch('./assets/engine.wasm');
    const bytes = await response.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    self.postMessage({ bytes: bytes.byteLength, exports: WebAssembly.Module.exports(module).length, isolated: crossOriginIsolated });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
`;
const parentWorkerSource = `
const worker = new Worker(new URL('./runtime-worker.js', import.meta.url), { type: 'module' });
worker.onmessage = event => self.postMessage(event.data);
worker.onerror = event => self.postMessage({ error: event.message });
self.onmessage = () => worker.postMessage(null);
`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  const send = (body, type) => {
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  };
  if (pathname === '/') return send('<!doctype html><title>Resource cache regression</title>', 'text/html');
  if (pathname === '/fetchModel.js') return send(loaderSource, 'text/javascript');
  if (pathname === '/example-selector.js') return send(selectorSource, 'text/javascript');
  if (pathname.startsWith('/runtime/')) {
    try {
      const relative = pathname.slice('/runtime/'.length) || 'index.html';
      if (relative.includes('..')) return response.writeHead(400).end();
      if (relative === 'index.html' && deployOnRuntimeNavigation) {
        const deploy = deployOnRuntimeNavigation;
        deployOnRuntimeNavigation = null;
        await deploy();
      }
      const body = await readFile(join(runtimeDist, relative));
      if (relative === 'assets/engine.wasm' && cacheRuntimeHttp) response.setHeader('Cache-Control', 'public, max-age=31536000');
      if (relative.startsWith('assets/')) transferred.set(pathname, (transferred.get(pathname) || 0) + body.length);
      const type = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.json') ? 'application/json' : relative.endsWith('.html') ? 'text/html' : relative.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
      return send(body, type);
    } catch {
      return response.writeHead(404).end();
    }
  }
  const bytes = resources.get(pathname);
  if (!bytes) return response.writeHead(404).end();
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
  if (pathname === '/models/cancel.onnx') {
    response.write(bytes.subarray(0, 8));
    transferred.set(pathname, (transferred.get(pathname) || 0) + 8);
    slowResponses.add(response);
    response.once('close', () => slowResponses.delete(response));
    return;
  }
  const body = pathname === '/models/broken.onnx' ? bytes.subarray(0, 8) : bytes;
  transferred.set(pathname, (transferred.get(pathname) || 0) + body.length);
  response.end(body);
});
let context;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const bytesTransferred = () => [...transferred.values()].reduce((sum, value) => sum + value, 0);
async function openProfile(path = '/') {
  context = await chromium.launchPersistentContext(profile, { headless: true });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(`${origin}${path}`);
  return page;
}
async function loadExample(page) {
  await page.evaluate(async asset => {
    const { createExampleSelector } = await import('/example-selector.js');
    document.querySelector('nd-example-selector')?.remove();
    document.body.append(createExampleSelector({
      examples: [{ id: 'fixture', label: 'Pinned example', files: [{ ...asset, name: 'input.nii' }] }],
      async onLoad(example, { fetchFiles }) {
        const [file] = await fetchFiles();
        window.loadedExample = { name: file.name, bytes: [...new Uint8Array(await file.arrayBuffer())] };
      },
    }));
  }, { url: `${origin}/examples/input.nii`, ...integrity(example) });
  await page.getByRole('combobox', { name: 'Input', exact: true }).selectOption('fixture');
  await expect(page.locator('nd-example-selector')).toHaveAttribute('data-example-state', 'ready');
  assert.deepEqual(await page.evaluate(() => window.loadedExample), { name: 'input.nii', bytes: [...example] });
}
async function loadModel(page, path, expected) {
  return page.evaluate(async ({ path, expected }) => {
    const { fetchModel } = await import('/fetchModel.js');
    const bytes = await fetchModel({ url: new URL(path, location.href).href, integrity: expected });
    return [...new Uint8Array(bytes)];
  }, { path, expected: integrity(expected) });
}
async function prepareRuntime(bytes, title) {
  await writeFile(join(runtimeDist, 'index.html'), `<!doctype html><html><head><title>${title}</title></head><body>Runtime cache fixture</body></html>`);
  await writeFile(join(runtimeDist, 'runtime-worker.js'), workerFetchSource);
  await writeFile(join(runtimeDist, 'runtime-parent-worker.js'), parentWorkerSource);
  await writeFile(join(runtimeDist, 'assets', 'engine.wasm'), bytes);
  await writeFile(join(runtimeDist, 'assets', 'shell.js'), 'export const shell = true;');
  return writeRuntimeCacheManifest({ distDir: runtimeDist });
}
async function corruptCache(page, sha256) {
  return page.evaluate(async expected => {
    let changed = 0;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const key of await cache.keys()) {
        const bytes = await (await cache.match(key)).arrayBuffer();
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== expected) continue;
        await cache.put(key, new Response(new Uint8Array(bytes.byteLength)));
        changed += 1;
      }
    }
    return changed;
  }, sha256);
}
async function loadRuntime(page) {
  await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
  return page.evaluate(async () => {
    const response = await fetch('./assets/engine.wasm');
    const bytes = await response.arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    return { bytes: bytes.byteLength, exports: WebAssembly.Module.exports(module).length, isolated: crossOriginIsolated };
  });
}
async function loadWorkerRuntime(page, nested = false, persistent = false) {
  return page.evaluate(({ nested, persistent }) => new Promise((resolve, reject) => {
    window.runtimeWorkers ??= new Map();
    const key = nested ? 'nested' : 'dedicated';
    const worker = (persistent && window.runtimeWorkers.get(key))
      || new Worker(nested ? './runtime-parent-worker.js' : './runtime-worker.js', { type: 'module' });
    if (persistent) window.runtimeWorkers.set(key, worker);
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Runtime worker timed out'));
    }, 15000);
    worker.onmessage = event => {
      clearTimeout(timeout);
      if (!persistent) worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data);
    };
    worker.onerror = event => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(null);
  }), { nested, persistent });
}
async function stopServiceWorker(page) {
  const session = await context.newCDPSession(page);
  const versions = new Map();
  session.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await session.send('ServiceWorker.enable');
  await expect.poll(() => [...versions.values()].find(version => version.scriptURL === `${origin}/runtime/coi-serviceworker.js` && version.runningStatus === 'running')?.versionId).toBeTruthy();
  const version = [...versions.values()].find(version => version.scriptURL === `${origin}/runtime/coi-serviceworker.js` && version.runningStatus === 'running');
  await session.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await expect.poll(() => versions.get(version.versionId)?.runningStatus).toBe('stopped');
  await session.detach();
}
try {
  let page = await openProfile();
  assert.deepEqual(await loadModel(page, '/models/first.onnx', model), [...model]);
  assert.equal(transferred.get('/models/first.onnx'), model.length, 'first load downloads the model body');
  await loadExample(page);
  assert.equal(transferred.get('/examples/input.nii'), example.length, 'first example selection downloads its body');
  const firstLoadBytes = bytesTransferred();
  await page.reload();
  assert.deepEqual(await loadModel(page, '/models/first.onnx', model), [...model]);
  assert.equal(bytesTransferred(), firstLoadBytes, 'reload must reuse verified model bytes without transferring its body');
  await context.close();
  context = null;
  page = await openProfile();
  assert.deepEqual(await loadModel(page, '/models/first.onnx', model), [...model]);
  assert.equal(bytesTransferred(), firstLoadBytes, 'browser restart must reuse persistent verified model bytes');
  await loadExample(page);
  assert.equal(bytesTransferred(), firstLoadBytes, 'example selector reuses verified files after browser restart');
  assert.deepEqual(await loadModel(page, '/deployment-two/model.onnx', model), [...model]);
  assert.equal(bytesTransferred(), firstLoadBytes, 'an unchanged checksum survives a deployment URL change');
  assert.deepEqual(await loadModel(page, '/models/updated.onnx', updatedModel), [...updatedModel]);
  assert.equal(transferred.get('/models/updated.onnx'), updatedModel.length, 'changed checksum downloads changed model bytes');
  const beforeCorruption = bytesTransferred();
  const corrupted = await corruptCache(page, digest(updatedModel));
  assert.ok(corrupted > 0, 'test corrupts the persisted model body');
  assert.deepEqual(await loadModel(page, '/models/updated.onnx', updatedModel), [...updatedModel]);
  assert.equal(bytesTransferred() - beforeCorruption, updatedModel.length, 'corrupted cached model is downloaded and verified again');
  const failedLoads = await page.evaluate(async expected => {
    const { fetchModel } = await import('/fetchModel.js');
    const cancelled = new AbortController();
    const cacheEntries = async () => (await Promise.all((await caches.keys()).map(async name =>
      (await (await caches.open(name)).keys()).map(key => `${name} ${key.url}`),
    ))).flat().sort();
    const before = await cacheEntries();
    const outcomes = [];
    for (const [path, signal] of [['/models/cancel.onnx', cancelled.signal], ['/models/broken.onnx', undefined]]) {
      try {
        await fetchModel({ url: new URL(path, location.href).href, integrity: expected }, {
          signal,
          onProgress() { if (signal) cancelled.abort(); },
        });
        outcomes.push('unexpected success');
      } catch (error) {
        outcomes.push(error.name);
      }
    }
    return { outcomes, before, after: await cacheEntries() };
  }, integrity(failureModel));
  assert.deepEqual(failedLoads.outcomes, ['AbortError', 'TypeError']);
  assert.deepEqual(failedLoads.after, failedLoads.before, 'cancelled and partial responses cannot publish cache entries');
  console.log(`PASS verified models and example files persist through reload and Chromium restart; deployment URL changes transfer 0 model bytes; corrupt bytes refetch; failed downloads publish no entries (${firstLoadBytes} first-load bytes)`);
  const manifest = await prepareRuntime(wasm, 'First deployment');
  assert.equal(manifest.assets.length, 1, 'generated runtime map includes binary runtime and excludes ordinary JavaScript');
  const workerBeforeUpgrade = await readFile(join(runtimeDist, 'coi-serviceworker.js'), 'utf8');
  await page.goto(`${origin}/runtime/`);
  const firstRuntime = await loadRuntime(page);
  assert.ok(firstRuntime.exports > 0, 'actual nii2tvx WASM compiles and exposes runtime exports');
  assert.equal(firstRuntime.bytes, wasm.length);
  assert.equal(transferred.get('/runtime/assets/engine.wasm'), wasm.length, 'first runtime load transfers the actual WASM body once');
  const firstRuntimeBytes = bytesTransferred();
  await page.reload();
  assert.deepEqual(await loadRuntime(page), firstRuntime);
  assert.equal(bytesTransferred(), firstRuntimeBytes, 'reload reuses the verified WASM body');
  await context.close();
  context = null;
  page = await openProfile('/runtime/');
  assert.deepEqual(await loadRuntime(page), firstRuntime);
  assert.equal(bytesTransferred(), firstRuntimeBytes, 'restarted Chromium reuses the verified WASM body');
  assert.deepEqual(await loadWorkerRuntime(page, false, true), firstRuntime, 'dedicated module workers compile the persisted WASM after restart');
  assert.equal(bytesTransferred(), firstRuntimeBytes, 'dedicated workers reuse verified WASM without transferring its body');
  const beforeNested = bytesTransferred();
  assert.deepEqual(await loadWorkerRuntime(page, true, true), firstRuntime, 'nested module workers compile correct WASM after restart');
  const nestedBytes = bytesTransferred() - beforeNested;
  assert.ok(nestedBytes === 0 || nestedBytes === wasm.length, 'unidentified nested workers may safely bypass the cache');
  await stopServiceWorker(page);
  const beforeWorkerRestart = bytesTransferred();
  assert.deepEqual(await loadWorkerRuntime(page, false, true), firstRuntime, 'an existing dedicated worker compiles WASM after its service worker restarts');
  assert.deepEqual(await loadRuntime(page), firstRuntime, 'the existing document compiles WASM after its service worker restarts');
  assert.equal(bytesTransferred(), beforeWorkerRestart, 'service-worker restart preserves cache reuse for the document and its active dedicated worker');
  const beforeNestedRestart = bytesTransferred();
  assert.deepEqual(await loadWorkerRuntime(page, true, true), firstRuntime, 'an existing nested worker compiles correct WASM after its service worker restarts');
  assert.ok([0, wasm.length].includes(bytesTransferred() - beforeNestedRestart), 'unidentified nested workers safely bypass after service-worker restart');
  console.log(`PASS dedicated module workers reuse persisted WASM across browser and service-worker restarts; nested module workers compile correct WASM (${nestedBytes} network bytes where Chromium omits their client identity)`);
  const beforeUnchangedDeployment = bytesTransferred();
  await prepareRuntime(wasm, 'Unchanged runtime deployment');
  await page.goto(`${origin}/runtime/`);
  assert.equal(await page.title(), 'Unchanged runtime deployment');
  assert.deepEqual(await loadRuntime(page), firstRuntime);
  assert.equal(bytesTransferred(), beforeUnchangedDeployment, 'unchanged runtime checksum survives a deployment');
  const controllerBeforeUpgrade = await page.evaluate(() => navigator.serviceWorker.controller.scriptURL);
  cacheRuntimeHttp = true;
  const httpCachePage = await context.newPage();
  await httpCachePage.goto(origin);
  const beforeHttpCachePrime = bytesTransferred();
  assert.equal(await httpCachePage.evaluate(async () => (await (await fetch('/runtime/assets/engine.wasm', { cache: 'reload' })).arrayBuffer()).byteLength), wasm.length, 'uncontrolled page primes the HTTP cache with the old runtime');
  assert.equal(bytesTransferred() - beforeHttpCachePrime, wasm.length, 'HTTP cache prime downloads the old runtime body');
  const beforeChangedDeployment = bytesTransferred();
  deployOnRuntimeNavigation = () => prepareRuntime(updatedWasm, 'Changed runtime deployment');
  await page.goto(`${origin}/runtime/`);
  assert.equal(deployOnRuntimeNavigation, null, 'deployment changes exactly when the server receives the HTML navigation');
  assert.equal(await page.title(), 'Changed runtime deployment');
  assert.equal(await readFile(join(runtimeDist, 'coi-serviceworker.js'), 'utf8'), workerBeforeUpgrade, 'deployment changes only the external map, leaving the controlling worker unchanged');
  assert.equal(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), controllerBeforeUpgrade);
  assert.equal(await httpCachePage.evaluate(async () => (await (await fetch('/runtime/assets/engine.wasm')).arrayBuffer()).byteLength), wasm.length, 'browser HTTP cache still contains the fresh old runtime at the unchanged URL');
  assert.equal(bytesTransferred(), beforeChangedDeployment, 'HTTP cache probe transfers no bytes despite changed server content');
  await httpCachePage.close();
  const nextRuntime = await loadRuntime(page);
  assert.equal(nextRuntime.bytes, updatedWasm.length, 'an existing controlling worker uses the new document runtime map');
  assert.equal(nextRuntime.exports, firstRuntime.exports);
  assert.equal(bytesTransferred() - beforeChangedDeployment, updatedWasm.length, 'changed runtime checksum downloads exactly the new WASM body');
  assert.deepEqual(await loadWorkerRuntime(page), nextRuntime, 'new deployment dedicated workers receive the new runtime bytes');
  assert.equal(bytesTransferred() - beforeChangedDeployment, updatedWasm.length, 'new deployment dedicated workers reuse the new verified binary');
  assert.deepEqual(await loadWorkerRuntime(page, true), nextRuntime, 'new deployment nested workers never receive old cached runtime bytes');
  cacheRuntimeHttp = false;
  const cacheSession = await context.newCDPSession(page);
  await cacheSession.send('Network.clearBrowserCache');
  await cacheSession.detach();
  const beforeRuntimeCorruption = bytesTransferred();
  assert.ok(await corruptCache(page, digest(updatedWasm)) > 0, 'test corrupts the persistent WASM body');
  assert.deepEqual(await loadRuntime(page), nextRuntime);
  assert.equal(bytesTransferred() - beforeRuntimeCorruption, updatedWasm.length, 'corrupt runtime bytes are downloaded and verified again before compilation');
  const beforeUnlisted = bytesTransferred();
  await page.evaluate(async () => {
    await (await fetch('./assets/shell.js')).text();
    await (await fetch('./assets/shell.js')).text();
  });
  assert.equal(bytesTransferred() - beforeUnlisted, Buffer.byteLength('export const shell = true;') * 2, 'ordinary JavaScript requests remain network requests');
  const beforeMissingManifest = bytesTransferred();
  await writeFile(join(runtimeDist, 'assets', 'extra.bin'), Buffer.from('new manifest identity'));
  await prepareRuntime(updatedWasm, 'Missing runtime map deployment');
  const missingManifestHtml = await readFile(join(runtimeDist, 'index.html'), 'utf8');
  const manifestReference = missingManifestHtml.match(/<meta name="neurodesk-runtime-manifest" content="([^"]+)">/)[1];
  await rm(join(runtimeDist, manifestReference));
  await page.goto(`${origin}/runtime/`);
  assert.equal((await loadRuntime(page)).bytes, updatedWasm.length);
  assert.equal((await loadRuntime(page)).bytes, updatedWasm.length);
  assert.equal(bytesTransferred() - beforeMissingManifest, updatedWasm.length * 2, 'missing runtime maps disable resource caching without breaking isolation');
  console.log(`PASS actual nii2tvx WASM compiles after reload and Chromium restart with 0 extra runtime bytes; unchanged deployments reuse it; old controlling worker downloads ${updatedWasm.length} changed runtime bytes; corrupt runtime bytes refetch; unlisted scripts and missing maps bypass cache`);
} finally {
  await context?.close();
  for (const response of slowResponses) response.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
