import assert from 'node:assert/strict';
import test from 'node:test';
import { createNiftiHeaderFromVolume, createNiftiFromData, readNiftiFrames } from '../packages/components/src/file-io/NiftiUtils.js';
import { cropTrackingDwi } from '../test-utils/dwi-tracking-crop.mjs';

function fixture() {
  const header = createNiftiHeaderFromVolume({ hdr: {
    dims: [4, 4, 4, 3, 2, 1, 1, 1],
    pixDims: [1, 2, 3, 4, 1, 1, 1, 1],
    affine: [[0, -3, 0, 10], [2, 0, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]],
  } });
  return createNiftiFromData(Float32Array.from({ length: 96 }, (_, i) => i), header, { dims: [4, 4, 3, 2] });
}

test('tracking crop retains every frame and translates the oblique affine without resampling', async () => {
  const result = await cropTrackingDwi(fixture(), { sourceShape: [4, 4, 3], shape: [2, 2, 1], frames: 2 });
  const output = readNiftiFrames(result.bytes);
  assert.deepEqual(result.origin, [1, 1, 1]);
  assert.deepEqual(output.dims, [2, 2, 1]);
  assert.equal(output.frames, 2);
  assert.deepEqual([...output.data], [21, 22, 25, 26, 69, 70, 73, 74]);
  assert.deepEqual(output.header.affine.map(row => [...row]), [[0, -3, 0, 7], [2, 0, 0, 22], [0, 0, 4, 34], [0, 0, 0, 1]]);
  assert.equal(output.header.qformCode, 0);
});

test('tracking fixture refuses a changed source geometry and an invalid crop', async () => {
  await assert.rejects(cropTrackingDwi(fixture()), /Unexpected tracking fixture geometry/);
  await assert.rejects(cropTrackingDwi(fixture(), { sourceShape: [4, 4, 3], shape: [5, 2, 1], frames: 2 }), /must fit/);
});
