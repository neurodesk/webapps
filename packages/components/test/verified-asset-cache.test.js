import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModel, VERIFIED_ASSET_CACHE } from '../src/worker/fetchModel.js';

const bytes = new Uint8Array([1, 2, 3]);
const sha256 = '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81';
const asset = { url: 'https://models.example.org/release/model', integrity: { bytes: 3, sha256 } };
const key = `https://apps.example.org/__neurodesk_cache__/sha256/${sha256}`;
const noNetwork = async () => assert.fail('verified cache hit must not fetch');

function replaceGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

function browserCache(t, faults = {}) {
  const entries = new Map();
  const operations = [];
  replaceGlobal(t, 'location', new URL('https://apps.example.org/app/'));
  replaceGlobal(t, 'caches', {
    async open(name) {
      operations.push(['open', name]);
      if (faults.open) throw faults.open;
      return {
        async match(id) {
          operations.push(['match', id]);
          if (faults.read) throw faults.read;
          const entry = entries.get(id);
          return entry ? new Response(await entry.clone().arrayBuffer()) : undefined;
        },
        async put(id, response) {
          operations.push(['put', id]);
          if (faults.write) throw faults.write;
          entries.set(id, response);
        },
        async delete(id) {
          operations.push(['delete', id]);
          if (faults.delete) throw faults.delete;
          entries.delete(id);
        },
      };
    },
  });
  return { entries, operations };
}

test('default cache reuses SHA-256 identity across URL, app path and cacheKey changes', async t => {
  const { entries, operations } = browserCache(t);
  let downloaded = 0;
  await fetchModel(asset, { fetch: async () => { downloaded++; return new Response(bytes); } });
  globalThis.location = new URL('https://apps.example.org/another-app/');
  const mirror = { ...asset, url: 'https://mirror.example.org/new-release/model', cacheKey: 'different-deployment',
    integrity: { ...asset.integrity, sha256: sha256.toUpperCase() } };
  assert.deepEqual(new Uint8Array(await fetchModel(mirror, { fetch: noNetwork })), bytes);
  assert.equal(downloaded, 1);
  assert.deepEqual([...entries.keys()], [key]);
  assert.ok(operations.filter(([op]) => op === 'open').every(([, name]) => name === VERIFIED_ASSET_CACHE));
});

test('default cache verifies bytes again and replaces a corrupt entry', async t => {
  const { entries } = browserCache(t);
  entries.set(key, new Response(new Uint8Array([9, 9, 9])));
  const invalid = [];
  const result = await fetchModel(asset, {
    fetch: async () => new Response(bytes),
    onInvalidCache: error => invalid.push(error.message),
  });
  assert.deepEqual(new Uint8Array(result), bytes);
  assert.deepEqual(invalid, ['Model SHA-256 mismatch']);
  assert.deepEqual(new Uint8Array(await entries.get(key).arrayBuffer()), bytes);
});

test('a changed SHA-256 requires a fresh download', async t => {
  const { entries } = browserCache(t);
  entries.set(key, new Response(bytes));
  let requested = false;
  await assert.rejects(fetchModel({ ...asset, integrity: { ...asset.integrity, sha256: '0'.repeat(64) } }, {
    fetch: async () => { requested = true; return new Response(bytes); },
  }), /SHA-256 mismatch/);
  assert.equal(requested, true);
  assert.equal(entries.size, 1);
});

test('explicit null and assets without a SHA-256 pin do not open automatic storage', async t => {
  const { operations } = browserCache(t);
  for (const [record, options] of [[asset, { cache: null }], [{ url: asset.url }, {}],
    [{ ...asset, integrity: { bytes: 3 } }, {}]]) {
    await fetchModel(record, { ...options, fetch: async () => new Response(bytes) });
  }
  assert.deepEqual(operations, []);
});

test('an inaccessible CacheStorage getter reports the error and returns verified download', async t => {
  browserCache(t);
  const failure = new DOMException('Storage is not permitted', 'SecurityError');
  Object.defineProperty(globalThis, 'caches', { configurable: true, get() { throw failure; } });
  const reported = [];
  let downloaded = 0;
  const result = await fetchModel(asset, {
    fetch: async () => { downloaded++; return new Response(bytes); },
    onCacheError: error => reported.push(error),
  });
  assert.deepEqual(new Uint8Array(result), bytes);
  assert.equal(downloaded, 1);
  assert.deepEqual(reported, [failure]);
});

test('opaque origins bypass automatic storage and still verify downloaded bytes', async t => {
  browserCache(t);
  replaceGlobal(t, 'location', new URL('data:text/html,opaque'));
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    get() { throw new Error('opaque origins must not access CacheStorage'); },
  });
  const result = await fetchModel(asset, { fetch: async () => new Response(bytes) });
  assert.deepEqual(new Uint8Array(result), bytes);
  await assert.rejects(fetchModel(asset, { fetch: async () => new Response(new Uint8Array([9, 9, 9])) }), /SHA-256 mismatch/);
});

for (const fault of ['open', 'read', 'delete', 'write']) {
  test(`automatic cache ${fault} failure reports the error and still returns verified download`, async t => {
    const failure = Error(`${fault} unavailable`);
    const { entries } = browserCache(t, { [fault]: failure });
    if (fault === 'delete') entries.set(key, new Response(new Uint8Array([9])));
    const reported = [];
    const result = await fetchModel(asset, { fetch: async () => new Response(bytes), onCacheError: error => reported.push(error) });
    assert.deepEqual(new Uint8Array(result), bytes);
    assert.deepEqual(reported, [failure]);
  });
}

test('optional cache failures warn when the caller has no error hook', async t => {
  browserCache(t, { open: Error('storage unavailable') });
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  await fetchModel(asset, { fetch: async () => new Response(bytes) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][1].message, /storage unavailable/);
});

test('failed, partial and invalid downloads never publish to shared storage', async t => {
  const { entries } = browserCache(t);
  for (const response of [
    () => new Response(null, { status: 404 }),
    () => new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(new Uint8Array([1])),
    () => new Response(new Uint8Array([9, 9, 9])),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.error(Error('connection lost')); } })),
  ]) {
    await assert.rejects(fetchModel(asset, { fetch: async () => response() }));
    assert.equal(entries.size, 0);
  }
});

test('already cancelled cache hits reject without touching storage', async t => {
  const { entries, operations } = browserCache(t);
  entries.set(key, new Response(bytes));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fetchModel(asset, { signal: controller.signal, fetch: noNetwork }), { name: 'AbortError' });
  assert.deepEqual(operations, []);
});

test('cancelling a cached read stops delivery without evicting verified bytes', async t => {
  const { entries, operations } = browserCache(t);
  entries.set(key, new Response(bytes));
  const controller = new AbortController();
  await assert.rejects(fetchModel(asset, { signal: controller.signal, fetch: noNetwork,
    onProgress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(entries.size, 1);
  assert.equal(operations.some(([op]) => op === 'delete'), false);
});

test('cancelling streamed download prevents cache publication and completion callback', async t => {
  const { entries } = browserCache(t);
  const controller = new AbortController();
  let completed = false;
  await assert.rejects(fetchModel(asset, { signal: controller.signal,
    fetch: async () => new Response(bytes), onProgress: () => controller.abort(),
    onDownloaded: () => { completed = true; } }), { name: 'AbortError' });
  assert.equal(entries.size, 0);
  assert.equal(completed, false);
});

test('cancellation during verification prevents publication', async t => {
  const { entries } = browserCache(t);
  const controller = new AbortController();
  const crypto = globalThis.crypto;
  replaceGlobal(t, 'crypto', { subtle: { async digest(...args) {
    const result = await crypto.subtle.digest(...args);
    controller.abort();
    return result;
  } } });
  await assert.rejects(fetchModel(asset, { signal: controller.signal,
    fetch: async () => new Response(bytes) }), { name: 'AbortError' });
  assert.equal(entries.size, 0);
});

test('verification infrastructure errors retain cached bytes and do not fetch', async t => {
  const { entries } = browserCache(t);
  entries.set(key, new Response(bytes));
  replaceGlobal(t, 'crypto', { subtle: { digest: async () => { throw Error('crypto unavailable'); } } });
  await assert.rejects(fetchModel(asset, { fetch: noNetwork }), /crypto unavailable/);
  assert.equal(entries.size, 1);
});

test('window requests persistent storage once and a denied request does not block loading', async t => {
  browserCache(t);
  let requested = 0;
  replaceGlobal(t, 'window', globalThis);
  replaceGlobal(t, Symbol.for('neurodesk.storage.persistenceRequested'), undefined);
  replaceGlobal(t, 'navigator', { storage: { async persist() { requested++; return false; } } });
  await fetchModel(asset, { fetch: async () => new Response(bytes) });
  await fetchModel(asset, { fetch: noNetwork });
  assert.equal(requested, 1);
});

test('worker does not call the window-only persistence API', async t => {
  browserCache(t);
  let requested = false;
  replaceGlobal(t, 'navigator', { storage: { async persist() { requested = true; } } });
  await fetchModel(asset, { fetch: async () => new Response(bytes) });
  assert.equal(requested, false);
});
