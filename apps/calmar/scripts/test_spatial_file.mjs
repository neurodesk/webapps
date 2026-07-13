#!/usr/bin/env node --no-warnings

import assert from 'node:assert/strict';
import {
  VOLUME_SPACES,
  atlasOptionSpace,
  atlasVolumeSpace,
  assertSameSpace,
  assertSpace,
  assertVolumeStackSpaces,
  getSpatialMetadata,
  spatialLabel,
  tagSpatialFile
} from '../web/js/modules/spatial-file.js';

const affine = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
];
const shiftedAffine = [
  [1, 0, 0, 10],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1]
];

{
  const file = { name: 't1.nii' };
  tagSpatialFile(file, {
    space: VOLUME_SPACES.NATIVE_T1,
    role: 'structural',
    sourceStage: 'input',
    dims: [4, 5, 6],
    affine
  });
  assert.equal(getSpatialMetadata(file).space, VOLUME_SPACES.NATIVE_T1,
    'tagSpatialFile must attach spatial metadata to arbitrary file-like objects');
  assert.deepEqual(getSpatialMetadata(file).dims, [4, 5, 6],
    'tagSpatialFile must retain 3D dimensions');
  assert.equal(spatialLabel(file), VOLUME_SPACES.NATIVE_T1,
    'spatialLabel must report tagged space names');
  assert.equal(assertSpace(file, VOLUME_SPACES.NATIVE_T1, 'native structural'), true,
    'assertSpace must pass for matching tagged spaces');
}

{
  const untracked = { name: 'legacy-file.nii' };
  assert.equal(assertSpace(untracked, VOLUME_SPACES.MNI160, 'legacy input'), true,
    'assertSpace must keep legacy untagged files permissive by default');
  assert.throws(
    () => assertSpace(untracked, VOLUME_SPACES.MNI160, 'strict input', { requireMetadata: true }),
    /strict input: missing spatial metadata; expected mni160/,
    'strict callers must be able to require explicit spatial metadata'
  );
}

{
  const base = tagSpatialFile({ name: 'base.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [2, 2, 2],
    affine
  });
  const overlay = tagSpatialFile({ name: 'overlay.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [2, 2, 2],
    affine
  });
  assert.equal(assertSameSpace(base, overlay, 'MNI viewer stack'), true,
    'assertSameSpace must pass matching space, dimensions, and affine');
}

{
  const base = tagSpatialFile({ name: 'native.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    dims: [2, 2, 2],
    affine
  });
  const overlay = tagSpatialFile({ name: 'mni.nii' }, {
    space: VOLUME_SPACES.MNI160,
    dims: [2, 2, 2],
    affine
  });
  assert.throws(
    () => assertSameSpace(base, overlay, 'Brain mask overlay'),
    /Brain mask overlay: base is in native-t1, overlay is in mni160/,
    'assertSameSpace must reject cross-space overlays with useful context'
  );
}

{
  const base = tagSpatialFile({ name: 'base.nii' }, {
    space: atlasVolumeSpace('schaefer400-7n-2mm'),
    dims: [2, 2, 2],
    affine
  });
  const differentDims = tagSpatialFile({ name: 'different-dims.nii' }, {
    space: atlasVolumeSpace('schaefer400-7n-2mm'),
    dims: [3, 2, 2],
    affine
  });
  const differentAffine = tagSpatialFile({ name: 'different-affine.nii' }, {
    space: atlasVolumeSpace('schaefer400-7n-2mm'),
    dims: [2, 2, 2],
    affine: shiftedAffine
  });
  assert.throws(
    () => assertSameSpace(base, differentDims, 'Schaefer overlay'),
    /dimensions differ \(2x2x2 vs 3x2x2\)/,
    'matching atlas ids must still reject dimension mismatches'
  );
  assert.throws(
    () => assertSameSpace(base, differentAffine, 'Schaefer overlay'),
    /affines differ/,
    'matching atlas ids must still reject affine mismatches'
  );
}

{
  const base = tagSpatialFile({ name: 'atlas-base.nii' }, {
    space: atlasVolumeSpace('yeo7-mni2mm'),
    dims: [2, 2, 2],
    affine
  });
  const okOverlay = tagSpatialFile({ name: 'network-map.nii' }, {
    space: atlasVolumeSpace('yeo7-mni2mm'),
    dims: [2, 2, 2],
    affine
  });
  const wrongOverlay = tagSpatialFile({ name: 'patient-threshold.nii' }, {
    space: VOLUME_SPACES.NATIVE_T1,
    dims: [2, 2, 2],
    affine
  });
  assert.equal(assertVolumeStackSpaces([
    { file: base, stage: 'atlas-brain-mask' },
    { file: okOverlay, stage: 'network-map' }
  ], 'Network-map atlas stack'), true,
  'assertVolumeStackSpaces must validate each overlay against the stack base');
  assert.throws(
    () => assertVolumeStackSpaces([
      { file: base, stage: 'atlas-brain-mask' },
      { file: wrongOverlay, stage: 'threshold-preview' }
    ], 'Network-map atlas stack'),
    /Network-map atlas stack: threshold-preview: base is in atlas:yeo7-mni2mm, overlay is in native-t1/,
    'assertVolumeStackSpaces must include the overlay stage in failures'
  );
}

{
  assert.equal(atlasVolumeSpace('schaefer400-7n-2mm'), 'atlas:schaefer400-7n-2mm',
    'atlasVolumeSpace must make atlas grid ids explicit');
  assert.equal(
    atlasOptionSpace({
      overlapAtlasAssetId: 'schaefer400-7n-2mm',
      affectedAtlasAssetId: 'schaefer400-7n-4mm'
    }),
    'atlas:schaefer400-7n-2mm',
    'atlasOptionSpace must use the direct-overlap atlas by default'
  );
  assert.equal(
    atlasOptionSpace({
      overlapAtlasAssetId: 'schaefer400-7n-2mm',
      affectedAtlasAssetId: 'schaefer400-7n-4mm'
    }, 'affected'),
    'atlas:schaefer400-7n-4mm',
    'atlasOptionSpace must use affectedAtlasAssetId for affected-map labeling'
  );
}

console.log('spatial-file OK: tagging + explicit-space assertions + viewer-stack mismatch guards.');
