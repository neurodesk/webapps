import test from 'node:test';
import assert from 'node:assert/strict';
import { runBet } from '../../src/bet.js';
import { dice, maskVoxels } from '../../../../test-utils/dice.mjs';
import { loadBetRuntime } from '../bet-runtime.mjs';
import { BET_MIN_DICE, loadHeadReference } from '../head-reference.mjs';

// Downloads the pinned whole-head reference, so this runs in `test:reference`, which the
// brain-extraction app's tests run, and not in the every-run `pnpm test:packages`.
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
