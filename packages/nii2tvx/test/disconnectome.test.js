import assert from 'node:assert/strict';
import test from 'node:test';
import { gridAdvice, isGridMismatch, lesionId, tableName } from '../src/disconnectome.js';

test('lesion ids remove only the final NIfTI extension, independent of case', () => {
  for (const name of ['sub-01.nii', 'sub-01.nii.gz', 'sub-01.NII', 'sub-01.NII.GZ']) {
    assert.equal(lesionId(name), 'sub-01', name);
  }
  for (const name of ['sub-01', 'sub-01.nii.backup', 'sub-01.nii.gz.backup', 'sub-01Xnii', 'sub-01.niiXgz']) {
    assert.equal(lesionId(name), name);
  }
  assert.equal(lesionId('first.nii.second.nii.gz'), 'first.nii.second');
});

test('table filenames preserve the lesion id and distinguish atlas results', () => {
  assert.equal(tableName('sub-01_lesion', 'enigma'), 'sub-01_lesion_enigma_disconnectome.tsv');
  assert.equal(tableName('sub-01_lesion', 'hcp1065'), 'sub-01_lesion_hcp1065_disconnectome.tsv');
});

test('grid mismatch detection recognizes each native reason without reclassifying other failures', () => {
  for (const message of ['grid mismatch', 'DIM mismatch', 'sto_xyz mismatch']) {
    assert.equal(isGridMismatch(new Error(message)), true, message);
  }
  for (const message of ['', 'invalid NIfTI header', 'atlas checksum failed', 'allocation failed']) {
    assert.equal(isGridMismatch(new Error(message)), false, message);
  }
});

test('grid refusal names the target dimensions and normalization app', () => {
  assert.equal(gridAdvice({ dim: [182, 218, 182] }), 'Not on the 182 × 218 × 182 MNI152 grid; normalize it with SYNcro first.');
  assert.equal(gridAdvice({ dim: [91, 109, 91] }), 'Not on the 91 × 109 × 91 MNI152 grid; normalize it with SYNcro first.');
});
