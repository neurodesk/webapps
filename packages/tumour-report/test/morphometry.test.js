import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axialAxisIndex,
  computeNativeMorphometry,
  exactMaxDiameter3dMm,
  exactMinSurfaceDistanceMm,
} from '../src/morphometry.js';
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
  // Exact IBSI Lorensen Marching Cubes reference on r=10 digital sphere:
  // mesh vol = 4147.83 mm^3, mesh area = 1372.04 mm^2, sphericity = 0.9099.
  assert.ok(Math.abs(l.volumeMl - 4.189) < 0.15, `unexpected volume ${l.volumeMl}`);
  assert.ok(Math.abs(l.meshVolumeMl - 4.148) < 0.01, `unexpected IBSI mesh volume ${l.meshVolumeMl}`);
  assert.ok(Math.abs(l.surfaceAreaMm2 - 1372.04) < 0.1, `unexpected IBSI mesh area ${l.surfaceAreaMm2}`);
  assert.deepEqual(l.centroidMm, [16, 16, 16]);
  assert.ok(Math.abs(l.maxDiameter3dMm - 20) < 0.5, `unexpected 3D diam ${l.maxDiameter3dMm}`);
  assert.ok(Math.abs(l.axialBidimensional.longAxisMm - 21) < 1.5);
  assert.ok(Math.abs(l.axialBidimensional.shortAxisMm - 21) < 1.5);
  assert.ok(l.axialBidimensional.longAxisMm >= l.axialBidimensional.shortAxisMm);
  assert.equal(l.axialBidimensional.measurable10x10mm, true);
  assert.ok(Math.abs(l.sphericity - 0.9099) < 0.001, `unexpected IBSI sphericity ${l.sphericity}`);
});

test('IBSI Marching Cubes matches exact reference on 5x5x5 2mm cube and preserves area under shear', () => {
  const dims = [9, 9, 9];
  const mask = new Uint8Array(9 * 9 * 9);
  for (let z = 2; z < 7; z++) {
    for (let y = 2; y < 7; y++) {
      for (let x = 2; x < 7; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const iso2 = [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const res = computeNativeMorphometry({ tumourMask: mask, dims, affine: iso2 });
  assert.ok(Math.abs(res.lesions[0].meshVolumeMl - 0.945) < 0.002);
  assert.ok(Math.abs(res.lesions[0].surfaceAreaMm2 - 526.69) < 0.1);
  assert.ok(Math.abs(res.lesions[0].sphericity - 0.8844) < 0.001);

  // Volume-preserving shear affine: det=8 unchanged, mesh volume unchanged, surface area increases accurately.
  const sheared = [[2, 1, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const resShear = computeNativeMorphometry({ tumourMask: mask, dims, affine: sheared });
  assert.ok(Math.abs(resShear.lesions[0].meshVolumeMl - 0.945) < 0.002);
  assert.ok(resShear.lesions[0].surfaceAreaMm2 > res.lesions[0].surfaceAreaMm2);
});

test('axial bidimensional measurement never bridges hollow rings or concavities', () => {
  const dims = [30, 30, 5];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  // 1-voxel-thick 21x21 hollow square ring on slice z=2 (x in [4..24], y in [4..24] perimeter only).
  for (let x = 4; x <= 24; x++) {
    mask[voxelIndex(x, 4, 2, dims)] = 1;
    mask[voxelIndex(x, 24, 2, dims)] = 1;
  }
  for (let y = 4; y <= 24; y++) {
    mask[voxelIndex(4, y, 2, dims)] = 1;
    mask[voxelIndex(24, y, 2, dims)] = 1;
  }
  const res = computeNativeMorphometry({ tumourMask: mask, dims, affine: IDENTITY });
  assert.equal(res.lesionCount, 1);
  const ax = res.lesions[0].axialBidimensional;
  assert.ok(ax.longAxisMm <= 22.5, `hollow ring long axis bridged hole: ${ax.longAxisMm}`);
  assert.ok(ax.shortAxisMm <= 2.5, `hollow ring short axis bridged hole: ${ax.shortAxisMm}`);
  assert.equal(ax.measurable10x10mm, false);
});

test('exactMaxDiameter3dMm and exactMinSurfaceDistanceMm match brute force on large point clouds', () => {
  const ptsA = [];
  const ptsB = [];
  for (let i = 0; i < 2500; i++) {
    ptsA.push([(i * 17) % 40, (i * 31) % 35, (i * 13) % 25]);
    ptsB.push([50 + ((i * 19) % 30), (i * 23) % 35, (i * 11) % 25]);
  }
  // Insert one known closest pair separated by 4.5 mm (< 5 mm threshold) and one known farthest pair.
  ptsA.push([45, 10, 10]);
  ptsB.push([49.5, 10, 10]);
  ptsA.push([-20, -20, -20]);
  ptsA.push([80, 80, 80]);

  const maxD = exactMaxDiameter3dMm(ptsA);
  assert.ok(Math.abs(maxD - Math.hypot(100, 100, 100)) < 1e-6, `unexpected maxD ${maxD}`);
  const minD = exactMinSurfaceDistanceMm(ptsA, ptsB);
  assert.ok(Math.abs(minD - 4.5) < 1e-6, `unexpected minD ${minD}`);
});

test('computeNativeMorphometry handles empty brain mask without throwing and sets brainPercentage to null', () => {
  const dims = [10, 10, 10];
  const mask = new Uint8Array(1000);
  mask[voxelIndex(5, 5, 5, dims)] = 1;
  const res = computeNativeMorphometry({
    tumourMask: mask,
    brainMask: new Uint8Array(1000),
    dims,
    affine: IDENTITY,
  });
  assert.equal(res.brainVolumeMl, 0);
  assert.equal(res.brainPercentage, null);
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
