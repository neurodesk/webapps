import assert from 'node:assert/strict';
import test from 'node:test';
import { anatomicalGrid } from '../js/orientation.js';

test('RAS input retains native voxel order', () => {
  const grid = anatomicalGrid([3, 4, 5], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(grid.dims, [3, 4, 5]);
  assert.equal(grid.index(2, 3, 4), 59);
});

test('Marques sagittal PSR acquisition displays anatomical planes without changing voxels', () => {
  const grid = anatomicalGrid([218, 220, 143], [0, 0, 1, -69, -1.04545, 0, 0, 142, 0, 1.04545, 0, -146, 0, 0, 0, 1]);
  assert.deepEqual(grid.dims, [143, 218, 220]);
  assert.equal(grid.index(0, 0, 0), 217);
  assert.equal(grid.index(142, 217, 219), 218 * (219 + 220 * 142));
  assert.equal(grid.index(70, 100, 110), 117 + 218 * (110 + 220 * 70));
});
