import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import * as nifti from 'nifti-reader-js';
import { displaySource } from '../src/display-source.js';
import { writeInt16Nifti } from '../src/qc.js';
import { readVolume } from '../src/volume.js';
import { nifti2Buffer, source } from './region-fixture.js';

const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
const qformOnly = { sformCode: 0, qformCode: 1, offset: [20, 0, 0], pixdim: [1, 1, 1], qfac: -1 };

const sameAffine = (actual, expected, message) => assert.ok(actual.every((row, i) => row.every((value, j) => Math.abs(value - expected[i][j]) < 1e-9)), `${message}: ${JSON.stringify(actual)}`);

// The affine NiiVue draws a NIfTI file with: nifti-reader-js's header affine.
const viewerAffine = (buffer) => nifti.readHeader(nifti.isCompressed(buffer) ? nifti.decompress(buffer) : buffer).affine;

test('a NIfTI-1 scan and a NIfTI-2 scan whose srows hold the affine are shown as they are', async () => {
  const nifti1 = new File([writeInt16Nifti(source([4, 4, 4]), new Int16Array(64), 'scan')], 'scan.nii');
  assert.equal(await displaySource(nifti1), nifti1);
  const sform = new File([nifti2Buffer([5, 6, 7], [[2, 0, 0, -5], [0, 2.5, 0.5, -7], [0, 0, 3, -9]])], 'sform.nii');
  assert.equal(await displaySource(sform), sform);
  const gzipped = new File([gzipSync(new Uint8Array(nifti2Buffer([5, 6, 7], [[2, 0, 0, -5], [0, 2.5, 0.5, -7], [0, 0, 3, -9]])))], 'sform.nii.gz');
  assert.equal(await displaySource(gzipped), gzipped);
});

test('a qform-only NIfTI-2 scan is shown on the grid TopoFit reads', async () => {
  for (const srow of [identity, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]]) {
    const original = nifti2Buffer([5, 6, 7], srow, qformOnly);
    const expected = readVolume(original.slice(0)).affine;
    sameAffine(expected, [[1, 0, 0, 20], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]], 'reader');
    for (const [name, bytes] of [['qform.nii', new Uint8Array(original)], ['qform.nii.gz', gzipSync(new Uint8Array(original))]]) {
      const shown = await displaySource(new File([bytes], name, { type: 'application/octet-stream' }));
      assert.equal(shown.name, 'qform.nii');
      const buffer = await shown.arrayBuffer();
      sameAffine(viewerAffine(buffer), expected, name);
      sameAffine(readVolume(buffer.slice(0)).affine, expected, name);
      assert.equal(nifti.readHeader(buffer).sform_code, 1);
      assert.deepEqual(new Uint8Array(buffer, 544), new Uint8Array(original, 544), `${name} voxels`);
    }
  }
});

test('a scan stored in micrometres is shown in millimetres', async () => {
  const original = nifti2Buffer([5, 6, 7], identity, qformOnly);
  new DataView(original).setInt32(500, 3, true);
  const shown = await displaySource(new File([original], 'micro.nii'));
  const buffer = await shown.arrayBuffer();
  sameAffine(viewerAffine(buffer), readVolume(original.slice(0)).affine, 'micrometres');
  assert.equal(nifti.readHeader(buffer).xyzt_units & 7, 2);
});
