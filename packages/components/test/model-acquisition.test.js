import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModel } from '../src/worker/fetchModel.js';

const bytes = new Uint8Array([1, 2, 3]);
const hash = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
const asset = { url: 'https://example.org/model', integrity: { bytes: 3, sha256: hash } };

function namedCache(t, initial, faults = {}) {
  const previous = globalThis.caches;
  const calls = [];
  let stored = initial;
  globalThis.caches = {
    async open(name) {
      calls.push(['open', name]);
      if (faults.open) throw faults.open;
      return {
        async match(key) {
          calls.push(['match', key]);
          if (faults.read) throw faults.read;
          return stored?.clone();
        },
        async delete(key) {
          calls.push(['delete', key]);
          if (faults.delete) throw faults.delete;
          stored = null;
        },
        async put(key, response) {
          calls.push(['put', key]);
          if (faults.write) throw faults.write;
          stored = response;
        },
      };
    },
  };
  t.after(() => { globalThis.caches = previous; });
  return calls;
}

test('named cache stores verified bytes and serves them offline', async t => {
  const calls = namedCache(t);
  let requests = 0;
  const options = { cache: 'models-v1', fetch: async () => { requests++; return new Response(bytes); } };
  assert.deepEqual(new Uint8Array(await fetchModel(asset, options)), bytes);
  assert.deepEqual(new Uint8Array(await fetchModel(asset, { ...options, fetch: async () => { throw Error('offline'); } })), bytes);
  assert.equal(requests, 1);
  assert.deepEqual(calls.slice(0, 3), [['open', 'models-v1'], ['match', asset.url], ['put', asset.url]]);
});

test('corrupt named cache is deleted and replaced in the same call', async t => {
  const calls = namedCache(t, new Response(new Uint8Array([9, 9, 9])));
  await fetchModel(asset, { cache: 'models', fetch: async () => new Response(bytes) });
  assert.equal(calls.filter(([op]) => op === 'delete').length, 1);
  assert.equal(calls.filter(([op]) => op === 'put').length, 1);
});

for (const fault of ['read', 'delete']) {
  test(`named cache ${fault} failure remains fatal`, async t => {
    const calls = namedCache(t, new Response(new Uint8Array([9])), { [fault]: Error(fault) });
    await assert.rejects(fetchModel(asset, { cache: 'models', fetch: async () => { assert.fail('network must not run'); } }), new RegExp(fault));
    assert.equal(calls.some(([op]) => op === 'put'), false);
  });
}

for (const fault of ['open', 'write']) {
  test(`named cache ${fault} failure is optional`, async t => {
    namedCache(t, null, { [fault]: Error(fault) });
    assert.deepEqual(new Uint8Array(await fetchModel(asset, { cache: 'models', fetch: async () => new Response(bytes) })), bytes);
  });
}

test('oversized stream cancels before reading another chunk and releases its lock', async () => {
  let reads = 0;
  let cancelled = false;
  let released = false;
  await assert.rejects(fetchModel(asset, { fetch: async () => ({ ok: true, body: { getReader: () => ({
    async read() {
      reads++;
      return reads === 1 ? { done: false, value: new Uint8Array(4) } : { done: true };
    },
    async cancel() { cancelled = true; throw Error('cancel'); },
    releaseLock() { released = true; },
  }) } }) }), /size mismatch/);
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('content length is only a progress hint without a size pin', async () => {
  const result = await fetchModel('/model', { fetch: async () => new Response(bytes, { headers: { 'Content-Length': '1' } }) });
  assert.equal(result.byteLength, 3);
});

test('HTML response is cancelled without reading or publishing it', async () => {
  let cancelled = false;
  await assert.rejects(fetchModel('/model', { fetch: async () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/html' }), body: { async cancel() { cancelled = true; } } }) }), /download failed/);
  assert.equal(cancelled, true);
});

test('cached oversized response cancels early and recovers', async t => {
  let reads = 0;
  let cancelled = false;
  let deleted = false;
  const previous = globalThis.caches;
  globalThis.caches = { async open() { return {
    async match() { return { body: { getReader: () => ({
      async read() {
        reads++;
        return reads === 1 ? { done: false, value: new Uint8Array(4) } : { done: true };
      },
      async cancel() { cancelled = true; },
      releaseLock() {},
    }) } }; },
    async delete() { deleted = true; },
    async put() {},
  }; } };
  t.after(() => { globalThis.caches = previous; });
  assert.deepEqual(new Uint8Array(await fetchModel(asset, { cache: 'models', fetch: async () => new Response(bytes) })), bytes);
  assert.equal(reads, 1);
  assert.equal(cancelled, true);
  assert.equal(deleted, true);
});

test('crypto infrastructure failure does not evict cached bytes', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: { digest: async () => { throw Error('crypto unavailable'); } } } });
  t.after(() => { Object.defineProperty(globalThis, 'crypto', previous); });
  const calls = namedCache(t, new Response(bytes));
  await assert.rejects(fetchModel(asset, { cache: 'models', fetch: async () => { assert.fail('network must not run'); } }), /crypto unavailable/);
  assert.equal(calls.some(([op]) => op === 'delete'), false);
});

test('adapter preserves keys, callbacks, fallback options and verified publication', async () => {
  const events = [];
  const result = await fetchModel({ ...asset, cacheKey: 'release/hash', urls: ['/failed', '/model'] }, {
    requestCache: 'no-store',
    cache: {
      async get(key) { events.push(['get', key]); return new Uint8Array([9]); },
      async delete(key) { events.push(['delete', key]); },
      async set(key, value) { events.push(['set', key, value.byteLength]); },
    },
    onInvalidCache: () => events.push(['invalid']),
    onDownloaded: event => events.push(['downloaded', event.url, event.bytes]),
    fetch: async (url, options) => {
      assert.equal(options.cache, 'no-store');
      return url === '/failed' ? new Response(null, { status: 503 }) : new Response(bytes);
    },
  });
  assert.equal(result.byteLength, 3);
  assert.deepEqual(events, [['get', 'release/hash'], ['delete', 'release/hash'], ['invalid'], ['set', 'release/hash', 3], ['downloaded', '/model', 3]]);
});

test('reader failure is fatal, cancels and retains original error', async () => {
  let cancelled = false;
  await assert.rejects(fetchModel('/model', { fetch: async () => ({ ok: true, body: { getReader: () => ({
    async read() { throw Error('reader failed'); },
    async cancel() { cancelled = true; throw Error('cancel failed'); },
    releaseLock() { throw Error('release failed'); },
  }) } }) }), /reader failed/);
  assert.equal(cancelled, true);
});
