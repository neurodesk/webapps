import assert from 'node:assert/strict';
import test from 'node:test';
import { dice, labelDice, maskVoxels } from '../test-utils/dice.mjs';

test('identical masks score 1', () => {
  assert.equal(dice(Uint8Array.of(1, 0, 1, 1), Uint8Array.of(1, 0, 1, 1)), 1);
});

test('disjoint masks score 0', () => {
  assert.equal(dice(Uint8Array.of(1, 1, 0, 0), Uint8Array.of(0, 0, 1, 1)), 0);
});

test('{1,1,0,0} against {1,0,0,0} scores 2/3', () => {
  // intersection 1, sizes 2 and 1: 2 * 1 / (2 + 1)
  assert.equal(dice(Uint8Array.of(1, 1, 0, 0), Uint8Array.of(1, 0, 0, 0)), 2 / 3);
});

test('two empty masks are defined as 1, and an empty mask against a non-empty one is 0', () => {
  assert.equal(dice(new Uint8Array(4), new Uint8Array(4)), 1);
  assert.equal(dice(new Uint8Array(4), Uint8Array.of(0, 1, 0, 0)), 0);
});

test('any non-zero value counts as inside the mask, across array types', () => {
  // {7,0,0.5,0} and {1,1,0,0}: intersection 1, sizes 2 and 2
  assert.equal(dice(Float32Array.of(7, 0, 0.5, 0), [1, 1, 0, 0]), 0.5);
});

test('arrays of different length are rejected', () => {
  assert.throws(() => dice(new Uint8Array(3), new Uint8Array(4)), /equally sized/);
  assert.throws(() => labelDice(new Uint8Array(3), new Uint8Array(4)), /equally sized/);
});

test('maskVoxels counts non-zero voxels', () => {
  assert.equal(maskVoxels(Uint8Array.of(0, 2, 0, 1, 1)), 3);
});

test('labelDice scores each label of a label map separately', () => {
  const a = Uint8Array.of(1, 1, 2, 2, 0, 3);
  const b = Uint8Array.of(1, 2, 2, 2, 0, 0);
  // label 1: intersection 1, sizes 2 and 1 -> 2/3
  // label 2: intersection 2, sizes 2 and 3 -> 4/5
  // label 3: intersection 0, sizes 1 and 0 -> 0
  assert.deepEqual(labelDice(a, b), {
    1: { dice: 2 / 3, voxelsA: 2, voxelsB: 1 },
    2: { dice: 4 / 5, voxelsA: 2, voxelsB: 3 },
    3: { dice: 0, voxelsA: 1, voxelsB: 0 },
  });
});

test('labelDice reports requested labels, scoring one absent from both maps as 1', () => {
  const a = Uint8Array.of(1, 1, 0, 0);
  const b = Uint8Array.of(1, 0, 0, 0);
  assert.deepEqual(labelDice(a, b, [1, 9]), {
    1: { dice: 2 / 3, voxelsA: 2, voxelsB: 1 },
    9: { dice: 1, voxelsA: 0, voxelsB: 0 },
  });
});

test('overlapping voxels with different labels do not count as agreement', () => {
  assert.deepEqual(labelDice(Uint8Array.of(1, 1), Uint8Array.of(2, 2)), {
    1: { dice: 0, voxelsA: 2, voxelsB: 0 },
    2: { dice: 0, voxelsA: 0, voxelsB: 2 },
  });
});
