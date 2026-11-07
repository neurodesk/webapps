import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPeaks, overlapRegion, registerPair, shiftedCorrelation } from '../src/core/pairwise.js';
import { blobField, renderTile } from './synthetic.js';

const field2d = blobField([700, 500], { seed: 5 });

function offsetError(result, truth) {
  return Math.hypot(...result.offset.map((v, d) => v - truth[d]));
}

test('the overlap region under a layout is the intersection of the two tiles, in A coordinates', () => {
  assert.deepEqual(overlapRegion([100, 80], [100, 80], [70, -5]), { lo: [70, 0], size: [30, 75] });
  assert.equal(overlapRegion([100, 80], [100, 80], [100, 0]), null);
});

test('a horizontal pair is registered to a fraction of a pixel when the layout is 9 px off', () => {
  const a = renderTile(field2d, [256, 200], [20.0, 30.0], { noise: 4, seed: 1 });
  const b = renderTile(field2d, [256, 200], [222.37, 33.81], { noise: 4, seed: 2 });
  const truth = [202.37, 3.81];
  const result = registerPair(a, b, [211, -3]);
  assert.ok(result.r > 0.95, `r = ${result.r}`);
  assert.ok(offsetError(result, truth) < 0.25, `offset ${result.offset} vs ${truth}`);
});

test('a shift beyond half the overlap region is resolved by checking the periodic alternatives', () => {
  // The region is 60 px wide; the true offset is 26 px from the layout, more than half of it.
  const a = renderTile(field2d, [200, 160], [100, 100], { noise: 2, seed: 3 });
  const b = renderTile(field2d, [200, 160], [266.4, 101.2], { noise: 2, seed: 4 });
  const result = registerPair(a, b, [140, 0]);
  assert.ok(offsetError(result, [166.4, 1.2]) < 0.3, `offset ${result.offset}`);
});

test('a 3D pair is registered to a fraction of a voxel along every axis', () => {
  const field = blobField([220, 120, 60], { seed: 9, density: 0.002, sigma: [1.5, 3] });
  const a = renderTile(field, [96, 80, 40], [10, 10, 10], { noise: 2, seed: 5 });
  const b = renderTile(field, [96, 80, 40], [86.6, 13.3, 12.75], { noise: 2, seed: 6 });
  const result = registerPair(a, b, [72, 0, 0]);
  assert.ok(result.r > 0.9, `r = ${result.r}`);
  assert.ok(offsetError(result, [76.6, 3.3, 2.75]) < 0.3, `offset ${result.offset}`);
});

test('pairs with no shared structure score a low correlation', () => {
  const a = renderTile(blobField([300, 300], { seed: 21 }), [128, 128], [0, 0], { noise: 2, seed: 7 });
  const b = renderTile(blobField([300, 300], { seed: 22 }), [128, 128], [0, 0], { noise: 2, seed: 8 });
  const result = registerPair(a, b, [100, 0]);
  assert.ok(result.r < 0.3, `r = ${result.r}`);
});

test('peaks are local maxima, strongest first, and correlation is Pearson over the overlap', () => {
  const values = new Float64Array(16);
  values[5] = 3;
  values[6] = 2;
  values[12] = 1;
  const peaks = findPeaks(values, [4, 4], 2);
  assert.deepEqual(peaks.map((p) => p.position), [[1, 1], [0, 3]]);
  const a = Float64Array.from({ length: 12 }, (_, i) => i % 4);
  const b = Float64Array.from({ length: 12 }, (_, i) => (i % 4) + 1);
  assert.equal(shiftedCorrelation(a, b, [4, 3], [1, 0]).r, 1);
  assert.equal(shiftedCorrelation(a, b, [4, 3], [1, 0]).pixels, 9);
});

test('Pearson scores are invariant to large intensity offsets, including shifted uint32 tiles', () => {
  const a = Float64Array.from({ length: 100 }, (_, i) => i % 7);
  const b = Float64Array.from({ length: 100 }, (_, i) => (i + 2) % 7);
  for (const Type of [Float64Array, Uint32Array]) {
    const highA = Type.from(a, (v) => v + 1e9);
    const highB = Type.from(b, (v) => v + 2e9);
    assert.ok(Math.abs(shiftedCorrelation(highA, highA, [100, 1], [0, 0]).r - 1) < 1e-12);
    for (const shift of [[0, 0], [2, 0], [-3, 0]]) {
      const low = shiftedCorrelation(a, b, [100, 1], shift);
      const high = shiftedCorrelation(highA, highB, [100, 1], shift);
      assert.equal(high.pixels, low.pixels);
      assert.ok(Math.abs(high.r - low.r) < 1e-12);
    }
  }
  const constant = new Uint32Array(100).fill(1e9);
  assert.equal(shiftedCorrelation(constant, constant, [100, 1], [0, 0]).r, 0);
});
