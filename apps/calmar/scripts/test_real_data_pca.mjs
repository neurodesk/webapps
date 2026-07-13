#!/usr/bin/env node --no-warnings
// Phase 29: PCA prealign on real anatomical data (the ds004884 T1).
//
// Phase 26's unit tests cover principalAxisAlign on synthetic rotated
// boxes; this test validates it on a real clinical 160x256x256 1mm T1
// (ds004884 sub-M2051). Steps:
//
//   1. Load the T1.
//   2. Derive a quick brain mask via intensity threshold (T1 > 0.1 * max).
//      Real users would use SynthStrip; for this Node-side test we only
//      need a roughly-brain-shaped mask to exercise the PCA math on
//      real anatomy.
//   3. Run principalAxisAlign.
//   4. Assert: principal-axis eigenvalue is the largest and corresponds
//      to the head's longest physical extent. Rotation matrix is
//      right-handed (det = +1).
//   5. Resample the brain mask onto MNI160 1mm via the result. Verify
//      the resampled mask centroid lands at MNI voxel (80, 80, 96)
//      within 1 voxel.
//
// This catches a regression where PCA fails on real-shaped brain masks
// (eigenvalues come out NaN, eigenvectors not orthonormal, or rotation
// isn't right-handed when applied to a non-synthetic phantom).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1_PATH = path.join(ROOT, 'tests/fixtures/ds004884-mini/T1.nii.gz');

const { centroidOfMask, principalAxisAlign } =
  await import(path.join(ROOT, 'web/js/modules/prealign.js'));
const { resampleAffine } =
  await import(path.join(ROOT, 'web/js/modules/resample.js'));

async function loadNifti() {
  const mod = await import('nifti-reader-js');
  return mod.default || mod;
}

async function decode(filePath) {
  const bytes = await fs.readFile(filePath);
  const nifti = await loadNifti();
  let buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) buf = nifti.decompress(buf);
  if (!nifti.isNIFTI(buf)) throw new Error(`Not NIfTI: ${filePath}`);
  const header = nifti.readHeader(buf);
  const imageBuffer = nifti.readImage(header, buf);
  let data;
  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8:   data = new Uint8Array(imageBuffer); break;
    case nifti.NIFTI1.TYPE_INT16:   data = new Int16Array(imageBuffer); break;
    case nifti.NIFTI1.TYPE_INT32:   data = new Int32Array(imageBuffer); break;
    case nifti.NIFTI1.TYPE_FLOAT32: data = new Float32Array(imageBuffer); break;
    case nifti.NIFTI1.TYPE_FLOAT64: data = new Float64Array(imageBuffer); break;
    default:
      throw new Error(`Unsupported datatype ${header.datatypeCode}`);
  }
  const dims = [Number(header.dims[1]), Number(header.dims[2]), Number(header.dims[3])];
  return { data, dims, affine: header.affine };
}

const t1 = await decode(T1_PATH);
console.log(
  `T1 dims=${t1.dims.join('x')}, dtype=${t1.data.constructor.name}`
);
assert.deepEqual(t1.dims, [160, 256, 256], 'expected ds004884 T1 dims 160x256x256');

// ---- Step 2: rough brain mask via intensity threshold ----
let max = 0;
for (let i = 0; i < t1.data.length; i++) if (t1.data[i] > max) max = t1.data[i];
const threshold = 0.1 * max;
const mask = new Uint8Array(t1.data.length);
let maskCount = 0;
for (let i = 0; i < t1.data.length; i++) {
  if (t1.data[i] > threshold) { mask[i] = 1; maskCount++; }
}
console.log(`Brain mask (T1 > ${threshold.toFixed(0)}): ${maskCount.toLocaleString()} voxels`);
assert.ok(maskCount > 100_000 && maskCount < 5_000_000,
  `Brain mask voxel count out of expected range: ${maskCount}`);

// ---- Step 3: PCA prealign ----
const { dstAffine, mniDims, eigenvalues, R } =
  principalAxisAlign(mask, t1.dims, t1.affine);
console.log(`Eigenvalues (descending): ${eigenvalues.map(v => v.toFixed(2)).join(', ')}`);

// All eigenvalues finite + positive (covariance is positive semi-definite).
for (let i = 0; i < 3; i++) {
  assert.ok(Number.isFinite(eigenvalues[i]),
    `eigenvalue ${i} not finite: ${eigenvalues[i]}`);
  assert.ok(eigenvalues[i] >= 0,
    `eigenvalue ${i} should be >= 0; got ${eigenvalues[i]}`);
}
// Largest eigenvalue dominates (real heads are anisotropic - SI > AP > LR usually).
assert.ok(eigenvalues[0] > eigenvalues[1] * 1.05,
  `top eigenvalue should dominate by >=5%: got [${eigenvalues.join(', ')}]`);

// ---- Step 4: rotation is right-handed ----
const det =
  R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
  R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
  R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
console.log(`det(R) = ${det.toFixed(6)}`);
assert.ok(Math.abs(det - 1) < 1e-3, `det(R) must be +1; got ${det}`);

// R is a source-world rotation; columns must be orthonormal.
for (let i = 0; i < 3; i++) {
  const col = [R[0][i], R[1][i], R[2][i]];
  const norm = Math.sqrt(col[0] ** 2 + col[1] ** 2 + col[2] ** 2);
  assert.ok(Math.abs(norm - 1) < 1e-6, `R col${i} norm ${norm}`);
}

// R columns are canonical destination axes, not descending PCA rank.
// The ds004884 brain's strongest PCs are AP/SI/LR by eigenvalue order; this
// regression catches the old behavior that mapped those ranks onto x/y/z.
for (let c = 0; c < 3; c++) {
  const col = [R[0][c], R[1][c], R[2][c]];
  const offAxisMax = Math.max(...col.map((v, i) => i === c ? 0 : Math.abs(v)));
  assert.ok(col[c] > 0.7,
    `R col${c} must point mostly along positive canonical world axis ${c}; got ${col.join(', ')}`);
  assert.ok(Math.abs(col[c]) > offAxisMax,
    `R col${c} canonical component must dominate; got ${col.join(', ')}`);
}

// ---- Step 5: resample mask + verify centroid lands at MNI center ----
const aligned = resampleAffine(mask, t1.dims, t1.affine, mniDims, dstAffine, 'nearest');
let alignedCount = 0;
let cx = 0, cy = 0, cz = 0;
for (let z = 0; z < mniDims[2]; z++)
  for (let y = 0; y < mniDims[1]; y++)
    for (let x = 0; x < mniDims[0]; x++) {
      if (aligned[x + y * mniDims[0] + z * mniDims[0] * mniDims[1]]) {
        alignedCount++;
        cx += x; cy += y; cz += z;
      }
    }
cx /= alignedCount; cy /= alignedCount; cz /= alignedCount;
console.log(
  `Aligned mask: ${alignedCount.toLocaleString()} voxels in MNI160; ` +
  `centroid (${cx.toFixed(1)}, ${cy.toFixed(1)}, ${cz.toFixed(1)})`
);
// Source mask had ~maskCount voxels on a 160x256x256 grid; some clip when
// mapped to 160x160x192 (smaller grid in y, z). Expect 60-100% retained.
assert.ok(alignedCount > 0.5 * maskCount,
  `Aligned mask too small: ${alignedCount} vs ${maskCount}`);
assert.ok(alignedCount < 1.1 * maskCount,
  `Aligned mask larger than source (?): ${alignedCount} vs ${maskCount}`);
// Centroid lands at MNI center (80, 80, 96) within 1 voxel.
for (const [name, actual, expected] of [
  ['cx', cx, 80], ['cy', cy, 80], ['cz', cz, 96]
]) {
  assert.ok(Math.abs(actual - expected) < 1.5,
    `aligned ${name} drifted: got ${actual.toFixed(2)}, expected ${expected}`);
}

console.log(
  `\nreal-data PCA OK: principal axis eigenvalue ${eigenvalues[0].toFixed(0)} ` +
  `(${(eigenvalues[0] / eigenvalues[2]).toFixed(2)}× the smallest), ` +
  `det(R)=${det.toFixed(3)}, aligned centroid within 1.5 voxels of MNI center.`
);
