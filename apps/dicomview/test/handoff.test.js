import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { handoffBlocker, handoffFiles, handoffImage, lesionHandoffBlocker } from '../src/handoff.js';

function niftiBytes(dims) {
  const bytes = new Uint8Array(352 + 64);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  dims.forEach((size, axis) => view.setInt16(40 + 2 * axis, size, true));
  bytes.set([0x6e, 0x2b, 0x31, 0], 344);
  return bytes;
}

function nifti(dims, { gzip = false } = {}) {
  const bytes = niftiBytes(dims);
  return new File([gzip ? gzipSync(bytes) : bytes], gzip ? 'scan.nii.gz' : 'scan.nii');
}

// The same gzip member with a comment longer than 64 KB in its header: still valid, and its
// first decoded byte lies past any fixed prefix of the compressed file.
function withLongComment(member) {
  const comment = new Uint8Array(70 * 1024).fill(0x61);
  const padded = new Uint8Array(member.length + comment.length + 1);
  padded.set(member.subarray(0, 10));
  padded[3] |= 0x10;
  padded.set(comment, 10);
  padded.set(member.subarray(10), 11 + comment.length);
  return padded;
}

test('a 3D image can be sent, gzipped or not', async () => {
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, 40, 1, 1, 1, 1])), null);
  assert.equal(await lesionHandoffBlocker(nifti([4, 64, 64, 40, 1, 1, 1, 1], { gzip: true })), null, 'a fourth axis of one is still 3D');
});

test('a gzipped image whose header lies past the first 64 KB of compressed data can be sent', async () => {
  const image = new File([withLongComment(gzipSync(niftiBytes([3, 64, 64, 40, 1, 1, 1, 1])))], 'scan.nii.gz');
  assert.equal(await lesionHandoffBlocker(image), null);
});

test('a time series or a single slice is refused with a reason short enough to show', async () => {
  const series = await lesionHandoffBlocker(nifti([4, 64, 64, 40, 120, 1, 1, 1], { gzip: true }));
  assert.equal(series, 'White matter lesions takes one 3D image; this one has 120 volumes.');
  assert.equal(await lesionHandoffBlocker(nifti([5, 64, 64, 40, 1, 3, 1, 1])), 'White matter lesions takes one 3D image; this one has 3 volumes.');
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, 1, 1, 1, 1, 1])), 'White matter lesions takes a 3D image; this one is a single slice.');
  assert.ok(series.length <= 90);
});

test('a depth of zero or less is refused as a single slice', async () => {
  const single = 'White matter lesions takes a 3D image; this one is a single slice.';
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, 0, 1, 1, 1, 1])), single);
  assert.equal(await lesionHandoffBlocker(nifti([3, 64, 64, -1, 1, 1, 1, 1], { gzip: true })), single);
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

test('only White matter lesions refuses an image before it is sent', async () => {
  const timeSeries = nifti([4, 64, 64, 40, 3, 1, 1, 1]);
  const lesions = { path: 'white-matter-lesions', title: 'White matter lesions', receives: 'nifti' };
  assert.match(await handoffBlocker(lesions, timeSeries), /3 volumes/);
  assert.equal(await handoffBlocker({ path: 'niimath', title: 'NiiMath', receives: 'nifti' }, timeSeries), null);
  assert.equal(await handoffBlocker({ path: 'dicompare', title: 'dicompare', receives: 'dicom' }, timeSeries), null);
});

test('an app that reads DICOM receives the series files as opened, any other the image', () => {
  const series = { uid: '1.2.3', number: 4, description: 'FLAIR sag', files: [{ file: new File(['a'], '1.dcm') }, { file: new File(['b'], '2.dcm') }] };
  const outputs = [{ image: new File(['nifti'], 'Doe_Jane_FLAIR_20240102_4.nii'), sidecar: null }];
  const dicom = handoffFiles({ path: 'dicompare', receives: 'dicom' }, series, outputs, 0, [series]);
  assert.deepEqual(dicom, series.files.map((record) => record.file));
  const image = handoffFiles({ path: 'niimath', receives: 'nifti' }, series, outputs, 0, [series]);
  assert.deepEqual(image.map((file) => file.name), ['series4_FLAIR_sag.nii']);
  assert.deepEqual(handoffFiles({ path: 'dicompare', receives: 'dicom' }, series, null, 0, [series]).length, 2, 'DICOM needs no conversion');
});
