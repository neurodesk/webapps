#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import {
  analysisVolumeSpace,
  assertSameSpace,
  assertSpace,
  assertVolumeStackSpaces,
  getSpatialMetadata,
  spatialLabel,
  tagSpatialFile,
  VOLUME_SPACES
} from '../web/js/modules/spatial-file.js';

const affine = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
];
const shiftedAffine = [
  [1, 0, 0, 4],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
];

{
  const file = { name: 'source.nii' };
  tagSpatialFile(file, {
    space: VOLUME_SPACES.SOURCE_NATIVE,
    role: 'source',
    sourceStage: 'input',
    dims: [4, 5, 6],
    affine
  });
  assert.equal(getSpatialMetadata(file).space, VOLUME_SPACES.SOURCE_NATIVE);
  assert.deepEqual(getSpatialMetadata(file).dims, [4, 5, 6]);
  assert.equal(spatialLabel(file), VOLUME_SPACES.SOURCE_NATIVE);
  assert.equal(assertSpace(file, VOLUME_SPACES.SOURCE_NATIVE, 'source'), true);
}

{
  const untracked = { name: 'legacy.nii' };
  assert.equal(assertSpace(untracked, VOLUME_SPACES.SOURCE_NATIVE, 'legacy'), true);
  assert.throws(
    () => assertSpace(untracked, VOLUME_SPACES.SOURCE_NATIVE, 'strict', { requireMetadata: true }),
    /strict: missing spatial metadata; expected source-native/
  );
}

{
  const base = tagSpatialFile({ name: 'base.nii' }, {
    space: analysisVolumeSpace('abc'),
    dims: [2, 2, 2],
    affine
  });
  const overlay = tagSpatialFile({ name: 'overlay.nii' }, {
    space: analysisVolumeSpace('abc'),
    dims: [2, 2, 2],
    affine
  });
  assert.equal(assertSameSpace(base, overlay, 'analysis overlay'), true);
}

{
  const base = tagSpatialFile({ name: 'source.nii' }, {
    space: VOLUME_SPACES.SOURCE_NATIVE,
    dims: [2, 2, 2],
    affine
  });
  const overlay = tagSpatialFile({ name: 'downsampled.nii' }, {
    space: analysisVolumeSpace('downsampled'),
    dims: [1, 1, 1],
    affine
  });
  assert.throws(
    () => assertSameSpace(base, overlay, 'vessel overlay'),
    /vessel overlay: base is in source-native, overlay is in analysis:downsampled/
  );
}

{
  const base = tagSpatialFile({ name: 'base.nii' }, {
    space: analysisVolumeSpace('same-grid'),
    dims: [2, 2, 2],
    affine
  });
  const badDims = tagSpatialFile({ name: 'bad-dims.nii' }, {
    space: analysisVolumeSpace('same-grid'),
    dims: [3, 2, 2],
    affine
  });
  const badAffine = tagSpatialFile({ name: 'bad-affine.nii' }, {
    space: analysisVolumeSpace('same-grid'),
    dims: [2, 2, 2],
    affine: shiftedAffine
  });
  assert.throws(() => assertSameSpace(base, badDims, 'stack'), /dimensions differ/);
  assert.throws(() => assertSameSpace(base, badAffine, 'stack'), /affines differ/);
}

{
  const base = tagSpatialFile({ name: 'base.nii' }, {
    space: analysisVolumeSpace('stack'),
    dims: [2, 2, 2],
    affine
  });
  const overlay = tagSpatialFile({ name: 'overlay.nii' }, {
    space: analysisVolumeSpace('stack'),
    dims: [2, 2, 2],
    affine
  });
  assert.equal(assertVolumeStackSpaces([
    { file: base, stage: 'n4' },
    { file: overlay, stage: 'segmentation' }
  ], 'viewer stack'), true);
}

console.log('spatial-file OK: tagging + strict space/dims/affine assertions.');
