#!/usr/bin/env node
// Pure-JS tests for the registration helpers in
// web/js/modules/registration.js. The math here replaces the three
// SynthMorph layers we cut from the ONNX export (VecInt scaling-and-
// squaring, RescaleTransform half->full upsample, SpatialTransformer
// warp); these unit tests pin the invariants so any port-side regression
// surfaces here, not in browser inference.
//
// Conventions:
//   - Volume layout: F-order Float32Array, idx(x,y,z) = x + y*X + z*X*Y.
//     Matches NIfTI / our existing volume-utils.
//   - Displacement-field layout: row-major (TF-style NDHWC channel-last)
//     because that's what the SynthMorph ONNX emits. Each voxel carries
//     three floats `[d_x, d_y, d_z]`. idx(x,y,z,c) = ((x*Y + y)*Z + z)*3 + c.
//     Stays consistent across upsample + integrate + warp.
//   - SVF channel-c semantics: voxel-coordinate displacement along axis c
//     of the SAME tensor (channel 0 = displacement along x, etc.). Matches
//     voxelmorph's `transform(vec, vec)` convention.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/registration.js')
  );
  const {
    integrateSvf,
    upsampleDisplacementField,
    displacementMagnitudeField,
    warpVolume,
    inverseWarpVolume
  } = await import(moduleUrl);

  function dispIdx(dims, x, y, z, c) {
    const [, Y, Z] = dims;
    return ((x * Y + y) * Z + z) * 3 + c;
  }
  function fIdx(dims, x, y, z) {
    const [X, Y] = dims;
    return x + y * X + z * X * Y;
  }
  function constField(dims, dx, dy, dz) {
    const [X, Y, Z] = dims;
    const out = new Float32Array(X * Y * Z * 3);
    for (let z = 0; z < Z; z++)
      for (let y = 0; y < Y; y++)
        for (let x = 0; x < X; x++) {
          const i = ((x * Y + y) * Z + z) * 3;
          out[i] = dx; out[i + 1] = dy; out[i + 2] = dz;
        }
    return out;
  }

  // ---- integrateSvf ----

  // (1) zero SVF integrates to zero displacement.
  {
    const dims = [4, 4, 4];
    const svf = new Float32Array(4 * 4 * 4 * 3);
    const disp = integrateSvf(svf, dims, 7);
    for (let i = 0; i < disp.length; i++) {
      assert.equal(disp[i], 0, `zero SVF must yield zero displacement at i=${i}`);
    }
  }

  // (2) constant SVF integrates to (approximately) the same constant in the
  //     interior. With nb_steps=N, the iterative composition for a constant
  //     field gives:
  //       disp_k = 2^k * const / 2^N
  //     after N steps -> disp = const. Edge voxels diverge under clamp-to-
  //     border sampling, so check only the interior.
  {
    const dims = [16, 16, 16];
    const C_X = 0.7, C_Y = -0.5, C_Z = 0.3;
    const svf = constField(dims, C_X, C_Y, C_Z);
    const disp = integrateSvf(svf, dims, 7);
    let maxErr = 0;
    for (let z = 4; z < 12; z++)
      for (let y = 4; y < 12; y++)
        for (let x = 4; x < 12; x++) {
          const i = ((x * 16 + y) * 16 + z) * 3;
          maxErr = Math.max(maxErr,
            Math.abs(disp[i] - C_X), Math.abs(disp[i + 1] - C_Y), Math.abs(disp[i + 2] - C_Z));
        }
    assert.ok(maxErr < 1e-3,
      `constant SVF interior should integrate to itself; max err = ${maxErr}`);
  }

  // (3) integrateSvf is non-mutating: input SVF is unchanged.
  {
    const dims = [4, 4, 4];
    const svf = constField(dims, 0.1, 0.2, 0.3);
    const snapshot = Float32Array.from(svf);
    integrateSvf(svf, dims, 5);
    for (let i = 0; i < svf.length; i++) {
      assert.equal(svf[i], snapshot[i], 'input SVF must not be mutated');
    }
  }

  // ---- upsampleDisplacementField (half -> full, with x2 scaling) ----

  // (4) constant half-res displacement [1, 2, 3] -> constant full-res [2, 4, 6].
  //     The x2 scaling converts half-grid voxel units to full-grid voxel
  //     units (one half-voxel == two full-voxels of motion).
  {
    const halfDims = [4, 4, 4];
    const fullDims = [8, 8, 8];
    const half = constField(halfDims, 1, 2, 3);
    const full = upsampleDisplacementField(half, halfDims, fullDims);
    assert.equal(full.length, 8 * 8 * 8 * 3);
    let maxErr = 0;
    // Check interior voxels (away from extrapolation at the far edge).
    for (let z = 1; z < 7; z++)
      for (let y = 1; y < 7; y++)
        for (let x = 1; x < 7; x++) {
          const i = ((x * 8 + y) * 8 + z) * 3;
          maxErr = Math.max(maxErr,
            Math.abs(full[i] - 2), Math.abs(full[i + 1] - 4), Math.abs(full[i + 2] - 6));
        }
    assert.ok(maxErr < 1e-5,
      `constant upsample with x2 scaling must be exact in the interior; max err = ${maxErr}`);
  }

  // (5) Linear ramp on x axis: half-res displacement = [x_half, 0, 0]
  //     where x_half ranges 0..3 across a 4-wide grid. After x2 scaling it
  //     should be [2*x_half, 0, 0] = [0, 2, 4, 6] across the half grid.
  //     Trilinear-upsampled to 8 voxels: at full-grid x=2 (center between
  //     half x=0 and x=1), value = (0 + 2)/2 = 1 in half-units -> 2 in
  //     full-units. We just check monotonicity + endpoints.
  {
    const halfDims = [4, 4, 4];
    const fullDims = [8, 8, 8];
    const half = new Float32Array(4 * 4 * 4 * 3);
    for (let z = 0; z < 4; z++)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++) {
          half[((x * 4 + y) * 4 + z) * 3 + 0] = x;
        }
    const full = upsampleDisplacementField(half, halfDims, fullDims);
    // Monotonicity along x at fixed (y, z).
    let prev = -Infinity;
    for (let x = 0; x < 8; x++) {
      const v = full[((x * 8 + 4) * 8 + 4) * 3 + 0];
      assert.ok(v >= prev - 1e-6, `displacement must be monotonic in x; v[${x}] = ${v}, prev = ${prev}`);
      prev = v;
    }
    // Endpoint values under pixel-centers-aligned mapping
    // (src=dst*(sN-1)/(dN-1)): full x=0 hits src x=0 (val 0, scaled to 0);
    // full x=7 hits src x=3 (val 3, scaled to 6).
    const v0 = full[((0 * 8 + 4) * 8 + 4) * 3 + 0];
    const v7 = full[((7 * 8 + 4) * 8 + 4) * 3 + 0];
    assert.ok(Math.abs(v0 - 0) < 1e-3, `left endpoint should be ~0, got ${v0}`);
    assert.ok(Math.abs(v7 - 6) < 1e-3, `right endpoint should be ~6, got ${v7}`);
  }

  // ---- warpVolume ----

  // (6) Identity displacement: warpVolume returns the input bit-equivalent.
  {
    const dims = [6, 6, 6];
    const vol = new Float32Array(6 * 6 * 6);
    for (let i = 0; i < vol.length; i++) vol[i] = i + 1;   // unique values
    const zeroDisp = new Float32Array(6 * 6 * 6 * 3);
    const out = warpVolume(vol, dims, zeroDisp, dims);
    for (let i = 0; i < vol.length; i++) {
      assert.ok(Math.abs(out[i] - vol[i]) < 1e-6,
        `identity warp must reproduce input; idx ${i}: ${out[i]} vs ${vol[i]}`);
    }
  }

  // (7) Constant displacement of (+2, 0, 0): output[x,y,z] = vol[x+2, y, z].
  //     Voxels for which x+2 falls outside the input become 0
  //     (zero-pad for out-of-bounds samples on a scalar volume).
  {
    const dims = [6, 6, 6];
    const vol = new Float32Array(6 * 6 * 6);
    for (let z = 0; z < 6; z++)
      for (let y = 0; y < 6; y++)
        for (let x = 0; x < 6; x++) {
          vol[x + y * 6 + z * 36] = x;   // ramp on x
        }
    const disp = constField(dims, 2, 0, 0);
    const out = warpVolume(vol, dims, disp, dims);
    // Interior: out[x, y, z] = vol[x+2, y, z] = x+2 for x ∈ [0, 3].
    for (let z = 1; z < 5; z++)
      for (let y = 1; y < 5; y++)
        for (let x = 0; x < 4; x++) {
          const expected = x + 2;
          const got = out[x + y * 6 + z * 36];
          assert.ok(Math.abs(got - expected) < 1e-5,
            `constant +2 shift on x: expected ${expected} at (${x},${y},${z}), got ${got}`);
        }
    // Out-of-bounds samples (x ∈ {4, 5} -> sample at x+2 ∈ {6, 7} outside) -> 0.
    for (let z = 1; z < 5; z++)
      for (let y = 1; y < 5; y++) {
        for (const x of [4, 5]) {
          const got = out[x + y * 6 + z * 36];
          assert.ok(Math.abs(got - 0) < 1e-5,
            `out-of-bounds samples should be 0; (${x},${y},${z}) got ${got}`);
        }
      }
  }

  // (8) warpVolume on a half-res displacement field that gets upsampled
  //     first, end-to-end. Identity SVF -> identity warp.
  {
    const halfDims = [4, 4, 4];
    const fullDims = [8, 8, 8];
    const halfDisp = new Float32Array(4 * 4 * 4 * 3);    // zero half-res field
    const fullDisp = upsampleDisplacementField(halfDisp, halfDims, fullDims);
    const vol = new Float32Array(8 * 8 * 8);
    for (let i = 0; i < vol.length; i++) vol[i] = (i + 1) * 0.7;
    const out = warpVolume(vol, fullDims, fullDisp, fullDims);
    for (let i = 0; i < vol.length; i++) {
      assert.ok(Math.abs(out[i] - vol[i]) < 1e-5,
        `zero-SVF -> identity warp at idx ${i}: ${out[i]} vs ${vol[i]}`);
    }
  }

  // ---- inverseWarpVolume ----

  // (9) Identity displacement: inverseWarpVolume returns the input.
  {
    const dims = [6, 6, 6];
    const vol = new Float32Array(6 * 6 * 6);
    for (let i = 0; i < vol.length; i++) vol[i] = i + 1;
    const zeroDisp = new Float32Array(6 * 6 * 6 * 3);
    const out = inverseWarpVolume(vol, dims, zeroDisp, dims, { mode: 'nearest' });
    for (let i = 0; i < vol.length; i++) {
      assert.ok(Math.abs(out[i] - vol[i]) < 1e-6,
        `identity inverse warp must reproduce input; idx ${i}: ${out[i]} vs ${vol[i]}`);
    }
  }

  // (10) Constant forward displacement of (+2, 0, 0) maps source x=3 to
  //      target x=1. Inverse warp must bring a target-space mask at x=1
  //      back to source x=3.
  {
    const dims = [6, 6, 6];
    const target = new Float32Array(6 * 6 * 6);
    target[fIdx(dims, 1, 3, 3)] = 1;
    const disp = constField(dims, 2, 0, 0);
    const out = inverseWarpVolume(target, dims, disp, dims, {
      mode: 'nearest',
      iterations: 4
    });
    assert.equal(out[fIdx(dims, 3, 3, 3)], 1,
      'inverse warp must recover the source-space voxel for a constant translation');
    assert.equal(out[fIdx(dims, 1, 3, 3)], 0,
      'target-space location should not remain at the unprojected coordinate');
  }

  // (11) Displacement magnitude map is F-order and Euclidean per voxel.
  {
    const dims = [2, 1, 1];
    const disp = new Float32Array(dims[0] * dims[1] * dims[2] * 3);
    disp[dispIdx(dims, 0, 0, 0, 0)] = 3;
    disp[dispIdx(dims, 0, 0, 0, 1)] = 4;
    disp[dispIdx(dims, 1, 0, 0, 2)] = 12;
    const mag = displacementMagnitudeField(disp, dims);
    assert.equal(mag[fIdx(dims, 0, 0, 0)], 5,
      'magnitude must use sqrt(dx^2 + dy^2 + dz^2)');
    assert.equal(mag[fIdx(dims, 1, 0, 0)], 12,
      'magnitude output must use F-order voxel indexing');
  }

  console.log('registration helpers OK: 11 cases (integrate, upsample, warp, inverse-warp, magnitude).');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
