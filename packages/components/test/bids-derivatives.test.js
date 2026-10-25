import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  derivativeSidecar,
  gzipFile,
  maskName,
  outputNames,
  sidecarText,
  sourceStem,
  splitName
} from '@neurodesk/webapp-components/file-io/bids-derivatives';

test('a name splits into its stem and suffix, for .nii and .nii.gz', () => {
  assert.deepEqual(splitName('sub-01_dir-AP_dwi.nii.gz'), ['sub-01_dir-AP', 'dwi']);
  assert.deepEqual(splitName('sub-01_dir-AP_dwi.nii'), ['sub-01_dir-AP', 'dwi']);
  assert.deepEqual(splitName('sub-01_T1w.NII.GZ'), ['sub-01', 'T1w']);
  assert.deepEqual(splitName('data.nii'), ['data', '']);
  assert.deepEqual(splitName('data.nii.gz'), ['data', '']);
});

test('the source stem drops every desc- entity', () => {
  assert.equal(sourceStem('sub-01_desc-preproc_dir-AP_dwi.nii.gz'), 'sub-01_dir-AP');
  assert.equal(sourceStem('sub-01_dir-AP_dwi.nii'), 'sub-01_dir-AP');
  assert.equal(sourceStem('data.nii.gz'), 'data');
});

test('derivative names with a suffix, with and without an earlier desc-', () => {
  const expected = {
    image: 'sub-01_dir-AP_desc-step_dwi.nii.gz',
    bval: 'sub-01_dir-AP_desc-step_dwi.bval',
    bvec: 'sub-01_dir-AP_desc-step_dwi.bvec',
    sidecar: 'sub-01_dir-AP_desc-step_dwi.json'
  };
  for (const name of ['sub-01_dir-AP_dwi.nii.gz', 'sub-01_dir-AP_dwi.nii', 'sub-01_desc-raw_dir-AP_dwi.nii.gz', 'sub-01_dir-AP_desc-step_dwi.nii']) {
    assert.deepEqual(outputNames(name, 'step'), expected, name);
  }
});

test('derivative names without a suffix, with and without an earlier desc-', () => {
  const expected = {
    image: 'data_desc-step.nii.gz',
    bval: 'data_desc-step.bval',
    bvec: 'data_desc-step.bvec',
    sidecar: 'data_desc-step.json'
  };
  assert.deepEqual(outputNames('data.nii', 'step'), expected);
  assert.deepEqual(outputNames('data.nii.gz', 'step'), expected);
  assert.deepEqual(outputNames('data_desc-raw.nii', 'step'), expected);
  assert.deepEqual(outputNames('data_desc-raw.nii.gz', 'step'), expected);
  // A name with no underscore has no suffix, even when it is dwi.
  assert.equal(outputNames('dwi.nii.gz', 'denoised').image, 'dwi_desc-denoised.nii.gz');
  assert.equal(outputNames('scan.nii.gz', 'hmc', { defaultSuffix: 'dwi' }).image, 'scan_desc-hmc_dwi.nii.gz');
  assert.equal(outputNames('sub-01_T1w.nii', 'hmc', { defaultSuffix: 'dwi' }).image, 'sub-01_desc-hmc_T1w.nii.gz');
});

test('the names of every DWI app stay as they were', () => {
  assert.equal(outputNames('sub-01_desc-denoise_dwi.nii.gz', 'degibbs').image, 'sub-01_desc-degibbs_dwi.nii.gz');
  assert.equal(outputNames('sub-01_desc-raw_dwi.nii.gz', 'denoised').image, 'sub-01_desc-denoised_dwi.nii.gz');
  assert.equal(outputNames('t1.nii', 'n4').image, 't1_desc-n4.nii.gz');
  assert.equal(maskName(sourceStem('sub-01_desc-denoise_dwi.nii.gz')), 'sub-01_desc-brain_mask.nii.gz');
});

test('the derivative sidecar keeps the input fields and their order, then Description', () => {
  const input = { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05 };
  const sidecar = derivativeSidecar(input, 'Step');
  assert.deepEqual(Object.keys(sidecar), ['PhaseEncodingDirection', 'TotalReadoutTime', 'Description']);
  assert.equal(sidecar.Description, 'Step');
  assert.deepEqual(input, { PhaseEncodingDirection: 'j-', TotalReadoutTime: 0.05 });
  assert.deepEqual(derivativeSidecar(null, 'Step'), { Description: 'Step' });
  assert.deepEqual(derivativeSidecar(undefined, 'Step'), { Description: 'Step' });
  assert.equal(sidecarText(sidecar), '{\n  "PhaseEncodingDirection": "j-",\n  "TotalReadoutTime": 0.05,\n  "Description": "Step"\n}\n');
});

test('outputNames and derivativeSidecar refuse a missing, empty or non-string label', () => {
  // The DWI apps export one-argument wrappers named outputNames and derivativeSidecar, so a swapped import drops the label.
  assert.throws(() => outputNames('sub-01_dwi.nii.gz'), TypeError);
  assert.throws(() => derivativeSidecar({ PhaseEncodingDirection: 'j-' }), TypeError);
  for (const label of [null, '', 5]) {
    assert.throws(() => outputNames('sub-01_dwi.nii.gz', label), TypeError, String(label));
    assert.throws(() => derivativeSidecar({ PhaseEncodingDirection: 'j-' }, label), TypeError, String(label));
  }
});

test('gzipFile writes a gzip File that inflates to the input bytes', async () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 7);
  const file = await gzipFile(bytes, 'x.nii.gz');
  assert.equal(file.name, 'x.nii.gz');
  assert.equal(file.type, 'application/gzip');
  assert.deepEqual(new Uint8Array(gunzipSync(Buffer.from(await file.arrayBuffer()))), bytes);
});

test('gzipFile stops on an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gzipFile(new Uint8Array(4), 'x.nii.gz', controller.signal), { name: 'AbortError' });
});
