import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IntensityWindowEstimator,
  isGenericDtypeWindow,
} from '../src/intensity_window.ts'

test('recognises the generic uint16 display range from rounded share controls', () => {
  assert.equal(
    isGenericDtypeWindow('uint16', { min: 0.5, max: 65535.5 }),
    true,
  )
  assert.equal(
    isGenericDtypeWindow('uint16', { min: 0, max: 6500 }),
    false,
  )
})

test('estimates a useful uint16 window while ignoring zero background', () => {
  const values = new Uint16Array(4096)
  for (let index = 512; index < values.length; index++) {
    values[index] = 800 + ((index * 37) % 5701)
  }

  const estimator = new IntensityWindowEstimator('uint16')
  const window = estimator.observe(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
  )

  assert.ok(window)
  assert.equal(window.min, 0)
  assert.ok(window.max >= 6000)
  assert.ok(window.max <= 6500)
})

test('waits for signal instead of auto-windowing an empty chunk', () => {
  const estimator = new IntensityWindowEstimator('uint16')
  assert.equal(estimator.observe(new Uint8Array(4096)), null)
})
