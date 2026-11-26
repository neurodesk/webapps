#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import {
  buildResultVolumeStack,
  buildVesselCharterHandoffFile,
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

{
  assert.equal(buildVesselCharterHandoffFile(null), null);
  const rawBytes = new Uint8Array([1, 2, 3, 4]);
  const seg = new File([rawBytes], 'segmentation.nii', { type: 'application/octet-stream' });
  const named = buildVesselCharterHandoffFile(seg, { name: 'sub-01_tof.nii.gz' });
  assert.equal(named.name, 'sub-01_tof_vesselboost_segmentation.nii');
  assert.equal(named.type, 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await named.arrayBuffer()), rawBytes);

  const upper = buildVesselCharterHandoffFile(seg, { name: 'SUB-01_TOF.NII.GZ' });
  assert.equal(upper.name, 'SUB-01_TOF_vesselboost_segmentation.nii');

  const mgz = buildVesselCharterHandoffFile(seg, { name: 'brain.mgz' });
  assert.equal(mgz.name, 'brain_vesselboost_segmentation.nii');

  const noDuplicate = buildVesselCharterHandoffFile(seg, { name: 'sub-01_vesselboost_segmentation.nii' });
  assert.equal(noDuplicate.name, 'sub-01_vesselboost_segmentation.nii');

  const editedFlag = buildVesselCharterHandoffFile(seg, { name: 'sub-01_tof.nii.gz' }, { edited: true });
  assert.equal(editedFlag.name, 'sub-01_tof_vesselboost_segmentation_edited.nii');

  const editedFile = new File([rawBytes], 'segmentation_edited.nii', { type: 'application/octet-stream' });
  const editedByName = buildVesselCharterHandoffFile(editedFile, { name: 'sub-01_tof.nii' });
  assert.equal(editedByName.name, 'sub-01_tof_vesselboost_segmentation_edited.nii');

  const fallback = buildVesselCharterHandoffFile(seg, null);
  assert.equal(fallback.name, 'segmentation.nii');

  const gzBytes = new Uint8Array([31, 139, 8, 0]);
  const gzSeg = new File([gzBytes], 'mask.nii.gz', { type: 'application/gzip' });
  const namedGz = buildVesselCharterHandoffFile(gzSeg, { name: 'my scan (1).nii' });
  assert.equal(namedGz.name, 'my_scan_1_vesselboost_segmentation.nii.gz');
  assert.equal(namedGz.type, 'application/gzip');
  assert.deepEqual(new Uint8Array(await namedGz.arrayBuffer()), gzBytes);
}

console.log('result-display OK: independent image/mask visibility planning.');
