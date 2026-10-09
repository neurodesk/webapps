import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { TOF_CROP } from './tof-crop.mjs';

const MIN_DICE = 0.99;
const fixture = new URL('./fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz', import.meta.url);

test('the upstream VesselBoost reference is the pinned mask on the crop grid', async () => {
  const bytes = await readFile(fixture);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '6502ec4c92e57bc98fda8d2c33f6cbd305d147a6d12b9982cf0932a2e37a3a1d');
  const reference = await readNifti(bytes, Uint8Array);
  assert.deepEqual(reference.dims, TOF_CROP.dims);
  assert.equal(maskVoxels(reference.data), 33894);
});

test('the browser test\'s Dice gate rejects an empty, a full and a displaced vessel mask', async () => {
  const reference = await readNifti(await readFile(fixture), Uint8Array);
  const empty = new Uint8Array(reference.data.length);
  const full = new Uint8Array(reference.data.length).fill(1);
  // The reference itself moved two voxels (0.94 mm) along x.
  const shifted = new Uint8Array(reference.data.length);
  reference.data.forEach((value, index) => {
    if (value && index + 2 < shifted.length) shifted[index + 2] = 1;
  });
  assert.equal(dice(reference.data, reference.data), 1);
  for (const wrong of [empty, full, shifted]) {
    assert.ok(dice(wrong, reference.data) < MIN_DICE, `Dice ${dice(wrong, reference.data)}`);
  }
});
