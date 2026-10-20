import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  InputTooLargeError,
  MAX_INPUT_BYTES,
  assertInputSize,
  assertNiftiDecodedSize,
  decodedFloat32Bytes,
  formatBytes,
  parseNiftiHeader,
  readNiftiHeader
} from '../src/file-io/index.js';

const DATATYPES = { int16: [4, 16], float32: [16, 32] };

/** A NIfTI-1 header, optionally followed by `dataBytes` zero bytes of image data. */
function nifti(dims, { type = 'float32', dataBytes = 0 } = {}) {
  const bytes = new Uint8Array(352 + dataBytes);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [dims.length, ...dims, 1, 1, 1, 1, 1, 1, 1].slice(0, 8).forEach((value, index) => view.setInt16(40 + index * 2, value, true));
  view.setInt16(70, DATATYPES[type][0], true);
  view.setInt16(72, DATATYPES[type][1], true);
  view.setFloat32(108, 352, true);
  bytes.set([0x6e, 0x2b, 0x31], 344);
  return bytes;
}

test('the decoded estimate is four bytes a voxel whatever the stored type', () => {
  const int16 = parseNiftiHeader(nifti([64, 64, 40], { type: 'int16' }));
  const float32 = parseNiftiHeader(nifti([64, 64, 40], { type: 'float32' }));
  assert.equal(decodedFloat32Bytes(int16), 64 * 64 * 40 * 4);
  assert.equal(decodedFloat32Bytes(float32), 64 * 64 * 40 * 4);
});

test('the decoded estimate multiplies every frame of a 4D or 5D image', () => {
  assert.equal(decodedFloat32Bytes(parseNiftiHeader(nifti([96, 96, 60, 65], { type: 'int16' }))), 96 * 96 * 60 * 65 * 4);
  assert.equal(decodedFloat32Bytes(parseNiftiHeader(nifti([10, 10, 10, 1, 3]))), 10 * 10 * 10 * 3 * 4);
});

test('a .nii.gz header is read without decompressing the image', async () => {
  const file = new File([gzipSync(nifti([32, 32, 16, 8], { type: 'int16', dataBytes: 32 * 32 * 16 * 8 * 2 }))], 'dwi.nii.gz');
  file.arrayBuffer = () => assert.fail('the whole file was read');
  const header = await readNiftiHeader(file);
  assert.deepEqual(header.dims.slice(0, 5), [4, 32, 32, 16, 8]);
  assert.equal(await assertNiftiDecodedSize(file), 32 * 32 * 16 * 8 * 4);
});

test('a header-only file whose decoded image passes the limit is refused', async () => {
  const header = nifti([256, 256, 256, 40], { type: 'int16' });
  for (const file of [new File([header], 'dwi.nii'), new File([gzipSync(header)], 'dwi.nii.gz')]) {
    await assert.rejects(assertNiftiDecodedSize(file), (error) => {
      assert.ok(error instanceof InputTooLargeError);
      assert.equal(error.actualBytes, 256 ** 3 * 40 * 4);
      assert.equal(error.limitBytes, MAX_INPUT_BYTES);
      assert.equal(error.message, 'Decoded image too large (2.68 GB; browser limit 2.00 GB).');
      return true;
    });
  }
  await assert.doesNotReject(assertNiftiDecodedSize(new File([header], 'dwi.nii'), 3e9));
});

test('the file-size limit counts every file and names both sizes', () => {
  const sized = (size) => ({ size });
  assert.doesNotThrow(() => assertInputSize([sized(MAX_INPUT_BYTES)]));
  assert.throws(() => assertInputSize([sized(1_500_000_000), sized(500_000_001)]), (error) => {
    assert.ok(error instanceof InputTooLargeError);
    assert.equal(error.name, 'InputTooLargeError');
    assert.equal(error.actualBytes, 2_000_000_001);
    assert.equal(error.message, 'Input too large (2.00 GB; browser limit 2.00 GB).');
    return true;
  });
  assert.throws(() => assertInputSize([sized(11)], 10), /Input too large \(11 bytes; browser limit 10 bytes\)\./);
});

test('the status message stays within 90 characters', () => {
  const message = new InputTooLargeError(999e12, MAX_INPUT_BYTES, { subject: 'Decoded image' }).message;
  assert.ok(message.length <= 90, message);
});

test('formatBytes keeps three significant digits', () => {
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(1_234_567), '1.23 MB');
  assert.equal(formatBytes(30_000_000_000), '30.0 GB');
  assert.equal(formatBytes(MAX_INPUT_BYTES), '2.00 GB');
});
