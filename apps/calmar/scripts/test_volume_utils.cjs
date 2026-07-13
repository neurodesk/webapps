#!/usr/bin/env node
// Verifies the volume-utils port from neurodesk/vesselboost-webapp's
// inference-worker.js. Pure-JS, runs under node:test-style assertions.
//
// These helpers underpin the SynthStrip brain-extraction stage (Phase 2a.1)
// and the lesion-segmentation pipeline (Phase 2a.2). Behavior is pinned with
// synthetic phantoms so a regression in resampling, CC labelling, or hole
// filling surfaces here, not in browser smoke tests.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/volume-utils.js')
  );
  const {
    computeResampledDims,
    resampleVolume,
    resampleLabelsNearest,
    computeForegroundBBox,
    cropVolume,
    uncrop,
    connectedComponents3D,
    removeSmallComponents,
    keepLargestComponentAndFill,
    inverseOrient,
    inverseOrientFloat32,
    orientFloat32
  } = await import(moduleUrl);

  // ---- computeResampledDims ----
  assert.deepEqual(
    computeResampledDims([10, 12, 14], [1, 1, 1], [1, 1, 1]),
    [10, 12, 14],
    'identity scaling preserves dims'
  );
  assert.deepEqual(
    computeResampledDims([10, 12, 14], [1, 1, 1], [2, 2, 2]),
    [5, 6, 7],
    '1mm -> 2mm halves dims'
  );
  assert.deepEqual(
    computeResampledDims([5, 5, 5], [2, 2, 2], [1, 1, 1]),
    [10, 10, 10],
    '2mm -> 1mm doubles dims'
  );

  // ---- resampleVolume linear interp ----
  // 2x2x2 -> 4x4x4. Corner values stay; midpoints linearly interpolate.
  const cube222 = new Float32Array([
    0, 1, 2, 3,
    4, 5, 6, 7
  ]); // x fastest, y, z. Corners: cube222[(x,y,z)] -> see encoding.
  const up = resampleVolume(cube222, [2, 2, 2], [1, 1, 1], [0.5, 0.5, 0.5]);
  assert.deepEqual(up.dims, [4, 4, 4]);
  // x=0,y=0,z=0 corner: value 0 (matches input corner).
  assert.equal(up.data[0], 0, 'upsample preserves (0,0,0) corner');
  // x=3,y=3,z=3 corner: value 7 (matches opposite corner).
  assert.equal(up.data[3 + 3 * 4 + 3 * 16], 7, 'upsample preserves (n,n,n) corner');
  // Round-trip 2->4->2 reproduces the original within tolerance.
  const roundTrip = resampleVolume(up.data, up.dims, [0.5, 0.5, 0.5], [1, 1, 1]);
  assert.deepEqual(roundTrip.dims, [2, 2, 2]);
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(roundTrip.data[i] - cube222[i]) < 1e-5,
      `round-trip preserves index ${i}: ${roundTrip.data[i]} vs ${cube222[i]}`);
  }

  // ---- resampleLabelsNearest preserves discrete labels ----
  // 2x2x2 atlas with labels {0, 1, 2, 3, 4, 5, 6, 7}. 2 -> 4 nearest-neighbor.
  const labels222 = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const lblUp = resampleLabelsNearest(labels222, [2, 2, 2], [4, 4, 4]);
  assert.equal(lblUp.length, 64);
  // Every output voxel must hold one of the 8 input labels (no interpolation).
  const seen = new Set(Array.from(lblUp));
  for (const v of seen) {
    assert.ok([0, 1, 2, 3, 4, 5, 6, 7].includes(v),
      `nearest-neighbor must not invent label ${v}`);
  }

  // ---- computeForegroundBBox ----
  // 8x8x8 volume, foreground 4x4x4 cube at corner (2,3,1).
  const dims888 = [8, 8, 8];
  const fg = new Float32Array(8 * 8 * 8);
  for (let z = 1; z < 5; z++) {
    for (let y = 3; y < 7; y++) {
      for (let x = 2; x < 6; x++) {
        fg[x + y * 8 + z * 64] = 42;
      }
    }
  }
  const bbox = computeForegroundBBox(fg, dims888, 0);
  assert.deepEqual(bbox.origin, [2, 3, 1], 'bbox origin');
  assert.deepEqual(bbox.end, [6, 7, 5], 'bbox end (exclusive)');
  // With margin=2 and clamping at 0, origin shrinks but stops at 0.
  const bboxMargin = computeForegroundBBox(fg, dims888, 2);
  assert.deepEqual(bboxMargin.origin, [0, 1, 0]);
  assert.deepEqual(bboxMargin.end, [8, 8, 7]);
  // All-zero volume returns null.
  assert.equal(computeForegroundBBox(new Float32Array(64), [4, 4, 4], 0), null);

  // ---- cropVolume + uncrop round-trip ----
  // Crop the foreground 4x4x4 out and put it back; should restore the
  // foreground voxels exactly (uncrop into Uint8 so we cast).
  const cropped = cropVolume(fg, dims888, bbox);
  assert.deepEqual(cropped.dims, [4, 4, 4]);
  // Convert cropped Float32 to Uint8 for uncrop (uncrop writes Uint8).
  const croppedU8 = new Uint8Array(cropped.data.length);
  for (let i = 0; i < cropped.data.length; i++) {
    croppedU8[i] = cropped.data[i] !== 0 ? 1 : 0;
  }
  const placed = uncrop(croppedU8, [4, 4, 4], [8, 8, 8], bbox.origin);
  // Every fg voxel must be 1; the rest must be 0.
  let mismatches = 0;
  for (let i = 0; i < 8 * 8 * 8; i++) {
    const expected = fg[i] !== 0 ? 1 : 0;
    if (placed[i] !== expected) mismatches += 1;
  }
  assert.equal(mismatches, 0, 'crop+uncrop round-trip preserves foreground');

  // ---- connectedComponents3D ----
  // Empty -> 0.
  const emptyCC = connectedComponents3D(new Uint8Array(8), [2, 2, 2]);
  assert.equal(emptyCC.numComponents, 0);

  // Single voxel -> 1 component.
  const singleVoxel = new Uint8Array(8);
  singleVoxel[0] = 1;
  const singleCC = connectedComponents3D(singleVoxel, [2, 2, 2]);
  assert.equal(singleCC.numComponents, 1);
  assert.equal(singleCC.labels[0], 1);

  // Two disjoint voxels (corners of a 4x4x4) -> 2 components.
  const twoBlobs = new Uint8Array(64);
  twoBlobs[0] = 1;                    // (0,0,0)
  twoBlobs[3 + 3 * 4 + 3 * 16] = 1;   // (3,3,3) — too far for 26-conn
  const twoCC = connectedComponents3D(twoBlobs, [4, 4, 4]);
  assert.equal(twoCC.numComponents, 2);

  // Two voxels touching diagonally (26-conn) -> single component.
  const diagBlobs = new Uint8Array(64);
  diagBlobs[0] = 1;                   // (0,0,0)
  diagBlobs[1 + 1 * 4 + 1 * 16] = 1;  // (1,1,1) — diagonal neighbor
  const diagCC = connectedComponents3D(diagBlobs, [4, 4, 4]);
  assert.equal(diagCC.numComponents, 1, '26-connectivity merges diagonal touch');

  // ---- removeSmallComponents ----
  // 6x6x6 grid (large enough that a corner-singleton is 26-disconnected from
  // a corner-cube): a 8-voxel 2x2x2 cube at (0,0,0) + a single voxel at
  // (5,5,5). 26-connectivity step from (1,1,1) to (5,5,5) requires distance
  // > 1 on each axis -> disconnected.
  const dims6 = [6, 6, 6];
  const idx6 = (x, y, z) => x + y * 6 + z * 36;
  const mixed = new Uint8Array(216);
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++)
        mixed[idx6(x, y, z)] = 1;
  mixed[idx6(5, 5, 5)] = 1;
  const cleaned = removeSmallComponents(mixed, dims6, 2);
  let cleanedSum = 0;
  for (let i = 0; i < 216; i++) cleanedSum += cleaned[i];
  assert.equal(cleanedSum, 8, 'removeSmallComponents drops the singleton');

  // ---- keepLargestComponentAndFill ----
  // 6x6x6 grid: a 3x3x3 cube at (1,1,1)..(3,3,3) (FULLY INTERIOR — none of
  // its voxels touch the volume border), with a hole punched at its centre
  // (2,2,2). Plus a disconnected singleton at (5,5,5). Expect:
  //   - singleton removed (smaller CC)
  //   - interior hole filled
  //   - cube becomes solid 27 voxels
  const punched = new Uint8Array(216);
  for (let z = 1; z <= 3; z++)
    for (let y = 1; y <= 3; y++)
      for (let x = 1; x <= 3; x++)
        punched[idx6(x, y, z)] = 1;
  punched[idx6(2, 2, 2)] = 0;          // hole at the centre
  punched[idx6(5, 5, 5)] = 1;          // disconnected singleton

  const filled = keepLargestComponentAndFill(punched, dims6);
  assert.equal(filled[idx6(5, 5, 5)], 0, 'singleton removed');
  assert.equal(filled[idx6(2, 2, 2)], 1, 'interior hole filled');
  let cubeFilled = 0;
  for (let z = 1; z <= 3; z++)
    for (let y = 1; y <= 3; y++)
      for (let x = 1; x <= 3; x++)
        cubeFilled += filled[idx6(x, y, z)] ? 1 : 0;
  assert.equal(cubeFilled, 27, 'entire cube is solid after fill');

  // ---- inverseOrient (identity perm+flip is a no-op) ----
  const v8 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const back = inverseOrient(v8, [2, 2, 2], [0, 1, 2], [false, false, false], [2, 2, 2]);
  for (let i = 0; i < 8; i++) {
    assert.equal(back[i], v8[i], `inverseOrient identity: index ${i}`);
  }

  // inverseOrientFloat32 sanity check on the same identity.
  const f8 = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const fback = inverseOrientFloat32(
    f8, [2, 2, 2], [0, 1, 2], [false, false, false], [2, 2, 2]
  );
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(fback[i] - f8[i]) < 1e-7);
  }

  // orientFloat32 + its inverse on a non-trivial perm restores the original.
  // Use perm=[2,0,1] and flip=[false,true,false] on the 2x2x2 cube.
  const f8b = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const oriented = orientFloat32(f8b, [2, 2, 2], [2, 0, 1], [false, true, false]);
  const restored = inverseOrientFloat32(
    oriented.data, oriented.dims, [2, 0, 1], [false, true, false], [2, 2, 2]
  );
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(restored[i] - f8b[i]) < 1e-7,
      `orient round-trip index ${i}: ${restored[i]} vs ${f8b[i]}`);
  }

  console.log('volume-utils OK: 11 cases (resample, bbox, crop/uncrop, CC, fill, orient).');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
