#!/usr/bin/env node
// Pure-helper tests for web/js/modules/brain-extraction.js. The orchestration
// (runSynthStrip) is 1:1 ported from vesselboost-webapp's stepSynthStrip and
// is verified end-to-end via the Phase 2a.1.5 browser smoke; what's tested
// here are the discrete pure functions that compose it.
//
// Helpers under test:
//   computeFreeSurferTargetDims(cropDims) -> [tx, ty, tz]
//   centerPadConform(croppedData, cropDims, targetDims) -> { data, offsets }
//   uncenterUnpadMask(paddedMask, targetDims, cropDims, offsets) -> Uint8Array
//   p99Normalize(data) -> { data, vMin, p99 }   (returns a NEW Float32Array)
//   fortranToCOrder(data, dims) -> Float32Array
//   cOrderToFortran(data, dims) -> Float32Array
//   dilate3D(mask, dims, radius=1) -> Uint8Array
//   chooseFastTargetSpacing(data, dims, spacing) -> [sx, sy, sz]

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/brain-extraction.js')
  );
  const {
    computeFreeSurferTargetDims,
    centerPadConform,
    uncenterUnpadMask,
    p99Normalize,
    fortranToCOrder,
    cOrderToFortran,
    dilate3D,
    chooseFastTargetSpacing
  } = await import(moduleUrl);

  // ---- computeFreeSurferTargetDims ----
  // Rule: per-axis target = min(320, max(192, ceil(crop / 64) * 64))
  // FreeSurfer SynthStrip requires multiples of 64 between 192 and 320.
  assert.deepEqual(computeFreeSurferTargetDims([100, 100, 100]), [192, 192, 192],
    'tiny brain clamps up to 192');
  assert.deepEqual(computeFreeSurferTargetDims([192, 192, 192]), [192, 192, 192],
    'exact 192 stays at 192');
  assert.deepEqual(computeFreeSurferTargetDims([193, 200, 256]), [256, 256, 256],
    'each axis rounds up independently to next multiple of 64');
  assert.deepEqual(computeFreeSurferTargetDims([321, 200, 256]), [320, 256, 256],
    'oversized axis clamps down to 320 (nnU-Net constraint)');
  assert.deepEqual(computeFreeSurferTargetDims([180, 250, 290]), [192, 256, 320],
    'mixed sizes route to different target buckets');

  // ---- centerPadConform + uncenterUnpadMask round-trip ----
  // 4x4x4 cropped volume centred inside an 8x8x8 conformed volume.
  // Offsets must be floor((target - crop) / 2) per axis = (2,2,2).
  // Then putting a mask back through uncenterUnpadMask must restore the
  // original 4x4x4 region exactly.
  const cropDims = [4, 4, 4];
  const targetDims = [8, 8, 8];
  const cropped = new Float32Array(64);
  for (let i = 0; i < 64; i++) cropped[i] = (i + 1) * 0.1;   // dense, unique values
  const { data: conformed, offsets } = centerPadConform(cropped, cropDims, targetDims);
  assert.deepEqual(offsets, [2, 2, 2], 'center-pad offsets are floor((t-c)/2)');
  assert.equal(conformed.length, 8 * 8 * 8);

  // The 4x4x4 region inside the 8x8x8 conformed volume must equal `cropped`,
  // and everything outside must be 0.
  for (let z = 0; z < 8; z++) {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const inside = x >= 2 && x < 6 && y >= 2 && y < 6 && z >= 2 && z < 6;
        const v = conformed[x + y * 8 + z * 64];
        if (inside) {
          const cx = x - 2, cy = y - 2, cz = z - 2;
          const expected = cropped[cx + cy * 4 + cz * 16];
          assert.ok(Math.abs(v - expected) < 1e-7,
            `inside (${x},${y},${z}) expected ${expected}, got ${v}`);
        } else {
          assert.equal(v, 0, `outside (${x},${y},${z}) must be padding 0`);
        }
      }
    }
  }

  // Round-trip uncenterUnpadMask: synthesise a binary "mask" from the
  // conformed data (>0.4 -> 1, else 0), then uncenter+unpad must extract the
  // exact slice that came from `cropped`.
  const conformedMask = new Uint8Array(8 * 8 * 8);
  for (let i = 0; i < conformed.length; i++) conformedMask[i] = conformed[i] > 0.4 ? 1 : 0;
  const uncropped = uncenterUnpadMask(conformedMask, targetDims, cropDims, offsets);
  assert.equal(uncropped.length, 64);
  for (let i = 0; i < 64; i++) {
    const expected = cropped[i] > 0.4 ? 1 : 0;
    assert.equal(uncropped[i], expected,
      `round-trip index ${i}: expected ${expected}, got ${uncropped[i]}`);
  }

  // ---- p99Normalize ----
  // Constructed input: 100 voxels at value 5, 1 voxel at value 1000 (outlier).
  // After: subtract min (5) from all -> [0, 0, ..., 995]. p99 of nonzero =
  // floor(1 * 0.99) = 0 -> p99 = 995. So everything becomes 0/995 except the
  // outlier which becomes 1.
  // Edge case: all-zero input -> normalized stays zero (no division by zero).
  const flat = new Float32Array(101);
  for (let i = 0; i < 100; i++) flat[i] = 5;
  flat[100] = 1000;
  const { data: norm, vMin, p99 } = p99Normalize(flat);
  assert.equal(norm.length, 101);
  assert.equal(vMin, 5, 'vMin = 5');
  assert.equal(p99, 995, 'p99 = 995 (the only nonzero after subtracting min)');
  for (let i = 0; i < 100; i++) {
    assert.equal(norm[i], 0, `index ${i} must normalise to 0`);
  }
  assert.ok(Math.abs(norm[100] - 1.0) < 1e-7, 'outlier normalises to 1');
  // Non-mutation: source array is untouched.
  assert.equal(flat[0], 5, 'p99Normalize must NOT mutate its input');
  assert.equal(flat[100], 1000);

  // All-zero input -> p99 = 0, output is all zeros (safe divide).
  const zero = new Float32Array(8);
  const { data: znorm, p99: zp99 } = p99Normalize(zero);
  assert.ok(zp99 === 0 || zp99 === 1, 'all-zero p99 is 0 or 1 (safe-divide guard)');
  for (let i = 0; i < 8; i++) assert.equal(znorm[i], 0);

  // ---- fortranToCOrder + cOrderToFortran round-trip ----
  // For a NX=2, NY=3, NZ=4 volume (24 voxels), the F-order index is
  //   x + y*nx + z*nx*ny, and the C-order index used by SynthStrip's
  //   ONNX wrapper is x*ny*nz + y*nz + z. Verify the conversion is a
  //   true permutation by round-tripping a unique-value volume.
  const dims234 = [2, 3, 4];
  const f234 = new Float32Array(24);
  for (let i = 0; i < 24; i++) f234[i] = i + 1;     // 1..24, all unique
  const c234 = fortranToCOrder(f234, dims234);
  assert.equal(c234.length, 24);
  // Sanity: every value in f234 must appear exactly once in c234 (permutation).
  const sortF = Array.from(f234).slice().sort((a, b) => a - b);
  const sortC = Array.from(c234).slice().sort((a, b) => a - b);
  assert.deepEqual(sortC, sortF, 'F->C must be a permutation of values');
  const back = cOrderToFortran(c234, dims234);
  for (let i = 0; i < 24; i++) {
    assert.equal(back[i], f234[i], `F->C->F round-trip index ${i}`);
  }

  // Targeted index mapping: F-order (x=1, y=2, z=3) sits at index
  //   1 + 2*2 + 3*2*3 = 23 (last voxel). After F->C, that voxel must land
  //   at C-order index 1*3*4 + 2*4 + 3 = 23 too. Pick a non-corner instead:
  //   F (x=1, y=0, z=2): F-idx = 1 + 0 + 2*6 = 13. C-idx = 1*12 + 0 + 2 = 14.
  const fVal = f234[13];
  assert.equal(c234[14], fVal,
    'F-index 13 ((1,0,2) in 2x3x4) maps to C-index 14');

  // ---- dilate3D ----
  // 5x5x5 cube; place a single voxel in the centre and dilate by 1 (6-conn).
  // Result: centre + 6 face-neighbours = 7 voxels.
  const single = new Uint8Array(125);
  const idx5 = (x, y, z) => x + y * 5 + z * 25;
  single[idx5(2, 2, 2)] = 1;
  const dil = dilate3D(single, [5, 5, 5], 1);
  let count = 0;
  for (let i = 0; i < 125; i++) count += dil[i];
  assert.equal(count, 7, 'single voxel + 1-radius 6-conn dilation = 7 voxels');
  assert.equal(dil[idx5(2, 2, 2)], 1);
  assert.equal(dil[idx5(1, 2, 2)], 1);
  assert.equal(dil[idx5(3, 2, 2)], 1);
  assert.equal(dil[idx5(2, 1, 2)], 1);
  assert.equal(dil[idx5(2, 3, 2)], 1);
  assert.equal(dil[idx5(2, 2, 1)], 1);
  assert.equal(dil[idx5(2, 2, 3)], 1);
  // Diagonal neighbour must NOT light up (we use 6-conn, not 26-conn).
  assert.equal(dil[idx5(1, 1, 1)], 0, '6-conn dilation does NOT include diagonals');

  // Empty input stays empty.
  const empty = dilate3D(new Uint8Array(125), [5, 5, 5], 1);
  let emptySum = 0;
  for (let i = 0; i < 125; i++) emptySum += empty[i];
  assert.equal(emptySum, 0);

  // Radius 0 = no-op (returns input or a copy).
  const noop = dilate3D(single, [5, 5, 5], 0);
  let noopSum = 0;
  for (let i = 0; i < 125; i++) noopSum += noop[i];
  assert.equal(noopSum, 1, 'radius=0 dilation is identity');

  // ---- chooseFastTargetSpacing ----
  // Regression for the ds004884 1mm clinical T1: a blanket 2mm fast-mode
  // target made the SynthStrip mask visibly overgrown while still passing
  // broad "mask exists" checks. The adaptive rule should keep this foreground
  // crop in the 192^3 conform bucket by choosing ~1.06mm, not 2mm.
  const clinicalDims = [160, 256, 256];
  const clinical = new Float32Array(clinicalDims[0] * clinicalDims[1] * clinicalDims[2]);
  const clinicalIdx = (x, y, z) => x + y * clinicalDims[0] + z * clinicalDims[0] * clinicalDims[1];
  clinical[clinicalIdx(6, 38, 24)] = 1;
  clinical[clinicalIdx(153, 226, 226)] = 1;
  const clinicalSpacing = chooseFastTargetSpacing(clinical, clinicalDims, [1, 1, 1]);
  assert.ok(clinicalSpacing[0] > 1.05 && clinicalSpacing[0] < 1.08,
    `1mm clinical fast target should be ~1.06mm, got ${clinicalSpacing[0]}`);
  assert.deepEqual(clinicalSpacing, [clinicalSpacing[0], clinicalSpacing[0], clinicalSpacing[0]],
    'fast target spacing remains isotropic');

  // Already-2mm inputs must not be upsampled in fast mode.
  const mniDims = [99, 95, 117];
  const mni = new Float32Array(mniDims[0] * mniDims[1] * mniDims[2]);
  mni[0] = 1;
  mni[mni.length - 1] = 1;
  assert.deepEqual(chooseFastTargetSpacing(mni, mniDims, [2, 2, 2]), [2, 2, 2],
    '2mm input stays at native 2mm in fast mode');

  console.log('brain-extraction helpers OK: 8 helper groups, 35+ assertions.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
