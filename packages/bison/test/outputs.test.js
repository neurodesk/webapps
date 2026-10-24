import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createFloat32Nifti, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { outputFiles, outputNames } from '../src/outputs.js';

function t1Header() {
  const header = new ArrayBuffer(352);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  view.setInt16(42, 4, true);
  view.setInt16(44, 3, true);
  view.setInt16(46, 2, true);
  view.setFloat32(80, 1, true);
  view.setFloat32(84, 1, true);
  view.setFloat32(88, 1, true);
  view.setFloat32(108, 352, true);
  view.setInt16(254, 1, true);
  view.setFloat32(280, -1, true);
  view.setFloat32(292, 90, true);
  view.setFloat32(300, 1, true);
  view.setFloat32(316, 1, true);
  new Uint8Array(header, 148, 7).set(new TextEncoder().encode('patient'));
  new Uint8Array(header, 344, 4).set([110, 43, 49, 0]);
  const image = createFloat32Nifti(new Float32Array(24).fill(1000), header);
  return new Uint8Array(image, 0, 352);
}

const run = {
  t1Name: 'sub-01_T1w.nii.gz',
  mode: 't1',
  voxels: Uint32Array.from([1, 5, 23]),
  labels: Uint8Array.from([7, 0, 8]),
  probabilities: Float32Array.from([
    0, 0, 0, 0, 0, 0, 0.1, 0.8, 0.1,
    0.6, 0.4, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0.25, 0.75,
  ]),
};

test('output names follow the T1 stem and the class slugs', () => {
  const names = outputNames('/data/sub-01_T1w.nii', 't1-flair');
  assert.equal(names.labels, 'sub-01_T1w_bison-labels.nii.gz');
  assert.equal(names.mask, 'sub-01_T1w_bison-mask.nii.gz');
  assert.deepEqual(names.probabilities.map((p) => p.slug).slice(-2), ['wm', 'wmh']);
  assert.equal(outputNames('a.nii.gz', 't1').probabilities.length, 8);
});

test('writes gzipped labels, probabilities and mask on the T1 grid', async () => {
  const files = [...outputFiles({ ...run, t1Header: t1Header() })];
  assert.equal(files.length, 10);
  const byName = Object.fromEntries(files.map((f) => [f.name, f.bytes]));
  const labels = await readNifti(byName['sub-01_T1w_bison-labels.nii.gz'], Uint8Array);
  assert.deepEqual(labels.dims, [4, 3, 2]);
  assert.equal(labels.header.datatype, 2);
  assert.equal(labels.header.sformCode, 1);
  assert.equal(labels.header.affine[0][0], -1);
  assert.equal(labels.header.affine[0][3], 90);
  assert.equal(labels.data[1], 7);
  assert.equal(labels.data[23], 8);
  assert.equal(labels.data.reduce((a, b) => a + b, 0), 15);
  const wm = await readNifti(byName['sub-01_T1w_bison-prob-wm.nii.gz']);
  assert.equal(wm.header.datatype, 16);
  assert.equal(wm.data[23], 0.75);
  assert.equal(wm.data[1], Math.fround(0.1));
  assert.equal(wm.data[0], 0);
  const ventricles = await readNifti(byName['sub-01_T1w_bison-prob-ventricles.nii.gz']);
  assert.equal(ventricles.data[5], Math.fround(0.4));
  const mask = await readNifti(byName['sub-01_T1w_bison-mask.nii.gz'], Uint8Array);
  assert.deepEqual([...mask.data].flatMap((v, i) => (v ? [i] : [])), [1, 5, 23]);
});

test('output bytes are deterministic and drop header text', () => {
  const first = [...outputFiles({ ...run, t1Header: t1Header() })];
  const second = [...outputFiles({ ...run, t1Header: t1Header() })];
  for (let i = 0; i < first.length; i++) assert.deepEqual(first[i].bytes, second[i].bytes);
  assert.equal(first[0].bytes[0], 0x1f);
  assert.deepEqual([...first[0].bytes.subarray(4, 8)], [0, 0, 0, 0]);
  const nifti = gunzipSync(first[0].bytes);
  assert.equal(nifti.length, 352 + 24);
  assert.ok(nifti.subarray(148, 252).every((b) => b === 0));
});

test('refuses results that do not match the mask', () => {
  assert.throws(() => [...outputFiles({ ...run, labels: new Uint8Array(2), t1Header: t1Header() })], /do not match/);
});
