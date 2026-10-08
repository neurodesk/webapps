import test from 'node:test';
import assert from 'node:assert/strict';
import { runBet } from '../src/bet.js';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { loadBetRuntime } from './bet-runtime.mjs';
import { BET_MIN_DICE, loadHeadReference } from './head-reference.mjs';

const volume = {
  dims: [2, 2, 2],
  affine: [[0, -3, 0, 14], [2, 0, 0, -9], [0, 0, 4, 7], [0, 0, 0, 1]],
  data: Float32Array.from([0, 10, 20, 30, 40, 50, 60, 70]),
};

// Wrapper contract only: the runtime here is a stub, so this says nothing about BET itself.
test('runBet hands the runtime float64 data, physical spacing of a rotated grid and a zero fractional intensity', () => {
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

test('real BET WebAssembly agrees with the FreeSurfer SynthSeg brain mask of a whole-head T1', async () => {
  const runtime = await loadBetRuntime();
  const reference = await loadHeadReference();
  const result = runBet({ volume: reference.volume, runtime, fractionalIntensity: 0.5 });
  const score = dice(result.mask.data, reference.mask);
  console.log(`BET Dice against FreeSurfer SynthSeg mask: ${score.toFixed(4)} (${maskVoxels(result.mask.data)} of ${maskVoxels(reference.mask)} reference voxels)`);
  assert.ok(score >= BET_MIN_DICE, `BET Dice ${score.toFixed(4)} is below ${BET_MIN_DICE}`);
  assert.deepEqual(result.mask.dims, reference.volume.dims);
  assert.deepEqual(result.mask.affine, reference.volume.affine);
  assert.ok(result.brain.data.every((value, index) => value === (result.mask.data[index] ? reference.volume.data[index] : 0)));

  // The gate must be able to fail: an empty mask, the whole field of view and the same mask
  // displaced by 20 voxels (20 mm) along x all score below it.
  const [nx] = reference.volume.dims;
  const shifted = new Uint8Array(result.mask.data.length);
  result.mask.data.forEach((value, index) => {
    if (value && index % nx + 20 < nx) shifted[index + 20] = 1;
  });
  for (const wrong of [new Uint8Array(shifted.length), new Uint8Array(shifted.length).fill(1), shifted]) {
    assert.ok(dice(wrong, reference.mask) < BET_MIN_DICE);
  }
});
