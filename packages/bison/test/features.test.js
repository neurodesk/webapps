import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_RANGE, buildFeatures, clipIntensity, histogramTable, maskVoxels, roundHalfEven } from '../src/features.js';

function table(classes) {
  const pdf = [];
  for (let row = 0; row < IMAGE_RANGE; row++) {
    pdf.push(Array.from({ length: classes }, (_, c) => row * 100 + c + 0.25));
  }
  return histogramTable({ pdf }, classes);
}

function images(mode, classes, length) {
  const priors = Array.from({ length: classes }, (_, k) => Float32Array.from({ length }, (_, i) => (k + 1) / 100 + i / 1000));
  return {
    mode,
    priors,
    t1: Float32Array.from([0.3, 2.5, 3.5, 254.5, 300, 100.25]),
    avT1: Float32Array.from({ length }, (_, i) => 50 + i),
    flair: Float32Array.from([10, 0, 7.5, 255.7, 1.5, 33.3]),
    avFlair: Float32Array.from({ length }, (_, i) => 20 + i),
    t1Histogram: table(classes),
    flairHistogram: table(classes),
  };
}

test('round half to even as numpy.round', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 3.5, 254.5, 2.4999, 2.5001].map(roundHalfEven), [0, 2, 2, 4, 254, 2, 3]);
  assert.deepEqual([0.3, 1, 300, 255, 254.9].map(clipIntensity), [1, 1, 255, 255, 254.9]);
});

test('mask voxels in linear order', () => {
  assert.deepEqual([...maskVoxels(Uint8Array.from([0, 1, 0, 2, 1]))], [1, 3, 4]);
});

test('T1 features: priors, clipped T1, Av_T1, histogram row', () => {
  const input = images('t1', 8, 6);
  const voxels = Uint32Array.from([0, 1, 2, 3, 4, 5]);
  const X = buildFeatures(input, voxels);
  assert.equal(X.length, 6 * 18);
  const rows = [1, 2, 4, 254, 255, 100];
  const t1c = [1, 2.5, 3.5, 254.5, 255, 100.25];
  for (let r = 0; r < 6; r++) {
    const row = X.subarray(r * 18, (r + 1) * 18);
    for (let k = 0; k < 8; k++) assert.equal(row[k], input.priors[k][r]);
    assert.equal(row[8], t1c[r]);
    assert.equal(row[9], 50 + r);
    for (let k = 0; k < 8; k++) assert.equal(row[10 + k], Math.fround(rows[r] * 100 + k + 0.25));
  }
});

test('T1 + FLAIR features: ratio of clipped values and the zero column', () => {
  const input = images('t1-flair', 9, 6);
  const voxels = Uint32Array.from([2, 4]);
  const X = buildFeatures(input, voxels);
  assert.equal(X.length, 2 * 33);
  const second = X.subarray(33, 66);
  assert.equal(second[9], 255);
  assert.equal(second[20], 1.5);
  assert.equal(second[21], 24);
  assert.equal(second[22], Math.fround(1.5 / 255));
  assert.equal(second[23], 0);
  for (let k = 0; k < 9; k++) assert.equal(second[24 + k], Math.fround(2 * 100 + k + 0.25));
  const first = X.subarray(0, 33);
  for (let k = 0; k < 9; k++) assert.equal(first[24 + k], Math.fround(8 * 100 + k + 0.25));
  assert.equal(first[22], Math.fround(7.5 / 3.5));
});

test('rejects inputs off the T1 grid and malformed tables', () => {
  const input = images('t1', 8, 6);
  input.avT1 = new Float32Array(5);
  assert.throws(() => buildFeatures(input, Uint32Array.from([0])), /T1 grid/);
  assert.throws(() => histogramTable({ pdf: [[1]] }, 8), /256 rows/);
  const nan = images('t1', 8, 6);
  nan.t1[1] = NaN;
  assert.throws(() => buildFeatures(nan, Uint32Array.from([1])), /NaN/);
});
