import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compositeMosaicBlocks,
  mosaicSamplingWindow,
} from '../src/mosaic_composite.ts'

test('samples a fractional voxel translation with linear interpolation', () => {
  const output = compositeMosaicBlocks([0, 0, 0], [3, 1, 1], 1, [
    {
      voxelOrigin: [0.5, 0, 0],
      shape: [2, 1, 1],
      outputLo: [0, 0, 0],
      outputHi: [3, 1, 1],
      sourceOrigin: [0, 0, 0],
      sourceDims: [2, 1, 1],
      bytes: Uint8Array.from([0, 100]),
    },
  ])
  assert.deepEqual([...output], [0, 50, 100])
})

test('averages overlapping translated stores instead of rejecting them', () => {
  const output = compositeMosaicBlocks([0, 0, 0], [5, 1, 1], 1, [
    {
      voxelOrigin: [0, 0, 0],
      shape: [3, 1, 1],
      outputLo: [0, 0, 0],
      outputHi: [3, 1, 1],
      sourceOrigin: [0, 0, 0],
      sourceDims: [3, 1, 1],
      bytes: Uint8Array.from([10, 10, 10]),
    },
    {
      voxelOrigin: [1.5, 0, 0],
      shape: [3, 1, 1],
      outputLo: [1, 0, 0],
      outputHi: [5, 1, 1],
      sourceOrigin: [0, 0, 0],
      sourceDims: [3, 1, 1],
      bytes: Uint8Array.from([30, 30, 30]),
    },
  ])
  assert.deepEqual([...output], [10, 20, 20, 30, 30])
})

test('blends uint16 overlap in little-endian voxel order', () => {
  const first = new Uint8Array(2)
  const second = new Uint8Array(2)
  new DataView(first.buffer).setUint16(0, 1000, true)
  new DataView(second.buffer).setUint16(0, 3000, true)
  const output = compositeMosaicBlocks([0, 0, 0], [1, 1, 1], 2, [
    {
      voxelOrigin: [0, 0, 0],
      shape: [1, 1, 1],
      outputLo: [0, 0, 0],
      outputHi: [1, 1, 1],
      sourceOrigin: [0, 0, 0],
      sourceDims: [1, 1, 1],
      bytes: first,
    },
    {
      voxelOrigin: [0, 0, 0],
      shape: [1, 1, 1],
      outputLo: [0, 0, 0],
      outputHi: [1, 1, 1],
      sourceOrigin: [0, 0, 0],
      sourceDims: [1, 1, 1],
      bytes: second,
    },
  ])
  assert.equal(new DataView(output.buffer).getUint16(0, true), 2000)
})

test('selects the three-row overlap for real DANDI chunk 9 at L6', () => {
  assert.deepEqual(
    mosaicSamplingWindow(
      [0, 28.676724137931036, 0],
      [663, 32, 32],
      [0, 0, 0],
      [663, 61, 32],
    ),
    {
      outputLo: [0, 29, 0],
      outputHi: [663, 61, 32],
      sourceOrigin: [0, 0, 0],
      sourceDims: [663, 32, 32],
    },
  )
})
