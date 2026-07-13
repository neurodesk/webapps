#!/usr/bin/env node --no-warnings
// Phase 33 audit follow-up: regression test for the Phase 4 Cache Storage
// silent-fail bug.
//
// History: when the FC pack first landed, the cacheKey was passed as
// the *entire* Request to Cache.put (e.g. 'yeo7-fc-pack-adhd200-n30-v1').
// Chromium silently rejected the put because the string parsed as a
// URL scheme rather than a normal URL — the put failed but the function
// kept going, and the user's "cache" was always empty. Every page load
// re-fetched 30 MB of FC pack from Hugging Face.
//
// The fix: fold cacheKey into the URL fragment ('${url}#${cacheKey}'),
// which is a valid URL and gets stored properly. This test asserts the
// fix is in place by inspecting what cacheUrl the helper passes to
// cache.put / cache.match.

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { fetchCacheFirst, loadConnectomeChannelsFromManifest } =
  await import(path.join(ROOT, 'web/js/modules/atlas-loader.js'));

// Recording fake Cache that captures every put/match argument.
function makeFakeCache(initial = []) {
  const store = new Map(initial);   // urlKey -> ArrayBuffer
  const calls = { match: [], put: [] };
  return {
    calls,
    async match(req) {
      calls.match.push(req);
      const buf = store.get(req);
      if (!buf) return undefined;
      return {
        async arrayBuffer() { return buf; }
      };
    },
    async put(req, response) {
      calls.put.push(req);
      const buf = await response.arrayBuffer();
      store.set(req, buf);
    }
  };
}

const ORIG_FETCH = globalThis.fetch;

function stubFetch(payload) {
  globalThis.fetch = async (url) => ({
    ok: true,
    arrayBuffer: async () => payload,
    clone() {
      return {
        async arrayBuffer() { return payload; }
      };
    }
  });
}

function restoreFetch() { globalThis.fetch = ORIG_FETCH; }

// ---- Test 1: cacheKey is folded into the URL as a fragment ----
{
  const url = 'https://example.com/asset.bin';
  const cacheKey = 'yeo7-fc-pack-adhd200-n30-v1';
  const expectedCacheUrl = `${url}#${encodeURIComponent(cacheKey)}`;
  const cache = makeFakeCache();
  const payload = new Uint8Array([1, 2, 3, 4]).buffer;
  stubFetch(payload);
  try {
    const buf = await fetchCacheFirst(url, cacheKey, cache);
    assert.equal(buf.byteLength, 4, 'payload round-trip');
    // The match attempt + the put MUST use the URL+fragment form, NOT
    // the bare cacheKey (which Chromium would reject).
    assert.deepEqual(cache.calls.match, [expectedCacheUrl],
      `match must use URL#cacheKey (regression: bare cacheKey would crash Cache.put)`);
    assert.deepEqual(cache.calls.put, [expectedCacheUrl],
      `put must use URL#cacheKey`);
    // Critically: the bare cacheKey must NEVER appear as a key.
    assert.ok(!cache.calls.match.includes(cacheKey),
      'bare cacheKey must not be passed to Cache.match');
    assert.ok(!cache.calls.put.includes(cacheKey),
      'bare cacheKey must not be passed to Cache.put');
  } finally { restoreFetch(); }
}

// ---- Test 2: warm cache short-circuits the fetch ----
{
  const url = 'https://example.com/cached.bin';
  const cacheKey = 'cached-key-v1';
  const cacheUrl = `${url}#${encodeURIComponent(cacheKey)}`;
  const warmPayload = new Uint8Array([9, 8, 7]).buffer;
  const cache = makeFakeCache([[cacheUrl, warmPayload]]);
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not fetch'); };
  try {
    const buf = await fetchCacheFirst(url, cacheKey, cache);
    assert.equal(fetchCalled, false,
      'a cache hit must NOT trigger a network fetch');
    const u8 = new Uint8Array(buf);
    assert.deepEqual(Array.from(u8), [9, 8, 7], 'warm cache returns the stored bytes');
  } finally { restoreFetch(); }
}

// ---- Test 3: cacheKey omitted -> raw URL is used as cache key ----
{
  const url = 'https://example.com/no-key.bin';
  const cache = makeFakeCache();
  stubFetch(new Uint8Array([0]).buffer);
  try {
    await fetchCacheFirst(url, null, cache);
    assert.deepEqual(cache.calls.put, [url],
      'omitted cacheKey -> bare URL (no fragment)');
  } finally { restoreFetch(); }
}

// ---- Test 4: cache.put failure is non-fatal (network response still returned) ----
{
  const url = 'https://example.com/put-fails.bin';
  const cacheKey = 'k';
  const payload = new Uint8Array([42]).buffer;
  const cache = {
    calls: { match: [], put: [] },
    async match() { this.calls.match.push('m'); return undefined; },
    async put() { throw new Error('synthetic put failure'); }
  };
  stubFetch(payload);
  try {
    const buf = await fetchCacheFirst(url, cacheKey, cache);
    const u8 = new Uint8Array(buf);
    assert.deepEqual(Array.from(u8), [42],
      'fetchCacheFirst must return the network bytes even when cache.put throws');
  } finally { restoreFetch(); }
}

// ---- Test 5: HTTP error surfaces as a thrown error (no silent empty buffer) ----
{
  const url = 'https://example.com/404.bin';
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    await assert.rejects(
      () => fetchCacheFirst(url, 'k', makeFakeCache()),
      /HTTP 404/,
      'a 404 must surface as a thrown Error, not return empty bytes'
    );
  } finally { restoreFetch(); }
}

// ---- Test 6: no cache passed -> still fetches and returns ----
{
  const payload = new Uint8Array([100, 200]).buffer;
  stubFetch(payload);
  try {
    const buf = await fetchCacheFirst('https://example.com/nocache.bin', null, null);
    assert.equal(buf.byteLength, 2, 'payload returned without a cache');
  } finally { restoreFetch(); }
}

// ---- Test 7: Phase 37 — onProgress callback fires during streaming download ----
// fetchCacheFirst opts into the streaming-tee path when an onProgress
// callback is provided AND the response body is a ReadableStream. Stub
// a streaming response with two chunks to verify both progress updates
// land + the final buffer is correctly assembled.
{
  const chunks = [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([5, 6, 7, 8, 9])
  ];
  const totalBytes = 9;
  const url = 'https://example.com/streamed.bin';
  globalThis.fetch = async () => {
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      }
    });
    return {
      ok: true,
      status: 200, statusText: 'OK',
      headers: { get: (k) => k.toLowerCase() === 'content-length' ? String(totalBytes) : null },
      body: stream
    };
  };
  const cache = makeFakeCache();
  const events = [];
  try {
    const buf = await fetchCacheFirst(url, 'streamed-key', cache, {
      onProgress: (e) => events.push({ ...e })
    });
    const u8 = new Uint8Array(buf);
    assert.deepEqual(Array.from(u8), [1, 2, 3, 4, 5, 6, 7, 8, 9],
      'streamed chunks must concatenate in order');
    assert.equal(events.length, 2, 'exactly one progress event per chunk');
    assert.equal(events[0].received, 4);
    assert.equal(events[0].total, 9);
    assert.equal(events[0].label, 'streamed-key');
    assert.equal(events[1].received, 9);
    assert.equal(events[1].total, 9);
    // Cache must be populated with the streamed bytes too.
    assert.ok(cache.calls.put.length === 1,
      `cache should be populated once; got ${cache.calls.put.length} put calls`);
  } finally { restoreFetch(); }
}

// ---- Test 8: onProgress callback exception is swallowed (best-effort) ----
{
  const chunks = [new Uint8Array([1, 2, 3])];
  globalThis.fetch = async () => {
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(chunks[i++]);
        else controller.close();
      }
    });
    return {
      ok: true,
      status: 200, statusText: 'OK',
      headers: { get: () => '3' },
      body: stream
    };
  };
  try {
    const buf = await fetchCacheFirst('https://example.com/err.bin', 'k', null, {
      onProgress: () => { throw new Error('synthetic onProgress failure'); }
    });
    assert.equal(buf.byteLength, 3,
      'fetchCacheFirst must complete even when onProgress throws');
  } finally { restoreFetch(); }
}

// ---- Test 9: Schaefer-style lazy channel loading fetches only needed shards ----
{
  const originalCaches = globalThis.caches;
  globalThis.caches = undefined;
  const fetched = [];
  const index = {
    dtype: 'float16',
    shape: [4, 2, 1, 1],
    voxelsPerMap: 2,
    shards: [
      {
        id: '001-002',
        sourceUrl: 'https://example.com/schaefer-shard-a.bin',
        cacheKey: 'schaefer-shard-a',
        channelLabels: ['1', '2']
      },
      {
        id: '003-004',
        sourceUrl: 'https://example.com/schaefer-shard-b.bin',
        cacheKey: 'schaefer-shard-b',
        channelLabels: ['3', '4']
      }
    ]
  };
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetched.push(href);
    if (href.includes('manifest.json')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            connectomeAssets: [{
              id: 'schaefer400-test-pack',
              sourceUrl: 'https://example.com/schaefer-full.bin',
              indexSourceUrl: 'https://example.com/schaefer-index.json',
              cacheKey: 'schaefer-test-pack',
              supportStatus: 'supported'
            }]
          };
        }
      };
    }
    if (href === 'https://example.com/schaefer-index.json') {
      const payload = new TextEncoder().encode(JSON.stringify(index)).buffer;
      return { ok: true, status: 200, async arrayBuffer() { return payload; } };
    }
    if (href === 'https://example.com/schaefer-shard-b.bin') {
      const payload = new Uint8Array([1, 2, 3, 4]).buffer;
      return { ok: true, status: 200, async arrayBuffer() { return payload; } };
    }
    throw new Error(`unexpected fetch in lazy-channel test: ${href}`);
  };

  try {
    const result = await loadConnectomeChannelsFromManifest('schaefer400-test-pack', ['3']);
    assert.equal(result.shards.length, 1,
      'lazy connectome loading must return only shards containing requested channels');
    assert.deepEqual(result.shards[0].neededLabels, ['3'],
      'lazy connectome loading must record the exact requested labels per shard');
    assert.ok(!fetched.includes('https://example.com/schaefer-full.bin'),
      'lazy connectome loading must not fetch the whole Schaefer pack');
    assert.ok(!fetched.includes('https://example.com/schaefer-shard-a.bin'),
      'lazy connectome loading must not fetch unrelated Schaefer shards');
    assert.ok(fetched.includes('https://example.com/schaefer-shard-b.bin'),
      'lazy connectome loading must fetch the shard containing the requested parcel');
  } finally {
    restoreFetch();
    globalThis.caches = originalCaches;
  }
}

console.log('atlas-loader cache OK: URL fragment fix + streaming progress + lazy channel loading + failure cases.');
