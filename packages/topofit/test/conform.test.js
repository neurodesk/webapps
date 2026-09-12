import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { conformVolume } from '../src/conform.js';

test('conform matches SciPy cubic interpolation on a centered integer volume', () => {
  const dims = [3, 4, 5];
  const data = Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => index - 20);
  const actual = conformVolume(
    {
      data,
      dims,
      affine: [
        [2, 0, 0, 4],
        [0, 2, 0, 5],
        [0, 0, 2, 6],
        [0, 0, 0, 1],
      ],
      datatypeCode: 4,
    },
    { shape: [5, 6, 7] },
  );

  assert.deepEqual(actual.dims, [5, 6, 7]);
  assert.deepEqual(actual.affine, [
    [1, 0, 0, 4],
    [0, 1, 0, 5],
    [0, 0, 1, 7],
    [0, 0, 0, 1],
  ]);
  assert.deepEqual([...actual.data], [
    -16, -16, -15, -14, -14, -15, -15, -14, -13, -13, -13, -13, -12, -11, -11,
    -11, -11, -10, -10, -9, -10, -10, -9, -8, -8, -8, -8, -7, -6, -6, -8, -8,
    -7, -6, -6, -7, -7, -6, -5, -5, -5, -5, -4, -3, -3, -3, -3, -3, -2, -1,
    -2, -2, -1, 0, 0, 0, 0, 1, 2, 2, -1, -1, 0, 0, 1, 0, 0, 1, 1, 2, 2, 2,
    3, 3, 4, 3, 3, 4, 5, 5, 5, 5, 6, 6, 7, 7, 7, 8, 8, 9, 4, 4, 5, 6, 6,
    5, 5, 6, 7, 7, 7, 7, 8, 9, 9, 9, 9, 10, 10, 11, 10, 10, 11, 12, 12, 12,
    12, 13, 14, 14, 9, 10, 10, 11, 11, 10, 11, 11, 12, 12, 12, 13, 13, 14, 14,
    14, 14, 15, 16, 16, 15, 16, 16, 17, 17, 17, 18, 18, 19, 19, 16, 16, 17, 18,
    18, 17, 17, 18, 19, 19, 19, 19, 20, 21, 21, 21, 21, 22, 22, 23, 22, 22, 23,
    24, 24, 24, 24, 25, 26, 26, 24, 24, 25, 26, 26, 25, 25, 26, 27, 27, 27, 27,
    28, 29, 29, 28, 29, 29, 30, 30, 30, 30, 31, 32, 32, 32, 32, 33, 34, 34,
  ]);
});

test('conform matches nibabel orientation permutations and flips', () => {
  const dims = [3, 4, 5];
  const actual = conformVolume(
    {
      data: Int16Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, index) => index - 20),
      dims,
      affine: [
        [0, 0, -4, 10],
        [2, 0, 0, 20],
        [0, 3, 0, 30],
        [0, 0, 0, 1],
      ],
      datatypeCode: 4,
    },
    { shape: [5, 6, 7] },
  );

  assert.deepEqual(actual.affine, [
    [1, 0, 0, 0],
    [0, 1, 0, 20],
    [0, 0, 1, 30],
    [0, 0, 0, 1],
  ]);
  assert.equal(
    createHash('sha256').update(new Uint8Array(actual.data.buffer)).digest('hex'),
    'f31080e375885ee239f8997a74ccf96b78ba8f88a1bf079505d2b6c7784ed595',
  );
});
