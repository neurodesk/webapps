import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hemisphereOf, resolveHemisphere } from '../src/inputs.js';

test('hemisphere inference agrees across FreeSurfer, BIDS and template names', () => {
  for (const name of ['rh_bars.gii', 'sub-01_hemi-R_bold.func.gii', '/data/rh_benson.gii']) {
    assert.equal(hemisphereOf(name), 'rh');
    assert.equal(resolveHemisphere(['functional.gii', name], { required: true }), 'rh');
  }
  assert.equal(hemisphereOf('lh.white'), 'lh');
  assert.equal(hemisphereOf('sub-01_lh.gii'), 'lh');
  assert.equal(hemisphereOf('lhrun.gii'), 'srf');
  assert.throws(() => resolveHemisphere(['functional.gii'], { required: true }), /known hemisphere/);
  assert.equal(resolveHemisphere(['functional.gii'], { hemisphere: 'rh', required: true }), 'rh');
  assert.equal(resolveHemisphere(['lh_run.gii'], { hemisphere: 'srf' }), 'srf');
  assert.throws(() => resolveHemisphere(['rh_run.gii'], { hemisphere: 'srf', required: true }), /known hemisphere/);
});

test('mixed hemispheres cannot be averaged or paired with the wrong template', () => {
  for (const names of [['lh_run.gii', 'rh_run.gii'], ['sub-01_hemi-R_bold.func.gii', 'lh_benson.gii'], ['lh_run.gii', 'rh.area']]) {
    assert.throws(() => resolveHemisphere(names), /different hemispheres/);
  }
  assert.throws(() => resolveHemisphere(['rh_run.gii'], { hemisphere: 'lh' }), /different hemispheres/);
  assert.throws(() => resolveHemisphere(['lh_run.gii', 'rh_run.gii'], { hemisphere: 'srf' }), /different hemispheres/);
});
