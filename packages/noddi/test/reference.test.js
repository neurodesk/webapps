import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createNiftiFromData } from '@neurodesk/webapp-components/file-io/nifti';
import { multiShellPhantom } from '../src/phantom.js';
import { CASES, compareInputChecksums, compareOutputs, phantomFiles, readReference, summarize } from '../validation/reference.mjs';

const template = multiShellPhantom({ size: 4 }).nifti.buffer;
const map = (values) => gzipSync(new Uint8Array(createNiftiFromData(Float32Array.from(values), template, { dims: [4, 4, 4] })));
const ramp = Array.from({ length: 64 }, (_, i) => i / 64);
const failed = (actual, expected) => compareOutputs('command line', actual, expected).filter(([passed]) => !passed).map(([, line]) => line);

test('input hashes compare by exact filename and bytes, regardless of key order', () => {
  const expected = { example: { 'image.nii': '123', 'image.bvec': '456' }, phantom: { 'phantom.nii': '789' } };
  const reordered = { phantom: { 'phantom.nii': '789' }, example: { 'image.bvec': '456', 'image.nii': '123' } };
  assert.equal(compareInputChecksums(reordered, expected).length, 3);
  assert.ok(compareInputChecksums(reordered, expected).every(([passed]) => passed));
  const changed = { ...expected, phantom: { 'phantom.nii': 'abc' } };
  assert.deepEqual(compareInputChecksums(changed, expected).filter(([passed]) => !passed), [
    [false, 'input phantom/phantom.nii: expected 789, actual abc'],
  ]);
});

test('missing and renamed inputs fail with their exact names and expected hashes', () => {
  assert.deepEqual(compareInputChecksums({ phantom: { 'renamed.nii': '123' } }, { example: { 'image.nii': '456' } }), [
    [false, 'example: input group is missing'],
    [false, 'input example/image.nii: expected 456, actual <missing>'],
    [false, 'phantom: input group is not in the reference'],
    [false, 'input phantom/renamed.nii: expected <missing>, actual 123'],
  ]);
});

test('the reference phantom uses pinned gradient bytes despite platform math rounding', async () => {
  const sin = Math.sin;
  let input;
  try {
    Math.sin = (angle) => sin(angle) * (1 + Number.EPSILON);
    input = await phantomFiles();
  } finally {
    Math.sin = sin;
  }
  const reference = await readReference();
  assert.equal(input.files.bvec.sha256, reference.inputs.phantom['sub-phantom_dwi.bvec']);
  assert.equal(await readFile(input.files.bvec.path, 'utf8'), await readFile(new URL('../validation/phantom.bvec', import.meta.url), 'utf8'));
});

test('identical decompressed files pass, whatever their compression', () => {
  const expected = { 'tensor-fa': summarize('a_fa.nii.gz', map(ramp)) };
  const level1 = gzipSync(gunzipSync(map(ramp)), { level: 1 });
  assert.deepEqual(failed({ 'tensor-fa': summarize('a_fa.nii.gz', level1) }, expected), []);
});

test('a changed voxel, a renamed file and a missing or extra role each fail', () => {
  const expected = { 'tensor-fa': summarize('a_fa.nii.gz', map(ramp)), mask: summarize('a_mask.nii.gz', map(ramp)) };
  const changed = [...ramp];
  changed[10] += 1e-6;
  assert.match(failed({ ...expected, 'tensor-fa': summarize('a_fa.nii.gz', map(changed)) }, expected)[0], /tensor-fa/);
  assert.match(failed({ ...expected, 'tensor-fa': summarize('b_fa.nii.gz', map(ramp)) }, expected)[0], /b_fa/);
  assert.deepEqual(failed({ mask: expected.mask }, expected), ['command line tensor-fa was not written']);
  assert.deepEqual(failed({ ...expected, extra: expected.mask }, expected), ['command line extra is not in the reference']);
});

test('the recorded reference covers every case, NODDI included', async () => {
  const reference = await readReference();
  assert.deepEqual(Object.keys(reference.browser.cases), CASES.map((testCase) => testCase.id));
  assert.equal(reference.browser.cases.phantom.provenance.method, 'dti+noddi-amico');
  assert.equal(Object.keys(reference.browser.cases.phantom.outputs).length, 11);
  // The example is the ds005134 multi-shell slab: NODDI runs on real data with the MindGrab mask.
  assert.equal(reference.browser.cases.example.provenance.method, 'dti+noddi-amico');
  assert.equal(Object.keys(reference.browser.cases.example.outputs).length, 11);
  assert.ok(Object.keys(reference.inputs.example).includes('sub-01_dir-AP_desc-slab_dwi.nii.gz'));
});


test('input checks reject missing or additional empty groups', () => {
  assert.equal(compareInputChecksums({ unexpected: {} }, {})[0][0], false);
  assert.equal(compareInputChecksums({}, { phantom: {} })[0][0], false);
});
