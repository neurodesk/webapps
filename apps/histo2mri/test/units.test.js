import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { mriVolume, scalarNifti } from '../src/core/nifti.js';
import { samplePlane, slicePlane } from '../src/core/plane.js';
import { phantomSlice } from './helpers.js';

// The same 0.6 mm MRI written with its affine in metres, millimetres and micrometres.
function written(unitCode, scale) {
  const dims = [40, 36, 5];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let k = 0; k < dims[2]; k++) data.set(phantomSlice(dims[0], dims[1], { phase: k }), k * dims[0] * dims[1]);
  const affine = [[0.6, 0, 0, -12], [0, 0, -0.6, 4], [0, 0.6, 0, -10.5], [0, 0, 0, 1]].map((row, r) => row.map((value) => (r < 3 ? value * scale : value)));
  const bytes = scalarNifti(data, dims, affine);
  new DataView(bytes.buffer).setUint8(123, unitCode);
  return parseNiftiVolume(bytes.buffer);
}

test('an MRI in metres, millimetres or micrometres gives the same millimetre plane', () => {
  const planes = [[1, 0.001], [2, 1], [3, 1000], [0, 1]].map(([code, scale]) => {
    const volume = mriVolume(written(code, scale));
    const plane = slicePlane(volume, { axis: 2, index: 2 });
    return { plane, image: samplePlane(volume, plane) };
  });
  const [reference] = planes;
  assert.ok(Math.abs(reference.plane.spacing - 0.6) < 1e-6, `${reference.plane.spacing} mm`);
  for (const { plane, image } of planes.slice(1)) {
    assert.ok(Math.abs(plane.spacing - reference.plane.spacing) < 1e-6);
    assert.deepEqual([plane.nu, plane.nv], [reference.plane.nu, reference.plane.nv]);
    plane.frame.forEach((row, r) => row.forEach((value, c) => assert.ok(Math.abs(value - reference.plane.frame[r][c]) < 1e-4, `frame ${r},${c}: ${value} vs ${reference.plane.frame[r][c]}`)));
    let difference = 0;
    for (let i = 0; i < image.length; i++) difference = Math.max(difference, Math.abs(image[i] - reference.image[i]));
    assert.ok(difference < 1e-2, `largest pixel difference ${difference}`);
  }
});

test('an unknown spatial unit, a 2-D image and NaN voxels are refused', () => {
  assert.throws(() => mriVolume(written(5, 1), 'odd.nii'), /odd.nii gives its spatial unit as code 5/);
  const flat = parseNiftiVolume(scalarNifti(new Float32Array(12), [4, 3, 1], [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]).buffer);
  assert.throws(() => mriVolume(flat, 'flat.nii'), /not a 3D volume/);
  const nan = written(2, 1);
  nan.imageData[7] = NaN;
  assert.throws(() => mriVolume(nan), /NaN or infinite/);
});
