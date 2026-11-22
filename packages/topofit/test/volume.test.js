import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import * as nifti from 'nifti-reader-js';
import { estimateConformMemoryBytes, needsConform, readVolume, resolveWorldAffine } from '../src/volume.js';
import { writeInt16Nifti } from '../src/qc.js';
import { regionMask } from '../src/analysis-qc.js';

function closeMatrix(actual, expected, tolerance = 1e-6, label = 'affine') {
  assert.equal(actual.length, 4, `${label}: 4 rows`);
  for (let row = 0; row < 4; row += 1) {
    assert.equal(actual[row].length, 4, `${label}: row ${row} length`);
    for (let col = 0; col < 4; col += 1) {
      assert.ok(
        Math.abs(actual[row][col] - expected[row][col]) <= tolerance,
        `${label} [${row}][${col}]: ${actual[row][col]} vs ${expected[row][col]}`,
      );
    }
  }
}

function makeNifti1({
  dims = [4, 5, 6],
  pixDims = [1, 1, 1, 1],
  qformCode = 0,
  sformCode = 1,
  quatern = [0, 0, 0],
  qoffset = [0, 0, 0],
  srow = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
  xyztUnits = 2,
} = {}) {
  const count = dims[0] * dims[1] * dims[2];
  const buffer = new ArrayBuffer(352 + count * 4);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  for (let i = 0; i < 3; i += 1) view.setInt16(42 + i * 2, dims[i], true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let i = 0; i < 4; i += 1) view.setFloat32(76 + i * 4, pixDims[i], true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setUint8(123, xyztUnits);
  view.setInt16(252, qformCode, true);
  view.setInt16(254, sformCode, true);
  for (let i = 0; i < 3; i += 1) view.setFloat32(256 + i * 4, quatern[i], true);
  for (let i = 0; i < 3; i += 1) view.setFloat32(268 + i * 4, qoffset[i], true);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) view.setFloat32(280 + (r * 4 + c) * 4, srow[r][c], true);
  }
  new Uint8Array(buffer).set([110, 43, 49, 0], 344);
  for (let i = 0; i < count; i += 1) view.setFloat32(352 + i * 4, i % 19, true);
  return buffer;
}

function makeNifti2({
  dims = [4, 5, 6],
  pixDims = [1, 1, 1, 1],
  qformCode = 0,
  sformCode = 1,
  quatern = [0, 0, 0],
  qoffset = [0, 0, 0],
  srow = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
  xyztUnits = 2,
  datatypeCode = 16,
  bitpix = 32,
  voxelBytes = null,
} = {}) {
  const count = dims[0] * dims[1] * dims[2];
  const payload = voxelBytes ?? new Uint8Array(count * (bitpix / 8));
  const buffer = new ArrayBuffer(544 + payload.byteLength);
  const view = new DataView(buffer);
  view.setInt32(0, 540, true);
  new Uint8Array(buffer).set([110, 43, 50, 0, 13, 10, 26, 10], 4);
  view.setInt16(12, datatypeCode, true);
  view.setInt16(14, bitpix, true);
  view.setBigInt64(16, 3n, true);
  for (let i = 1; i < 8; i += 1) view.setBigInt64(16 + i * 8, BigInt(dims[i - 1] ?? 1), true);
  for (let i = 0; i < 4; i += 1) view.setFloat64(104 + i * 8, pixDims[i], true);
  view.setBigInt64(168, 544n, true);
  view.setFloat64(176, 1, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i += 1) view.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i += 1) view.setFloat64(376 + i * 8, qoffset[i], true);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) view.setFloat64(400 + (r * 4 + c) * 8, srow[r][c], true);
  }
  view.setInt32(500, xyztUnits, true);
  if (voxelBytes) {
    new Uint8Array(buffer, 544).set(payload);
  } else {
    for (let i = 0; i < count; i += 1) view.setFloat32(544 + i * 4, i % 19, true);
  }
  return buffer;
}

const ZERO_SROW = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

test('needsConform matches the reference np.allclose identity tolerances', () => {
  const affine = [
    [1, 0, 0, 70],
    [0, 1, 0, -20],
    [0, 0, 1, 5],
    [0, 0, 0, 1],
  ];
  assert.equal(needsConform(affine), false);
  affine[0][0] = 1 + 1.0005e-5;
  assert.equal(needsConform(affine), false);
  affine[0][0] = 1 + 1.002e-5;
  assert.equal(needsConform(affine), true);
  affine[0][0] = 1;
  affine[0][1] = 1e-8;
  assert.equal(needsConform(affine), false);
  affine[0][1] = 1.01e-8;
  assert.equal(needsConform(affine), true);
  affine[0][1] = NaN;
  assert.equal(needsConform(affine), true);
});

test('conform memory bound covers every orientation of an anisotropic grid', () => {
  const retainedBytes = 1024;
  const bound = estimateConformMemoryBytes([64, 512, 512], retainedBytes);
  assert.equal(estimateConformMemoryBytes([512, 64, 512], retainedBytes), bound);
  assert.equal(estimateConformMemoryBytes([512, 512, 64], retainedBytes), bound);
  const source = 64 * 512 * 512;
  const afterX = 256 * 512 * 512;
  const afterY = 256 * 256 * 512;
  assert.ok(bound >= retainedBytes + 8 * (source + afterX + afterY));
});

test('resolveWorldAffine matches sform/qform code precedence identically for NIfTI-1 and NIfTI-2', () => {
  // 90° rotation around z: b=0, c=0, d=sqrt(1/2) => R = [[0,-1,0],[1,0,0],[0,0,1]]
  const q90z = [0, 0, Math.SQRT1_2];
  const expectedQ = [
    [0, -3, 0, 10],
    [2, 0, 0, -20],
    [0, 0, 4, 30],
    [0, 0, 0, 1],
  ];
  const srow = [
    [5, 0, 0, -1],
    [0, 6, 0, -2],
    [0, 0, 7, -3],
  ];
  const expectedS = [...srow, [0, 0, 0, 1]];
  const expectedMethod0 = [
    [2, 0, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 1],
  ];

  for (const [format, make] of [['NIfTI-1', makeNifti1], ['NIfTI-2', makeNifti2]]) {
    // qform-only with zeroed srows
    const qOnlyZero = make({ pixDims: [1, 2, 3, 4], qformCode: 1, sformCode: 0, quatern: q90z, qoffset: [10, -20, 30], srow: ZERO_SROW });
    closeMatrix(readVolume(qOnlyZero).affine, expectedQ, 1e-5, `${format} qform-only zero srow`);

    // qform-only with conflicting inactive srows
    const qOnlyConflict = make({ pixDims: [1, 2, 3, 4], qformCode: 1, sformCode: 0, quatern: q90z, qoffset: [10, -20, 30], srow });
    closeMatrix(readVolume(qOnlyConflict).affine, expectedQ, 1e-5, `${format} qform-only conflicting srow`);

    // sform-only
    const sOnly = make({ pixDims: [1, 2, 3, 4], qformCode: 0, sformCode: 1, quatern: q90z, qoffset: [10, -20, 30], srow });
    closeMatrix(readVolume(sOnly).affine, expectedS, 1e-5, `${format} sform-only`);

    // equal codes -> sform wins
    const bothEqual = make({ pixDims: [1, 2, 3, 4], qformCode: 1, sformCode: 1, quatern: q90z, qoffset: [10, -20, 30], srow });
    closeMatrix(readVolume(bothEqual).affine, expectedS, 1e-5, `${format} equal codes`);

    // sform_code > qform_code -> sform wins
    const sHigher = make({ pixDims: [1, 2, 3, 4], qformCode: 1, sformCode: 2, quatern: q90z, qoffset: [10, -20, 30], srow });
    closeMatrix(readVolume(sHigher).affine, expectedS, 1e-5, `${format} sform > qform`);

    // qform_code > sform_code -> qform wins (matches nifti-reader-js NIfTI-1 rule)
    const qHigher = make({ pixDims: [1, 2, 3, 4], qformCode: 2, sformCode: 1, quatern: q90z, qoffset: [10, -20, 30], srow });
    closeMatrix(readVolume(qHigher).affine, expectedQ, 1e-5, `${format} qform > sform`);

    // neither code set -> Method 0 pixDims diagonal
    const neither = make({ pixDims: [1, 2, 3, 4], qformCode: 0, sformCode: 0, quatern: q90z, qoffset: [10, -20, 30], srow: ZERO_SROW });
    closeMatrix(readVolume(neither).affine, expectedMethod0, 1e-5, `${format} neither set`);
  }
});

test('resolveWorldAffine handles negative qfac, zero qfac and 180-degree quaternions rounding past 1.0', () => {
  // Float32 representation of (0.6, 0.8, 0): b^2 + c^2 = 1.0000000476837158 > 1
  const b = Math.fround(0.6);
  const c = Math.fround(0.8);
  assert.ok(1 - (b * b + c * c) < 0, 'test quaternion rounds past 1.0');
  // 180° rotation about (0.6, 0.8, 0): R = 2*u*u^T - I = [[-0.28, 0.96, 0], [0.96, 0.28, 0], [0, 0, -1]]
  // With pixDims = [-1, 2, 3, 4] (qfac = -1), column 2 is multiplied by -4, giving +4 on [2][2].
  const expectedNegQfac = [
    [-0.28 * 2, 0.96 * 3, 0, 5],
    [0.96 * 2, 0.28 * 3, 0, -6],
    [0, 0, 4, 7],
    [0, 0, 0, 1],
  ];
  const expectedZeroQfac = [
    [-0.28 * 2, 0.96 * 3, 0, 5],
    [0.96 * 2, 0.28 * 3, 0, -6],
    [0, 0, -4, 7],
    [0, 0, 0, 1],
  ];

  for (const [format, make] of [['NIfTI-1', makeNifti1], ['NIfTI-2', makeNifti2]]) {
    const negQfac = make({ pixDims: [-1, 2, 3, 4], qformCode: 1, sformCode: 0, quatern: [b, c, 0], qoffset: [5, -6, 7], srow: ZERO_SROW });
    const zeroQfac = make({ pixDims: [0, 2, 3, 4], qformCode: 1, sformCode: 0, quatern: [b, c, 0], qoffset: [5, -6, 7], srow: ZERO_SROW });
    closeMatrix(readVolume(negQfac).affine, expectedNegQfac, 1e-5, `${format} 180deg qfac=-1`);
    closeMatrix(readVolume(zeroQfac).affine, expectedZeroQfac, 1e-5, `${format} 180deg qfac=0`);
  }

  // Exact 180° rotation about X: (b, c, d) = (1, 0, 0) with qfac = -1 => diag(1, -1, 1)
  const exact180 = makeNifti2({ pixDims: [-1, 1, 1, 1], qformCode: 1, sformCode: 0, quatern: [1, 0, 0], qoffset: [0, 0, 0], srow: ZERO_SROW });
  closeMatrix(readVolume(exact180).affine, [
    [1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ], 1e-12, 'exact 180deg X');
});

test('resolveWorldAffine scales metres, millimetres, micrometres and unknown units (preserving temporal bits)', () => {
  const baseMm = [
    [0, -2, 0, 12],
    [1.5, 0, 0, -8],
    [0, 0, 2.5, 4],
    [0, 0, 0, 1],
  ];
  const cases = [
    ['unknown', 0, 1],
    ['metres + sec', 1 | 8, 1e-3],
    ['millimetres + msec', 2 | 16, 1],
    ['micrometres + usec', 3 | 24, 1e3],
  ];
  for (const [format, make] of [['NIfTI-1', makeNifti1], ['NIfTI-2', makeNifti2]]) {
    for (const [label, xyztUnits, storedFactor] of cases) {
      const srow = baseMm.slice(0, 3).map((row) => row.map((value) => value * storedFactor));
      const sBuf = make({
        pixDims: [1, 1.5 * storedFactor, 2 * storedFactor, 2.5 * storedFactor],
        qformCode: 0,
        sformCode: 1,
        srow,
        xyztUnits,
      });
      closeMatrix(readVolume(sBuf).affine, baseMm, 1e-4, `${format} sform ${label}`);

      const qBuf = make({
        pixDims: [1, 1.5 * storedFactor, 2 * storedFactor, 2.5 * storedFactor],
        qformCode: 1,
        sformCode: 0,
        quatern: [0, 0, Math.SQRT1_2],
        qoffset: [12 * storedFactor, -8 * storedFactor, 4 * storedFactor],
        srow: ZERO_SROW,
        xyztUnits,
      });
      closeMatrix(readVolume(qBuf).affine, baseMm, 1e-4, `${format} qform ${label}`);
    }
  }
});

test('resolveWorldAffine rejects non-finite and singular affines', () => {
  const singularNifti2 = makeNifti2({ qformCode: 0, sformCode: 1, srow: ZERO_SROW });
  assert.throws(() => readVolume(singularNifti2), /singular/);

  const singularMethod0 = makeNifti2({ pixDims: [1, 0, 1, 1], qformCode: 0, sformCode: 0, srow: ZERO_SROW });
  assert.throws(() => readVolume(singularMethod0), /singular/);

  const singularQform = makeNifti2({ pixDims: [1, 1, 0, 1], qformCode: 1, sformCode: 0, srow: ZERO_SROW });
  assert.throws(() => readVolume(singularQform), /singular/);

  const nanSrow = makeNifti2({
    qformCode: 0,
    sformCode: 1,
    srow: [[NaN, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
  });
  assert.throws(() => readVolume(nanSrow), /non-finite/);

  const infQuatern = makeNifti2({
    qformCode: 1,
    sformCode: 0,
    quatern: [Infinity, 0, 0],
    srow: ZERO_SROW,
  });
  assert.throws(() => readVolume(infQuatern), /non-finite/);

  assert.throws(() => resolveWorldAffine({
    qform_code: 0,
    sform_code: 1,
    xyzt_units: 2,
    pixDims: [1, 1, 1, 1],
    affine: [[1, 0, 0, Infinity], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  }), /non-finite/);
});

test('readVolume accepts a gzipped NIfTI file with a bad gzip CRC trailer', () => {
  const raw = makeNifti2({ pixDims: [1, 1, 1, 1], qformCode: 1, sformCode: 0, quatern: [0, 0, Math.SQRT1_2], qoffset: [1, 2, 3], srow: ZERO_SROW });
  const gz = Buffer.from(gzipSync(Buffer.from(raw)));
  // Corrupt the 4-byte CRC32 located 8 bytes before EOF.
  gz[gz.length - 8] ^= 0xff;
  const volume = readVolume(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength));
  closeMatrix(volume.affine, [
    [0, -1, 0, 1],
    [1, 0, 0, 2],
    [0, 0, 1, 3],
    [0, 0, 0, 1],
  ], 1e-5, 'bad-crc gzipped NIfTI-2');
});

test('QC and mask outputs of a NIfTI-2 qform-only and metre scan carry the resolved millimetre grid', () => {
  const qOnlyMetre = makeNifti2({
    dims: [4, 5, 6],
    pixDims: [-1, 0.002, 0.0025, 0.003],
    qformCode: 2,
    sformCode: 0,
    quatern: [0, 0, Math.SQRT1_2],
    qoffset: [-0.01, 0.02, -0.03],
    srow: ZERO_SROW,
    xyztUnits: 1 | 8,
  });
  const volume = readVolume(qOnlyMetre);
  const expected = [
    [0, -2.5, 0, -10],
    [2, 0, 0, 20],
    [0, 0, -3, -30],
    [0, 0, 0, 1],
  ];
  closeMatrix(volume.affine, expected, 1e-5, 'NIfTI-2 qform-only metre reader');
  for (const [label, bytes] of [
    ['QC', writeInt16Nifti(volume, new Int16Array(120), 'qc')],
    ['mask', regionMask(volume, [], 'mask')],
  ]) {
    const view = new DataView(bytes);
    assert.equal(view.getInt32(0, true), 348, `${label} is NIfTI-1`);
    assert.equal(view.getUint8(123), 2 | 8, `${label} units are mm + sec`);
    assert.equal(view.getInt16(254, true), 2, `${label} preserves qform_code as sform_code`);
    closeMatrix(readVolume(bytes).affine, expected, 1e-4, `${label} written affine`);
  }
});

test('a real brain scan converted to NIfTI-2 (qform-only, micrometres, metres) matches the NIfTI-1 volume', async () => {
  const bytes = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
  const rawNifti1 = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const reference = readVolume(rawNifti1);
  const decompressed = nifti.decompress(rawNifti1);
  const h1 = reference.header;
  const voxelBytes = new Uint8Array(nifti.readImage(h1, decompressed));

  for (const [label, xyztUnits, storedFactor] of [
    ['qform-only mm', 2, 1],
    ['qform-only µm', 3, 1000],
    ['qform-only m', 1, 0.001],
  ]) {
    const nifti2 = makeNifti2({
      dims: reference.dims,
      pixDims: [
        h1.pixDims[0],
        h1.pixDims[1] * storedFactor,
        h1.pixDims[2] * storedFactor,
        h1.pixDims[3] * storedFactor,
      ],
      qformCode: h1.qform_code,
      sformCode: 0,
      quatern: [h1.quatern_b, h1.quatern_c, h1.quatern_d],
      qoffset: [
        h1.qoffset_x * storedFactor,
        h1.qoffset_y * storedFactor,
        h1.qoffset_z * storedFactor,
      ],
      srow: ZERO_SROW,
      xyztUnits,
      datatypeCode: h1.datatypeCode,
      bitpix: h1.numBitsPerVoxel,
      voxelBytes,
    });
    const actual = readVolume(nifti2);
    assert.deepEqual(actual.dims, reference.dims, `${label}: dims`);
    assert.deepEqual(actual.data, reference.data, `${label}: voxels`);
    closeMatrix(actual.affine, reference.affine, 1e-4, `${label}: oblique brain affine`);
  }
});
