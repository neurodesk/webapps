#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io';
import { VesselBoostPipeline } from '../web/js/controllers/VesselBoostPipeline.js';
import { buildEditVolumeStack } from '../web/js/modules/ui/result-display.js';
import { assertSameSpace, getSpatialMetadata, VOLUME_SPACES } from '../web/js/modules/spatial-file.js';

function nifti(dims, voxelSize, values = null) {
  const count = dims[0] * dims[1] * dims[2];
  const img = values || new Float32Array(count);
  const affine = [[voxelSize, 0, 0, -10], [0, voxelSize, 0, -12], [0, 0, voxelSize, -4], [0, 0, 0, 1]];
  return createNiftiFromVolume({ img, hdr: { dims, pixDims: [voxelSize, voxelSize, voxelSize], affine } });
}

// The worker writes analysis-grid results with a qform and an empty sform; NiiVue saves the edit with both.
function qformOnly(buffer) {
  const view = new DataView(buffer);
  view.setInt16(254, 0, true);
  for (let offset = 280; offset < 328; offset += 4) view.setFloat32(offset, 0, true);
  return buffer;
}

function pipelineWithResults() {
  const pipeline = new VesselBoostPipeline({ updateOutput: () => {} });
  const source = nifti([8, 8, 4], 1);
  pipeline.setSourceFile(new File([source], 'tof.nii'), source);
  pipeline.handleStageData({ stage: 'downsample', niftiData: qformOnly(nifti([4, 4, 2], 2)), description: 'Downsampled' });
  pipeline.handleStageData({ stage: 'segmentation', niftiData: qformOnly(nifti([4, 4, 2], 2, new Float32Array(32).fill(1))), description: 'Vessels' });
  pipeline.handleBrainMaskOverlay({ niftiData: qformOnly(nifti([4, 4, 2], 2, new Float32Array(32).fill(1))) });
  return pipeline;
}

{
  const pipeline = pipelineWithResults();
  assert.equal(pipeline.getResult('segmentation').editable, true, 'the vessel mask is editable');
  assert.equal(pipeline.getResult('brainmask').editable, true, 'the brain mask is editable');
  assert.equal(pipeline.getResult('downsample').editable, false, 'an image is not editable');
}

{
  const pipeline = pipelineWithResults();
  const original = pipeline.getResult('segmentation').file;
  const edited = new File([nifti([4, 4, 2], 2, new Float32Array(32))], original.name);
  const result = pipeline.replaceWithEdit('segmentation', edited, original);
  assert.equal(pipeline.getResult('segmentation').file, edited, 'Download returns the edited file');
  assert.equal(result.edited, true);
  assert.equal(result.original, original);
  assert.equal(result.description, 'Vessels');
  assert.deepEqual(getSpatialMetadata(edited).space, getSpatialMetadata(original).space, 'the edit is tagged with the analysis grid');
  assert.notEqual(getSpatialMetadata(edited).space, VOLUME_SPACES.SOURCE_NATIVE);
  assert.doesNotThrow(() => assertSameSpace(pipeline.getResult('downsample').file, edited, 'edited overlay', { requireMetadata: true }));

  const again = new File([nifti([4, 4, 2], 2)], original.name);
  pipeline.replaceWithEdit('segmentation', again, edited);
  assert.equal(pipeline.getResult('segmentation').original, original, 'a second edit keeps the pipeline output as the original');
}

{
  const pipeline = pipelineWithResults();
  const { visibility, baseStage, stack } = buildEditVolumeStack({
    stage: 'segmentation',
    sourceFile: { name: 'tof.nii' },
    stages: pipeline.getStageOrder(),
    results: pipeline.getResults(),
    visibility: { downsample: false, segmentation: false, brainmask: false },
    preferredBaseStage: 'input'
  });
  assert.equal(baseStage, 'downsample', 'a hidden analysis image becomes the visible base');
  assert.equal(visibility.downsample, true);
  assert.equal(visibility.segmentation, true);
  assert.deepEqual(stack.map(entry => entry.stage), ['downsample', 'segmentation']);
  assert.equal(stack[0].visible, true);
}

{
  const source = { name: 'tof.nii' };
  const results = { segmentation: { file: { name: 'segmentation.nii' } }, brainmask: { file: { name: 'brain-mask.nii' } } };
  const { baseStage, stack } = buildEditVolumeStack({
    stage: 'segmentation',
    sourceFile: source,
    stages: ['segmentation', 'brainmask'],
    results,
    visibility: { brainmask: true }
  });
  assert.equal(baseStage, 'input', 'without an analysis image the source image is the base');
  assert.deepEqual(stack.map(entry => entry.stage), ['input', 'segmentation']);
  assert.equal(stack[0].file, source);
  assert.equal(stack[1].file, results.segmentation.file);
}

console.log('mask edit tests passed');
