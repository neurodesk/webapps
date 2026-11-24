import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCorticalOverlap,
  computeLaterality,
  computeResectability,
  computeSubcorticalTracts,
  parseBcbTractsPack,
  squaredEdt3d,
} from '../src/rads.js';
import { voxelIndex } from '../src/preprocess.js';

test('computeLaterality matches Raidionics convention (1=right, 2=left, midline crossing)', () => {
  const lat = new Uint8Array([1, 1, 2, 2, 0]);
  const rightOnly = computeLaterality(new Uint8Array([1, 1, 0, 0, 0]), lat);
  assert.deepEqual(rightOnly, { leftPct: 0, rightPct: 100, midlineCrossing: false });

  const bilateral = computeLaterality(new Uint8Array([1, 0, 1, 1, 0]), lat);
  assert.equal(bilateral.leftPct, 66.67);
  assert.equal(bilateral.rightPct, 33.33);
  assert.equal(bilateral.midlineCrossing, true);
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
