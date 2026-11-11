import assert from 'node:assert/strict';
import test from 'node:test';
import { compareValues } from '../validation/matlab/compare-values.mjs';

test('relative bounds cannot accept mismatched finite, infinite or NaN values', () => {
  const values = [0, 1, -1, NaN, Infinity, -Infinity];
  const predicates = [
    (a, e) => Math.abs(a - e) <= 1e-12 * Math.max(1, Math.abs(e)),
    (a, e) => Math.abs(a - e) <= 32 * 2 ** -24 * Math.abs(e),
    () => true,
  ];
  for (const accept of predicates) {
    assert.deepEqual(compareValues(values, values, accept, 'identical'), []);
    for (const actual of values) {
      for (const expected of values) {
        if (Number.isFinite(actual) && Number.isFinite(expected)) continue;
        if (Object.is(actual, expected)) continue;
        assert.deepEqual(compareValues([actual], [expected], accept, 'mutated'), [
          { index: 0, actual, expected },
        ]);
      }
    }
    assert.equal(compareValues([0, 0], [Infinity, -Infinity], accept, 'review probe').length, 2);
  }
});

test('finite comparisons retain their per-value tolerance and reject wrong shapes', () => {
  const conditioning = [1, 5e4];
  const accept = (a, e, i) => Math.abs(a - e) <= 1e-12 * conditioning[i] * Math.max(1, Math.abs(e));
  const failures = compareValues([1 + 1e-8, 1 + 1e-8, -0], [1, 1, 0], accept, 'finite');
  assert.deepEqual(failures, [{ index: 0, actual: 1 + 1e-8, expected: 1 }]);
  assert.throws(() => compareValues([1], [], accept, 'truncated'), /truncated: shape/);
});
