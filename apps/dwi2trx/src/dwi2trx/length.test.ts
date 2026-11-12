import assert from 'node:assert/strict'
import test from 'node:test'
import { dropLongStreamlines, streamlineLengthMm } from './length.ts'

const anisotropic = [
  [-2, 0, 0, 90],
  [0, 2, 0, -126],
  [0, 0, 3, -72],
  [0, 0, 0, 1],
]

await test('length is measured in mm through the affine, so anisotropic voxels count their own size', () => {
  const alongX = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0])
  const alongZ = new Float32Array([0, 0, 0, 0, 0, 1])
  const diagonal = new Float32Array([0, 0, 0, 1, 1, 0])
  assert.equal(streamlineLengthMm(alongX, anisotropic), 4)
  assert.equal(streamlineLengthMm(alongZ, anisotropic), 3)
  assert.equal(streamlineLengthMm(diagonal, anisotropic), Math.hypot(2, 2))
  assert.equal(streamlineLengthMm(new Float32Array([5, 5, 5]), anisotropic), 0)
})

await test('streamlines longer than the limit are removed in order and counted; one at the limit stays', () => {
  const short = new Float32Array([0, 0, 0, 0, 0, 1]) // 3 mm
  const atLimit = new Float32Array([0, 0, 0, 2, 0, 0]) // 4 mm
  const long = new Float32Array([0, 0, 0, 0, 0, 2]) // 6 mm
  const lines = [long, short, long, atLimit]
  assert.equal(dropLongStreamlines(lines, anisotropic, 4), 2)
  assert.deepEqual(lines, [short, atLimit])
})
