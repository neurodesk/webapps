import assert from 'node:assert/strict';

/** Compare nonfinite classifications before applying a numerical tolerance. */
export function compareValues(actual, expected, accept, label) {
  assert.equal(actual.length, expected.length, `${label}: shape`);
  const failures = [];
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i], e = expected[i];
    if (a === e || Number.isNaN(a) && Number.isNaN(e)) continue;
    if (Number.isFinite(a) && Number.isFinite(e) && accept(a, e, i)) continue;
    failures.push({ index: i, actual: a, expected: e });
  }
  return failures;
}
