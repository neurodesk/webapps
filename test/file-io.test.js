import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FileIOController,
  categorizeNeuroFile,
  createFloat64Nifti,
  createNiftiHeaderFromVolume,
  isNiftiFile,
  parseNiftiHeader,
  readNiftiImageData
} from '../src/file-io/index.js';

function fakeFile(name) {
  return { name };
}

test('detects NIfTI files', () => {
  assert.equal(isNiftiFile('image.nii'), true);
  assert.equal(isNiftiFile('image.nii.gz'), true);
  assert.equal(isNiftiFile('image.json'), false);
});

test('categorizes QSM bucket files', () => {
  assert.equal(categorizeNeuroFile(fakeFile('sub_mag_e1.nii.gz')), 'magnitude');
  assert.equal(categorizeNeuroFile(fakeFile('sub_phase_e1.nii.gz')), 'phase');
  assert.equal(categorizeNeuroFile(fakeFile('sub_total_fieldmap.nii.gz')), 'totalField');
  assert.equal(categorizeNeuroFile(fakeFile('sub_local_chi.nii.gz')), 'localField');
  assert.equal(categorizeNeuroFile(fakeFile('sub.json')), 'json');
});

test('bucketed FileIOController enforces exclusive field inputs', () => {
  const io = new FileIOController({ mode: 'bucketed' });
  io.addFiles([fakeFile('a_phase.nii.gz'), fakeFile('b_phase.nii.gz')]);
  assert.equal(io.getBucket('phase').length, 2);
  io.addFiles([fakeFile('fieldmap_total.nii.gz')]);
  assert.equal(io.getBucket('phase').length, 0);
  assert.equal(io.getBucket('totalField').length, 1);
  assert.equal(io.getBucket('extra').length, 2);
  assert.equal(io.getInputMode(), 'totalField');
});

test('creates NIfTI output from NiiVue-style volume metadata', () => {
  const header = createNiftiHeaderFromVolume({
    dims: [2, 2, 1],
    pixDims: [0.7, 0.8, 1.5],
    img: new Float32Array([1, 2, 3, 4])
  });
  const output = createFloat64Nifti(new Float64Array([1.25, 2.5, 3.75, 5]), header);
  const parsed = parseNiftiHeader(output);
  assert.deepEqual([parsed.nx, parsed.ny, parsed.nz], [2, 2, 1]);
  assert.deepEqual(parsed.voxelSize.map(value => Number(value.toFixed(2))), [0.7, 0.8, 1.5]);
  const { data } = readNiftiImageData(output, Float64Array);
  assert.deepEqual(Array.from(data), [1.25, 2.5, 3.75, 5]);
});
