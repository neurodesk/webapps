import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NIFTI1 } from 'nifti-reader-js';
import { decodeVolume } from '../src/nifti.js';

function image(littleEndian, values = [1, 2]) {
  const header = new NIFTI1();
  header.littleEndian = littleEndian;
  header.dims = [3, 2, 1, 1, 1, 1, 1, 1];
  header.pixDims = [1, 1, 1, 1, 1, 1, 1, 1];
  header.datatypeCode = 16;
  header.numBitsPerVoxel = 32;
  header.vox_offset = 352;
  header.sform_code = 1;
  header.affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  header.magic = 'n+1';
  const bytes = new Uint8Array(360);
  bytes.set(new Uint8Array(header.toArrayBuffer()));
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(352 + 4 * index, value, littleEndian));
  return bytes;
}

test('NIfTI values decode with the header byte order', () => {
  assert.deepEqual(Array.from(decodeVolume(image(true)).data), [1, 2]);
  assert.deepEqual(Array.from(decodeVolume(image(false)).data), [1, 2]);
});

test('non-finite and invalid image bytes fail before inference', () => {
  assert.throws(() => decodeVolume(image(true, [NaN, 2])), /non-finite/);
  assert.throws(() => decodeVolume(new Uint8Array(10)), /NIfTI/);
});

test('zero slope with a nonzero intercept preserves a reviewed binary mask', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(new URL('../../components/test/fixtures/uint8-zero-slope-intercept.nii', import.meta.url));
  assert.deepEqual(Array.from(decodeVolume(bytes).data), [0, 1]);
});
