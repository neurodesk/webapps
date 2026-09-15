import test from 'node:test';
import assert from 'node:assert/strict';
import { runBet } from '../src/bet.js';

const volume = {
  dims: [2, 2, 2],
  affine: [[0, -3, 0, 14], [2, 0, 0, -9], [0, 0, 4, 7], [0, 0, 0, 1]],
  data: Float32Array.from([0, 10, 20, 30, 40, 50, 60, 70]),
};

test('BET preserves rotated geometry, uses physical spacing and accepts zero fractional intensity', () => {
  const progress = [];
  const runtime = { bet_wasm_with_progress(data, ...args) {
    assert.ok(data instanceof Float64Array);
    assert.deepEqual([...data], [0, 10, 20, 30, 40, 50, 60, 70]);
    const callback = args.pop();
    assert.deepEqual(args, [2, 2, 2, 2, 3, 4, 0, 1, 0, 1000, 4]);
    callback(5, 10);
    return Uint8Array.from([0, 1, 1, 0, 1, 0, 1, 0]);
  } };
  const result = runBet({ volume, runtime, fractionalIntensity: 0, onProgress: value => progress.push(value) });
  assert.deepEqual([...result.brain.data], [0, 10, 20, 0, 40, 0, 60, 0]);
  assert.deepEqual(result.mask.affine, volume.affine);
  assert.deepEqual(result.brain.dims, [2, 2, 2]);
  assert.deepEqual(progress, [0, 0.5]);
});

test('BET rejects invalid options and empty masks', () => {
  const runtime = { bet_wasm_with_progress: () => new Uint8Array(8) };
  for (const fractionalIntensity of [NaN, -1, 2]) {
    assert.throws(() => runBet({ volume, runtime, fractionalIntensity }), /fractional intensity/);
  }
  assert.throws(() => runBet({ volume, runtime }), /empty mask/);
});
