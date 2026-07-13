#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import {
  buildResultVolumeStack,
  chooseResultBaseStage,
  defaultResultVisibility,
  isImageResultStage,
  isMaskResultStage,
  isResultStageVisible
} from '../web/js/modules/ui/result-display.js';

function result(stage) {
  return { file: { name: `${stage}.nii` } };
}

const stages = ['downsample', 'n4', 'nlm', 'segmentation', 'bet', 'brainmask'];
const results = Object.fromEntries(stages.map(stage => [stage, result(stage)]));

assert.equal(isImageResultStage('n4'), true);
assert.equal(isMaskResultStage('brainmask'), true);
assert.equal(defaultResultVisibility('segmentation'), true);
assert.equal(defaultResultVisibility('brainmask'), false);
assert.equal(isResultStageVisible('brainmask', { brainmask: true }), true);

{
  const base = chooseResultBaseStage({
    stages,
    results,
    visibility: { downsample: true, n4: false, nlm: true },
    preferredBaseStage: 'downsample'
  });
  assert.deepEqual(base, { stage: 'downsample', visible: true });
}

{
  const stack = buildResultVolumeStack({
    stages,
    results,
    visibility: {
      downsample: false,
      n4: false,
      nlm: false,
      segmentation: false,
      bet: false,
      brainmask: true
    },
    preferredBaseStage: 'bet',
    segmentationOpacity: 0.6
  });
  assert.equal(stack.length, 2, 'brain mask should render over a hidden image anchor');
  assert.equal(stack[0].stage, 'bet');
  assert.equal(stack[0].visible, false);
  assert.equal(stack[1].stage, 'brainmask');
  assert.equal(stack[1].visible, true);
  assert.equal(stack[1].colormap, 'blue');
}

{
  const stack = buildResultVolumeStack({
    stages,
    results,
    visibility: {
      downsample: true,
      n4: true,
      nlm: false,
      segmentation: true,
      bet: false,
      brainmask: true
    },
    preferredBaseStage: 'n4',
    segmentationOpacity: 0.7
  });
  assert.deepEqual(
    stack.map(entry => [entry.stage, entry.scalar, entry.opacity, entry.colormap]),
    [
      ['n4', true, 1, 'gray'],
      ['downsample', true, 0.45, 'gray'],
      ['segmentation', false, 0.7, 'vesselboost'],
      ['brainmask', false, 0.35, 'blue']
    ],
    'segmentation masks must use the transparent vesselboost LUT'
  );
}

{
  const stack = buildResultVolumeStack({
    stages,
    results,
    visibility: Object.fromEntries(stages.map(stage => [stage, false]))
  });
  assert.deepEqual(stack, [], 'all hidden stages should produce an empty viewer stack');
}

console.log('result-display OK: independent image/mask visibility planning.');
