import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivationStorage } from '../src/activation-storage.js';

test('channel slabs crossing storage boundaries preserve every activation', () => {
  const expected = Float32Array.from({ length: 63 }, (_, i) => i / 8);
  const storage = createActivationStorage(expected.length, 7);
  storage.set(expected);
  storage.set(new Float32Array([101, 102, 103, 104]), 5);
  expected.set([101, 102, 103, 104], 5);
  for (let start = 0; start < expected.length; start++) {
    for (let end = start; end <= expected.length; end++) {
      assert.deepEqual(storage.subarray(start, end), expected.subarray(start, end));
    }
  }
  assert.deepEqual(storage.slice(0, expected.length), expected);
  assert.throws(() => storage.set(new Float32Array(2), expected.length - 1), RangeError);
});

test('large SynthSR activation uses bounded allocations', () => {
  const storage = createActivationStorage(3057647616 / 4);
  storage.set(new Float32Array([2, 3]), storage.length - 2);
  assert.deepEqual(storage.subarray(storage.length - 2, storage.length), new Float32Array([2, 3]));
});
