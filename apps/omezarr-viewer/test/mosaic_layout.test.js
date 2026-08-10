import assert from 'node:assert/strict'
import test from 'node:test'
import {
  layoutTranslatedBlocks,
  spatialTransformMm,
} from '../src/mosaic_layout.ts'

test('composes dataset and multiscale transforms into X/Y/Z millimetres', () => {
  assert.deepEqual(
    spatialTransformMm(
      [
        [
          { type: 'scale', scale: [1, 1, 2, 3, 4] },
          { type: 'translation', translation: [0, 0, 10, 20, 30] },
        ],
        [{ type: 'translation', translation: [0, 0, 1, 2, 3] }],
      ],
      [1, 1, 0.001, 0.001, 0.001],
    ),
    { spacing: [0.004, 0.003, 0.002], translation: [0.033, 0.022, 0.011] },
  )
})

test('places translated stores in one voxel grid', () => {
  const layout = layoutTranslatedBlocks([
    { id: 'left', shape: [4, 3, 2], spacing: [0.5, 1, 2], translation: [10, 20, 30] },
    { id: 'right', shape: [2, 3, 2], spacing: [0.5, 1, 2], translation: [12, 20, 30] },
  ])
  assert.deepEqual(layout.worldOrigin, [10, 20, 30])
  assert.deepEqual(layout.shape, [6, 3, 2])
  assert.deepEqual(layout.blocks.map((block) => block.voxelOrigin), [[0, 0, 0], [4, 0, 0]])
})

test('preserves fractional overlapping translations from DANDI chunks 8 and 9', () => {
  const layout = layoutTranslatedBlocks([
    {
      id: 'chunk-8',
      shape: [663, 32, 32],
      spacing: [0.164096, 0.232, 0.164096],
      translation: [0, 46.5836875, 254],
    },
    {
      id: 'chunk-9',
      shape: [663, 32, 32],
      spacing: [0.164096, 0.232, 0.164096],
      translation: [0, 53.2366875, 254],
    },
  ])
  assert.deepEqual(layout.shape, [663, 61, 32])
  assert.deepEqual(layout.worldOrigin, [0, 46.5836875, 254])
  assert.deepEqual(layout.blocks[0].voxelOrigin, [0, 0, 0])
  assert.ok(Math.abs(layout.blocks[1].voxelOrigin[1] - 28.6767241379) < 1e-9)
})
