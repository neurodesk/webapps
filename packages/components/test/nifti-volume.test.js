import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  computeFallbackAffine,
  parseNiftiVolumeHeader,
  readNiftiVolume,
  writeNiftiVolume,
} from '../src/file-io/nifti-volume.js';

function makeNifti1Raw({
  dims = [4, 4, 4],
  datatype = 16,
  qformCode = 0,
  sformCode = 0,
  pixdim0 = 1,
  pixDims = [1, 1, 1],
  quatern = [0, 0, 0],
  qoffset = [0, 0, 0],
  srows = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  xyztUnits = 2,
  values = null,
} = {}) {
  const total = dims[0] * dims[1] * dims[2];
  const bytesPerVoxel = datatype === 64 ? 8 : datatype === 2 ? 1 : 4;
  const buf = new ArrayBuffer(352 + total * bytesPerVoxel);
  const v = new DataView(buf);
  v.setInt32(0, 348, true);
  v.setInt16(40, 3, true);
  v.setInt16(42, dims[0], true);
  v.setInt16(44, dims[1], true);
  v.setInt16(46, dims[2], true);
  for (let i = 4; i < 8; i += 1) v.setInt16(40 + i * 2, 1, true);
  v.setInt16(70, datatype, true);
  v.setInt16(72, bytesPerVoxel * 8, true);
  v.setFloat32(76, pixdim0, true);
  v.setFloat32(80, pixDims[0], true);
  v.setFloat32(84, pixDims[1], true);
  v.setFloat32(88, pixDims[2], true);
  v.setFloat32(108, 352, true);
  v.setFloat32(112, 1, true);
  v.setFloat32(116, 0, true);
  v.setUint8(123, xyztUnits);
  v.setInt16(252, qformCode, true);
  v.setInt16(254, sformCode, true);
  v.setFloat32(256, quatern[0], true);
  v.setFloat32(260, quatern[1], true);
  v.setFloat32(264, quatern[2], true);
  v.setFloat32(268, qoffset[0], true);
  v.setFloat32(272, qoffset[1], true);
  v.setFloat32(276, qoffset[2], true);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      v.setFloat32(280 + (r * 4 + c) * 4, srows[r][c], true);
    }
  }
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
  for (let i = 0; i < total; i += 1) {
    const val = values ? values[i] : i;
    if (datatype === 64) v.setFloat64(352 + i * 8, val, true);
    else if (datatype === 2) v.setUint8(352 + i, val);
    else v.setFloat32(352 + i * 4, val, true);
  }
  return new Uint8Array(buf);
}

function makeNifti2Raw({
  dims = [4, 4, 4],
  qformCode = 1,
  sformCode = 0,
  pixdim0 = 1,
  pixDims = [2, 3, 4],
  quatern = [0, 0, 0],
  qoffset = [10, 20, 30],
  srows = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  xyztUnits = 2,
  allocateVoxels = true,
} = {}) {
  const total = allocateVoxels ? dims[0] * dims[1] * dims[2] : 0;
  const buf = new ArrayBuffer(544 + total * 4);
  const v = new DataView(buf);
  v.setInt32(0, 540, true);
  new Uint8Array(buf, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
  v.setInt16(12, 16, true);
  v.setInt16(14, 32, true);
  v.setBigInt64(16, 3n, true);
  v.setBigInt64(24, BigInt(dims[0]), true);
  v.setBigInt64(32, BigInt(dims[1]), true);
  v.setBigInt64(40, BigInt(dims[2]), true);
  for (let i = 4; i < 8; i += 1) v.setBigInt64(16 + i * 8, 1n, true);
  v.setFloat64(104, pixdim0, true);
  v.setFloat64(112, pixDims[0], true);
  v.setFloat64(120, pixDims[1], true);
  v.setFloat64(128, pixDims[2], true);
  v.setBigInt64(168, 544n, true);
  v.setFloat64(176, 1, true);
  v.setFloat64(184, 0, true);
  v.setInt32(344, qformCode, true);
  v.setInt32(348, sformCode, true);
  v.setFloat64(352, quatern[0], true);
  v.setFloat64(360, quatern[1], true);
  v.setFloat64(368, quatern[2], true);
  v.setFloat64(376, qoffset[0], true);
  v.setFloat64(384, qoffset[1], true);
  v.setFloat64(392, qoffset[2], true);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      v.setFloat64(400 + (r * 4 + c) * 8, srows[r][c], true);
    }
  }
  v.setInt32(500, xyztUnits, true);
  for (let i = 0; i < total; i += 1) v.setFloat32(544 + i * 4, i + 1, true);
  return new Uint8Array(buf);
}

test('NiBabel affine precedence picks sform_code=1 over qform_code=2 and preserves BOTH verbatim', () => {
  const raw = makeNifti1Raw({
    qformCode: 2,
    sformCode: 1,
    pixDims: [1, 1, 1],
    qoffset: [5, 6, 7],
    srows: [
      [1, 0, 0, 105],
      [0, 1, 0, 6],
      [0, 0, 1, 7],
    ],
  });
  const vol = readNiftiVolume(raw);
  assert.equal(vol.affineSource, 'sform');
  assert.equal(vol.affine[0][3], 105);

  const rewritten = writeNiftiVolume({
    data: new Uint8Array(vol.data.length).fill(1),
    dims: vol.dims,
    affine: vol.affine,
    transforms: vol.transforms,
    version: vol.version,
  });
  const header = parseNiftiVolumeHeader(rewritten);
  assert.equal(header.qformCode, 2);
  assert.equal(header.sformCode, 1);
  assert.equal(header.transforms.qoffsetX, 5);
  assert.equal(header.transforms.srowX[3], 105);
});

test('qform-only NIfTI-2 and dims > 32767 are parsed and written faithfully', () => {
  const v2 = makeNifti2Raw({
    dims: [4, 4, 4],
    qformCode: 1,
    sformCode: 0,
    pixdim0: -1,
    pixDims: [2, 3, 4],
    qoffset: [10, 20, 30],
  });
  const vol = readNiftiVolume(v2);
  assert.equal(vol.version, 2);
  assert.equal(vol.affineSource, 'qform');
  assert.deepEqual(vol.affine, [
    [2, 0, 0, 10],
    [0, 3, 0, 20],
    [0, 0, -4, 30],
    [0, 0, 0, 1],
  ]);
  const out = writeNiftiVolume({
    data: new Uint8Array(64).fill(1),
    dims: vol.dims,
    affine: vol.affine,
    transforms: vol.transforms,
    version: vol.version,
  });
  const roundTripped = readNiftiVolume(out);
  assert.equal(roundTripped.version, 2);
  assert.equal(roundTripped.transforms.qformCode, 1);
  assert.equal(roundTripped.transforms.sformCode, 0);
  assert.deepEqual(roundTripped.affine, vol.affine);

  // Header parsing supports dims > 32767 via NIfTI-2 int64 dim fields.
  const largeHeaderBytes = makeNifti2Raw({ dims: [40000, 2, 2], allocateVoxels: false });
  const largeHeader = parseNiftiVolumeHeader(largeHeaderBytes);
  assert.equal(largeHeader.version, 2);
  assert.equal(largeHeader.dims[1], 40000);
});

test('LAS-centered fallback affine matches NiBabel get_base_affine when qform=0 and sform=0', () => {
  const raw = makeNifti1Raw({
    dims: [5, 7, 9],
    qformCode: 0,
    sformCode: 0,
    pixDims: [2, 3, 4],
  });
  const vol = readNiftiVolume(raw);
  assert.equal(vol.affineSource, 'fallback');
  const expected = computeFallbackAffine([5, 7, 9], [2, 3, 4]);
  assert.deepEqual(vol.affine, expected);
  assert.deepEqual(expected, [
    [-2, 0, 0, 4],
    [0, 3, 0, -9],
    [0, 0, 4, -16],
    [0, 0, 0, 1],
  ]);
});

test('gzip CRC corruption is rejected and two-member gzip streams decode cleanly', () => {
  const raw = makeNifti1Raw({ sformCode: 1 });
  const gz = gzipSync(raw);
  const corrupt = Buffer.from(gz);
  corrupt[corrupt.length - 6] ^= 0xff; // Flip CRC32 byte
  assert.throws(
    () => readNiftiVolume(corrupt, { decompress: (b, o) => gunzipSync(b, o) }),
    /incorrect data check|invalid|zlib|CRC/i,
  );

  // Two-member gzip stream (concatenation of two valid gzip members)
  const split = Math.floor(raw.length / 2);
  const twoMember = Buffer.concat([gzipSync(raw.subarray(0, split)), gzipSync(raw.subarray(split))]);
  const decoded = readNiftiVolume(twoMember, { decompress: (b, o) => gunzipSync(b, o) });
  assert.deepEqual(decoded.dims, [4, 4, 4]);
  assert.equal(decoded.data[10], 10);
});

test('FLOAT64 1e100 voxel overflow and float32 affine overflow are handled safely', () => {
  const values = new Array(64).fill(1);
  values[7] = 1e100;
  const overflowVoxels = makeNifti1Raw({ datatype: 64, sformCode: 1, values });
  assert.throws(
    () => readNiftiVolume(overflowVoxels),
    /non-finite or float32-overflowing intensities/,
  );

  const hugeAffine = [
    [1, 0, 0, 1e100],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  assert.throws(
    () => writeNiftiVolume({ data: new Uint8Array(8), dims: [2, 2, 2], affine: hugeAffine, version: 1 }),
    /NIfTI-1 finite float32/,
  );
  // Auto-selects NIfTI-2 when version is omitted.
  const autoV2 = writeNiftiVolume({ data: new Uint8Array(8), dims: [2, 2, 2], affine: hugeAffine });
  assert.equal(parseNiftiVolumeHeader(autoV2).version, 2);
});
