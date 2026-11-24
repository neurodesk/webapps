import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axialAxisIndex,
  computeNativeMorphometry,
  exactMaxDiameter3dMm,
  exactMinMeshDistanceMm,
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
  assert.ok(Math.abs(l.maxDiameter3dMm - 20.5) < 0.6, `unexpected 3D mesh diam ${l.maxDiameter3dMm}`);
  assert.ok(Math.abs(l.axialBidimensional.longAxisMm - 21) < 1.5);
  assert.ok(Math.abs(l.axialBidimensional.shortAxisMm - 21) < 1.5);
  assert.ok(l.axialBidimensional.longAxisMm >= l.axialBidimensional.shortAxisMm);
  assert.equal(l.axialBidimensional.measurable10x10mm, true);
  assert.ok(Math.abs(l.sphericity - 0.9099) < 0.001, `unexpected IBSI sphericity ${l.sphericity}`);
});

test('single 1 mm voxel reports IBSI mesh diameter 1 mm, and 4 mm surface gap between cubes is not multifocal', () => {
  const singleDims = [5, 5, 5];
  const single = new Uint8Array(125);
  single[voxelIndex(2, 2, 2, singleDims)] = 1;
  const resSingle = computeNativeMorphometry({ tumourMask: single, dims: singleDims, affine: IDENTITY });
  assert.equal(resSingle.lesions[0].maxDiameter3dMm, 1);

  // Two 5x5x5 cubes (0.125 mL each) at x=[2..6] (right surface x=6.5) and x=[11..15] (left surface x=10.5):
  // true surface gap = 4.0 mm (< 5.0 mm threshold) -> must NOT be multifocal.
  const dims = [20, 10, 10];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 2; z < 7; z++) {
    for (let y = 2; y < 7; y++) {
      for (let x = 2; x < 7; x++) mask[voxelIndex(x, y, z, dims)] = 1;
      for (let x = 11; x < 16; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const resGap = computeNativeMorphometry({ tumourMask: mask, dims, affine: IDENTITY });
  assert.equal(resGap.lesionCount, 2);
  assert.equal(resGap.maxMinFociDistanceMm, 4);
  assert.equal(resGap.multifocal, false);
});

test('single 20 x 6 mm row reports exact 20 x 6 mm and is not measurable, and diagonal across empty cells is rejected', () => {
  // Single row: 20 voxels along x (1 mm) x 1 voxel along y (6 mm) -> exact 20 x 6 mm.
  const dims = [24, 5, 3];
  const affine = [[1, 0, 0, 0], [0, 6, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let x = 2; x < 22; x++) mask[voxelIndex(x, 2, 1, dims)] = 1;
  const resRow = computeNativeMorphometry({ tumourMask: mask, dims, affine });
  const ax = resRow.lesions[0].axialBidimensional;
  assert.equal(ax.longAxisMm, 20);
  assert.equal(ax.shortAxisMm, 6);
  assert.equal(ax.measurable10x10mm, false);

  // Two diagonally touching blocks separated by background corners: exact DDA must reject diagonal chord across empty cells.
  const d2 = [12, 12, 3];
  const diagMask = new Uint8Array(d2[0] * d2[1] * d2[2]);
  // Diagonal chain of single cells (1,1), (2,2), (3,3), (4,4) with no flanking cells.
  for (let i = 1; i <= 4; i++) diagMask[voxelIndex(i, i, 1, d2)] = 1;
  const resDiag = computeNativeMorphometry({ tumourMask: diagMask, dims: d2, affine: IDENTITY });
  assert.ok(resDiag.lesions[0].axialBidimensional.longAxisMm <= 1.5, `diagonal across empty corners was accepted: ${resDiag.lesions[0].axialBidimensional.longAxisMm}`);
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
  // Focus 1: 10x6x4 = 240 voxels (0.24 mL) at x=[2..11] (surface x=11.5 -> -4.25 mm)
  for (let z = 4; z < 8; z++) {
    for (let y = 4; y < 10; y++) {
      for (let x = 2; x < 12; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  // Focus 2: 8x5x4 = 160 voxels (0.16 mL) at x=[26..33] (surface x=25.5 -> +2.75 mm) -> true surface gap = 7.0 mm >= 5 mm
  for (let z = 4; z < 8; z++) {
    for (let y = 4; y < 9; y++) {
      for (let x = 26; x < 34; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const res = computeNativeMorphometry({ tumourMask: mask, dims, affine });
  assert.equal(res.lesionCount, 2);
  assert.equal(res.multifocal, true);
  assert.equal(res.multifocalCount, 2);
  assert.ok(Math.abs(res.maxMinFociDistanceMm - 7.0) < 0.01, `unexpected gap ${res.maxMinFociDistanceMm}`);
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

test('axial bidimensional measurement is invariant under mirroring and rotation of L-shaped lesions', () => {
  const dims = [28, 28, 3];
  const makeL = (flipX, flipY) => {
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        if (x < 12 || y < 12) {
          const mx = flipX ? 23 - x : x;
          const my = flipY ? 23 - y : y;
          mask[voxelIndex(mx + 2, my + 2, 1, dims)] = 1;
        }
      }
    }
    return mask;
  };
  const expected = [];
  for (const [fx, fy] of [[false, false], [true, false], [false, true], [true, true]]) {
    const res = computeNativeMorphometry({ tumourMask: makeL(fx, fy), dims, affine: IDENTITY });
    const ax = res.lesions[0].axialBidimensional;
    assert.equal(ax.longAxisMm, 33.94, `flip=(${fx},${fy}) longAxisMm=${ax.longAxisMm}`);
    assert.equal(ax.shortAxisMm, 16.97, `flip=(${fx},${fy}) shortAxisMm=${ax.shortAxisMm}`);
    assert.equal(ax.measurable10x10mm, true, `flip=(${fx},${fy}) measurable`);
    expected.push(`${ax.longAxisMm}x${ax.shortAxisMm}`);
  }
  assert.equal(new Set(expected).size, 1);

  // 12x12 L with unequal 2- and 3-voxel arms has tied longest chords with different
  // perpendicular spans; all 8 dihedral symmetries must return identical measurements.
  const asymDims = [16, 16, 3];
  const asymSeen = new Set();
  for (const swapXY of [false, true]) {
    for (const fx of [false, true]) {
      for (const fy of [false, true]) {
        const mask = new Uint8Array(asymDims[0] * asymDims[1] * asymDims[2]);
        for (let y = 0; y < 12; y++) {
          for (let x = 0; x < 12; x++) {
            if (x < 2 || y < 3) {
              let rx = fx ? 11 - x : x;
              let ry = fy ? 11 - y : y;
              if (swapXY) [rx, ry] = [ry, rx];
              mask[voxelIndex(rx + 2, ry + 2, 1, asymDims)] = 1;
            }
          }
        }
        const ax = computeNativeMorphometry({ tumourMask: mask, dims: asymDims, affine: IDENTITY }).lesions[0].axialBidimensional;
        assert.equal(ax.longAxisMm, 12.2);
        assert.equal(ax.shortAxisMm, 11.59);
        assert.equal(ax.measurable10x10mm, true);
        asymSeen.add(`${ax.longAxisMm}x${ax.shortAxisMm}:${ax.measurable10x10mm}`);
      }
    }
  }
  assert.equal(asymSeen.size, 1);

  // Reversing both in-plane axes with affine adjusted to preserve the same physical lesion
  // (with near-tied chords separated by ~1e-10) must return identical results regardless of
  // traversal order (tie window anchored to final true maximum, never a running value).
  const revDims = [28, 28, 3];
  const revA = new Uint8Array(revDims[0] * revDims[1] * revDims[2]);
  const revB = new Uint8Array(revDims[0] * revDims[1] * revDims[2]);
  for (let y = 0; y < 22; y++) {
    for (let x = 0; x < 22; x++) {
      if (x < 3 || (x < 12 && y < 12) || y < 2) {
        revA[voxelIndex(x + 2, y + 2, 1, revDims)] = 1;
        revB[voxelIndex(25 - x, 25 - y, 1, revDims)] = 1;
      }
    }
  }
  const affA = [[1, 1e-10, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const affB = [[-1, -1e-10, 0, 27], [0, -1, 0, 27], [0, 0, 1, 0], [0, 0, 0, 1]];
  const resRevA = computeNativeMorphometry({ tumourMask: revA, dims: revDims, affine: affA }).lesions[0].axialBidimensional;
  const resRevB = computeNativeMorphometry({ tumourMask: revB, dims: revDims, affine: affB }).lesions[0].axialBidimensional;
  assert.deepEqual(resRevA, resRevB);
});

test('exact triangle-to-triangle mesh distance avoids false multifocality on parallel faces 4.99 mm apart and stays inclusive at rotated 5.00 mm', () => {
  // Two 7x7x7 cubes (~0.342 mL each) with sheared affine so opposing mesh faces are strictly
  // parallel at 4.99 mm apart while vertices are laterally staggered by 0.45 mm
  // (vertex-only distance = sqrt(4.99^2 + 0.45^2) = 5.01 mm > 5 mm, true face distance = 4.99 mm < 5 mm).
  const dims = [24, 12, 12];
  const affine = [
    [0.998, 0, 0, 0],
    [0.09, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 2; z < 9; z++) {
    for (let y = 2; y < 9; y++) {
      for (let x = 2; x < 9; x++) mask[voxelIndex(x, y, z, dims)] = 1;
      for (let x = 14; x < 21; x++) mask[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const res = computeNativeMorphometry({ tumourMask: mask, dims, affine });
  assert.equal(res.lesionCount, 2);
  assert.equal(res.maxMinFociDistanceMm, 4.99);
  assert.equal(res.multifocal, false);

  // Same two 7x7x7 cubes with faces exactly 5.00 mm apart rotated by 30 deg:
  // raw float distance ~4.999999999999998 must still satisfy inclusive >= 5.0 mm cutoff.
  const rad30 = (30 * Math.PI) / 180;
  const rot30 = [
    [Math.cos(rad30), -Math.sin(rad30), 0, 0],
    [Math.sin(rad30), Math.cos(rad30), 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const resRot = computeNativeMorphometry({ tumourMask: mask, dims, affine: rot30 });
  assert.equal(resRot.maxMinFociDistanceMm, 5);
  assert.equal(resRot.multifocal, true);

  // Direct triangle-to-triangle check on staggered coplanar-normal triangles 4.99 mm apart.
  const triA = [[[0, 0, 0], [4, 0, 0], [0, 4, 0]]];
  const triB = [[[1, 1, 4.99], [5, 1, 4.99], [1, 5, 4.99]]];
  assert.ok(Math.abs(exactMinMeshDistanceMm(triA, triB) - 4.99) < 1e-9);
});
