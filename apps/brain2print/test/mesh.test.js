import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flipWinding, inspectMesh } from '../src/mesh.js'

// Unit cube, counter-clockwise from outside: outward normals, volume +1.
const positions = new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,1,0, 0,0,1, 1,0,1, 1,1,1, 0,1,1])
const cube = () => new Uint32Array([
  0,2,1, 0,3,2, // z = 0
  4,5,6, 4,6,7, // z = 1
  0,1,5, 0,5,4, // y = 0
  2,3,7, 2,7,6, // y = 1
  0,4,7, 0,7,3, // x = 0
  1,2,6, 1,6,5, // x = 1
])

test('closed outward cube: manifold, consistent, positive volume', () => {
  const report = inspectMesh({ positions, indices: cube() })
  assert.deepEqual(report, { manifold: true, consistent: true, signedVolume: 1 })
})

test('flipping the winding negates the volume and flipping back restores it', () => {
  const indices = flipWinding(cube())
  assert.equal(inspectMesh({ positions, indices }).signedVolume, -1)
  assert.equal(inspectMesh({ positions, indices: flipWinding(indices) }).signedVolume, 1)
})

test('a mirrored (left-handed) transform of the positions inverts the volume sign', () => {
  // x -> -x, as a negative-determinant affine would do to voxel coordinates.
  const mirrored = positions.map((v, i) => (i % 3 === 0 ? -v : v))
  assert.equal(inspectMesh({ positions: mirrored, indices: cube() }).signedVolume, -1)
})

test('an open surface is not manifold; a flipped face is not consistent', () => {
  assert.equal(inspectMesh({ positions, indices: cube().subarray(3) }).manifold, false)
  const indices = cube()
  ;[indices[1], indices[2]] = [indices[2], indices[1]]
  assert.equal(inspectMesh({ positions, indices }).consistent, false)
})
