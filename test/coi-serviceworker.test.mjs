import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { isolationFallback } from '../scripts/lib/isolation-fallback-plugin.mjs';

const source = await readFile(
  join(repoRoot, 'packages', 'runtime-support', 'src', 'coi-serviceworker.js'),
  'utf8',
);

test('shared runtime changes invalidate cached app builds', async () => {
  const turbo = JSON.parse(await readFile(join(repoRoot, 'turbo.json'), 'utf8'));
  assert.ok(turbo.globalDependencies.includes('packages/runtime-support/src/**'));
  assert.ok(turbo.globalDependencies.includes('scripts/lib/isolation-fallback-plugin.mjs'));
  assert.ok(turbo.globalDependencies.includes('scripts/lib/runtime-support.mjs'));
  assert.ok(turbo.globalDependencies.includes('scripts/lib/runtime-cache.mjs'));
  assert.ok(turbo.globalDependencies.includes('scripts/lib/app-theme-dist.mjs'));
  assert.ok(turbo.globalDependencies.includes('scripts/vendor-runtime-support.mjs'));
});

test('isolation fallback emits and serves the scoped worker for a relative Vite base', async () => {
  const plugin = isolationFallback();
  let emitted;
  plugin.configResolved({ base: './' });
  await plugin.generateBundle.call({ emitFile: (file) => { emitted = file; } });
  assert.equal(emitted.fileName, 'coi-serviceworker.js');
  assert.match(emitted.source, /Cross-Origin-Opener-Policy/);
  assert.equal(plugin.transformIndexHtml.handler()[0].attrs.src, './coi-serviceworker.js');

  let middleware;
  plugin.configureServer({ middlewares: { use: (handler) => { middleware = handler; } } });
  let ended = '';
  await middleware(
    { url: '/coi-serviceworker.js' },
    { setHeader() {}, end: (body) => { ended = body; } },
    () => assert.fail('the worker route should not fall through'),
  );
  assert.match(ended, /Cross-Origin-Embedder-Policy/);
});

test('recovers when an update reload happens before the worker controls the page', async () => {
  const storage = new Map([['coiReloadedBySelf', 'updatefound']]);
  let registrations = 0;
  let reloads = 0;
  const registration = {
    active: { state: 'activated' },
    addEventListener() {},
  };
  const serviceWorker = {
    controller: null,
    register: async () => {
      registrations++;
      return registration;
    },
  };
  const window = {
    crossOriginIsolated: false,
    isSecureContext: true,
    document: {
      currentScript: { src: 'https://example.test/app/coi-serviceworker.js' },
    },
    location: {
      reload() {
        reloads++;
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
  };

  vm.runInNewContext(source, {
    console: { error() {}, log() {}, warn() {} },
    navigator: { serviceWorker },
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registrations, 1);
  assert.equal(reloads, 1);
  assert.equal(storage.get('coiReloadedBySelf'), 'notcontrolling');
  assert.equal(await window.coiWillReload, true);
});

test('reloads after an installing worker activates when updatefound was missed', async () => {
  const storage = new Map();
  let reloads = 0;
  let stateChangeListener;
  const installing = {
    state: 'installing',
    addEventListener(type, listener) {
      if (type === 'statechange') stateChangeListener = listener;
    },
  };
  const registration = {
    active: null,
    installing,
    waiting: null,
    addEventListener() {},
  };
  const serviceWorker = {
    controller: null,
    register: async () => registration,
  };
  const window = {
    crossOriginIsolated: false,
    isSecureContext: true,
    document: {
      currentScript: { src: 'https://example.test/app/coi-serviceworker.js' },
    },
    location: {
      reload() {
        reloads++;
      },
    },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
  };

  vm.runInNewContext(source, {
    console: { error() {}, log() {}, warn() {} },
    navigator: { serviceWorker },
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reloads, 0);
  assert.equal(typeof stateChangeListener, 'function');
  const pending = Symbol('pending');
  assert.equal(await Promise.race([window.coiWillReload, Promise.resolve(pending)]), pending, 'undecided until the worker activates');

  installing.state = 'activated';
  stateChangeListener();

  assert.equal(await window.coiWillReload, true);
  assert.equal(reloads, 1);
  assert.equal(storage.get('coiReloadedBySelf'), 'notcontrolling');
});

function runtimeWorker({ stores = new Map(), routes, failStorage, manifestUrl, bootstrap = true } = {}) {
  const listeners = new Map();
  const calls = [];
  const warnings = [];
  const workerUrl = new URL('https://example.test/site/app/coi-serviceworker.js');
  vm.runInNewContext(source.replace('/*__COI_RUNTIME_CONFIG__*/ {}', JSON.stringify({
    runtimeCache: true,
    cacheRoute: '/__lnm_downloads/',
    cacheName: 'lnm-mask-downloads-v1',
  })), {
    self: {
      location: workerUrl,
      addEventListener: (type, listener) => listeners.set(type, listener),
      clients: { claim: async () => {}, get: async () => undefined },
      skipWaiting() {},
    },
    caches: {
      open: async (name) => {
        if (failStorage === 'open') throw new Error('storage denied');
        if (!stores.has(name)) stores.set(name, new Map());
        const entries = stores.get(name);
        return {
          match: async (key) => {
            if (failStorage === 'read') throw new Error('storage read failed');
            return entries.get(key)?.clone();
          },
          put: async (key, value) => {
            if (failStorage === 'write') throw new Error('quota exceeded');
            entries.set(key, value.clone());
          },
          delete: async (key) => entries.delete(key),
        };
      },
    },
    fetch: async (request, init) => {
      const url = typeof request === 'string' ? request : request.url;
      calls.push({ url, init });
      const response = routes.get(url);
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(request, init) : response?.clone() ?? new Response('missing', { status: 404 });
    },
    console: { warn: (...args) => warnings.push(args), log() {}, error() {} },
    crypto: webcrypto,
    URL,
    Request,
    Response,
    Headers,
    Uint8Array,
    TextDecoder,
  });
  if (bootstrap && manifestUrl) {
    listeners.get('message')({
      data: { type: 'runtimeManifest', url: manifestUrl },
      source: { id: 'document-one' },
      waitUntil() {},
    });
  }
  return {
    calls,
    stores,
    warnings,
    workerUrl,
    async fetch(path, { mode, method = 'GET', headers = {}, clientId = 'document-one', resultingClientId = mode === 'navigate' ? clientId : '' } = {}) {
      const url = new URL(path, workerUrl).href;
      const request = mode === 'navigate'
        ? { url, method, headers: new Headers(headers), mode, cache: 'default' }
        : new Request(url, { method, headers });
      let response;
      listeners.get('fetch')({ request, clientId, resultingClientId, respondWith: promise => { response = promise; } });
      assert.ok(response, 'the worker handles the request');
      return response;
    },
  };
}

function runtimeFixture(body = 'wasm version one') {
  const workerUrl = 'https://example.test/site/app/coi-serviceworker.js';
  const assetUrl = new URL('./assets/engine.wasm', workerUrl).href;
  const asset = {
    url: './assets/engine.wasm',
    sha256: createHash('sha256').update(body).digest('hex'),
    bytes: Buffer.byteLength(body),
    contentType: 'application/wasm',
  };
  const manifestBody = `${JSON.stringify({ schema_version: 1, assets: [asset] }, null, 2)}\n`;
  const manifestHash = createHash('sha256').update(manifestBody).digest('hex');
  const manifestUrl = new URL(`./runtime-cache-manifest.${manifestHash}.json`, workerUrl).href;
  const routes = new Map([
    [manifestUrl, new Response(manifestBody)],
    [assetUrl, new Response(body)],
    [new URL('./', workerUrl).href, new Response(`<html><head><meta name="neurodesk-runtime-manifest" content="${manifestUrl}"></head>current deployment</html>`)],
  ]);
  return { routes, assetUrl, manifestUrl, asset, body };
}

test('runtime bodies persist across worker restarts and retain WASM MIME and isolation headers', async () => {
  const fixture = runtimeFixture();
  const stores = new Map();
  const first = runtimeWorker({ ...fixture, stores });
  const downloaded = await first.fetch(fixture.assetUrl);
  assert.equal(await downloaded.text(), fixture.body);
  assert.equal(downloaded.headers.get('Content-Type'), 'application/wasm');
  assert.equal(downloaded.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(downloaded.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal((await first.fetch(fixture.assetUrl)).status, 200);
  assert.equal(first.calls.filter(call => call.url === fixture.assetUrl).length, 1);
  assert.equal(first.calls.find(call => call.url === fixture.manifestUrl).init.cache, 'no-store');

  const restarted = runtimeWorker({ ...fixture, stores, bootstrap: false });
  assert.equal(await (await restarted.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(restarted.calls.filter(call => call.url === fixture.assetUrl).length, 0);
  assert.equal(restarted.calls.filter(call => call.url === fixture.manifestUrl).length, 0, 'the exact document manifest is verified from persistent storage');
});

test('an old controlling worker binds changed runtime bytes to the exact new document manifest', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  await worker.fetch('./', { mode: 'navigate' });
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 1, 'an unchanged deployment reuses the same digest');

  const deployed = runtimeFixture('wasm version two');
  fixture.routes.set(fixture.assetUrl, deployed.routes.get(fixture.assetUrl));
  let finishRefresh;
  fixture.routes.set(new URL('./', worker.workerUrl).href, deployed.routes.get(new URL('./', worker.workerUrl).href));
  fixture.routes.set(deployed.manifestUrl, () => new Promise(resolve => { finishRefresh = resolve; }));
  const navigation = worker.fetch('./', { mode: 'navigate', clientId: 'document-two' });
  await new Promise(resolve => setImmediate(resolve));
  const runtime = worker.fetch(fixture.assetUrl, { clientId: 'document-two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 1, 'dependent fetch waits for the new map');
  finishRefresh(deployed.routes.get(deployed.manifestUrl).clone());
  await navigation;
  assert.equal(await (await runtime).text(), deployed.body);
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 2);
});

for (const [name, failure] of [
  ['missing', new Response('missing', { status: 404 })],
  ['invalid', Response.json({ schema_version: 1, assets: [{ url: './engine.wasm' }] })],
  ['failed', new TypeError('network unavailable')],
]) {
  test(`${name} deployment manifest clears the old map and bypasses persistent bytes`, async () => {
    const fixture = runtimeFixture();
    const worker = runtimeWorker(fixture);
    await worker.fetch(fixture.assetUrl);
    const deployed = runtimeFixture('new unlisted deployment');
    fixture.routes.set(deployed.manifestUrl, failure);
    fixture.routes.set(new URL('./', worker.workerUrl).href, deployed.routes.get(new URL('./', worker.workerUrl).href));
    fixture.routes.set(fixture.assetUrl, new Response('new unlisted deployment'));
    await worker.fetch('./', { mode: 'navigate', clientId: 'document-two' });
    assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: 'document-two' })).text(), 'new unlisted deployment');
    assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 2);
  });
}

test('corrupt cached bytes are evicted and complete network bodies must match the deployment digest', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  await worker.fetch(fixture.assetUrl);
  const entries = worker.stores.get('neurodesk-runtime-assets-v1');
  const key = [...entries.keys()][0];
  entries.set(key, new Response('wasm version bad'));
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 2);
  assert.equal(await entries.get(key).clone().text(), fixture.body);

  entries.clear();
  fixture.routes.set(fixture.assetUrl, new Response('wasm version bad'));
  assert.equal((await worker.fetch(fixture.assetUrl)).type, 'error');
  assert.equal(entries.size, 0, 'mismatched bytes are never published to the cache');
  fixture.routes.set(fixture.assetUrl, new Response('truncated'));
  assert.equal((await worker.fetch(fixture.assetUrl)).type, 'error');
  assert.equal(entries.size, 0);
});

for (const failStorage of ['open', 'read', 'write']) {
  test(`runtime cache ${failStorage} failure still returns verified network bytes and warns`, async () => {
    const fixture = runtimeFixture();
    const worker = runtimeWorker({ ...fixture, failStorage });
    assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
    assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 1);
    assert.ok(worker.warnings.some(args => /Runtime .*cache/.test(args[0])));
  });
}

test('range, partial, opaque, non-GET and unlisted scripts bypass runtime caching', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  fixture.routes.set(fixture.assetUrl, new Response('partial', { status: 206, headers: { 'Content-Range': 'bytes 0-6/99' } }));
  assert.equal((await worker.fetch(fixture.assetUrl, { headers: { Range: 'bytes=0-6' } })).status, 206);
  assert.equal((await worker.fetch(fixture.assetUrl)).status, 206);
  assert.equal((await worker.fetch(fixture.assetUrl, { method: 'POST' })).status, 206);
  fixture.routes.set(fixture.assetUrl, () => ({ status: 0, type: 'opaque', clone() { return this; } }));
  assert.equal((await worker.fetch(fixture.assetUrl)).type, 'opaque');
  fixture.routes.set(new URL('./unlisted.js', worker.workerUrl).href, new Response('export const current = true;'));
  await worker.fetch('./unlisted.js');
  await worker.fetch('./unlisted.js');
  assert.equal(worker.calls.filter(call => call.url.endsWith('/unlisted.js')).length, 2);
  assert.equal(worker.stores.get('neurodesk-runtime-assets-v1')?.size ?? 0, 0);
});

test('runtime digest sharing normalizes MIME separately for WASM and binary aliases', async () => {
  const fixture = runtimeFixture();
  const binary = { ...fixture.asset, url: './assets/engine.bin', contentType: 'application/octet-stream' };
  const aliasBody = JSON.stringify({ schema_version: 1, assets: [binary, fixture.asset] });
  fixture.manifestUrl = new URL(`./runtime-cache-manifest.${createHash('sha256').update(aliasBody).digest('hex')}.json`, fixture.assetUrl.replace('/assets/engine.wasm', '/')).href;
  fixture.routes.set(fixture.manifestUrl, new Response(aliasBody));
  fixture.routes.set(new URL(binary.url, fixture.assetUrl.replace('/assets/engine.wasm', '/')).href, new Response(fixture.body));
  const worker = runtimeWorker(fixture);
  const [wasm, data] = await Promise.all([worker.fetch(fixture.assetUrl), worker.fetch('./assets/engine.bin')]);
  assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
  assert.equal(data.headers.get('Content-Type'), 'application/octet-stream');
});

test('runtime caching preserves the Calmar generated-download route', async () => {
  const fixture = runtimeFixture();
  const stores = new Map([['lnm-mask-downloads-v1', new Map([
    ['https://example.test/site/app/__lnm_downloads/mask.nii.gz', new Response('generated patient download')],
  ])]]);
  const worker = runtimeWorker({ ...fixture, stores });
  const response = await worker.fetch('./__lnm_downloads/mask.nii.gz');
  assert.equal(await response.text(), 'generated patient download');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(worker.calls.length, 0);
});

test('header-isolated pages register the cache worker without reloading the application', async () => {
  let registrations = 0;
  let reloads = 0;
  let persistRequests = 0;
  const storage = new Map();
  const context = {
    console: { log() {}, warn() {}, error() {} },
    navigator: {
      storage: { persist: async () => { persistRequests++; return false; } },
      serviceWorker: {
        controller: null,
        register: async () => {
          registrations++;
          return { active: { state: 'activated' }, addEventListener() {} };
        },
      },
    },
    window: {
      crossOriginIsolated: true,
      isSecureContext: true,
      document: { currentScript: { src: 'https://example.test/app/coi-serviceworker.js' } },
      location: { reload: () => { reloads++; } },
      sessionStorage: {
        getItem: key => storage.get(key),
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key),
      },
    },
  };
  const configured = source.replace('/*__COI_RUNTIME_CONFIG__*/ {}', JSON.stringify({ runtimeCache: true }));
  vm.runInNewContext(configured, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrations, 1);
  assert.equal(reloads, 0);
  assert.equal(persistRequests, 1);
  assert.equal(await context.window.coiWillReload, false);
});

test('a page whose worker cannot register stays, and says so', async () => {
  const window = {
    crossOriginIsolated: false,
    isSecureContext: true,
    document: { currentScript: { src: 'https://example.test/app/coi-serviceworker.js' } },
    location: { reload: () => assert.fail('no reload without a worker') },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  vm.runInNewContext(source, {
    console: { error() {}, log() {}, warn() {} },
    navigator: { serviceWorker: { controller: null, register: async () => { throw new Error('denied'); } } },
    window,
  });
  assert.equal(await window.coiWillReload, false);
});


test('a new deployment cannot join an old document runtime download still in flight', async () => {
  const fixture = runtimeFixture();
  let finishOldDownload;
  let markDownloadStarted;
  const downloadStarted = new Promise(resolve => { markDownloadStarted = resolve; });
  fixture.routes.set(fixture.assetUrl, () => new Promise(resolve => { finishOldDownload = resolve; markDownloadStarted(); }));
  const worker = runtimeWorker(fixture);
  const oldDownload = worker.fetch(fixture.assetUrl);
  await downloadStarted;
  assert.equal(typeof finishOldDownload, 'function');
  const deployed = runtimeFixture('wasm version two');
  fixture.routes.set(deployed.manifestUrl, deployed.routes.get(deployed.manifestUrl));
  fixture.routes.set(new URL('./', worker.workerUrl).href, deployed.routes.get(new URL('./', worker.workerUrl).href));
  fixture.routes.set(fixture.assetUrl, deployed.routes.get(fixture.assetUrl));
  await worker.fetch('./', { mode: 'navigate', clientId: 'document-two' });
  assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: 'document-two' })).text(), deployed.body);
  finishOldDownload(new Response(fixture.body));
  assert.equal(await (await oldDownload).text(), fixture.body);
});

test('an interrupted runtime body never leaves a reusable partial cache entry', async () => {
  const fixture = runtimeFixture();
  fixture.routes.set(fixture.assetUrl, () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('partial'));
      controller.error(new Error('connection interrupted'));
    },
  })));
  const worker = runtimeWorker(fixture);
  assert.equal((await worker.fetch(fixture.assetUrl)).type, 'error');
  assert.equal(worker.stores.get('neurodesk-runtime-assets-v1').size, 0);
  fixture.routes.set(fixture.assetUrl, new Response(fixture.body));
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
});

test('deployment switching at the HTML request binds the new map and keeps old tabs on their own map', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  await worker.fetch(fixture.assetUrl);
  const deployed = runtimeFixture('wasm version two');
  fixture.routes.set(new URL('./', worker.workerUrl).href, () => {
    fixture.routes.set(deployed.manifestUrl, deployed.routes.get(deployed.manifestUrl));
    fixture.routes.set(fixture.assetUrl, deployed.routes.get(fixture.assetUrl));
    return deployed.routes.get(new URL('./', worker.workerUrl).href).clone();
  });
  const navigation = await worker.fetch('./', { mode: 'navigate', clientId: 'document-two' });
  assert.match(await navigation.text(), new RegExp(deployed.manifestUrl));
  assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: 'document-two' })).text(), deployed.body);
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body, 'an existing tab retains its own exact manifest');
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 2);
});

test('worker idle restart restores the old document identity and verified immutable map after deployment removes it', async () => {
  const fixture = runtimeFixture();
  const stores = new Map();
  const first = runtimeWorker({ ...fixture, stores });
  await first.fetch('./worker.js', { resultingClientId: 'worker-one' });
  assert.equal(await (await first.fetch(fixture.assetUrl, { clientId: 'worker-one' })).text(), fixture.body);
  fixture.routes.set(fixture.manifestUrl, new Response('old deployment removed', { status: 404 }));
  fixture.routes.set(fixture.assetUrl, new Response('new deployment bytes'));
  const restarted = runtimeWorker({ ...fixture, stores, bootstrap: false });
  assert.equal(await (await restarted.fetch(fixture.assetUrl, { clientId: 'worker-one' })).text(), fixture.body);
  assert.equal(restarted.calls.length, 0, 'exact persisted identity, map and binary survive worker termination');
});

test('unknown clients and nested requests without a client ID bypass cached runtime bytes', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  await worker.fetch(fixture.assetUrl);
  fixture.routes.set(fixture.assetUrl, new Response('network bytes for an unknown document'));
  assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: 'unknown-client' })).text(), 'network bytes for an unknown document');
  assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: '' })).text(), 'network bytes for an unknown document');
});

test('corrupt immutable manifest entries are evicted and verified again from the network', async () => {
  const fixture = runtimeFixture();
  const stores = new Map();
  await runtimeWorker({ ...fixture, stores }).fetch(fixture.assetUrl);
  stores.get('neurodesk-runtime-manifests-v1').set(fixture.manifestUrl, new Response('corrupt manifest bytes'));
  const restarted = runtimeWorker({ ...fixture, stores, bootstrap: false });
  assert.equal(await (await restarted.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(restarted.calls.filter(call => call.url === fixture.manifestUrl).length, 1);
  assert.equal(restarted.calls.filter(call => call.url === fixture.assetUrl).length, 0);
});

test('a failed immutable manifest load retries on the next runtime request', async () => {
  const fixture = runtimeFixture();
  const valid = fixture.routes.get(fixture.manifestUrl);
  fixture.routes.set(fixture.manifestUrl, new TypeError('temporary network failure'));
  const worker = runtimeWorker(fixture);
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  fixture.routes.set(fixture.manifestUrl, valid);
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(await (await worker.fetch(fixture.assetUrl)).text(), fixture.body);
  assert.equal(worker.calls.filter(call => call.url === fixture.manifestUrl).length, 2);
  assert.equal(worker.calls.filter(call => call.url === fixture.assetUrl).length, 2);
});

test('a navigation without a valid app-local immutable identity cannot inherit another document map', async () => {
  const fixture = runtimeFixture();
  const worker = runtimeWorker(fixture);
  await worker.fetch(fixture.assetUrl);
  const outside = fixture.manifestUrl.replace('/app/', '/another-app/');
  fixture.routes.set(new URL('./', worker.workerUrl).href, new Response(`<html><head><meta name="neurodesk-runtime-manifest" content="${outside}"></head></html>`));
  fixture.routes.set(fixture.assetUrl, new Response('ordinary network bytes'));
  await worker.fetch('./', { mode: 'navigate', clientId: 'document-two' });
  assert.equal(await (await worker.fetch(fixture.assetUrl, { clientId: 'document-two' })).text(), 'ordinary network bytes');
  assert.equal(worker.calls.filter(call => call.url === outside).length, 0);
});

function bootstrapPage({ isolated = false, controller = null, registration, storage = new Map(), coi } = {}) {
  const page = { reloads: 0 };
  page.window = {
    coi,
    crossOriginIsolated: isolated,
    isSecureContext: true,
    document: { currentScript: { src: 'https://example.test/app/coi-serviceworker.js' } },
    location: { reload: () => { page.reloads++; } },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      removeItem: (key) => storage.delete(key),
      setItem: (key, value) => storage.set(key, value),
    },
  };
  vm.runInNewContext(source, {
    console: { error() {}, log() {}, warn() {} },
    navigator: { serviceWorker: { controller, register: async () => registration } },
    window: page.window,
  });
  return page;
}

function workerIn(state) {
  const worker = { state, listeners: [], addEventListener: (type, listener) => worker.listeners.push(listener) };
  worker.become = (next) => {
    worker.state = next;
    for (const listener of worker.listeners) listener();
  };
  return worker;
}

test('a first-visit worker that turns redundant settles the page as staying', async () => {
  const installing = workerIn('installing');
  const page = bootstrapPage({ registration: { installing, waiting: null, active: null, addEventListener() {} } });
  await new Promise((resolve) => setImmediate(resolve));
  installing.become('redundant');
  assert.equal(await page.window.coiWillReload, false);
  assert.equal(page.reloads, 0);
});

test('a bootstrap that cannot use sessionStorage settles the page as staying', async () => {
  const page = bootstrapPage({ storage: { get: () => { throw new DOMException('denied', 'SecurityError'); } } });
  assert.equal(await page.window.coiWillReload, false);
  assert.equal(page.reloads, 0);
});

test('a first visit that cannot write its reload marker stays, and says so', async () => {
  const storage = { get: () => undefined, delete() {}, set: () => { throw new DOMException('full', 'QuotaExceededError'); } };
  const page = bootstrapPage({ storage, registration: { installing: null, waiting: null, active: { state: 'activated' }, addEventListener() {} } });
  assert.equal(await page.window.coiWillReload, false);
  assert.equal(page.reloads, 0);
});

for (const held of [false, true]) {
  test(`a worker update on a controlled, unisolated page ${held ? 'waits while reloads are held' : 'reloads it as before'}`, async () => {
    let updatefound;
    const registration = {
      installing: null,
      addEventListener: (type, listener) => { if (type === 'updatefound') updatefound = listener; },
    };
    const page = bootstrapPage({ controller: { postMessage() {} }, registration, coi: { coepDegrade: () => false } });
    assert.equal(await page.window.coiWillReload, false);
    if (held) page.window.coiHoldReloads();
    registration.installing = workerIn('installing');
    updatefound();
    registration.installing.become('activated');
    assert.equal(page.reloads, held ? 0 : 1);
  });
}
