import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createFloat32Nifti,
  createMaskNifti,
  decodeNiftiBuffer,
  extractNiftiHeader,
  isGzipped,
  isValidNifti1,
  parseNiftiHeader,
  parseNiftiVolume,
  readNifti
} from '../src/file-io/index.js';

// The fixtures are written by nibabel (test/fixtures/make_nifti_fixtures.py), so the
// reader is checked against an independent implementation, not against our own writer.
const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const rows = affine => affine.map(row => Array.from(row, value => Number(value.toFixed(5)) + 0));

test('reads a gzipped, scaled int16 NIfTI written by nibabel', async () => {
  const bytes = await fixture('sform-int16-scaled.nii.gz');
  assert.equal(isGzipped(bytes), true);
  const { data, dims, header } = await readNifti(bytes, Float64Array);
  assert.deepEqual(dims, [2, 3, 4]);
  assert.equal(header.datatype, 4);
  assert.equal(header.bitpix, 16);
  assert.deepEqual(header.voxelSize, [0.5, 0.75, 2]);
  // Stored x + 2y + 6z with scl_slope 0.5 and scl_inter 10, x fastest.
  assert.deepEqual(Array.from(data), Array.from({ length: 24 }, (_, index) => 10 + index / 2));
  assert.deepEqual(rows(header.affine), [
    [-0.5, 0, 0, 90],
    [0, -0.75, 0, 126],
    [0, 0, 2, -72],
    [0, 0, 0, 1]
  ]);
});

test('builds the affine from the quaternion when only the qform is set', async () => {
  const bytes = await fixture('qform-float32.nii');
  assert.equal(isGzipped(bytes), false);
  assert.equal(isValidNifti1(bytes), true);
  const header = parseNiftiHeader(bytes);
  // A 90 degree rotation about z: voxel i runs along +y, voxel j along -x.
  assert.deepEqual(rows(header.affine), [
    [0, -2, 0, 5],
    [1, 0, 0, -7],
    [0, 0, 3, 11],
    [0, 0, 0, 1]
  ]);
  const volume = parseNiftiVolume(bytes);
  assert.deepEqual(volume.dims, [2, 3, 4]);
  assert.deepEqual(volume.voxelSize, [1, 2, 3]);
  assert.deepEqual(Array.from(volume.imageData), Array.from({ length: 24 }, (_, index) => index / 4));
  assert.equal(volume.headerBytes.byteLength, 352);
});

test('rejects buffers that are not single-file NIfTI-1', async () => {
  const bytes = new Uint8Array(await fixture('qform-float32.nii'));
  assert.equal(isValidNifti1(bytes.slice(0, 100)), false);
  const wrongMagic = bytes.slice();
  wrongMagic[344] = 0x00;
  assert.equal(isValidNifti1(wrongMagic), false);
  await assert.rejects(
    async () => parseNiftiVolume(await fixture('sform-int16-scaled.nii.gz')),
    /Compressed NIfTI requires a decompress function/
  );
});

test('derived outputs keep the source geometry and take the new datatype', async () => {
  const source = await decodeNiftiBuffer(await fixture('sform-int16-scaled.nii.gz'));
  const sourceHeader = extractNiftiHeader(source);
  const values = Float32Array.from({ length: 24 }, (_, index) => index * 1.5);

  const float = parseNiftiHeader(createFloat32Nifti(values, sourceHeader));
  assert.equal(float.datatype, 16);
  assert.equal(float.bitpix, 32);
  assert.deepEqual([float.nx, float.ny, float.nz], [2, 3, 4]);
  assert.deepEqual(rows(float.affine)[0], [-0.5, 0, 0, 90]);
  // The source's 0.5x + 10 scaling describes the source voxels, not the derived ones.
  const derived = await readNifti(createFloat32Nifti(values, sourceHeader), Float64Array);
  assert.deepEqual(Array.from(derived.data), Array.from(values));

  const mask = await readNifti(createMaskNifti([0, 5, 0, -1, ...new Array(20).fill(0)], sourceHeader), Uint8Array);
  assert.equal(mask.header.datatype, 2);
  assert.deepEqual(Array.from(mask.data.slice(0, 4)), [0, 1, 0, 1]);
});
