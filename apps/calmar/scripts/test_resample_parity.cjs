#!/usr/bin/env node
// Roundtrip parity test for resample.js under realistic LNM grids.
//
// Phase 6 chains [Yeo-grid manual mask] -> overlap, OR
// [native lesion -> warp -> MNI160 1mm -> resample -> Yeo grid]. Both
// branches feed the same overlap reducer, so the math has to be lossless
// up to the resample step.
//
// This test simulates the second branch with synthetic but realistic
// affines:
//   - Yeo7 grid: 99x117x95 @ 2mm, origin (-98, -134, -72) (FSL MNI152
//     2mm convention).
//   - MNI160 1mm grid: 160x160x192 @ 1mm, origin (-80, -80, -96)
//     (centered).
//
// We place a 6x6x6 lesion cube at a known location in the Yeo grid,
// resample Yeo -> MNI160 1mm (nearest), then back MNI160 -> Yeo
// (nearest), and assert the recovered mask equals the original within a
// small Dice loss (not bit-identical: nearest-neighbor over different
// physical grids drops a small fraction of border voxels).

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/resample.js')
  );
  const { resampleAffine } = await import(moduleUrl);

  const yeoDims = [99, 117, 95];
  const yeoAffine = [
    [2, 0, 0, -98],
    [0, 2, 0, -134],
    [0, 0, 2, -72],
    [0, 0, 0, 1]
  ];
  const mniDims = [160, 160, 192];
  const mniAffine = [
    [1, 0, 0, -80],
    [0, 1, 0, -80],
    [0, 0, 1, -96],
    [0, 0, 0, 1]
  ];

  // Place a 6x6x6 cube at Yeo voxel (50, 60, 50) -> world coord (2,
  // -14, 28). Should map to MNI voxel (82, 66, 124), which is in-bounds.
  const yeoMask = new Uint8Array(yeoDims[0] * yeoDims[1] * yeoDims[2]);
  const cubeOrigin = [50, 60, 50];
  for (let dz = 0; dz < 6; dz++)
    for (let dy = 0; dy < 6; dy++)
      for (let dx = 0; dx < 6; dx++) {
        const x = cubeOrigin[0] + dx;
        const y = cubeOrigin[1] + dy;
        const z = cubeOrigin[2] + dz;
        yeoMask[x + y * yeoDims[0] + z * yeoDims[0] * yeoDims[1]] = 1;
      }
  let yeoCount = 0;
  for (let i = 0; i < yeoMask.length; i++) yeoCount += yeoMask[i];
  assert.equal(yeoCount, 216, 'phantom must be 216 voxels');

  // Forward: Yeo -> MNI160 1mm. The 2mm cube spans 12mm; on a 1mm grid
  // the resampled cube should approach 12^3 = 1728 voxels for a true
  // continuous cube, but nearest-neighbor sampling from a sparse 6^3
  // source loses corners — we expect roughly the cube volume.
  const mniMask = resampleAffine(yeoMask, yeoDims, yeoAffine,
    mniDims, mniAffine, 'nearest');
  let mniCount = 0;
  for (let i = 0; i < mniMask.length; i++) mniCount += mniMask[i];
  assert.ok(mniCount >= 1500 && mniCount <= 2000,
    `forward resample: expected ~1700 MNI voxels, got ${mniCount}`);

  // Backward: MNI160 1mm -> Yeo grid. For an aligned-grid roundtrip with
  // nearest-neighbour resampling on a 2x downsample-then-upsample chain,
  // the Dice should be 1.0 — the math is bit-exact under these grids.
  // Earlier this gate was 0.95 (loose); tightened to require exact
  // recovery so a regression that drops a single voxel surfaces.
  const recovered = resampleAffine(mniMask, mniDims, mniAffine,
    yeoDims, yeoAffine, 'nearest');
  let intersect = 0, union = 0;
  for (let i = 0; i < yeoMask.length; i++) {
    const a = yeoMask[i] === 1;
    const b = recovered[i] === 1;
    if (a && b) intersect++;
    if (a || b) union++;
  }
  const dice = (2 * intersect) / ((intersect + (yeoCount - intersect)) +
    (intersect + (union - yeoCount)));
  assert.equal(dice, 1.0,
    `roundtrip Dice must be exactly 1.0 for an aligned-grid 2x ` +
    `nearest-neighbour roundtrip; got ${dice.toFixed(6)} ` +
    `(intersect=${intersect}, recovered_count=${
      Array.from(recovered).reduce((a, b) => a + b, 0)
    })`);

  // Also assert the recovered cube is centered on the same Yeo voxel
  // (i.e. world-coord round-trip didn't drift).
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (let z = 0; z < yeoDims[2]; z++)
    for (let y = 0; y < yeoDims[1]; y++)
      for (let x = 0; x < yeoDims[0]; x++) {
        if (recovered[x + y * yeoDims[0] + z * yeoDims[0] * yeoDims[1]] === 1) {
          cx += x; cy += y; cz += z; n++;
        }
      }
  cx /= n; cy /= n; cz /= n;
  // Original cube centroid: 50 + 2.5 = 52.5 etc.
  const expected = [cubeOrigin[0] + 2.5, cubeOrigin[1] + 2.5, cubeOrigin[2] + 2.5];
  assert.ok(Math.abs(cx - expected[0]) < 1.0,
    `centroid x drift: ${cx} vs ${expected[0]}`);
  assert.ok(Math.abs(cy - expected[1]) < 1.0,
    `centroid y drift: ${cy} vs ${expected[1]}`);
  assert.ok(Math.abs(cz - expected[2]) < 1.0,
    `centroid z drift: ${cz} vs ${expected[2]}`);

  console.log(
    `resample-parity OK: forward count ${mniCount}/MNI, recovered ${n}/Yeo, ` +
    `Dice=${dice.toFixed(4)}, centroid drift < 1 voxel.`
  );
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
