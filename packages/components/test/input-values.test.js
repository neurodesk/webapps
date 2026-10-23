import test from 'node:test';
import assert from 'node:assert/strict';
import { assertImageValues } from '../src/file-io/index.js';

test('the range of finite, varying values', () => {
  assert.deepEqual(assertImageValues(new Float32Array([2, -1, 5])), { min: -1, max: 5 });
});

test('NaN and infinite values are refused, with the image named', () => {
  assert.throws(() => assertImageValues(new Float32Array([1, NaN, 2]), { subject: 'The series' }), /^Error: The series holds values that are not finite/);
  assert.throws(() => assertImageValues(new Float64Array([1, Infinity])), /not finite numbers/);
});

test('a constant image is refused unless allowed', () => {
  assert.throws(() => assertImageValues(new Float32Array(8)), /same value \(0\) in every voxel/);
  assert.deepEqual(assertImageValues(new Float32Array([3, 3]), { allowConstant: true }), { min: 3, max: 3 });
  assert.throws(() => assertImageValues(new Float32Array(0)), /no voxels/);
});
