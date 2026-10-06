import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editedResult, extractionOutputs } from '../src/outputs.js';

const file = name => new File([name], name);

test('only the brain mask is editable', () => {
  const outputs = extractionOutputs(file('brain.nii'), file('mask.nii'));
  assert.equal(outputs.mask.editable, true);
  assert.equal(outputs.brain.editable, undefined);
});

test('an applied edit replaces the file and keeps the pipeline result', () => {
  const pipeline = file('mask.nii');
  const first = file('mask.nii');
  const second = file('mask.nii');
  const { mask } = extractionOutputs(file('brain.nii'), pipeline);
  const once = editedResult(mask, first, pipeline);
  assert.deepEqual(once, { description: 'Brain mask', file: first, editable: true, edited: true, original: pipeline });
  const twice = editedResult(once, second, first);
  assert.equal(twice.file, second);
  assert.equal(twice.original, pipeline);
  assert.equal(mask.file, pipeline);
});
