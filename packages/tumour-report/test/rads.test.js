import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import initGreedy, * as greedyApi from '@neurodesk/greedy/wasm-single';
import { writeVolume } from '@neurodesk/synthsr';
import {
  computeCorticalOverlap,
  computeLaterality,
  computeResectability,
  computeSubcorticalTracts,
  normalizeToMniWithGreedy,
  parseBcbTractsPack,
  prepareRegistrationInputsRas,
  squaredEdt3d,
} from '../src/rads.js';
import { voxelIndex, labelComponents26 } from '../src/preprocess.js';

test('computeLaterality matches Raidionics convention and uses unrounded hemisphere counts for midlineCrossing', () => {
  const lat = new Uint8Array([1, 1, 2, 2, 0]);
  const rightOnly = computeLaterality(new Uint8Array([1, 1, 0, 0, 0]), lat);
  assert.equal(rightOnly.leftPct, 0);
  assert.equal(rightOnly.rightPct, 100);
  assert.equal(rightOnly.unlabelledPct, 0);
  assert.equal(rightOnly.midlineCrossing, false);

  const bilateral = computeLaterality(new Uint8Array([1, 0, 1, 1, 0]), lat);
  assert.equal(bilateral.leftPct, 66.67);
  assert.equal(bilateral.rightPct, 33.33);
  assert.equal(bilateral.midlineCrossing, true);

  // 1 left + 1 unlabelled must NOT assert midline crossing!
  const leftPlusUnlabelled = computeLaterality(new Uint8Array([0, 0, 1, 0, 1]), lat);
  assert.equal(leftPlusUnlabelled.leftPct, 50);
  assert.equal(leftPlusUnlabelled.rightPct, 0);
  assert.equal(leftPlusUnlabelled.unlabelledPct, 50);
  assert.equal(leftPlusUnlabelled.midlineCrossing, false);
});

test('prepareRegistrationInputsRas preserves tumour voxels at native resolution without dropping sub-millimetre foci', () => {
  const dims = [30, 12, 12];
  const affine = [[0.6, 0, 0, 0], [0, 0.6, 0, 0], [0, 0, 0.6, 0], [0, 0, 0, 1]];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]).fill(50);
  const brain = new Uint8Array(data.length);
  const tumour = new Uint8Array(data.length);
  // Brain occupies x=[2..10]; tumour has a 16-voxel focus inside brain and a 16-voxel focus outside brain (x=[24..25]).
  for (let z = 2; z <= 9; z++) {
    for (let y = 2; y <= 9; y++) {
      for (let x = 2; x <= 10; x++) brain[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  for (let z = 4; z < 6; z++) {
    for (let y = 4; y < 8; y++) {
      for (let x = 5; x < 7; x++) tumour[voxelIndex(x, y, z, dims)] = 1;
      for (let x = 24; x < 26; x++) tumour[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const prepared = prepareRegistrationInputsRas({ data, dims, affine }, brain, tumour);
  let maskSum = 0;
  for (let i = 0; i < prepared.mask.data.length; i++) maskSum += prepared.mask.data[i];
  assert.equal(maskSum, 32, 'all 32 native-resolution tumour voxels across both foci must survive');
  assert.equal(prepared.mask.affine[0][0], 0.6, 'moving tumour mask stays at native resolution for direct Greedy reslicing');
});

test('computeResectability selects hemisphere map and matches Kommers/Raidionics formula', () => {
  const mask = new Uint8Array(2000).fill(1);
  const leftMap = new Float32Array(2000);
  const rightMap = new Float32Array(2000).fill(0.2);
  leftMap.fill(0.8, 0, 1000);
  leftMap.fill(0.4, 1000, 2000);
  const resLeft = computeResectability(mask, 60, leftMap, rightMap);
  assert.equal(resLeft.hemisphereMap, 'left');
  assert.equal(resLeft.resectabilityIndex, 0.6);
  assert.ok(Math.abs(resLeft.expectedResectableMl - 1.2) < 1e-3);
  assert.ok(Math.abs(resLeft.expectedResidualMl - 0.8) < 1e-3);

  const resRight = computeResectability(mask, 40, leftMap, rightMap);
  assert.equal(resRight.hemisphereMap, 'right');
  assert.equal(resRight.resectabilityIndex, 0.2);
});

test('computeCorticalOverlap computes percentages of tumour and region sorted descending', () => {
  const atlas = new Uint8Array([1, 1, 2, 2, 2, 0]);
  const mask = new Uint8Array([1, 0, 1, 1, 0, 1]);
  const labels = [
    { label: 1, name: 'frontal_left', region: 'frontal', laterality: 'left' },
    { label: 2, name: 'parietal_left', region: 'parietal', laterality: 'left' },
  ];
  const res = computeCorticalOverlap(mask, atlas, labels);
  assert.equal(res.byName.frontal_left, 25);
  assert.equal(res.byName.parietal_left, 50);
  assert.equal(res.involved[0].name, 'parietal_left');
  assert.equal(res.involved[0].regionPct, 66.67);
});

test('squaredEdt3d matches brute-force Euclidean distance with anisotropic spacing', () => {
  const dims = [6, 5, 4];
  const spacing = [1, 2, 3];
  const mask = new Uint8Array(120);
  mask[voxelIndex(1, 1, 1, dims)] = 1;
  mask[voxelIndex(4, 3, 2, dims)] = 1;
  const distSq = squaredEdt3d(mask, dims, spacing);
  const seeds = [[1, 1, 1], [4, 3, 2]];
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        let best = Infinity;
        for (const [sx, sy, sz] of seeds) {
          const d2 = ((x - sx) * spacing[0]) ** 2 + ((y - sy) * spacing[1]) ** 2 + ((z - sz) * spacing[2]) ** 2;
          if (d2 < best) best = d2;
        }
        assert.ok(Math.abs(distSq[voxelIndex(x, y, z, dims)] - best) < 1e-4);
      }
    }
  }
});

test('parseBcbTractsPack and computeSubcorticalTracts score overlapping and nearby tracts', () => {
  const dims = [8, 8, 8];
  // Tract A: single voxel at (2, 2, 2) -> overlaps tumour
  // Tract B: single voxel at (6, 2, 2) -> 4 mm away from tumour at (2, 2, 2)
  const meta = JSON.stringify({
    format: 'bcb-tracts-bitpack-v1',
    dims,
    cutoff: 0.5,
    tracts: [
      { id: 'TractA_mni', name: 'TractA', bbox: [2, 2, 2, 3, 3, 3], voxels: 1, byteOffset: 0, byteLength: 1 },
      { id: 'TractB_mni', name: 'TractB', bbox: [6, 2, 2, 7, 3, 3], voxels: 1, byteOffset: 1, byteLength: 1 },
    ],
  });
  const metaBytes = new TextEncoder().encode(meta);
  const raw = new Uint8Array(4 + metaBytes.length + 2);
  new DataView(raw.buffer).setUint32(0, metaBytes.length, true);
  raw.set(metaBytes, 4);
  raw[4 + metaBytes.length] = 1;
  raw[4 + metaBytes.length + 1] = 1;

  const pack = parseBcbTractsPack(raw);
  const tumour = new Uint8Array(512);
  tumour[voxelIndex(2, 2, 2, dims)] = 1;
  const res = computeSubcorticalTracts(tumour, dims, pack);
  assert.equal(res.overlapping.length, 1);
  assert.equal(res.overlapping[0].name, 'TractA');
  assert.equal(res.overlapping[0].overlapPct, 100);
  assert.equal(res.overlapping[0].minDistanceMm, 0);
  assert.equal(res.nearby.length, 1);
  assert.equal(res.nearby[0].name, 'TractB');
  assert.equal(res.nearby[0].minDistanceMm, 4);
});

test('normalizeToMniWithGreedy succeeds on sheared NIfTIs by orthogonalizing the cropped mask at native spacing', async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('@neurodesk/greedy/wasm-single').replace(/\.js$/, '_bg.wasm');
  await initGreedy({ module_or_path: readFileSync(wasmPath) });

  const dims = [32, 32, 32];
  const fixedData = new Float32Array(dims[0] * dims[1] * dims[2]);
  const brain = new Uint8Array(fixedData.length);
  const tumour = new Uint8Array(fixedData.length);
  for (let z = 6; z < 26; z++) {
    for (let y = 6; y < 26; y++) {
      for (let x = 6; x < 26; x++) {
        const r2 = (x - 16) ** 2 + (y - 16) ** 2 + (z - 16) ** 2;
        if (r2 < 100) {
          const idx = voxelIndex(x, y, z, dims);
          fixedData[idx] = 100 - r2;
          brain[idx] = 1;
        }
      }
    }
  }
  for (let z = 14; z < 18; z++) {
    for (let y = 14; y < 18; y++) {
      for (let x = 14; x < 18; x++) tumour[voxelIndex(x, y, z, dims)] = 1;
    }
  }

  const fixedBytes = new Uint8Array(writeVolume({
    data: fixedData,
    dims,
    affine: [[1, 0, 0, -16], [0, 1, 0, -16], [0, 0, 1, -16], [0, 0, 0, 1]],
  }));
  const shearedAffine = [[1, 0.25, 0, -16], [0, 1, 0, -16], [0, 0, 1, -16], [0, 0, 0, 1]];

  const prepared = prepareRegistrationInputsRas({ data: fixedData, dims, affine: shearedAffine }, brain, tumour);
  assert.equal(prepared.mask.affine[0][1], 0, 'sheared moving mask is resampled to orthogonal RAS grid');

  const res = await normalizeToMniWithGreedy({
    volume: { data: fixedData, dims, affine: shearedAffine },
    brainMask: brain,
    tumourMask: tumour,
    mniTemplateBytes: fixedBytes,
    greedyApi,
  });
  assert.ok(res.mniVoxels >= 48, `expected non-empty MNI mask for sheared scan, got ${res.mniVoxels}`);
});

test('prepareRegistrationInputsRas preserves every focus including a 1-voxel focus under rotation and shear', () => {
  const dims = [24, 24, 24];
  const rad15 = (15 * Math.PI) / 180;
  const c = Math.cos(rad15);
  const s = Math.sin(rad15);
  const affine = [
    [0.5 * c, -0.5 * s + 0.02, 0, 0],
    [0.5 * s, 0.5 * c, 0, 0],
    [0, 0, 0.5, 0],
    [0, 0, 0, 1],
  ];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]).fill(50);
  const brain = new Uint8Array(data.length);
  for (let z = 2; z < 22; z++) {
    for (let y = 2; y < 22; y++) {
      for (let x = 2; x < 22; x++) brain[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  // Single-voxel focus at (12, 12, 12) alone must survive orthogonalization.
  const single = new Uint8Array(data.length);
  single[voxelIndex(12, 12, 12, dims)] = 1;
  const prepSingle = prepareRegistrationInputsRas({ data, dims, affine }, brain, single);
  assert.equal(labelComponents26(prepSingle.mask.data, prepSingle.mask.dims).count, 1);

  // With a second focus present, BOTH distinct foci must survive orthogonalization.
  const twoFoci = Uint8Array.from(single);
  for (let z = 4; z < 7; z++) {
    for (let y = 4; y < 7; y++) {
      for (let x = 4; x < 7; x++) twoFoci[voxelIndex(x, y, z, dims)] = 1;
    }
  }
  const prepTwo = prepareRegistrationInputsRas({ data, dims, affine }, brain, twoFoci);
  assert.equal(labelComponents26(prepTwo.mask.data, prepTwo.mask.dims).count, 2);

  // Close singleton foci at (5,5,5) and (4,7,5) under 0.5 mm spacing, 45 deg rotation, and 0.4 shear:
  // per-component coverage tracking must keep both foci separated rather than collapsing onto one.
  const closeDims = [12, 12, 12];
  const rad45 = Math.PI / 4;
  const c45 = Math.cos(rad45);
  const s45 = Math.sin(rad45);
  const closeAffine = [
    [0.5 * c45, -0.5 * s45 + 0.4, 0, 0],
    [0.5 * s45, 0.5 * c45, 0, 0],
    [0, 0, 0.5, 0],
    [0, 0, 0, 1],
  ];
  const closeData = new Float32Array(12 * 12 * 12).fill(50);
  const closeBrain = new Uint8Array(closeData.length);
  for (let z = 2; z < 10; z++) {
    for (let y = 2; y < 10; y++) {
      for (let x = 2; x < 10; x++) closeBrain[voxelIndex(x, y, z, closeDims)] = 1;
    }
  }
  const closeTumour = new Uint8Array(closeData.length);
  closeTumour[voxelIndex(5, 5, 5, closeDims)] = 1;
  closeTumour[voxelIndex(4, 7, 5, closeDims)] = 1;
  const prepClose = prepareRegistrationInputsRas({ data: closeData, dims: closeDims, affine: closeAffine }, closeBrain, closeTumour);
  assert.equal(labelComponents26(prepClose.mask.data, prepClose.mask.dims).count, 2);

  // Adding a distant 3rd focus on a 70^3 grid must still preserve all 3 foci within the voxel budget
  // (refining only sheared axes so un-sheared Z keeps native resolution).
  const bigDims = [70, 70, 70];
  const bigData = new Float32Array(70 * 70 * 70).fill(50);
  const bigBrain = new Uint8Array(bigData.length);
  for (let z = 2; z < 68; z++) {
    for (let y = 2; y < 68; y++) {
      for (let x = 2; x < 68; x++) bigBrain[voxelIndex(x, y, z, bigDims)] = 1;
    }
  }
  const bigTumour = new Uint8Array(bigData.length);
  bigTumour[voxelIndex(5, 5, 5, bigDims)] = 1;
  bigTumour[voxelIndex(4, 7, 5, bigDims)] = 1;
  bigTumour[voxelIndex(67, 67, 67, bigDims)] = 1;
  const prepBig = prepareRegistrationInputsRas({ data: bigData, dims: bigDims, affine: closeAffine }, bigBrain, bigTumour);
  assert.equal(labelComponents26(prepBig.mask.data, prepBig.mask.dims).count, 3);

  // Diagonal 26-connected pair (5,5,5) and (4,4,5) under 1 mm, 10 deg rotation, and 0.1 shear
  // forms one native focus and must NOT be split into two components.
  const rad10 = (10 * Math.PI) / 180;
  const c10 = Math.cos(rad10);
  const s10 = Math.sin(rad10);
  const diagAffine = [
    [c10, -s10 + 0.1, 0, 0],
    [s10, c10, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const diagTumour = new Uint8Array(closeData.length);
  diagTumour[voxelIndex(5, 5, 5, closeDims)] = 1;
  diagTumour[voxelIndex(4, 4, 5, closeDims)] = 1;
  const prepDiag = prepareRegistrationInputsRas({ data: closeData, dims: closeDims, affine: diagAffine }, closeBrain, diagTumour);
  assert.equal(labelComponents26(prepDiag.mask.data, prepDiag.mask.dims).count, 1);
});
