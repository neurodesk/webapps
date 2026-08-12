import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DecodedChunkCache,
  withDecodedChunkCaching,
} from '../src/decoded_chunk_cache.ts'

function chunk(values) {
  return {
    data: new Uint8Array(values),
    shape: [values.length],
    stride: [1],
  }
}

test('coalesces concurrent decoded-chunk loads and reuses the result', async () => {
  const cache = new DecodedChunkCache(1024)
  const controller = new AbortController()
  let loads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const array = {
    async getChunk() {
      loads++
      await gate
      return chunk([1, 2, 3, 4])
    },
  }
  const wrapped = withDecodedChunkCaching(array, {
    cache,
    namespace: 'store/L0',
  })

  const first = wrapped.getChunk([0], { signal: controller.signal })
  const second = wrapped.getChunk([0], { signal: controller.signal })
  release()

  assert.strictEqual(await first, await second)
  assert.strictEqual(
    await wrapped.getChunk([0], { signal: new AbortController().signal }),
    await first,
  )
  assert.equal(loads, 1)
  assert.equal(cache.misses, 1)
  assert.equal(cache.hits, 2)
})

test('does not reuse an aborted in-flight decode for a newer session', async () => {
  const cache = new DecodedChunkCache(1024)
  const stale = new AbortController()
  const current = new AbortController()
  let rejectStale
  const staleLoad = new Promise((_, reject) => {
    rejectStale = reject
  })

  const first = cache.getOrLoad('chunk', stale.signal, () => staleLoad)
  const second = cache.getOrLoad('chunk', current.signal, async () => chunk([9]))
  rejectStale(new DOMException('superseded', 'AbortError'))

  await assert.rejects(first, { name: 'AbortError' })
  assert.deepEqual((await second).data, new Uint8Array([9]))
  assert.strictEqual(
    await cache.getOrLoad('chunk', undefined, async () => chunk([0])),
    await second,
  )
})

test('evicts least-recently-used decoded chunks by byte size', async () => {
  const cache = new DecodedChunkCache(8)
  const loads = new Map()
  const load = (key) =>
    cache.getOrLoad(key, undefined, async () => {
      loads.set(key, (loads.get(key) ?? 0) + 1)
      return chunk([1, 2, 3, 4])
    })

  await load('a')
  await load('b')
  await load('a')
  await load('c')
  await load('b')

  assert.equal(loads.get('a'), 1)
  assert.equal(loads.get('b'), 2)
  assert.equal(loads.get('c'), 1)
  assert.ok(cache.byteLength <= 8)
})
