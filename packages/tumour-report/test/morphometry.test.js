import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axialAxisIndex, computeNativeMorphometry } from '../src/morphometry.js';
import { voxelIndex } from '../src/preprocess.js';

const IDENTITY = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function sphereMask(dims, cx, cy, cz, r) {
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2 <= r * r) {
          mask[voxelIndex(x, y, z, dims)] = 1;
        }
      }
    }
  }
  return mask;
}

test('computeNativeMorphometry reports empty state explicitly when no voxels are segmented', () => {
  const dims = [10, 10, 10];
  const brain = new Uint8Array(1000).fill(1);
  const res = computeNativeMorphometry({
    tumourMask: new Uint8Array(1000),
    brainMask: brain,
    dims,
    affine: IDENTITY,
  });
  assert.equal(res.status, 'no_lesions_segmented');
  assert.equal(res.lesionCount, 0);
  assert.equal(res.totalVolumeMl, 0);
  assert.equal(res.brainVolumeMl, 1);
  assert.equal(res.lesions.length, 0);
});

test('computeNativeMorphometry measures a 10 mm radius sphere accurately on isotropic grid', () => {
  const dims = [32, 32, 32];
  const mask = sphereMask(dims, 16, 16, 16, 10);
  const res = computeNativeMorphometry({
    tumourMask: mask,
    dims,
    affine: IDENTITY,
  });
  assert.equal(res.status, 'lesions_segmented');
  assert.equal(res.lesionCount, 1);
  assert.equal(res.multifocal, false);
  const l = res.lesions[0];
  // Analytic sphere volume = 4/3 * pi * 10^3 = 4188.8 mm^3 = 4.189 mL
  assert.ok(Math.abs(l.volumeMl - 4.189) < 0.15, `unexpected volume ${l.volumeMl}`);
  assert.deepEqual(l.centroidMm, [16, 16, 16]);
  assert.ok(Math.abs(l.maxDiameter3dMm - 20) < 0.5, `unexpected 3D diam ${l.maxDiameter3dMm}`);
  assert.ok(Math.abs(l.axialBidimensional.longAxisMm - 21) < 1.5);
  assert.ok(Math.abs(l.axialBidimensional.shortAxisMm - 21) < 1.5);
  assert.equal(l.axialBidimensional.measurable10x10mm, true);
  assert.ok(l.sphericity > 0.6 && l.sphericity <= 1);
});

test('computeNativeMorphometry handles anisotropic affines and multifocality distance threshold', () => {
  const dims = [40, 20, 20];
  // 0.5 x 1 x 2 mm voxels -> voxel volume = 1 mm^3 = 0.001 mL
  const affine = [
    [0.5, 0, 0, -10],
    [0, 1, 0, 0],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  // Focus 1: 10x6x4 = 240 voxels (0.24 mL) at x=[2..11] (mm -9..-4.5)
  for (let z = 4; z < 8; z++) {
    for (let y = 4; y < 10; y++) {
      for (let x = 2; x < 12; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  // Focus 2: 8x5x4 = 160 voxels (0.16 mL) at x=[26..33] (mm +3..+6.5) -> gap = 7.5 mm >= 5 mm
  for (let z = 4; z < 8; z++) {
    for (let y = 4; y < 9; y++) {
      for (let x = 26; x < 34; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const res = computeNativeMorphometry({ tumourMask: mask, dims, affine });
  assert.equal(res.lesionCount, 2);
  assert.equal(res.multifocal, true);
  assert.equal(res.multifocalCount, 2);
  assert.ok(Math.abs(res.maxMinFociDistanceMm - 7.5) < 0.01, `unexpected gap ${res.maxMinFociDistanceMm}`);
  assert.equal(res.lesions[0].voxels, 240);
  assert.equal(res.lesions[1].voxels, 160);
});

test('axialAxisIndex detects superior-inferior axis on sagittal acquisitions', () => {
  const sagittalAffine = [
    [0, 0, 1, 0],
    [1, 0, 0, 0],
    [0, -1, 0, 0],
    [0, 0, 0, 1],
  ];
  assert.equal(axialAxisIndex(sagittalAffine), 1);
});
