import assert from 'node:assert/strict'
import test from 'node:test'
import { measurementIndexAtCanvasPoint } from '../src/measurement_hit_test.ts'

const identitySlice = {
  leftTopWidthHeight: [0, 0, 100, 100],
  mvpMatrix: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ],
  planeNormal: [0, 0, 1],
  planePoint: [0, 0, 0],
}

test('finds only a visible measurement close to the right-click point', () => {
  const measurements = [
    { startMM: [-0.5, 0, 0], endMM: [0.5, 0, 0] },
    { startMM: [-0.5, 0.5, 1], endMM: [0.5, 0.5, 1] },
  ]

  assert.equal(
    measurementIndexAtCanvasPoint(measurements, [identitySlice], [50, 52], 5, 0.1),
    0,
  )
  assert.equal(
    measurementIndexAtCanvasPoint(measurements, [identitySlice], [50, 70], 5, 0.1),
    -1,
  )
})
