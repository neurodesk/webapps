import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { editedResult, labelNames, labelsResult, looksLikeCt, outputStem, sameGrid } from '../src/logic.js';
const freesurferLut = createRequire(import.meta.url)('@neurodesk/webapp-components/automation/freesurfer-lut');

test('output stem drops the NIfTI extension only', () => {
  assert.equal(outputStem('T1_head.nii.gz'), 'T1_head');
  assert.equal(outputStem('T1.NII'), 'T1');
  assert.equal(outputStem('scan.nii.gz.nii'), 'scan.nii.gz');
  assert.equal(outputStem('series_01'), 'series_01');
});

test('CT auto-detection keys on negative intensities', () => {
  assert.equal(looksLikeCt(new Float32Array([0, 12, 900])), false);
  assert.equal(looksLikeCt(new Float32Array([-1024, 0, 40])), true);
  assert.equal(looksLikeCt(new Float32Array(0)), false);
});

const grid = (dims, shift = 0) => ({
  dims,
  affine: [[1, 0, 0, shift], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]].map(row => Float64Array.from(row)),
});

test('the input is the edit base only when it shares the labels grid', () => {
  assert.equal(sameGrid(grid([4, 5, 6]), grid([4, 5, 6])), true);
  assert.equal(sameGrid(grid([4, 5, 6]), grid([4, 5, 7])), false);
  assert.equal(sameGrid(grid([4, 5, 6]), grid([4, 5, 6], 1)), false);
  assert.equal(sameGrid(grid([4, 5, 6]), grid([4, 5, 6], 1e-6)), true);
});

test('label names come from the shipped FreeSurfer LUT, without background', () => {
  const names = labelNames(freesurferLut);
  assert.equal(names[17], 'Left-Hippocampus');
  assert.equal(names[53], 'Right-Hippocampus');
  assert.equal(names[0], undefined);
  assert.equal(Object.keys(names).length, freesurferLut.I.length - 1);
});

test('labels are editable; applying an edit replaces the file and keeps the pipeline output', () => {
  const pipeline = new File(['a'], 'T1_synthseg.nii.gz');
  const first = new File(['b'], 'T1_synthseg.nii.gz');
  const second = new File(['c'], 'T1_synthseg.nii.gz');
  const result = labelsResult(pipeline, grid([4, 5, 6]));
  assert.equal(result.editable, true);
  assert.equal(result.edited, undefined);
  const edited = editedResult(result, first);
  assert.equal(edited.file, first);
  assert.equal(edited.original, pipeline);
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.grid, result.grid);
  assert.equal(editedResult(edited, second).original, pipeline);
  assert.equal(result.file, pipeline);
});
