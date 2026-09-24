import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VolumePlaneSource,
  planeViewportExportGeometry,
  windowVoxelsToRgba,
} from '../src/volume_plane_source.ts'

const levels = [
  { level: 0, shape: [8, 6, 4], spacing: [1, 2, 3] },
  { level: 1, shape: [4, 3, 2], spacing: [2, 4, 6] },
]

function mockVolume(calls) {
  return {
    levels,
    datatypeCode: 2,
    fetchChunk: async (request) => {
      calls.push(request)
      const count = request.texDims.reduce((product, size) => product * size, 1)
      return Uint8Array.from({ length: count }, (_, index) => index)
    },
  }
}

test('maps native tiles into all three orthogonal volume planes', async () => {
  const cases = [
    {
      plane: 'axial',
      index: 2,
      tile: 3,
      manifest: [8, 12],
      origin: [4, 4, 2],
      dimensions: [4, 2, 1],
    },
    {
      plane: 'sagittal',
      index: 3,
      tile: 1,
      manifest: [6, 6],
      origin: [3, 4, 0],
      dimensions: [1, 2, 4],
    },
    {
      plane: 'coronal',
      index: 4,
      tile: 1,
      manifest: [8, 12],
      origin: [4, 4, 0],
      dimensions: [4, 1, 4],
    },
  ]

  for (const expected of cases) {
    const calls = []
    const source = new VolumePlaneSource(mockVolume(calls), {
      id: expected.plane,
      name: expected.plane,
      plane: expected.plane,
      index: expected.index,
      window: [0, 255],
      tileSize: 4,
    })
    assert.deepEqual(
      [source.manifest.width, source.manifest.height],
      expected.manifest,
    )
    const level = source.manifest.levels[0]
    const tile = level.tiles[expected.tile]
    const rgba = await source.fetchTileBytes(level, tile, expected.plane)
    assert.deepEqual(calls[0].texOrigin, expected.origin)
    assert.deepEqual(calls[0].texDims, expected.dimensions)
    assert.equal(rgba.byteLength, tile.width * tile.height * 4)
  }
})

test('maps one anatomical plane consistently across pyramid levels', async () => {
  const calls = []
  const source = new VolumePlaneSource(mockVolume(calls), {
    id: 'axial-levels',
    name: 'axial levels',
    plane: 'axial',
    index: 3,
    window: [0, 255],
    tileSize: 4,
  })
  const level = source.manifest.levels[1]
  await source.fetchTileBytes(level, level.tiles[0], 'coarse')

  assert.equal(calls[0].texOrigin[2], 1)
  assert.equal(level.downsample, 2)
})

test('windows uint16 voxels into grayscale RGBA', () => {
  const values = new Uint16Array([0, 100, 200, 300])
  const bytes = new Uint8Array(values.buffer)
  assert.deepEqual(
    [...windowVoxelsToRgba(bytes, 2, 4, [100, 300])],
    [
      0, 0, 0, 255,
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 255,
    ],
  )
})

test('maps every zoomed NVSlide plane to a cropped 3D NIfTI geometry', () => {
  const cases = [
    {
      plane: 'axial',
      baseNormalIndex: 30,
      manifestWidth: 100,
      manifestHeight: 80,
      slideBounds: { minX: 20, maxX: 60, minY: 16, maxY: 48 },
      origin: [10, 8, 9],
    },
    {
      plane: 'sagittal',
      baseNormalIndex: 50,
      manifestWidth: 80,
      manifestHeight: 60,
      slideBounds: { minX: 16, maxX: 48, minY: 12, maxY: 36 },
      origin: [15, 8, 6],
    },
    {
      plane: 'coronal',
      baseNormalIndex: 40,
      manifestWidth: 100,
      manifestHeight: 60,
      slideBounds: { minX: 20, maxX: 60, minY: 12, maxY: 36 },
      origin: [10, 12, 6],
    },
  ]

  for (const expected of cases) {
    const geometry = planeViewportExportGeometry({
      plane: expected.plane,
      level: {
        level: 1,
        shape: [50, 40, 30],
        spacing: [2, 4, 6],
      },
      baseShape: [100, 80, 60],
      baseNormalIndex: expected.baseNormalIndex,
      manifestWidth: expected.manifestWidth,
      manifestHeight: expected.manifestHeight,
      slideBounds: expected.slideBounds,
    })

    assert.deepEqual(geometry.origin, expected.origin)
    assert.deepEqual(geometry.shape, [20, 16, 12])
    assert.deepEqual(geometry.spacing, [2, 4, 6])
    assert.equal(geometry.level, 1)
  }
})

test('clamps an NVSlide pane export to the source extent', () => {
  const geometry = planeViewportExportGeometry({
    plane: 'coronal',
    level: {
      level: 0,
      shape: [10, 8, 6],
      spacing: [1, 1, 1],
    },
    baseShape: [10, 8, 6],
    baseNormalIndex: 7,
    manifestWidth: 10,
    manifestHeight: 6,
    slideBounds: {
      minX: -100,
      maxX: 100,
      minY: -100,
      maxY: 100,
    },
  })

  assert.deepEqual(geometry.origin, [0, 0, 0])
  assert.deepEqual(geometry.shape, [10, 8, 6])
})

test('forwards the NVSlide tile signal to the volume request', async () => {
  let requestSignal
  const volume = {
    levels,
    datatypeCode: 2,
    fetchChunk: (request) => {
      requestSignal = request.signal
      return new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(request.signal.reason))
      })
    },
  }
  const source = new VolumePlaneSource(volume, {
    id: 'cancel',
    name: 'cancel',
    plane: 'axial',
    index: 0,
    window: [0, 255],
  })
  const level = source.manifest.levels[0]
  const controller = new AbortController()
  const pending = source.fetchTileBytes(level, level.tiles[0], 'pending', controller.signal)
  controller.abort()

  await assert.rejects(pending)
  assert.equal(requestSignal, controller.signal)
})
