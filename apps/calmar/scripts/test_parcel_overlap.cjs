#!/usr/bin/env node
// Tests the pure-JS parcel-overlap reducer used by the LNM pipeline. Given a
// binary lesion mask and an integer-labelled parcellation atlas (both on the
// same MNI grid), computeParcelOverlap must return one entry per non-zero
// label with voxel counts and fractional overlaps.
//
// This test is the contract for web/js/modules/parcel-overlap.js. Written
// before the implementation per the project's TDD policy.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/parcel-overlap.js')
  );
  const { computeParcelOverlap, summarizeNetworkOverlap } = await import(moduleUrl);

  // ---- Case 1: 4x4x4 phantom, 3 parcels, lesion straddling parcels 1+2 ----
  // Atlas layout (z=0 plane only; z=1..3 are zeros):
  //   labels = [1,1,2,2; 1,1,2,2; 0,0,3,3; 0,0,3,3]  (row-major, x fast)
  // Lesion (z=0): a 2x2 block in the top-left corner -> all parcel 1.
  // Plus 1 voxel in (x=2,y=0,z=0) -> parcel 2.
  const dims = [4, 4, 4];
  const N = dims[0] * dims[1] * dims[2];
  const atlas = new Int16Array(N);
  // z=0 plane only; rest stay 0 (background).
  const idx = (x, y, z) => x + dims[0] * (y + dims[1] * z);
  const z0 = 0;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      let label;
      if (y < 2 && x < 2) label = 1;
      else if (y < 2 && x >= 2) label = 2;
      else if (y >= 2 && x < 2) label = 0;
      else label = 3;
      atlas[idx(x, y, z0)] = label;
    }
  }
  // Lesion: 2x2 in top-left at z=0 (parcel 1, 4 voxels) + 1 voxel at (2,0,0) (parcel 2).
  const lesion = new Uint8Array(N);
  lesion[idx(0, 0, 0)] = 1;
  lesion[idx(1, 0, 0)] = 1;
  lesion[idx(0, 1, 0)] = 1;
  lesion[idx(1, 1, 0)] = 1;
  lesion[idx(2, 0, 0)] = 1;

  // Parcel sizes: parcel 1 = 4, parcel 2 = 4, parcel 3 = 4 (each occupies 4 voxels at z=0).
  const result = computeParcelOverlap({ lesion, atlas, dims });

  assert.ok(Array.isArray(result.parcels), 'result.parcels must be an array');
  assert.equal(result.totalLesionVoxels, 5, 'totalLesionVoxels');
  // All 5 lesion voxels in case 1 sit on labelled parcels at z=0.
  assert.equal(result.voxelsOutsideAtlas, 0,
    'no voxelsOutsideAtlas when lesion is fully inside the atlas');
  // Background (label 0) must NOT appear in parcels[].
  assert.ok(
    !result.parcels.some(p => p.label === 0),
    'background label 0 must not appear in parcels[]'
  );

  const byLabel = Object.fromEntries(result.parcels.map(p => [p.label, p]));
  assert.equal(byLabel[1]?.voxelsInLesion, 4, 'parcel 1 voxelsInLesion');
  assert.equal(byLabel[1]?.parcelSize, 4, 'parcel 1 parcelSize');
  assert.equal(byLabel[1]?.fractionOfParcel, 1.0, 'parcel 1 fully damaged');
  assert.equal(byLabel[1]?.fractionOfLesion, 4 / 5, 'parcel 1 share of lesion');
  assert.equal(byLabel[2]?.voxelsInLesion, 1);
  assert.equal(byLabel[2]?.parcelSize, 4);
  assert.equal(byLabel[2]?.fractionOfParcel, 1 / 4);
  // Parcel 3 untouched -> must NOT appear (only nonzero overlaps are returned).
  assert.equal(byLabel[3], undefined, 'untouched parcels must be omitted');

  // ---- Case 2: dims mismatch must throw, not silently misindex ----
  assert.throws(
    () => computeParcelOverlap({
      lesion: new Uint8Array(8),
      atlas: new Int16Array(64),
      dims: [4, 4, 4]
    }),
    /size|length|dim/i,
    'mismatched lesion length must throw'
  );
  assert.throws(
    () => computeParcelOverlap({
      lesion: new Uint8Array(64),
      atlas: new Int16Array(8),
      dims: [4, 4, 4]
    }),
    /size|length|dim/i,
    'mismatched atlas length must throw'
  );

  // ---- Case 3: empty lesion returns empty parcels[] and totalLesionVoxels=0 ----
  const empty = computeParcelOverlap({
    lesion: new Uint8Array(N),
    atlas,
    dims
  });
  assert.equal(empty.totalLesionVoxels, 0);
  assert.equal(empty.voxelsOutsideAtlas, 0);
  assert.deepEqual(empty.parcels, []);

  // ---- Case 3b: lesion partially outside the atlas ----
  // Add 2 lesion voxels at z=1 (where the atlas is all-zero background).
  // Existing case-1 lesion stays in lesion[]; we re-run with extra voxels.
  const lesionPartialOutside = new Uint8Array(N);
  lesionPartialOutside.set(lesion);
  lesionPartialOutside[idx(0, 0, 1)] = 1;
  lesionPartialOutside[idx(0, 1, 1)] = 1;
  const partialOutside = computeParcelOverlap({
    lesion: lesionPartialOutside,
    atlas,
    dims
  });
  assert.equal(partialOutside.totalLesionVoxels, 7,
    'totalLesionVoxels counts every lesion voxel, in or out of the atlas');
  assert.equal(partialOutside.voxelsOutsideAtlas, 2,
    'voxelsOutsideAtlas counts lesion voxels where atlas label is 0');
  // Voxels inside the atlas remain unchanged from case 1.
  const partialByLabel = Object.fromEntries(partialOutside.parcels.map(p => [p.label, p]));
  assert.equal(partialByLabel[1]?.voxelsInLesion, 4);
  assert.equal(partialByLabel[2]?.voxelsInLesion, 1);
  // fractionOfLesion is over totalLesionVoxels (incl. outside), so 4/7 not 4/5.
  assert.equal(partialByLabel[1]?.fractionOfLesion, 4 / 7,
    'fractionOfLesion uses totalLesionVoxels (incl. outside-atlas voxels)');

  // ---- Case 4: summarizeNetworkOverlap aggregates parcels by network id ----
  // parcelToNetwork maps label -> network name. Yeo-style 7 networks.
  const parcelToNetwork = { 1: 'Default', 2: 'Default', 3: 'Visual' };
  const summary = summarizeNetworkOverlap(result, parcelToNetwork);
  // 4 lesion voxels in parcel 1 + 1 in parcel 2 -> Default = 5 voxels (100% of lesion).
  // Visual: 0 voxels.
  const byNet = Object.fromEntries(summary.networks.map(n => [n.network, n]));
  assert.equal(byNet.Default.voxelsInLesion, 5);
  assert.equal(byNet.Default.fractionOfLesion, 1.0);
  // Visual must either be absent or have zero voxels — both are valid; we
  // assert the absence-or-zero invariant rather than over-prescribing.
  assert.ok(!byNet.Visual || byNet.Visual.voxelsInLesion === 0);

  // ---- Case 5: a parcel without a network mapping is reported under 'Unassigned' ----
  const partialMap = { 1: 'Default' /* parcel 2 missing */ };
  const partial = summarizeNetworkOverlap(result, partialMap);
  const partialByNet = Object.fromEntries(partial.networks.map(n => [n.network, n]));
  assert.equal(partialByNet.Default.voxelsInLesion, 4);
  assert.equal(partialByNet.Unassigned.voxelsInLesion, 1);

  console.log('parcel-overlap OK: 6 cases (incl. outside-atlas counting).');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
