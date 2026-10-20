import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createNiftiFromData } from '@neurodesk/webapp-components/file-io/nifti';
import { multiShellPhantom } from '../src/phantom.js';
import { CASES, compareOutputs, readReference, summarize } from '../validation/reference.mjs';

const template = multiShellPhantom({ size: 4 }).nifti.buffer;
const map = (values) => gzipSync(new Uint8Array(createNiftiFromData(Float32Array.from(values), template, { dims: [4, 4, 4] })));
const ramp = Array.from({ length: 64 }, (_, i) => i / 64);
const failed = (actual, expected) => compareOutputs('command line', actual, expected).filter(([passed]) => !passed).map(([, line]) => line);

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
  assert.equal(reference.browser.cases.example.provenance.method, 'dti');
});
