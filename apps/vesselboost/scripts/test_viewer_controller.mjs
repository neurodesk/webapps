#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import { ViewerController } from '../web/js/controllers/ViewerController.js';
import { analysisVolumeSpace, tagSpatialFile } from '../web/js/modules/spatial-file.js';

globalThis.URL = {
  createObjectURL: file => `blob:${file?.name || 'file'}`,
  revokeObjectURL: () => {}
};

function makeNv() {
  const calls = {
    loadVolumes: [],
    addVolumeFromUrl: [],
    setOpacity: [],
    setColormap: [],
    removeVolumeByIndex: [],
    updateGLVolume: 0,
    drawScene: 0
  };
  const nv = {
    volumes: [],
    sliceTypeMultiplanar: 0,
    sliceTypeAxial: 1,
    sliceTypeCoronal: 2,
    sliceTypeSagittal: 3,
    sliceTypeRender: 4,
    addColormap() {},
    async loadVolumes(entries) {
      calls.loadVolumes.push(entries);
      this.volumes = entries.map((entry, index) => ({
        id: `vol-${index}`,
        name: entry.name,
        opacity: entry.opacity ?? 1,
        colormap: 'gray',
        interpolation: true,
        img: new Float32Array([0, 1])
      }));
    },
    async addVolumeFromUrl(opts) {
      calls.addVolumeFromUrl.push(opts);
      this.volumes.push({
        id: `vol-${this.volumes.length}`,
        name: opts.name,
        opacity: opts.opacity ?? 1,
        colormap: opts.colormap || 'gray',
        interpolation: true,
        img: new Float32Array([0, 1])
      });
    },
    setOpacity(index, opacity) {
      calls.setOpacity.push([index, opacity]);
      if (this.volumes[index]) this.volumes[index].opacity = opacity;
    },
    setColormap(id, colormap) { calls.setColormap.push([id, colormap]); },
    setSliceType() {},
    updateGLVolume() { calls.updateGLVolume += 1; },
    drawScene() { calls.drawScene += 1; },
    removeVolumeByIndex(index) {
      calls.removeVolumeByIndex.push(index);
      this.volumes.splice(index, 1);
    }
  };
  return { nv, calls };
}

function file(name, space = analysisVolumeSpace('grid'), dims = [2, 2, 2]) {
  return tagSpatialFile({ name }, {
    space,
    dims,
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ]
  });
}

{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadVolumeStack([
    { file: file('base.nii'), stage: 'n4' },
    { file: file('seg.nii'), stage: 'segmentation', colormap: 'vesselboost', opacity: 0.5 },
    { file: file('brainmask.nii'), stage: 'brainmask', colormap: 'green', opacity: 0.35 }
  ]);
  assert.equal(calls.loadVolumes.length, 1, 'base is loaded once');
  assert.equal(calls.loadVolumes[0].length, 1, 'base load must use a single-entry loadVolumes call');
  assert.equal(calls.addVolumeFromUrl.length, 2, 'overlays must use addVolumeFromUrl');
  assert.equal(vc.getVolumeIndexForStage('n4'), 0);
  assert.equal(vc.getVolumeIndexForStage('segmentation'), 1);
  assert.equal(vc.getVolumeIndexForStage('brainmask'), 2);
}

{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(file('base.nii'), { stage: 'n4' });
  await vc.loadOverlay(file('seg-a.nii'), 'vesselboost', 0.5, { stage: 'segmentation' });
  await vc.replaceOverlayForStage('segmentation', file('seg-b.nii'), 'vesselboost', 0.65);
  assert.deepEqual(calls.removeVolumeByIndex, [1]);
  assert.equal(nv.volumes.length, 2, 'stage replacement must not accumulate duplicate overlays');
  assert.equal(nv.volumes[1].name, 'seg-b.nii');
}

{
  const { nv, calls } = makeNv();
  const vc = new ViewerController({ nv });
  await vc.loadBaseVolume(file('base.nii'), { stage: 'n4' });
  await vc.loadOverlay(file('seg.nii'), 'vesselboost', 0.5, { stage: 'segmentation' });
  vc.setStageVisible('segmentation', false);
  assert.equal(nv.volumes.length, 2, 'hiding a stage must not remove the volume');
  assert.deepEqual(calls.setOpacity.at(-1), [1, 0]);
  vc.setStageVisible('segmentation', true);
  assert.deepEqual(calls.setOpacity.at(-1), [1, 0.5]);
}

{
  const { nv } = makeNv();
  const vc = new ViewerController({ nv, updateOutput: () => {} });
  await vc.loadBaseVolume(file('base.nii', analysisVolumeSpace('a')), { stage: 'n4' });
  const oldError = console.error;
  console.error = () => {};
  const ok = await vc.loadOverlay(file('wrong.nii', analysisVolumeSpace('b')), 'vesselboost', 0.5, { stage: 'segmentation' });
  console.error = oldError;
  assert.equal(ok, false, 'wrong-space overlay must be rejected');
  assert.equal(nv.volumes.length, 1, 'wrong-space overlay must not be added');
}

console.log('viewer-controller OK: stage-aware stacks + opacity visibility + space guard.');
