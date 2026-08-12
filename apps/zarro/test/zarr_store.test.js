import assert from 'node:assert/strict'
import test from 'node:test'
import * as zarr from 'zarrita'
import {
  withInflightReadDeduplication,
  withOptionalConsolidatedMetadata,
} from '../src/zarr_store.ts'

const encoder = new TextEncoder()

function metadataDocument() {
  return encoder.encode(
    JSON.stringify({
      zarr_consolidated_format: 1,
      metadata: {
        '.zgroup': { zarr_format: 2 },
        '.zattrs': { multiscales: [] },
        '0/.zarray': {
          zarr_format: 2,
          shape: [1],
          chunks: [1],
          dtype: '|u1',
          compressor: null,
          fill_value: 0,
          order: 'C',
          filters: null,
        },
        '0/.zattrs': {},
      },
    }),
  )
}

test('opens v2 group and arrays from one consolidated metadata request', async () => {
  const requests = []
  const store = {
    async get(path) {
      requests.push(path)
      return path === '/.zmetadata' ? metadataDocument() : undefined
    },
  }

  const consolidated = await withOptionalConsolidatedMetadata(store)
  const root = zarr.root(consolidated)
  await zarr.open(root, { kind: 'group' })
  await zarr.open(root.resolve('/0'), { kind: 'array' })

  assert.deepEqual(requests, ['/.zmetadata'])
})

test('cancels an obsolete consolidated metadata request', async () => {
  const controller = new AbortController()
  const store = {
    get(_path, options) {
      return new Promise((_, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(options.signal.reason),
          { once: true },
        )
      })
    },
  }

  const opening = withOptionalConsolidatedMetadata(store, controller.signal)
  controller.abort(new DOMException('superseded', 'AbortError'))

  await assert.rejects(opening, { name: 'AbortError' })
})

test('coalesces reads only when their abort signal is shared', async () => {
  let reads = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const store = {
    async get() {
      reads++
      await gate
      return new Uint8Array([reads])
    },
  }
  const deduplicated = withInflightReadDeduplication(store)
  const firstSession = new AbortController()
  const secondSession = new AbortController()

  const first = deduplicated.get('/0', { signal: firstSession.signal })
  const duplicate = deduplicated.get('/0', { signal: firstSession.signal })
  const newer = deduplicated.get('/0', { signal: secondSession.signal })
  release()

  assert.strictEqual(await first, await duplicate)
  assert.notStrictEqual(await first, await newer)
  assert.equal(reads, 2)
})
