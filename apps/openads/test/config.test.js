import assert from 'node:assert/strict';
import test from 'node:test';
import { APP, classifyFileName, assignRoles, detectMode, inferSubjectId } from '../src/config.js';

test('APP metadata and filename role classification cover DWI, ADC, b0, PWI, JSON and MNI masks', () => {
  assert.equal(APP.id, 'openads');
  assert.equal(classifyFileName('02e8eb42_DWI.nii.gz'), 'dwi');
  assert.equal(classifyFileName('02e8eb42_ADC.nii.gz'), 'adc');
  assert.equal(classifyFileName('02e8eb42_b0.nii.gz'), 'b0');
  assert.equal(classifyFileName('02e8eb42_PWI.nii.gz'), 'pwi');
  assert.equal(classifyFileName('02e8eb42_PWI.json'), 'pwi-json');
  assert.equal(classifyFileName('02e8eb42_DWI.json'), null);
  assert.equal(classifyFileName('sub-02e8eb42_stroke_space-MNI152.nii.gz'), 'mask');
  assert.equal(classifyFileName('sub-02e8eb42_brain-mask_space-MNI152.nii.gz'), 'brainmask');
});

test('assignRoles matches PWI JSON sidecar to the selected PWI scan and skips unrelated or ambiguous JSONs', () => {
  const mkFiles = (names) => names.map((name) => ({ name }));

  const paired = assignRoles(mkFiles(['case_dwi.json', 'case_pwi.nii.gz', 'case_pwi.json']));
  assert.equal(paired['pwi-json'], 2);

  const unrelatedOnly = assignRoles(mkFiles(['case_dwi.json', 'case_pwi.nii.gz']));
  assert.equal(unrelatedOnly['pwi-json'], null);

  const ambiguous = assignRoles(mkFiles(['case_dsc_run-1.json', 'case_dsc_run-2.json', 'case_perfusion.nii.gz']));
  assert.equal(ambiguous['pwi-json'], null);

  const stemWins = assignRoles(mkFiles(['case_dsc_run-1.json', 'case_dsc_run-2.json', 'case_dsc_run-2.nii.gz']));
  assert.equal(stemWins['pwi-json'], 1);

  const duplicateStem = assignRoles(mkFiles(['case_pwi.json', 'case_pwi.json', 'case_pwi.nii.gz']));
  assert.equal(duplicateStem['pwi-json'], null);
});

test('detectMode chooses dwi-pwi, dwi, or mni-report accurately', () => {
  const mkFiles = (names) => names.map((name) => ({ name }));
  const mni = assignRoles(mkFiles(['sub-02e8eb42_stroke_space-MNI152.nii.gz', 'sub-02e8eb42_ADC_space-MNI152.nii.gz']));
  assert.equal(detectMode(mni).mode, 'mni-report');

  const dwi = assignRoles(mkFiles(['02e8eb42_DWI.nii.gz', '02e8eb42_b0.nii.gz']));
  assert.equal(detectMode(dwi).mode, 'dwi');

  const pwi = assignRoles(mkFiles(['02e8eb42_DWI.nii.gz', '02e8eb42_ADC.nii.gz', '02e8eb42_PWI.nii.gz', '02e8eb42_PWI.json']));
  assert.equal(detectMode(pwi).mode, 'dwi-pwi');

  const stackedPwi = assignRoles(mkFiles(['02e8eb42_DWI.nii.gz', '02e8eb42_PWI.nii.gz']));
  assert.equal(detectMode(stackedPwi).mode, 'dwi-pwi');

  assert.equal(inferSubjectId(mkFiles(['sub-02e8eb42_DWI.nii.gz'])), 'sub-02e8eb42');
  assert.equal(inferSubjectId(mkFiles(['02e8eb42_DWI.nii.gz'])), 'sub-02e8eb42');
});
