// Reader parity: NIfTI, MGZ, and RGB DICOM readers must reproduce the
// nibabel/pydicom arrays and affines (tools/golden/readers.json).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readNifti } from '../../web/js/readers/nifti.js';
import { readMgz } from '../../web/js/readers/mgz.js';
import { readDicomSeries } from '../../web/js/readers/dicom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PHANTOM = path.join(ROOT, 'tools', 'phantom_out');
const GOLDEN = path.join(ROOT, 'tools', 'golden');

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const TYPED = {
  uint8: Uint8Array, int8: Int8Array, uint16: Uint16Array, int16: Int16Array,
  int32: Int32Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array,
};

function loadGoldenArray(entry) {
  const Ctor = TYPED[entry.dtype];
  const ab = readAB(path.join(GOLDEN, `${entry.name}.bin`));
  return new Ctor(ab);
}

function assertArrayEqual(actual, golden, label, tol = 0) {
  assert.equal(actual.length, golden.length, `${label}: length mismatch`);
  let maxDiff = 0, at = -1;
  for (let i = 0; i < golden.length; i++) {
    const d = Math.abs(actual[i] - golden[i]);
    if (d > maxDiff) { maxDiff = d; at = i; }
  }
  assert.ok(maxDiff <= tol, `${label}: max|diff| = ${maxDiff} at ${at} (got ${actual[at]}, want ${golden[at]})`);
}

function assertAffine(actual, golden, label, tol = 1e-4) {
  const flat = golden.flat();
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(actual[i] - flat[i]) <= tol,
      `${label}: affine[${i}] ${actual[i]} vs ${flat[i]}`);
  }
}

const readersPath = path.join(GOLDEN, 'readers.json');
const haveGolden = fs.existsSync(readersPath);

test('reader goldens present', () => {
  assert.ok(haveGolden, 'Run tools/gen_phantom.py first');
});

if (haveGolden) {
  const golden = JSON.parse(fs.readFileSync(readersPath, 'utf8'));

  test('nifti grayscale (.nii)', async () => {
    const vol = await readNifti(readAB(path.join(PHANTOM, 'nifti_gray.nii')), 'nifti_gray.nii');
    assertArrayEqual(vol.data, loadGoldenArray(golden.nifti_gray.array), 'nifti_gray');
    assertAffine(vol.affine, golden.nifti_gray.affine, 'nifti_gray');
  });

  test('nifti grayscale (.nii.gz)', async () => {
    const vol = await readNifti(readAB(path.join(PHANTOM, 'nifti_gray.nii.gz')), 'nifti_gray.nii.gz');
    assertArrayEqual(vol.data, loadGoldenArray(golden.nifti_gray.array), 'nifti_gray_gz');
  });

  test('nifti RGB (.nii)', async () => {
    const vol = await readNifti(readAB(path.join(PHANTOM, 'nifti_rgb.nii')), 'nifti_rgb.nii');
    assert.equal(vol.channels, 3);
    assertArrayEqual(vol.data, loadGoldenArray(golden.nifti_rgb.array), 'nifti_rgb');
    assertAffine(vol.affine, golden.nifti_rgb.affine, 'nifti_rgb');
  });

  test('mgz grayscale', async () => {
    const vol = await readMgz(readAB(path.join(PHANTOM, 'vol.mgz')), 'vol.mgz');
    assertArrayEqual(vol.data, loadGoldenArray(golden.mgz.array), 'mgz', 1e-4);
    assertAffine(vol.affine, golden.mgz.affine, 'mgz', 1e-3);
  });

  test('dicom RGB series', () => {
    const files = fs.readdirSync(path.join(PHANTOM, 'dicom_rgb'))
      .filter((n) => n.toLowerCase().endsWith('.dcm'))
      .map((n) => ({ name: n, buffer: readAB(path.join(PHANTOM, 'dicom_rgb', n)) }));
    const vol = readDicomSeries(files);
    assert.equal(vol.channels, 3);
    assertArrayEqual(vol.data, loadGoldenArray(golden.dicom_rgb.array), 'dicom_rgb');
  });
}
