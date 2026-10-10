import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModel } from '../src/worker/index.js';

// FIPS 180-2 test vector: SHA-256("abc").
const ABC = new TextEncoder().encode('abc');
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const text = buffer => new TextDecoder().decode(buffer);
const respond = bytes => ({ ok: true, headers: new Map(), body: null, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

function memoryCache(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: async key => store.get(key) ?? null,
    set: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
  };
}

test('a download whose SHA-256 matches the manifest is returned and cached', async () => {
  const cache = memoryCache();
  const bytes = await fetchModel(
    { url: '/model.onnx', cacheKey: 'model@1', integrity: { sha256: ABC_SHA256.toUpperCase(), bytes: 3 } },
    { fetch: async () => respond(ABC), cache },
  );
  assert.equal(text(bytes), 'abc');
  assert.equal(text(cache.store.get('model@1')), 'abc');
});

test('a download with the right size and the wrong bytes is rejected and never cached', async () => {
  const cache = memoryCache();
  await assert.rejects(
    fetchModel(
      { url: '/model.onnx', cacheKey: 'model@1', integrity: { sha256: ABC_SHA256, bytes: 3 } },
      { fetch: async () => respond(new TextEncoder().encode('abd')), cache },
    ),
    /SHA-256 mismatch/,
  );
  assert.equal(cache.store.size, 0);
});

test('a verified cache entry is served without touching the network', async () => {
  let requests = 0;
  const bytes = await fetchModel(
    { url: '/model.onnx', cacheKey: 'model@1', integrity: { sha256: ABC_SHA256 } },
    { fetch: async () => { requests += 1; return respond(ABC); }, cache: memoryCache({ 'model@1': ABC }) },
  );
  assert.equal(text(bytes), 'abc');
  assert.equal(requests, 0);
});

test('a corrupted cache entry is dropped and replaced by a fresh verified download', async () => {
  const cache = memoryCache({ 'model@1': new TextEncoder().encode('xyz') });
  const invalid = [];
  const bytes = await fetchModel(
    { url: '/model.onnx', cacheKey: 'model@1', integrity: { sha256: ABC_SHA256 } },
    { fetch: async () => respond(ABC), cache, onInvalidCache: error => invalid.push(error.message) },
  );
  assert.equal(text(bytes), 'abc');
  assert.equal(text(cache.store.get('model@1')), 'abc');
  assert.deepEqual(invalid, ['Model SHA-256 mismatch']);
});

test('mirrors are tried in order after a failed or refused request', async () => {
  const requested = [];
  const downloaded = [];
  const bytes = await fetchModel(
    { url: '/primary', urls: ['/primary', '/offline', '/mirror', '/unused'], integrity: { sha256: ABC_SHA256 } },
    {
      fetch: async url => {
        requested.push(url);
        if (url === '/primary') return { ok: false, status: 503 };
        if (url === '/offline') throw new TypeError('Failed to fetch');
        return respond(ABC);
      },
      onDownloaded: event => downloaded.push(event),
    },
  );
  assert.equal(text(bytes), 'abc');
  assert.deepEqual(requested, ['/primary', '/offline', '/mirror']);
  assert.deepEqual(downloaded, [{ url: '/mirror', bytes: 3 }]);
});

test('when every source fails the last failure is reported', async () => {
  await assert.rejects(
    fetchModel({ url: '/a', urls: ['/a', '/b'] }, { fetch: async url => ({ ok: false, status: url === '/a' ? 500 : 404 }) }),
    /Model download failed \(404\): \/b/,
  );
});

test('a download below the declared minimum size is reported as truncated', async () => {
  await assert.rejects(
    fetchModel({ url: '/model', integrity: { minBytes: 10 } }, { fetch: async () => respond(ABC) }),
    /truncated: expected at least 10 bytes, received 3/,
  );
});

test('a full cache does not fail a verified download', async () => {
  const cacheErrors = [];
  const bytes = await fetchModel(
    { url: '/model', integrity: { sha256: ABC_SHA256 } },
    {
      fetch: async () => respond(ABC),
      cache: { get: async () => null, set: async () => { throw new Error('QuotaExceededError'); } },
      onCacheError: error => cacheErrors.push(error.message),
    },
  );
  assert.equal(text(bytes), 'abc');
  assert.deepEqual(cacheErrors, ['QuotaExceededError']);
});

test('a rejected body cancellation preserves the actionable download error', async () => {
  await assert.rejects(fetchModel({ url: 'https://example.test/model' }, {
    fetch: async () => ({ ok: false, status: 503, headers: new Map(), body: {
      async cancel() { throw new Error('body already closed'); },
    } }),
  }), /Model download failed \(503\)/);
});
