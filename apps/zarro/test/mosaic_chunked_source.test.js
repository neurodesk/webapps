import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkVolumeMultiLOD } from '@niivue/niivue'
import { createMosaicChunkedVolumeSource } from '../src/mosaic_chunked_source.ts'

test('keeps a large mosaic plan bounded and dispatches only requested FOV bricks', async () => {
  const levels = [
    { level: 0, shape: [41840, 18560, 2048], spacing: [1, 1, 1] },
    { level: 1, shape: [20920, 9280, 1024], spacing: [2, 2, 2] },
    { level: 2, shape: [10460, 4640, 512], spacing: [4, 4, 4] },
    { level: 3, shape: [5230, 2320, 256], spacing: [8, 8, 8] },
    { level: 4, shape: [2615, 1160, 128], spacing: [16, 16, 16] },
    { level: 5, shape: [1308, 580, 64], spacing: [32, 32, 32] },
    { level: 6, shape: [654, 290, 32], spacing: [64, 64, 64] },
  ]
  const calls = []
  const controller = new AbortController()
  const source = createMosaicChunkedVolumeSource({
    datatypeCode: 512,
    levels,
    signal: () => controller.signal,
    concurrency: 6,
    fetchRegion: async (level, request) => {
      calls.push({ level: level.level, request })
      return new Uint8Array(
        request.texDims[0] * request.texDims[1] * request.texDims[2] * request.bytesPerVoxel,
      )
    },
  })

  const plan = chunkVolumeMultiLOD(
    source.levels.map((level) => level.shape),
    { center: [5230, 2320, 256], radius: 64 },
    256,
    {
      cellEdge: 128,
      haloSize: [3, 3, 3],
      minLevel: 2,
      budgetBytes: 2 * 1024 * 1024 * 1024,
      maxBricks: 512,
      detail: 0.1,
    },
  )

  assert.ok(plan.chunks.length <= 512)
  assert.ok(plan.chunks.some((chunk) => chunk.sourceLevel === 2))
  assert.ok(plan.chunks.some((chunk) => (chunk.sourceLevel ?? 0) > 2))

  const visible = plan.chunks.find((chunk) => chunk.sourceLevel === 2)
  assert.ok(visible)
  const bytes = await source.fetchChunk({
    levelIndex: visible.sourceLevel,
    texOrigin: visible.texOrigin,
    texDims: visible.texDims,
    bytesPerVoxel: 2,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].level, 2)
  assert.deepEqual(calls[0].request.texOrigin, visible.texOrigin)
  assert.equal(
    bytes.byteLength,
    visible.texDims[0] * visible.texDims[1] * visible.texDims[2] * 2,
  )
})

test('keeps the requested finest focus brick when the global plan exceeds its budget', () => {
  const levels = [
    [41840, 18560, 2048],
    [20920, 9280, 1024],
    [10460, 4640, 512],
    [5230, 2320, 256],
    [2615, 1160, 128],
    [1308, 580, 64],
    [654, 290, 32],
  ]
  const plan = chunkVolumeMultiLOD(
    levels,
    { center: levels[0].map((size) => size * 0.5), radius: 64 },
    256,
    {
      cellEdge: 128,
      haloSize: [3, 3, 3],
      minLevel: 0,
      budgetBytes: 2 * 1024 * 1024 * 1024,
      maxBricks: 512,
      detail: 0.1,
    },
  )
  const estimatedBytes = plan.chunks.reduce(
    (sum, chunk) =>
      sum + chunk.texDims[0] * chunk.texDims[1] * chunk.texDims[2] * 8,
    0,
  )

  assert.ok(plan.chunks.length <= 512)
  assert.ok(estimatedBytes <= 2 * 1024 * 1024 * 1024)
  assert.ok(plan.chunks.some((chunk) => chunk.sourceLevel === 0))
})

test('reserves finest detail at the true focus when context uses a boundary bias', () => {
  const levels = [
    [41840, 18560, 2048],
    [20920, 9280, 1024],
    [10460, 4640, 512],
    [5230, 2320, 256],
    [2615, 1160, 128],
    [1308, 580, 64],
    [654, 290, 32],
  ]
  const reserveCenter = [20920, 9280, 746]
  const contextCenter = [
    reserveCenter[0] + 128 * 0.31,
    reserveCenter[1] + 128 * 0.17,
    reserveCenter[2] + 128 * 0.23,
  ]
  const plan = chunkVolumeMultiLOD(
    levels,
    { center: contextCenter, reserveCenter, radius: 64 },
    256,
    {
      cellEdge: 128,
      haloSize: [3, 3, 3],
      minLevel: 0,
      budgetBytes: 2 * 1024 * 1024 * 1024,
      maxBricks: 512,
      detail: 0.1,
    },
  )
  const halfFov = levels[0].map((size) => size / (2 * 64))
  const lo = reserveCenter.map((center, axis) => center - halfFov[axis])
  const hi = reserveCenter.map((center, axis) => center + halfFov[axis])
  const visibleL0 = plan.chunks.filter(
    (chunk) =>
      chunk.sourceLevel === 0 &&
      chunk.voxelOrigin.every(
        (origin, axis) =>
          origin < hi[axis] &&
          origin + chunk.voxelDims[axis] > lo[axis],
      ),
  )

  assert.ok(visibleL0.length > 0)
})

test('keeps every brick in the protected field of view at one level', () => {
  const levels = [
    [41840, 18560, 2048],
    [20920, 9280, 1024],
    [10460, 4640, 512],
    [5230, 2320, 256],
    [2615, 1160, 128],
    [1308, 580, 64],
    [654, 290, 32],
  ]
  const reserveCenter = [20920, 9280, 746]
  const contextCenter = [
    reserveCenter[0] + 128 * 0.31,
    reserveCenter[1] + 128 * 0.17,
    reserveCenter[2] + 128 * 0.23,
  ]
  const halfFov = levels[0].map((size) => size / (2 * 22.584554))
  const reserveBounds = [{
    min: reserveCenter.map((center, axis) => Math.max(0, center - halfFov[axis])),
    max: reserveCenter.map((center, axis) => Math.min(levels[0][axis], center + halfFov[axis])),
  }]
  const plan = chunkVolumeMultiLOD(
    levels,
    { center: contextCenter, reserveCenter, reserveBounds, radius: 64 },
    256,
    {
      cellEdge: 128,
      haloSize: [3, 3, 3],
      minLevel: 0,
      budgetBytes: 2 * 1024 * 1024 * 1024,
      maxBricks: 512,
      detail: 0.1,
    },
  )
  const fovLevels = new Set(
    plan.chunks
      .filter((chunk) => reserveBounds.some((bounds) =>
        chunk.voxelOrigin.every(
          (origin, axis) =>
            origin < bounds.max[axis] &&
            origin + chunk.voxelDims[axis] > bounds.min[axis],
        ),
      ))
      .map((chunk) => chunk.sourceLevel ?? 0),
  )

  assert.equal(fovLevels.size, 1)
  assert.ok([...fovLevels][0] > 0)

  const visibleSliceBounds = [0, 1, 2].map((sliceAxis) => {
    const bounds = {
      min: [...reserveBounds[0].min],
      max: [...reserveBounds[0].max],
    }
    bounds.min[sliceAxis] = reserveCenter[sliceAxis]
    bounds.max[sliceAxis] = reserveCenter[sliceAxis] + 0.001
    return bounds
  })
  const generousPlan = chunkVolumeMultiLOD(
    levels,
    {
      center: contextCenter,
      reserveCenter,
      reserveBounds: visibleSliceBounds,
      radius: 64,
    },
    256,
    {
      cellEdge: 128,
      haloSize: [3, 3, 3],
      minLevel: 0,
      budgetBytes: 8 * 1024 * 1024 * 1024,
      maxBricks: 1024,
      detail: 0.1,
    },
  )
  const generousFovLevels = new Set(
    generousPlan.chunks
      .filter((chunk) => visibleSliceBounds.some((bounds) =>
        chunk.voxelOrigin.every(
          (origin, axis) =>
            origin < bounds.max[axis] &&
            origin + chunk.voxelDims[axis] > bounds.min[axis],
        ),
      ))
      .map((chunk) => chunk.sourceLevel ?? 0),
  )

  assert.deepEqual([...generousFovLevels], [0])
  assert.ok(generousPlan.chunks.length <= 1024)
})

test('rejects an unavailable mosaic pyramid level before fetching', async () => {
  const source = createMosaicChunkedVolumeSource({
    datatypeCode: 2,
    levels: [{ level: 0, shape: [32, 32, 32], spacing: [1, 1, 1] }],
    signal: () => new AbortController().signal,
    concurrency: 1,
    fetchRegion: async () => new Uint8Array(),
  })

  await assert.rejects(
    source.fetchChunk({
      levelIndex: 1,
      texOrigin: [0, 0, 0],
      texDims: [1, 1, 1],
      bytesPerVoxel: 1,
    }),
    /level index 1 is unavailable/,
  )
})
