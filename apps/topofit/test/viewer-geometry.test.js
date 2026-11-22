import test from 'node:test';
import assert from 'node:assert/strict';
import { alignViewerVolumes } from '../src/viewer-geometry.js';

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
    // NIfTI-2 qform-only with zeroed srows and micrometre units + temporal sec bit (8)
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
    // NIfTI-1 metre overlay
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
