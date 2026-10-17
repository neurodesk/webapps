import assert from 'node:assert/strict'
import test from 'node:test'
import { createExampleAssetFetch } from '../src/example_asset_fetch.js'

const bytes = new Uint8Array([1, 2, 3])
const asset = {
  url: 'https://example.org/zarr/0/0.0.0',
  bytes: bytes.byteLength,
  sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81',
}

function browserCache(t) {
  const previousLocation = globalThis.location
  const previousCaches = globalThis.caches
  const stored = new Map()
  globalThis.location = { origin: 'https://zarro.example.org' }
  globalThis.caches = { async open() {
    return {
      async match(key) { return stored.get(key)?.clone() },
      async put(key, response) { stored.set(key, response) },
      async delete(key) { return stored.delete(key) },
    }
  } }
  t.after(() => {
    globalThis.location = previousLocation
    globalThis.caches = previousCaches
  })
  return stored
}

function response() {
  return new Response(bytes, { headers: { 'Content-Length': String(bytes.byteLength) } })
}

test('declared pinned GET verifies and persists bytes for a new adapter offline', async (t) => {
  browserCache(t)
  let requests = 0
  const initial = createExampleAssetFetch([asset], { fetch: async (request) => {
    requests++
    assert.equal(request.headers.get('X-Zarr-Test'), 'forwarded')
    return response()
  } })
  const request = new Request(asset.url, { headers: { 'X-Zarr-Test': 'forwarded' } })
  const first = await initial(request)
  assert.deepEqual(new Uint8Array(await first.response.arrayBuffer()), bytes)
  assert.equal(first.wireBytes, 3)
  const offline = createExampleAssetFetch([asset], { fetch: async () => assert.fail('network used for cached asset') })
  const second = await offline(request)
  assert.deepEqual(new Uint8Array(await second.response.arrayBuffer()), bytes)
  assert.equal(second.wireBytes, 0)
  assert.equal(requests, 1)
})

test('corrupt cached bytes are discarded and replaced with verified data', async (t) => {
  const stored = browserCache(t)
  const key = `https://zarro.example.org/__neurodesk_cache__/sha256/${asset.sha256}`
  stored.set(key, new Response(new Uint8Array([9, 9, 9])))
  let requests = 0
  const fetchAsset = createExampleAssetFetch([asset], { fetch: async () => { requests++; return response() } })
  const result = await fetchAsset(new Request(asset.url))
  assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), bytes)
  assert.deepEqual(new Uint8Array(await stored.get(key).arrayBuffer()), bytes)
  assert.equal(requests, 1)
})

test('aborted declared requests fail before cache or network acquisition', async (t) => {
  browserCache(t)
  const controller = new AbortController()
  controller.abort()
  const fetchAsset = createExampleAssetFetch([asset], { fetch: async () => assert.fail('aborted request fetched') })
  await assert.rejects(fetchAsset(new Request(asset.url, { signal: controller.signal })), { name: 'AbortError' })
})

test('unlisted, HEAD, range and conditional requests retain their native responses', async (t) => {
  const stored = browserCache(t)
  const cases = [
    new Request('https://user.example.org/zarr/0/0.0.0'),
    new Request(asset.url, { method: 'HEAD' }),
    new Request(asset.url, { headers: { Range: 'bytes=1-2' } }),
    new Request(asset.url, { headers: { 'If-None-Match': 'etag' } }),
  ]
  for (const request of cases) {
    const original = new Response(request.method === 'HEAD' ? null : bytes, {
      status: request.headers.has('Range') ? 206 : 200,
      headers: { 'Content-Length': '3' },
    })
    const fetchAsset = createExampleAssetFetch([asset], { fetch: async (forwarded) => {
      assert.equal(forwarded.url, request.url)
      assert.equal(forwarded.method, request.method)
      assert.deepEqual([...forwarded.headers], [...request.headers])
      return original
    } })
    const result = await fetchAsset(request)
    assert.equal(result.response, original)
    assert.equal(result.wireBytes, request.method === 'HEAD' ? 0 : 3)
  }
  assert.equal(stored.size, 0)
})

test('declared asset HTTP errors and retry behavior remain visible to the Zarr reader', async (t) => {
  const stored = browserCache(t)
  let requests = 0
  const fetchAsset = createExampleAssetFetch([asset], { fetch: async () => {
    requests++
    return new Response('missing', { status: requests === 1 ? 429 : 404, headers: { 'Retry-After': '0' } })
  } })
  const result = await fetchAsset(new Request(asset.url))
  assert.equal(result.response.status, 404)
  assert.equal(await result.response.text(), 'missing')
  assert.equal(requests, 2)
  assert.equal(stored.size, 0)
})

test('declared asset corruption fails integrity verification and is never published', async (t) => {
  const stored = browserCache(t)
  const fetchAsset = createExampleAssetFetch([asset], { fetch: async () => new Response(new Uint8Array([9, 9, 9])) })
  await assert.rejects(fetchAsset(new Request(asset.url)), /SHA-256 mismatch/)
  assert.equal(stored.size, 0)
})
