#!/usr/bin/env node
// Phase 26 tests: principal-axis (PCA) prealign for clinical T1s with
// non-canonical orientation. Pins:
//   - covarianceOfMask: 3x3 mass-weighted voxel covariance.
//   - jacobiEigen3x3: eigenvalues + eigenvectors of a symmetric 3x3.
//   - principalAxisAlign: end-to-end affine that places the brain's
//     world-mm principal axes along the canonical MNI axes + brain centroid
//     at MNI voxel (80, 80, 96).

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/prealign.js')
  );
  const {
    centroidOfMask, applyAffineToVoxel,
    covarianceOfMask, jacobiEigen3x3, principalAxisAlign
  } = await import(moduleUrl);
  const { resampleAffine } = await import(pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/resample.js')
  ));

  function affineColumnNorms(A) {
    return [0, 1, 2].map(c => Math.hypot(A[0][c], A[1][c], A[2][c]));
  }

  // ---- covarianceOfMask: axis-aligned 4x2x2 box centered at the dim center ----
  // Box voxel coords: x in [1,2], y in [1,2], z in [1,2] of a 4x4x4 volume.
  // Centroid (1.5, 1.5, 1.5). Diagonal cov entries are all 0.25
  // (variance of {0, 1} = 0.25). Off-diagonal = 0 because axes are
  // independent for an axis-aligned box.
  {
    const dims = [4, 4, 4];
    const mask = new Uint8Array(64);
    for (let z = 1; z <= 2; z++)
      for (let y = 1; y <= 2; y++)
        for (let x = 1; x <= 2; x++)
          mask[x + y * 4 + z * 16] = 1;
    const centroid = centroidOfMask(mask, dims);
    const cov = covarianceOfMask(mask, dims, centroid);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        const expect = (r === c) ? 0.25 : 0;
        assert.ok(Math.abs(cov[r][c] - expect) < 1e-9,
          `cov[${r}][${c}] = ${cov[r][c]}, expected ${expect}`);
      }
  }

  // ---- covarianceOfMask: anisotropic 6x2x2 box ----
  // Variance along x = 1.25 (range 0..3 - centroid 1.5; (1.5,0.5,-0.5,-1.5)^2
  // averaged), along y/z = 0.25.
  {
    const dims = [8, 4, 4];
    const mask = new Uint8Array(8 * 4 * 4);
    for (let z = 1; z <= 2; z++)
      for (let y = 1; y <= 2; y++)
        for (let x = 1; x <= 6; x++)
          mask[x + y * 8 + z * 32] = 1;
    const centroid = centroidOfMask(mask, dims);
    const cov = covarianceOfMask(mask, dims, centroid);
    // Variance along x of [1..6]: mean=3.5, sumSq/(N) = (2.5^2 + 1.5^2 + 0.5^2 + 0.5^2 + 1.5^2 + 2.5^2)/6 ≈ 2.917.
    assert.ok(cov[0][0] > 2.5 && cov[0][0] < 3.5,
      `cov[x][x] for elongated box: ${cov[0][0]}, expected ~2.92`);
    // y/z variance same as 4x2x2 case: 0.25.
    assert.ok(Math.abs(cov[1][1] - 0.25) < 1e-9, `cov[y][y] ${cov[1][1]}`);
    assert.ok(Math.abs(cov[2][2] - 0.25) < 1e-9, `cov[z][z] ${cov[2][2]}`);
  }

  // ---- jacobiEigen3x3: identity matrix → eigenvalues all 1, vectors are basis ----
  {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const { eigenvalues } = jacobiEigen3x3(I);
    for (const ev of eigenvalues) {
      assert.ok(Math.abs(ev - 1) < 1e-9, `identity eigenvalue ${ev}`);
    }
  }

  // ---- jacobiEigen3x3: known 2x2-block + scalar ----
  // M = [[2, 1, 0], [1, 2, 0], [0, 0, 3]] has eigenvalues 1, 3, 3.
  {
    const M = [[2, 1, 0], [1, 2, 0], [0, 0, 3]];
    const { eigenvalues } = jacobiEigen3x3(M);
    const sorted = [...eigenvalues].sort((a, b) => a - b);
    assert.ok(Math.abs(sorted[0] - 1) < 1e-6,
      `smallest eigenvalue should be 1, got ${sorted[0]}`);
    assert.ok(Math.abs(sorted[1] - 3) < 1e-6, `middle ${sorted[1]}`);
    assert.ok(Math.abs(sorted[2] - 3) < 1e-6, `largest ${sorted[2]}`);
  }

  // ---- jacobiEigen3x3: anisotropic diagonal ----
  // Cov for our 6x2x2 phantom has diagonal (~2.92, 0.25, 0.25). Eigenvalues
  // should match the diagonal entries (already diagonal -> eigenvectors are basis).
  {
    const D = [[2.92, 0, 0], [0, 0.25, 0], [0, 0, 0.25]];
    const { eigenvalues, eigenvectors } = jacobiEigen3x3(D);
    // Eigenvalues should sum + max to known values.
    const sum = eigenvalues[0] + eigenvalues[1] + eigenvalues[2];
    assert.ok(Math.abs(sum - 3.42) < 1e-6, `sum of eigenvalues ${sum}`);
    // Eigenvectors must form an orthonormal basis (each unit length, mutually orthogonal).
    for (let i = 0; i < 3; i++) {
      const v = eigenvectors[i];
      const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2);
      assert.ok(Math.abs(norm - 1) < 1e-6, `eigenvector ${i} norm ${norm}`);
    }
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++) {
        const a = eigenvectors[i];
        const b = eigenvectors[j];
        const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert.ok(Math.abs(dot) < 1e-6, `orthogonality ev${i}.ev${j} ${dot}`);
      }
  }

  // ---- principalAxisAlign: anisotropic axis-aligned box ----
  // Build a 12x4x4 box at the center of a 16x16x16 volume; identity source
  // affine. Principal axis is x (largest variance). After alignment, the
  // dst affine should sample the source so that:
  //   - dst voxel (mniCenter) -> source centroid
  //   - dst x-axis -> source x-axis (since x already is the principal axis)
  // i.e. for an already-canonical box, the rotation is a permutation that
  // could be identity OR a sign flip; we just verify the dst affine round-
  // trips the centroid.
  {
    const dims = [16, 16, 16];
    const mask = new Uint8Array(16 * 16 * 16);
    for (let z = 6; z < 10; z++)
      for (let y = 6; y < 10; y++)
        for (let x = 2; x < 14; x++)
          mask[x + y * 16 + z * 256] = 1;
    const srcAffine = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const { dstAffine, mniDims, mniCenterVox, eigenvalues } =
      principalAxisAlign(mask, dims, srcAffine);
    assert.deepEqual(mniDims, [160, 160, 192]);
    assert.deepEqual(mniCenterVox, [80, 80, 96]);
    // Eigenvalues sorted descending; the box is 12x4x4 so var ratios
    // are (~12 / 4 / 4) → first eigenvalue is the biggest.
    assert.ok(eigenvalues[0] > eigenvalues[1] && eigenvalues[0] > eigenvalues[2],
      `principal eigenvalue should be largest; got ${eigenvalues.join(', ')}`);
    // dst voxel (80, 80, 96) -> source world should equal source centroid in world.
    // For this synthetic case source affine is identity, so source centroid voxel
    // = source centroid world. centroid is (7.5, 7.5, 7.5).
    const centerWorld = applyAffineToVoxel(dstAffine, [80, 80, 96]);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(centerWorld[i] - 7.5) < 1e-6,
        `dst voxel center -> world axis ${i}: got ${centerWorld[i]}, want 7.5`);
    }
  }

  // ---- principalAxisAlign: rotated phantom preserves canonical axes ----
  // Build a 12x4x4 box rotated 90° around z axis: now extends along y.
  // PCA should identify y as the largest eigenvalue, but R columns now
  // represent canonical destination x/y/z axes, not descending PCA rank.
  // The dst y-axis should map to source y direction.
  {
    const dims = [16, 16, 16];
    const mask = new Uint8Array(16 * 16 * 16);
    // Box: y in [2..14), x in [6..10), z in [6..10).
    for (let z = 6; z < 10; z++)
      for (let y = 2; y < 14; y++)
        for (let x = 6; x < 10; x++)
          mask[x + y * 16 + z * 256] = 1;
    const srcAffine = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const { eigenvalues, R } = principalAxisAlign(mask, dims, srcAffine);
    assert.ok(eigenvalues[0] > eigenvalues[1] && eigenvalues[0] > eigenvalues[2],
      `rotated phantom: top eigenvalue dominates; got ${eigenvalues.join(', ')}`);
    // R is the source-world rotation: R @ e_c_dst = source direction
    // for canonical axis c. Since the source affine is identity, column 1
    // should be ±source-y even though y is the largest-variance PCA axis.
    const col0 = [R[0][0], R[1][0], R[2][0]];
    const col1 = [R[0][1], R[1][1], R[2][1]];
    assert.ok(Math.abs(col0[0]) > 0.99,
      `R col0 should remain the canonical x-axis; got ${col0.join(', ')}`);
    assert.ok(Math.abs(col1[1]) > 0.99,
      `R col1 should map the canonical y-axis to source y; got ${col1.join(', ')}`);
    assert.ok(Math.abs(col1[0]) < 0.01 && Math.abs(col1[2]) < 0.01,
      `R col1 should be along ±y only; got ${col1.join(', ')}`);
  }

  // ---- principalAxisAlign: submillimetre anisotropic source preserves 1mm destination scale ----
  // Regression for a real failure mode: when the source T1 is 0.5 x 0.4 x
  // 0.4mm, the sampling affine must still advance by ~1mm for each MNI output
  // voxel. The old voxel-space PCA transform inherited source voxel spacing,
  // making the brain appear ~2x too large and causing grid clipping.
  {
    const dims = [96, 140, 140];
    const srcAffine = [
      [0.5, 0, 0, -24],
      [0, 0.4, 0, -28],
      [0, 0, 0.4, -28],
      [0, 0, 0, 1]
    ];
    const mask = new Uint8Array(dims[0] * dims[1] * dims[2]);
    for (let z = 0; z < dims[2]; z++)
      for (let y = 0; y < dims[1]; y++)
        for (let x = 0; x < dims[0]; x++) {
          const wx = srcAffine[0][0] * x + srcAffine[0][3];
          const wy = srcAffine[1][1] * y + srcAffine[1][3];
          const wz = srcAffine[2][2] * z + srcAffine[2][3];
          const ellipsoid =
            (wx * wx) / (14 * 14) +
            (wy * wy) / (18 * 18) +
            (wz * wz) / (21 * 21);
          if (ellipsoid <= 1) mask[x + y * dims[0] + z * dims[0] * dims[1]] = 1;
        }

    const mniDims = [80, 80, 80];
    const mniCenterVox = [40, 40, 40];
    const mniAffine = [
      [1, 0, 0, -40],
      [0, 1, 0, -40],
      [0, 0, 1, -40],
      [0, 0, 0, 1]
    ];
    const { dstAffine } = principalAxisAlign(mask, dims, srcAffine, {
      mniDims, mniCenterVox, mniAffine
    });
    const norms = affineColumnNorms(dstAffine);
    for (const [axis, norm] of norms.entries()) {
      assert.ok(Math.abs(norm - 1) < 1e-6,
        `submillimetre source must sample destination axis ${axis} at 1mm, got ${norm}`);
    }

    const aligned = resampleAffine(mask, dims, srcAffine, mniDims, dstAffine, 'nearest');
    const centroid = centroidOfMask(aligned, mniDims);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(centroid[i] - mniCenterVox[i]) < 0.75,
        `submillimetre aligned centroid axis ${i}: got ${centroid[i]}, want ${mniCenterVox[i]}`);
    }
  }

  // ---- principalAxisAlign: rotation matrix is right-handed (det > 0) ----
  // PCA gives eigenvectors up to sign. The implementation must pick signs
  // so the resulting rotation has det = +1 (not -1). Otherwise the brain
  // gets mirrored.
  {
    const dims = [16, 16, 16];
    const mask = new Uint8Array(16 * 16 * 16);
    for (let z = 6; z < 10; z++)
      for (let y = 6; y < 10; y++)
        for (let x = 2; x < 14; x++)
          mask[x + y * 16 + z * 256] = 1;
    const srcAffine = [
      [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]
    ];
    const { R } = principalAxisAlign(mask, dims, srcAffine);
    const det =
      R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
      R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
      R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    assert.ok(Math.abs(det - 1) < 1e-6,
      `Rotation det must be +1 for right-handed alignment; got ${det}`);
  }

  console.log('prealign-pca OK: covariance + Jacobi + principalAxisAlign on rotated/aniso phantoms.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
