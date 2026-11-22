import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { alignViewerVolumes, readFileWorldAffine } from '../src/viewer-geometry.js';

function fakeNiivue(volumes) {
  const calls = [];
  let locationUpdates = 0;
  return {
    volumes,
    calls,
    get locationUpdates() { return locationUpdates; },
    async setVolumeAffine(index, affine) {
      calls.push({ index, affine, pixDims: [...volumes[index].hdr.pixDims], units: volumes[index].hdr.xyzt_units, dirty: volumes[index].isDirty });
      volumes[index].hdr.affine = affine.map((row) => [...row]);
    },
    createOnLocationChange() {
      locationUpdates += 1;
    },
  };
}

function makeNifti2Bytes({ pixDims = [1, 2, 3, 4], qformCode = 1, sformCode = 0, quatern = [0, 0, Math.SQRT1_2], qoffset = [10, -20, 30], xyztUnits = 2, extension = false } = {}) {
  const buffer = new ArrayBuffer(544 + 32);
  const view = new DataView(buffer);
  view.setInt32(0, 540, true);
  new Uint8Array(buffer).set([110, 43, 50, 0, 13, 10, 26, 10], 4);
  view.setInt16(12, 16, true);
  view.setInt16(14, 32, true);
  view.setBigInt64(16, 3n, true);
  for (let i = 1; i <= 3; i += 1) view.setBigInt64(16 + i * 8, 2n, true);
  for (let i = 0; i < 4; i += 1) view.setFloat64(104 + i * 8, pixDims[i], true);
  view.setBigInt64(168, extension ? 4096n : 544n, true);
  view.setFloat64(176, 1, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  for (let i = 0; i < 3; i += 1) view.setFloat64(352 + i * 8, quatern[i], true);
  for (let i = 0; i < 3; i += 1) view.setFloat64(376 + i * 8, qoffset[i], true);
  view.setInt32(500, xyztUnits, true);
  if (extension) new Uint8Array(buffer)[540] = 1;
  return new Uint8Array(buffer);
}

test('leaves already-aligned millimetre volumes untouched', async () => {
  const nv = fakeNiivue([{
    hdr: {
      qform_code: 0,
      sform_code: 1,
      xyzt_units: 2,
      pixDims: [1, 2, 2, 2],
      affine: [[2, 0, 0, -10], [0, 2, 0, -20], [0, 0, 2, -30], [0, 0, 0, 1]],
    },
  }]);
  assert.equal(await alignViewerVolumes(nv), true);
  assert.deepEqual(nv.calls, []);
  assert.equal(nv.locationUpdates, 0);
});

test('aligns NIfTI-2 qform-only, micrometre and metre volumes with matching pixDims, units and dirty flag', async () => {
  const nv = fakeNiivue([
    {
      hdr: {
        qform_code: 1,
        sform_code: 0,
        quatern_b: 0,
        quatern_c: 0,
        quatern_d: Math.SQRT1_2,
        qoffset_x: 10000,
        qoffset_y: -20000,
        qoffset_z: 30000,
        xyzt_units: 3 | 8,
        pixDims: [1, 2000, 3000, 4000],
        affine: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]],
      },
    },
    {
      hdr: {
        qform_code: 0,
        sform_code: 1,
        xyzt_units: 1,
        pixDims: [1, 0.002, 0.003, 0.004],
        affine: [[0.002, 0, 0, -0.01], [0, 0.003, 0, -0.02], [0, 0, 0.004, -0.03], [0, 0, 0, 1]],
      },
    },
  ]);

  assert.equal(await alignViewerVolumes(nv), true);
  assert.equal(nv.calls.length, 2);
  assert.equal(nv.locationUpdates, 1);

  const [first, second] = nv.calls;
  assert.equal(first.index, 0);
  assert.equal(first.dirty, true);
  assert.equal(first.units, 2 | 8);
  assert.deepEqual(first.pixDims.slice(1, 4).map((v) => Math.round(v * 1e6) / 1e6), [2, 3, 4]);
  assert.ok(Math.abs(first.affine[0][1] - (-3)) < 1e-6);
  assert.ok(Math.abs(first.affine[1][0] - 2) < 1e-6);
  assert.ok(Math.abs(first.affine[0][3] - 10) < 1e-6);

  assert.equal(second.index, 1);
  assert.equal(second.dirty, true);
  assert.equal(second.units, 2);
  assert.deepEqual(second.pixDims.slice(1, 4).map((v) => Math.round(v * 1e6) / 1e6), [2, 3, 4]);
  assert.ok(Math.abs(second.affine[0][0] - 2) < 1e-6);
  assert.ok(Math.abs(second.affine[2][3] - (-30)) < 1e-6);
});

test('recovers a NIfTI-1 180-degree quaternion volume whose nifti-reader-js affine has NaN', async () => {
  const b = Math.fround(0.6);
  const c = Math.fround(0.8);
  const nv = fakeNiivue([{
    hdr: {
      qform_code: 1,
      sform_code: 0,
      quatern_b: b,
      quatern_c: c,
      quatern_d: 0,
      qoffset_x: 5,
      qoffset_y: -6,
      qoffset_z: 7,
      xyzt_units: 2,
      pixDims: [-1, 1, 1, 1],
      affine: [[NaN, NaN, NaN, 5], [NaN, NaN, NaN, -6], [NaN, NaN, NaN, 7], [0, 0, 0, 1]],
    },
  }]);
  assert.equal(await alignViewerVolumes(nv), true);
  assert.equal(nv.calls.length, 1);
  assert.ok(nv.calls[0].affine.flat().every(Number.isFinite));
  assert.ok(Math.abs(nv.calls[0].affine[2][2] - 1) < 1e-6);
});

test('stops immediately when superseded by a newer load', async () => {
  let current = true;
  const nv = fakeNiivue([
    {
      hdr: {
        qform_code: 0,
        sform_code: 1,
        xyzt_units: 3,
        pixDims: [1, 1000, 1000, 1000],
        affine: [[1000, 0, 0, 0], [0, 1000, 0, 0], [0, 0, 1000, 0], [0, 0, 0, 1]],
      },
    },
    {
      hdr: {
        qform_code: 0,
        sform_code: 1,
        xyzt_units: 3,
        pixDims: [1, 1000, 1000, 1000],
        affine: [[1000, 0, 0, 0], [0, 1000, 0, 0], [0, 0, 1000, 0], [0, 0, 0, 1]],
      },
    },
  ]);
  const baseSet = nv.setVolumeAffine.bind(nv);
  nv.setVolumeAffine = async (index, affine) => {
    await baseSet(index, affine);
    current = false;
  };
  assert.equal(await alignViewerVolumes(nv, () => current), false);
  assert.equal(nv.calls.length, 1);
  assert.equal(nv.locationUpdates, 0);
});

test('readFileWorldAffine validates untouched headers across uncompressed, gzipped, bad-CRC gzip and invalid spacing', async () => {
  const valid = makeNifti2Bytes({ extension: true });
  const affineRaw = await readFileWorldAffine(new Blob([valid]));
  assert.ok(Math.abs(affineRaw[0][1] - (-3)) < 1e-6);
  assert.ok(Math.abs(affineRaw[1][0] - 2) < 1e-6);

  const gz = Buffer.from(gzipSync(Buffer.from(valid)));
  const affineGz = await readFileWorldAffine(new Blob([gz]));
  assert.deepEqual(affineGz, affineRaw);

  const badCrc = Buffer.from(gz);
  badCrc[badCrc.length - 8] ^= 0xff;
  const affineBadCrc = await readFileWorldAffine(new Blob([badCrc]));
  assert.deepEqual(affineBadCrc, affineRaw);

  for (const bad of [0, -2, NaN]) {
    const invalid = makeNifti2Bytes({ pixDims: [1, bad, 3, 4], qformCode: 1, sformCode: 0 });
    await assert.rejects(readFileWorldAffine(new Blob([invalid])), /voxel spacing must be finite and positive/);
  }

  for (const shortBytes of [new Uint8Array(0), new Uint8Array([0x1f])]) {
    await assert.rejects(readFileWorldAffine(new Blob([shortBytes])), /Choose a NIfTI image/);
  }
});

test('readFileWorldAffine bounds compressed reads for highly compressible and bad-CRC gzip scans', async () => {
  const header = makeNifti2Bytes({ extension: true });
  const large = new Uint8Array(32 * 1024 * 1024);
  large.set(header, 0);
  const gz = Buffer.from(gzipSync(large));
  assert.ok(gz.length > 8192, `expected multi-KiB compressed fixture, got ${gz.length}`);
  const badCrc = Buffer.from(gz);
  badCrc[badCrc.length - 8] ^= 0xff;

  for (const payload of [gz, badCrc]) {
    let slicedBytes = 0;
    let maxSliceBytes = 0;
    const blob = new Blob([payload]);
    const tracked = {
      size: blob.size,
      slice(start = 0, end = blob.size) {
        const len = Math.max(0, Math.min(end, blob.size) - Math.max(0, start));
        slicedBytes += len;
        maxSliceBytes = Math.max(maxSliceBytes, len);
        return blob.slice(start, end);
      },
      arrayBuffer() {
        throw new Error('header probe must not read the entire file');
      },
      stream() {
        throw new Error('header probe must not stream unbounded chunks');
      },
    };
    const affine = await readFileWorldAffine(tracked);
    assert.ok(Math.abs(affine[0][1] - (-3)) < 1e-6);
    assert.ok(Math.abs(affine[1][0] - 2) < 1e-6);
    assert.ok(maxSliceBytes <= 544, `expected bounded slices, saw ${maxSliceBytes}`);
    assert.ok(slicedBytes < 4096, `expected bounded total reads, saw ${slicedBytes} of ${blob.size}`);
  }
});

test('readFileWorldAffine handles max legal FEXTRA gzip header and leading empty DEFLATE blocks with bounded slices', async () => {
  const header = makeNifti2Bytes({ extension: true });
  // 1. Legal 65,535-byte FEXTRA header (payload begins at offset 65,547).
  const rawDeflate = deflateRawSync(Buffer.from(header));
  const fextraGzip = Buffer.alloc(10 + 2 + 65535 + rawDeflate.length + 8);
  fextraGzip.set([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff], 0);
  fextraGzip.writeUInt16LE(65535, 10);
  rawDeflate.copy(fextraGzip, 10 + 2 + 65535);
  let fextraRead = 0;
  let fextraMaxSlice = 0;
  const fextraBlob = new Blob([fextraGzip]);
  const fextraTracked = {
    size: fextraBlob.size,
    slice(start = 0, end = fextraBlob.size) {
      const len = Math.max(0, Math.min(end, fextraBlob.size) - Math.max(0, start));
      fextraRead += len;
      fextraMaxSlice = Math.max(fextraMaxSlice, len);
      return fextraBlob.slice(start, end);
    },
  };
  const fextraAffine = await readFileWorldAffine(fextraTracked);
  assert.ok(Math.abs(fextraAffine[0][1] - (-3)) < 1e-6);
  assert.ok(fextraMaxSlice <= 544);
  assert.ok(fextraRead < 2048, `expected FEXTRA to be skipped without reading, saw ${fextraRead}`);

  // 2. Leading empty stored DEFLATE blocks before a highly compressible 32 MiB
  // payload: must stop at the header boundary without reading to EOF.
  const large = new Uint8Array(32 * 1024 * 1024);
  large.set(header, 0);
  const largeRawDeflate = deflateRawSync(large);
  const fiftyEmpty = Buffer.alloc(50 * 5);
  for (let i = 0; i < 50; i += 1) fiftyEmpty.set([0x00, 0x00, 0x00, 0xff, 0xff], i * 5);
  const paddedLargeGzip = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff]),
    fiftyEmpty,
    largeRawDeflate,
    Buffer.alloc(8),
  ]);
  assert.ok(paddedLargeGzip.length > 16384);
  let paddedRead = 0;
  let paddedMaxSlice = 0;
  const paddedBlob = new Blob([paddedLargeGzip]);
  const paddedTracked = {
    size: paddedBlob.size,
    slice(start = 0, end = paddedBlob.size) {
      const len = Math.max(0, Math.min(end, paddedBlob.size) - Math.max(0, start));
      paddedRead += len;
      paddedMaxSlice = Math.max(paddedMaxSlice, len);
      return paddedBlob.slice(start, end);
    },
  };
  const paddedAffine = await readFileWorldAffine(paddedTracked);
  assert.ok(Math.abs(paddedAffine[0][1] - (-3)) < 1e-6);
  assert.ok(paddedMaxSlice <= 544, `expected fixed bounded slice <= 544, saw ${paddedMaxSlice}`);
  assert.ok(
    paddedRead < 2048,
    `expected probe to stop at header boundary well before EOF, saw ${paddedRead} of ${paddedLargeGzip.length}`,
  );
});

test('readFileWorldAffine stops immediately when cancelled during gzip header scanning or inflation', async () => {
  const header = makeNifti2Bytes({ extension: true });
  const rawDeflate = deflateRawSync(Buffer.from(header));

  // Cancel during DEFLATE inflation (4th slice of a long sequence of empty blocks).
  const manyEmpty = Buffer.alloc(1000 * 5);
  for (let i = 0; i < 1000; i += 1) manyEmpty.set([0x00, 0x00, 0x00, 0xff, 0xff], i * 5);
  const inflateGzip = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0, 0xff]),
    manyEmpty,
    rawDeflate,
    Buffer.alloc(8),
  ]);
  let inflateSlices = 0;
  let inflateActive = true;
  const inflateBlob = new Blob([inflateGzip]);
  const inflateTracked = {
    size: inflateBlob.size,
    slice(start = 0, end = inflateBlob.size) {
      inflateSlices += 1;
      if (inflateSlices === 4) inflateActive = false;
      return inflateBlob.slice(start, end);
    },
  };
  const inflateResult = await readFileWorldAffine(inflateTracked, { isCurrent: () => inflateActive });
  assert.equal(inflateResult, null);
  assert.equal(inflateSlices, 4, `expected inflation to stop at slice 4, saw ${inflateSlices}`);

  // Cancel during long FNAME scanning.
  const longName = Buffer.alloc(4096, 0x61);
  longName[longName.length - 1] = 0;
  const fnameGzip = Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0x08, 0, 0, 0, 0, 0, 0xff]),
    longName,
    rawDeflate,
    Buffer.alloc(8),
  ]);
  let fnameSlices = 0;
  let fnameActive = true;
  const fnameBlob = new Blob([fnameGzip]);
  const fnameTracked = {
    size: fnameBlob.size,
    slice(start = 0, end = fnameBlob.size) {
      fnameSlices += 1;
      if (fnameSlices === 3) fnameActive = false;
      return fnameBlob.slice(start, end);
    },
  };
  const fnameResult = await readFileWorldAffine(fnameTracked, { isCurrent: () => fnameActive });
  assert.equal(fnameResult, null);
  assert.equal(fnameSlices, 3, `expected FNAME scan to stop at slice 3, saw ${fnameSlices}`);
});

test('readFileWorldAffine stops at the NIfTI-1 header or DEFLATE member end on concatenated gzip files', async () => {
  // Build a complete minimal NIfTI-1 scan (< 544 bytes uncompressed) concatenated
  // with a 512 KiB second gzip member, plus a truncated first member and non-NIfTI member.
  const nifti1 = new Uint8Array(352 + 8 * 2);
  const view = new DataView(nifti1.buffer);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, 2, true);
  view.setInt16(44, 2, true);
  view.setInt16(46, 2, true);
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  view.setFloat32(76, 1, true);
  view.setFloat32(80, 2, true);
  view.setFloat32(84, 3, true);
  view.setFloat32(88, 4, true);
  view.setFloat32(108, 352, true);
  view.setUint8(123, 2);
  view.setInt16(252, 0, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, 2, true);
  view.setFloat32(300, 3, true);
  view.setFloat32(320, 4, true);
  nifti1.set([0x6e, 0x2b, 0x31, 0x00], 344);

  const trailerPayload = Buffer.from(gzipSync(Buffer.alloc(512 * 1024, 0x5a)));
  const bigSecondMember = Buffer.concat(Array.from({ length: 400 }, () => trailerPayload));
  assert.ok(bigSecondMember.length > 200 * 1024);

  const track = (buf) => {
    let slices = 0;
    let bytes = 0;
    const blob = new Blob([buf]);
    return {
      stats: () => ({ slices, bytes }),
      file: {
        size: blob.size,
        slice(start = 0, end = blob.size) {
          slices += 1;
          bytes += Math.max(0, Math.min(end, blob.size) - Math.max(0, start));
          return blob.slice(start, end);
        },
      },
    };
  };

  // 1. Complete NIfTI-1 first member (< 544 bytes) + huge second member.
  const concatValid = track(Buffer.concat([Buffer.from(gzipSync(nifti1)), bigSecondMember]));
  const affine = await readFileWorldAffine(concatValid.file);
  assert.deepEqual(affine, [
    [2, 0, 0, 0],
    [0, 3, 0, 0],
    [0, 0, 4, 0],
    [0, 0, 0, 1],
  ]);
  assert.ok(concatValid.stats().slices <= 3, `expected <= 3 slices, saw ${concatValid.stats().slices}`);
  assert.ok(concatValid.stats().bytes < 1024, `expected < 1024 bytes read, saw ${concatValid.stats().bytes}`);

  // 2. Truncated 100-byte NIfTI-1 prefix (starts with 348) + huge second member.
  const concatTruncated = track(Buffer.concat([Buffer.from(gzipSync(nifti1.subarray(0, 100))), bigSecondMember]));
  await assert.rejects(readFileWorldAffine(concatTruncated.file), /Choose a NIfTI image/);
  assert.ok(concatTruncated.stats().slices <= 3, `expected <= 3 slices, saw ${concatTruncated.stats().slices}`);
  assert.ok(concatTruncated.stats().bytes < 1024, `expected < 1024 bytes read, saw ${concatTruncated.stats().bytes}`);

  // 3. Non-NIfTI first member + huge second member stops immediately at 4 bytes.
  const nonNifti = Buffer.alloc(1024, 0x41);
  const concatNonNifti = track(Buffer.concat([Buffer.from(gzipSync(nonNifti)), bigSecondMember]));
  await assert.rejects(readFileWorldAffine(concatNonNifti.file), /Choose a NIfTI image/);
  assert.ok(concatNonNifti.stats().slices <= 3, `expected <= 3 slices, saw ${concatNonNifti.stats().slices}`);
  assert.ok(concatNonNifti.stats().bytes < 1024, `expected < 1024 bytes read, saw ${concatNonNifti.stats().bytes}`);
});
