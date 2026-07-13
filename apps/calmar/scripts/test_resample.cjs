#!/usr/bin/env node
// Pure-JS tests for web/js/modules/resample.js. Pins:
//   - affineFromHeader: prefers sform when sform_code > 0, otherwise qform.
//   - invertAffine: 4x4 inversion (only invertible-affine cases used here).
//   - resampleAffine: per-dst-voxel world-coord lookup with nearest-neighbor
//     and trilinear modes; out-of-bounds samples are zero.
//
// Phase 6.1: this is the bridge from the MNI160 1mm warp output to the
// Yeo7 MNI2mm 99x117x95 grid. The orchestrator's `applyRegistrationToLesion`
// will compose `warpVolume(...)` (already in registration.js) with this
// resampler so the FC chain inherits a Yeo-aligned lesion.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/resample.js')
  );
  const { affineFromHeader, invertAffine, resampleAffine } = await import(moduleUrl);

  // ---- affineFromHeader: sform takes precedence ----
  // nifti-reader-js exposes sform via affine[3][.]; the header object also
  // carries scl_slope/scl_inter etc. We only fake the bits affineFromHeader
  // reads.
  {
    const sform = [
      [-2, 0, 0, 78],
      [0, 2, 0, -112],
      [0, 0, 2, -50],
      [0, 0, 0, 1]
    ];
    const fakeHeader = { sform_code: 1, qform_code: 0, affine: sform };
    const A = affineFromHeader(fakeHeader);
    assert.deepEqual(A, sform, 'sform_code>0 must yield the sform affine');
  }

  // qform fallback: nifti-reader-js exposes a qform in `header.affine` only
  // when sform_code is 0 — we mirror that contract.
  {
    const qform = [
      [-1, 0, 0, 90],
      [0, 1, 0, -126],
      [0, 0, 1, -72],
      [0, 0, 0, 1]
    ];
    const fakeHeader = { sform_code: 0, qform_code: 1, affine: qform };
    const A = affineFromHeader(fakeHeader);
    assert.deepEqual(A, qform, 'qform fallback when sform_code==0');
  }

  // ---- invertAffine: identity round-trip + simple scale/translate ----
  {
    const I = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const Iinv = invertAffine(I);
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++)
        assert.ok(Math.abs(Iinv[r][c] - I[r][c]) < 1e-9,
          `identity inverse [${r}][${c}] = ${Iinv[r][c]}`);
  }
  {
    const A = [
      [2, 0, 0, 1],
      [0, 2, 0, 2],
      [0, 0, 2, 3],
      [0, 0, 0, 1]
    ];
    const Ai = invertAffine(A);
    // A * Ai = I.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += A[r][k] * Ai[k][c];
        const expect = r === c ? 1 : 0;
        assert.ok(Math.abs(s - expect) < 1e-9,
          `A*Ai[${r}][${c}] = ${s}, expected ${expect}`);
      }
    }
  }

  // ---- resampleAffine: identity grids, nearest, lossless copy ----
  // src 4x4x4, identity affine; dst same. Output must equal input.
  {
    const dims = [4, 4, 4];
    const aff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const src = new Float32Array(64);
    for (let i = 0; i < 64; i++) src[i] = i;
    const out = resampleAffine(src, dims, aff, dims, aff, 'nearest');
    for (let i = 0; i < 64; i++) {
      assert.equal(out[i], src[i], `identity resample mismatch at ${i}`);
    }
  }

  // ---- resampleAffine: 2x downsample via affine, nearest ----
  // src is 4x4x4 with voxel (1mm); dst is 2x2x2 with voxel (2mm). Both
  // share origin. dst voxel (i,j,k) maps to src (2i, 2j, 2k).
  {
    const srcDims = [4, 4, 4];
    const srcAff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const dstDims = [2, 2, 2];
    const dstAff = [
      [2, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 1]
    ];
    // F-order: idx = x + y*X + z*X*Y.
    const src = new Float32Array(64);
    for (let z = 0; z < 4; z++)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          src[x + y * 4 + z * 16] = x + 10 * y + 100 * z;
    const out = resampleAffine(src, srcDims, srcAff, dstDims, dstAff, 'nearest');
    // dst (i,j,k) sampled at src (2i, 2j, 2k).
    for (let z = 0; z < 2; z++)
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) {
          const got = out[x + y * 2 + z * 4];
          const expect = (2 * x) + 10 * (2 * y) + 100 * (2 * z);
          assert.equal(got, expect,
            `dst(${x},${y},${z}) expect ${expect}, got ${got}`);
        }
  }

  // ---- resampleAffine: out-of-bounds samples are zero ----
  {
    const srcDims = [4, 4, 4];
    const srcAff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    // dst origin shifted by +5mm in x => dst voxel 0 maps to src x=5 (out of bounds).
    const dstDims = [2, 2, 2];
    const dstAff = [
      [1, 0, 0, 5],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const src = new Float32Array(64);
    src.fill(7);
    const out = resampleAffine(src, srcDims, srcAff, dstDims, dstAff, 'nearest');
    for (let i = 0; i < out.length; i++) {
      assert.equal(out[i], 0, `oob index ${i} must be 0, got ${out[i]}`);
    }
  }

  // ---- resampleAffine: trilinear midpoint between two voxels ----
  // src is a 4x1x1 ramp [0, 10, 20, 30]; dst samples at world coord 0.5
  // (midway between src x=0 and src x=1) -> 5.
  {
    const srcDims = [4, 1, 1];
    const srcAff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const src = new Float32Array([0, 10, 20, 30]);
    const dstDims = [1, 1, 1];
    const dstAff = [
      [1, 0, 0, 0.5],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const out = resampleAffine(src, srcDims, srcAff, dstDims, dstAff, 'trilinear');
    assert.ok(Math.abs(out[0] - 5) < 1e-6,
      `trilinear midpoint: expected 5, got ${out[0]}`);
  }

  // ---- resampleAffine: nearest preserves binary mask values ----
  {
    const srcDims = [3, 3, 3];
    const srcAff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const src = new Uint8Array(27);
    src[1 + 1 * 3 + 1 * 9] = 1;            // center voxel only
    const dstDims = [3, 3, 3];
    const dstAff = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const out = resampleAffine(src, srcDims, srcAff, dstDims, dstAff, 'nearest');
    for (let i = 0; i < 27; i++) {
      assert.equal(out[i], src[i], `binary copy mismatch at ${i}`);
    }
    // Output dtype matches input request: caller uses Uint8Array on ctor.
    assert.ok(out instanceof Float32Array || out instanceof Uint8Array,
      'resample output must be Float32Array or Uint8Array');
  }

  // ---- input validation ----
  {
    assert.throws(
      () => resampleAffine(new Float32Array(8), [2, 2, 2],
        [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
        [2, 2, 2],
        [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
        'lanczos'),
      /mode/i,
      'unknown mode must throw'
    );
    assert.throws(
      () => resampleAffine(new Float32Array(7), [2, 2, 2],
        [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
        [2, 2, 2],
        [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
        'nearest'),
      /size|length|dim/i,
      'src size mismatch must throw'
    );
  }

  console.log('resample OK: affineFromHeader + invertAffine + resampleAffine (5 cases) + validation.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
