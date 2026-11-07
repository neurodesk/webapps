import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { mriViewerFile, mriVolume, scalarNifti } from '../src/core/nifti.js';
import { apply, invert } from '../src/core/matrix.js';
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

// NiiVue's own reader, which ignores xyzt_units, on the file the page shows.
async function viewerVolume(file) {
  const [{ nii2volume }, fs, path, { pathToFileURL, fileURLToPath }] = await Promise.all([import('@niivue/niivue'), import('node:fs'), import('node:path'), import('node:url')]);
  const niivue = path.dirname(fs.realpathSync(fileURLToPath(import.meta.resolve('@niivue/niivue'))));
  let dir = niivue;
  while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== '@niivue/niivue') dir = path.dirname(dir);
  const reader = fs.realpathSync(path.resolve(dir, '../../nifti-reader-js'));
  const nifti = await import(pathToFileURL(path.join(reader, JSON.parse(fs.readFileSync(path.join(reader, 'package.json'), 'utf8')).main)));
  const buffer = await file.arrayBuffer();
  const header = nifti.readHeader(buffer);
  return nii2volume(header, nifti.readImage(header, buffer));
}

test('the viewer shows a metre or micrometre MRI in millimetres, so the slice centre is its centre', async () => {
  for (const [code, scale] of [[2, 1], [1, 0.001], [3, 1000]]) {
    const parsed = written(code, scale);
    const volume = mriVolume(parsed);
    const original = new File([parsed.headerBytes, new Uint8Array(parsed.imageData.buffer)], 'mri.nii');
    const shown = mriViewerFile(original, volume);
    if (code === 2) assert.equal(shown, original);
    else assert.match(shown.name, /^mri_mm\.nii$/);
    const { frac2mm } = await viewerVolume(shown);
    const rows = [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((c) => frac2mm[c * 4 + r]));
    const fraction = apply(invert(rows), apply(volume.affine, [19.5, 17.5, 2]));
    fraction.forEach((value) => assert.ok(Math.abs(value - 0.5) < 1e-5, `unit ${code}: centre at fraction ${fraction}`));
  }
});
