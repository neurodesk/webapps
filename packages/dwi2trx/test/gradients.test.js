import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { B0_THRESHOLD, b0Index, b0Volumes, isB0, parseBval, parseBvalBvec } from '../src/gradients.js';

const crate = new URL('../../../exes/dwi/gradients/', import.meta.url);
const read = (path) => readFileSync(new URL(path, crate), 'utf8');
const b0Cases = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('\t').map((field) => (field === 'none' ? [] : field.split(/\s+/).filter(Boolean).map(Number))));

test('b-values must be finite, non-negative and, with a volume count, one per volume', () => {
  assert.deepEqual(parseBval('0 1000\t1000\n2000\n', 4), [0, 1000, 1000, 2000]);
  assert.deepEqual(parseBval('0 1000'), [0, 1000]);
  assert.throws(() => parseBval('  ', 1), /empty/);
  assert.throws(() => parseBval('0 abc', 2), /non-numeric/);
  assert.throws(() => parseBval('0 Infinity', 2), /non-finite/);
  assert.throws(() => parseBval('0 -5', 2), /negative/);
  assert.throws(() => parseBval('0 1000', 3), /The image has 3 volumes but the bval file lists 2\./);
  // parseBvalBvec checks its b-values with the same rules.
  assert.throws(() => parseBvalBvec('0 -5', '0 1\n0 0\n0 0'), /negative/);
});

test('b0 volumes are those with b < 50, or every volume without b-values', () => {
  assert.deepEqual(b0Volumes([0, 1000, 5, 2000], 4), [0, 2]);
  assert.deepEqual(b0Volumes(null, 3), [0, 1, 2]);
  assert.throws(() => b0Volumes([1000, 2000], 2), /no b0 volume \(b < 50 s\/mm²\)/);
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => b0Volumes([0, value], 2), /finite non-negative/);
  }
  assert.equal(b0Index('1000 0 0'), 1);
  assert.equal(b0Index('1000 2000'), 0);
});

test('the b0 threshold is the gradients crate threshold, and a b-value at it is not a b0', () => {
  const lib = read('src/lib.rs');
  assert.equal(Number(lib.match(/pub const B0_THRESHOLD: f64 = ([0-9.]+);/)[1]), B0_THRESHOLD);
  assert.equal(isB0(B0_THRESHOLD), false);
  assert.equal(isB0(B0_THRESHOLD - 1e-9), true);
});

test('the b0 selection agrees with the gradients crate on its shared cases', () => {
  // exes/dwi/gradients/tests/b0_rule.rs asserts the same indices on the same file.
  const cases = b0Cases(read('tests/data/b0-rule.tsv'));
  assert.equal(cases.length, 6);
  for (const [bvals, b0] of cases) {
    if (b0.length) assert.deepEqual(b0Volumes(bvals, bvals.length), b0, bvals.join(' '));
    else assert.throws(() => b0Volumes(bvals, bvals.length), /no b0 volume/, bvals.join(' '));
  }
});

test('the shared b0 cases survive a trailing-whitespace trim', () => {
  const text = read('tests/data/b0-rule.tsv');
  const trimmed = text.replace(/[ \t]+$/gm, '');
  assert.deepEqual(b0Cases(trimmed), b0Cases(text));
});

test('the b0 selection splits OpenNeuro ds005577 sub-107 as the gradients crate does', () => {
  const bvals = parseBval(read('tests/data/sub-107_dir-AP_dwi.bval'), 101);
  assert.deepEqual(b0Volumes(bvals, bvals.length), Array.from({ length: 11 }, (_, i) => 10 * i));
});
