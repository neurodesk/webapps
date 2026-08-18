import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MASKED_OUT, toBinaryMask, maskedInCount, maskedValues, isCurvatureName
} from '../src/niivue/overlayMask.js';

test('any non-zero finite value is inside the mask', () => {
  assert.deepEqual(
    [...toBinaryMask(Float32Array.from([0, 1, 0, 1]))], [0, 1, 0, 1]
  );
  // Not a threshold: a mask written as 2s, or as region labels, still reads as
  // "these vertices", and 0.5 would quietly reinterpret it.
  assert.deepEqual([...toBinaryMask(Float32Array.from([0, 2, 0.25, -3]))], [0, 1, 1, 1]);
  assert.deepEqual([...toBinaryMask(Float32Array.from([NaN, Infinity, 0, 1]))], [0, 0, 0, 1]);
  assert.equal(maskedInCount(toBinaryMask(Float32Array.from([0, 1, 1, 0, 1]))), 3);
});

test('vertices outside the mask are pushed below every finite window', () => {
  // The whole mechanism: NiiVue has no per-vertex alpha, so the value is the
  // alpha channel and only `v < cal_min` makes a vertex transparent.
  const base = Float32Array.from([5, 6, 7, 8]);
  const out = maskedValues(base, Uint8Array.from([1, 0, 1, 0]), 0);
  assert.deepEqual([...out], [5, MASKED_OUT, 7, MASKED_OUT]);
  assert.equal(out[1], -Infinity);
  assert.ok(out[1] < -1e308, 'must sit below any window a user could type');
});

test('kept values are clamped up to the window floor', () => {
  // Masking needs isTransparentBelowCalMin on, which would otherwise also drop
  // everything under the 2nd percentile — scattered holes through the overlay.
  const base = Float32Array.from([-4, 0.5, 2, 9]);
  assert.deepEqual([...maskedValues(base, Uint8Array.from([1, 1, 1, 1]), 1)],
    [1, 1, 2, 9]);
});

test('a vertex with no value is dropped rather than clamped', () => {
  // There is no colour for "no data", and NiiVue paints NaN black.
  const base = Float32Array.from([NaN, 3, Infinity]);
  const out = maskedValues(base, Uint8Array.from([1, 1, 1]), 0);
  assert.deepEqual([...out], [MASKED_OUT, 3, MASKED_OUT]);
});

test('the output buffer is reused, not reallocated', () => {
  // Called again on every window change, over ~163k vertices.
  const base = Float32Array.from([1, 2, 3]);
  const buffer = new Float32Array(3);
  const out = maskedValues(base, Uint8Array.from([1, 0, 1]), 0, buffer);
  assert.equal(out, buffer);
  // And it is fully rewritten each time, never merged with what was there.
  maskedValues(base, Uint8Array.from([0, 1, 0]), 0, buffer);
  assert.deepEqual([...buffer], [MASKED_OUT, 2, MASKED_OUT]);
});

test('an all-zero mask hides the overlay instead of throwing', () => {
  const out = maskedValues(Float32Array.from([1, 2]), Uint8Array.from([0, 0]), 0);
  assert.deepEqual([...out], [MASKED_OUT, MASKED_OUT]);
});

test('curvature is recognised by its FreeSurfer name', () => {
  for (const name of ['lh.curv', 'rh.curv', 'LH.CURV', 'lh.curv.gii', 'rh.curvature']) {
    assert.ok(isCurvatureName(name), `${name} should be treated as anatomy`);
  }
  for (const name of ['lh.thickness', 'lh.polarangle.mgz', 'curv', 'lh.sulc', '']) {
    assert.ok(!isCurvatureName(name), `${name} should be maskable data`);
  }
  assert.ok(!isCurvatureName(undefined));
});
