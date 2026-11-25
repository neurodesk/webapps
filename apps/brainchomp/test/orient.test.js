import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorldRemap,
  availableDirections,
  buildReorientMatrix,
  INPUT_WORLD_REMAP,
  outputNames,
} from '../src/orient.js';

test('buildReorientMatrix treats A, S, L (or ?) as identity', () => {
  assert.equal(buildReorientMatrix(['A', 'S', 'L']), null);
  assert.equal(buildReorientMatrix(['A', 'S', '?']), null);
});

test('buildReorientMatrix computes proper rotation when L is unknown', () => {
  // Swapping S -> I (prone/supine) with A unchanged flips R -> L (det = +1).
  const remap = buildReorientMatrix(['A', 'I', '?']);
  assert.deepEqual(remap, [
    [-1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
  ]);
});

test('availableDirections excludes already selected axes', () => {
  assert.equal(availableDirections([]).length, 6);
  assert.deepEqual(availableDirections(['A']), ['R', 'L', 'S', 'I']);
  assert.deepEqual(availableDirections(['A', 'I']), ['R', 'L']);
});

test('applyWorldRemap transforms upper 3x4 rows and preserves homogeneous row', () => {
  const affine = [
    [0.1, 0, 0, -12.8],
    [0, 0, 0.1, -12.8],
    [0, 0.1, 0, -12.8],
    [0, 0, 0, 1],
  ];
  const remapped = applyWorldRemap(affine, INPUT_WORLD_REMAP);
  assert.deepEqual(remapped, [
    [-0.1, 0, 0, 12.8],
    [0, -0.1, 0, 12.8],
    [0, 0, 0.1, -12.8],
    [0, 0, 0, 1],
  ]);
});

test('outputNames produces brain, mask and reoriented NIfTI names', () => {
  assert.deepEqual(outputNames('mouse_t2w.nii.gz'), {
    brain: 'mouse_t2w_brainchomp_brain.nii',
    mask: 'mouse_t2w_brainchomp_mask.nii',
    reoriented: 'mouse_t2w_reoriented.nii',
  });
  assert.equal(outputNames('mouse_t2w_reoriented.nii').reoriented, 'mouse_t2w_reoriented.nii');
});
