import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { handoffImage, lesionHandoffBlocker } from '../src/handoff.js';

function nifti(dims, { gzip = false } = {}) {
  const bytes = new Uint8Array(352 + 64);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  dims.forEach((size, axis) => view.setInt16(40 + 2 * axis, size, true));
  bytes.set([0x6e, 0x2b, 0x31, 0], 344);
  return new File([gzip ? gzipSync(bytes) : bytes], gzip ? 'scan.nii.gz' : 'scan.nii');
}

test('a 3D image can be sent, gzipped or not', async () => {
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, 40, 1, 1, 1, 1])), null);
  assert.equal(await lesionHandoffBlocker(nifti([4, 64, 64, 40, 1, 1, 1, 1], { gzip: true })), null, 'a fourth axis of one is still 3D');
});

test('a time series or a single slice is refused with a reason short enough to show', async () => {
  const series = await lesionHandoffBlocker(nifti([4, 64, 64, 40, 120, 1, 1, 1], { gzip: true }));
  assert.equal(series, 'White matter lesions takes one 3D image; this one has 120 volumes.');
  assert.equal(await lesionHandoffBlocker(nifti([5, 64, 64, 40, 1, 3, 1, 1])), 'White matter lesions takes one 3D image; this one has 3 volumes.');
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, 1, 1, 1, 1, 1])), 'White matter lesions takes a 3D image; this one is a single slice.');
  assert.ok(series.length <= 90);
});

test('the chosen image goes alone, under its download name', async () => {
  const series = { uid: '1.2.3', number: 4, description: 'FLAIR sag' };
  const dcm2niix = (name) => new File(['nifti'], name);
  const outputs = [
    { image: dcm2niix('Doe_Jane_FLAIR_20240102_4_e1.nii'), sidecar: { EchoTime: 0.1 } },
    { image: dcm2niix('Doe_Jane_FLAIR_20240102_4_e2.nii'), sidecar: null },
  ];
  const image = handoffImage(series, outputs, 1, [series]);
  assert.equal(image.name, 'series4_FLAIR_sag_2.nii');
  assert.equal(await image.text(), 'nifti');
});
