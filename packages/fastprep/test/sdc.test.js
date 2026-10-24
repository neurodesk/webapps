import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { loadSdc } from '@neurodesk/sdc';
import { createNiftiFromVolume, decodeNiftiBuffer, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { sdcDriver } from '../src/drivers.js';
import { Files } from '../src/files.js';

const runtime = await loadSdc(await readFile(new URL('../../sdc/src/sdc.wasm', import.meta.url)));
const dims = [8, 40, 4];
const affine = [[2, 0, 0, -8], [0, 2, 0, -40], [0, 0, 2, -4], [0, 0, 0, 1]];

// The existing sdc package's independently tested constant-shift case: 3 mm / 2 mm / 0.05 s = 30 Hz.
function image(shift, matrix = affine) {
  const img = new Float32Array(dims.reduce((a, b) => a * b));
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        const centre = dims[1] + 2 * Math.sin(x - 4) + z;
        const position = (y + 0.5) * 2 - shift;
        img[x + dims[0] * (y + dims[1] * z)] = 100 * Math.exp(-(((position - centre) / 6) ** 2)) + 5;
      }
    }
  }
  return new Uint8Array(createNiftiFromVolume({ dims, pixDims: [2, 2, 2], img, hdr: { affine: matrix } }));
}

function setup() {
  const files = new Files();
  files.put('/first.nii', image(3));
  files.put('/second.nii', image(-3));
  return files;
}
const command = (pe1 = 'j', pe2 = 'j-', trt = '0.05') => ['sdc', 'pyhysco', '/first.nii', '/second.nii', '/work/pair', '--pe1', pe1, '--pe2', pe2, '--trt', trt];

test('PEPOLAR driver runs the real solver, preserves geometry and records signed Hz acquisition', async () => {
  const files = setup();
  let loads = 0;
  const driver = sdcDriver(() => { loads++; return runtime; });
  assert.equal(loads, 0);
  assert.equal((await driver(command(), { files })).code, 0);
  const output = await decodeNiftiBuffer(await files.bytes('/work/pair_fieldmap.nii.gz'));
  assert.ok(sameNiftiGrid(output, await files.bytes('/first.nii')));
  const { data } = readNiftiFrames(output);
  const middle = [];
  for (let z = 0; z < dims[2]; z++) {
    for (let x = 0; x < dims[0]; x++) middle.push(data[x + dims[0] * (20 + dims[1] * z)]);
  }
  middle.sort((a, b) => a - b);
  assert.ok(Math.abs(middle[middle.length >> 1] - 30) < 3);
  const sidecar = JSON.parse(await files.text('/work/pair_fieldmap.json'));
  assert.equal(sidecar.Units, 'Hz');
  assert.equal(sidecar.TotalReadoutTime, 0.05);
  assert.equal(sidecar.PhaseEncodingDirection, 'j');
  for (const suffix of ['corrected1', 'corrected2']) {
    const corrected = readNiftiFrames(await decodeNiftiBuffer(await files.bytes(`/work/pair_${suffix}.nii.gz`)));
    assert.ok(corrected.data.every(Number.isFinite));
    assert.ok(corrected.data.some((value) => value > 0));
  }
  await driver(command('j-', 'j', '0.1'), { files });
  const reversed = readNiftiFrames(await decodeNiftiBuffer(await files.bytes('/work/pair_fieldmap.nii.gz'))).data;
  for (let i = 0; i < data.length; i++) assert.ok(Math.abs(reversed[i] + data[i] / 2) < 1e-5);
  assert.equal(loads, 1);
});

test('unsupported acquisition and grids refuse before loading or publishing correction', async () => {
  let loads = 0;
  const driver = sdcDriver(() => { loads++; return runtime; });
  for (const [argv, pattern] of [
    [command('k', 'k-'), /must be i/],
    [command('j', 'j'), /opposite/],
    [command('j', 'j-', 'NaN'), /finite and positive/],
    [command('j', 'j-', '0'), /finite and positive/],
    [command().slice(0, -2), /finite and positive/],
    [[...command(), '--invented'], /not supported/],
  ]) {
    const files = setup();
    await assert.rejects(driver(argv, { files }), pattern);
    assert.equal(files.has('/work/pair_fieldmap.nii.gz'), false);
  }
  const files = setup();
  const moved = affine.map((row) => [...row]);
  moved[0][3] += 1;
  files.put('/second.nii', image(-3, moved));
  await assert.rejects(driver(command(), { files }), /spatial grid/);
  const shear = affine.map((row) => [...row]);
  shear[0][1] = 0.1;
  files.put('/first.nii', image(3, shear));
  files.put('/second.nii', image(-3, shear));
  await assert.rejects(driver(command(), { files }), /sheared/);
  assert.equal(loads, 0);
});
