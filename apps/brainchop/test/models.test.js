import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findModel, labelColormap, labelNamesMap, MODELS, stemFor, TISSUE_STAGES } from '../src/models.js';

test('four v4.0 segmentation and tissue-fraction models are configured without skull stripping', () => {
  assert.deepEqual(MODELS.map(model => model.id), ['mindmap', 'mindmap-fast', 'mindsnap', 'tissue-fractions']);
  assert.ok(MODELS.every(model => model.coreModel !== 'mindgrab'));
  assert.equal(findModel('mindsnap')?.classes, 104);
  assert.equal(findModel('unknown'), null);
});

test('every label model exposes a built-in colormap and label names from @brainchop/core', () => {
  for (const model of MODELS.filter(entry => entry.kind === 'labels')) {
    const lut = labelColormap(model.id);
    assert.ok(lut, model.id);
    assert.equal(lut.labels.length, model.classes);
    assert.equal(lut.A[0], 0);
    assert.equal(lut.A[1], 255);
    assert.equal(Object.keys(labelNamesMap(model.id)).length, model.classes);
  }
  assert.equal(labelColormap('tissue-fractions'), null);
  assert.equal(TISSUE_STAGES.length, 4);
});

test('stemFor strips .nii and .nii.gz suffixes', () => {
  assert.equal(stemFor('sub-01_T1w.nii.gz'), 'sub-01_T1w');
  assert.equal(stemFor('brain.nii'), 'brain');
});
