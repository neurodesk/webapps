import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALIZER_PLANES, dicomSeries, localizerFile } from '../../../test-utils/dicom-fixture.mjs';
import { frameAffine, frameImages } from '../src/frame-images.js';

function header(bytes) {
  const view = new DataView(bytes);
  const sform = [280, 296, 312].map((row) => [0, 1, 2, 3].map((column) => view.getFloat32(row + 4 * column, true)));
  return {
    dims: [1, 2, 3].map((axis) => view.getInt16(40 + 2 * axis, true)),
    datatype: view.getInt16(70, true),
    qform: view.getInt16(252, true),
    sformCode: view.getInt16(254, true),
    sform,
    voxels: new Float32Array(bytes.slice(view.getFloat32(108, true))),
  };
}

// The world position (RAS) of voxel (i, j) of a slice.
const world = (sform, i, j) => sform.map((row) => row[0] * i + row[1] * j + row[3]);

test('each frame of a localizer becomes a one-slice image in its own plane', async () => {
  const { name, buffer } = localizerFile();
  const outputs = await frameImages(new File([buffer], name));
  assert.deepEqual(outputs.map(({ image }) => image.name), ['frame1.nii', 'frame2.nii', 'frame3.nii']);
  for (const [index, { image, sidecar }] of outputs.entries()) {
    const nifti = header(await image.arrayBuffer());
    assert.equal(sidecar, null);
    assert.deepEqual(nifti.dims, [16, 16, 1]);
    assert.equal(nifti.datatype, 16);
    assert.equal(nifti.qform, 0, 'the sform alone places the slice');
    assert.equal(nifti.sformCode, 1);
    assert.equal(nifti.voxels[0], (index + 1) * 100);
    assert.equal(nifti.voxels[17], (index + 1) * 100 + 17, 'i runs along a row');
    // DICOM's first pixel sits at the frame position (LPS); one row down moves 2 mm along the column direction.
    const { position, orientation } = LOCALIZER_PLANES[index];
    const lps = (point) => [-point[0], -point[1], point[2]].map((value) => value + 0);
    assert.deepEqual(lps(world(nifti.sform, 0, 0)), position);
    assert.deepEqual(lps(world(nifti.sform, 0, 1)), position.map((value, axis) => value + 2 * orientation[3 + axis]));
    assert.deepEqual(lps(world(nifti.sform, 1, 0)), position.map((value, axis) => value + 2 * orientation[axis]));
  }
});

test('the slice axis is the frame normal scaled by the slice thickness', () => {
  const affine = frameAffine({ ipp: [0, 0, 0], iop: [1, 0, 0, 0, 1, 0], spacing: [0.5, 0.25], thickness: 3 });
  assert.deepEqual(affine.map((row) => row.map((value) => value + 0)), [[-0.25, 0, 0, 0], [0, -0.5, 0, 0], [0, 0, 3, 0]]);
});

test('a single-frame file is left to dcm2niix', async () => {
  const [{ name, buffer }] = dicomSeries({ slices: 1 });
  await assert.rejects(frameImages(new File([buffer], name)), /single frame/);
});
