import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectedComponents3D,
  computeOtsuThreshold,
  computeTilePositions2D,
  cropVolume,
  dilateMask3D,
  fillHoles3D,
  resampleLabelsNearest,
  uncropVolume
} from '../src/volume/index.js';

test('connectedComponents3D labels separated regions', () => {
  const mask = new Uint8Array(27);
  mask[0] = 1;
  mask[26] = 1;
  const { labels, numComponents } = connectedComponents3D(mask, [3, 3, 3]);
  assert.equal(numComponents, 2);
  assert.notEqual(labels[0], labels[26]);
});

test('crop and uncrop preserve voxel placement', () => {
  const data = new Float32Array(27);
  data[13] = 5;
  const cropped = cropVolume(data, [3, 3, 3], { origin: [1, 1, 1], end: [2, 2, 2] });
  assert.deepEqual(cropped.dims, [1, 1, 1]);
  assert.equal(cropped.data[0], 5);
  const restored = uncropVolume(cropped.data, cropped.dims, [3, 3, 3], cropped.origin, Float32Array);
  assert.equal(restored[13], 5);
});

test('nearest label resampling keeps labels discrete', () => {
  const labels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const out = resampleLabelsNearest(labels, [2, 2, 2], [1, 1, 1]);
  assert.equal(out.length, 1);
  assert.ok(labels.includes(out[0]));
});

test('morphology fills a closed interior hole', () => {
  const mask = new Uint8Array(27).fill(1);
  mask[13] = 0;
  const filled = fillHoles3D(mask, [3, 3, 3], Uint8Array);
  assert.equal(filled[13], 1);
  const dilated = dilateMask3D(new Uint8Array([1, 0, 0]), [3, 1, 1], 1, Uint8Array);
  assert.deepEqual(Array.from(dilated), [1, 1, 0]);
});

test('threshold and tile helpers return useful values', () => {
  const threshold = computeOtsuThreshold(new Float32Array([0, 0, 1, 1]));
  assert.ok(threshold.thresholdValue >= 0);
  const tiles = computeTilePositions2D(10, 10, 4, 4, 0.5);
  assert.ok(tiles.length > 1);
});
