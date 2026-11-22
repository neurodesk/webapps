import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
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
});
