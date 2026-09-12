import assert from 'node:assert/strict';
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

  installing.state = 'activated';
  stateChangeListener();

  assert.equal(reloads, 1);
  assert.equal(storage.get('coiReloadedBySelf'), 'notcontrolling');
});
