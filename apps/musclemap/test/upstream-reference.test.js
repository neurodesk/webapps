import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiftiFromVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { compareWithUpstream, UPSTREAM_GATE } from './upstream-reference.mjs';

const dims = [4, 2, 1];
const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const reference = { dims, affine, labels: Uint16Array.of(0, 7101, 7101, 7101, 0, 7102, 7102, 0) };
const nifti = labels => createNiftiFromVolume({ img: Uint16Array.from(labels), hdr: { dims, pixDims: [1, 1, 1], affine } });

test('the upstream gate is the release gate of compare_upstream_output.py', () => {
  assert.deepEqual(UPSTREAM_GATE, { minimumOverallAgreement: 0.99, minimumForegroundDice: 0.95, minimumLabelDice: 0.95 });
});

test('an identical label map passes every measure', async () => {
  const result = await compareWithUpstream(nifti(reference.labels), reference);
  assert.equal(result.overallAgreement, 1);
  assert.equal(result.foregroundDice, 1);
  assert.equal(result.worstLabelDice, 1);
  assert.deepEqual(result.labelsBelowGate, []);
  assert.deepEqual(result.extraLabels, []);
  assert.equal(result.affineMatches, true);
});

test('an empty label map scores zero and lists every upstream label below the gate', async () => {
  const result = await compareWithUpstream(nifti(new Uint16Array(8)), reference);
  assert.equal(result.foregroundDice, 0);
  // Only the three background voxels agree.
  assert.equal(result.overallAgreement, 3 / 8);
  assert.deepEqual(result.labelsBelowGate.map(entry => entry.label), [7101, 7102]);
});

test('swapped labels keep the foreground but fail per label, and a label upstream lacks is reported', async () => {
  const result = await compareWithUpstream(nifti([0, 7102, 7102, 7102, 0, 7101, 7101, 9]), reference);
  // Foreground: 6 candidate voxels, 5 upstream, 5 shared.
  assert.equal(result.foregroundDice, 10 / 11);
  assert.equal(result.worstLabelDice, 0);
  assert.equal(result.labelsBelowGate.length, 2);
  assert.deepEqual(result.extraLabels, [{ label: 9, voxels: 1 }]);
});

test('a segmentation on another grid is refused', async () => {
  await assert.rejects(compareWithUpstream(nifti(reference.labels), { ...reference, dims: [2, 2, 2] }), /grid/);
});
