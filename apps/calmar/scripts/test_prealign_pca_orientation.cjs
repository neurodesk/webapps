#!/usr/bin/env node
// Phase 33 audit follow-up: PCA orientation — the silent-flip risk.
//
// PCA on a binary mask gives the principal axes UP TO SIGN. The brain's
// covariance matrix is identical to the covariance of the brain rotated
// 180° around any of its principal axes — same eigenvalues, eigenvectors
// flipped per column.
//
// principalAxisAlign currently only enforces det(R) = +1 (right-handed).
// It does NOT enforce that the resulting orientation matches MNI
// canonical (head-up, face-forward). A clinical T1 acquired upside-down
// could PCA-align with the centroid at MNI center but with z and/or y
// axes flipped relative to anatomy.
//
// This test DEMONSTRATES the limitation rather than fixing it: we build
// two phantoms — anatomically the same (asymmetric "head" shape) but
// acquired in mirror-image poses — run principalAxisAlign on each, and
// compare the output orientations. If the two outputs match, the
// algorithm correctly disambiguates. If they don't, we have the silent-
// flip and the test makes that visible (ASCII-prints a small slice of
// each output for human inspection).
//
// Currently expected: the two outputs do NOT match because PCA + det
// correction doesn't pick a canonical orientation. The test asserts
// the GAP so that a future "add 3rd-moment sign correction" change
// has a regression target. If the gap closes, this test fails and
// gets re-written to assert correct orientation.

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/prealign.js')
  );
  const { principalAxisAlign } = await import(moduleUrl);
  const { resampleAffine } = await import(pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/resample.js')
  ));

  // 16x8x8 phantom with clear z-asymmetry: a 14×6×3 slab at the bottom
  // (z=1..3) and a 4×4×3 cube on top (z=4..6). Phase 36's PCA fix uses
  // the source NIfTI affine as the orientation prior, so the test
  // models clinical reality: an upside-down acquisition has a flipped
  // affine (voxel z+ = world z-) and identical anatomical mass
  // distribution in WORLD space. Both phantoms must produce the same
  // prealigned output.
  function makePhantom({ flipZ = false } = {}) {
    const dims = [16, 8, 8];
    const mask = new Uint8Array(16 * 8 * 8);
    function set(x, y, z) {
      const Z = flipZ ? (7 - z) : z;
      mask[x + y * 16 + Z * 16 * 8] = 1;
    }
    // Base slab z=1..3 (anatomical "bottom" — head's foramen-magnum side)
    for (let z = 1; z <= 3; z++)
      for (let y = 1; y <= 6; y++)
        for (let x = 1; x <= 14; x++) set(x, y, z);
    // Bump cube z=4..6 (anatomical "top" — vertex side)
    for (let z = 4; z <= 6; z++)
      for (let y = 2; y <= 5; y++)
        for (let x = 6; x <= 9; x++) set(x, y, z);
    // Phase 36: when the voxel grid stores the brain upside-down, the
    // source NIfTI affine encodes the flip on z (voxel z+ -> world z-).
    // The world-space anatomical layout is therefore identical for both
    // phantoms — only the storage convention differs.
    const srcAffine = flipZ
      ? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, -1, 7], [0, 0, 0, 1]]
      : [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0,  1, 0], [0, 0, 0, 1]];
    return { mask, dims, srcAffine };
  }

  function alignAndSkew(phantom) {
    // Use a small destination grid (32×32×32) so the resampled output
    // occupies a meaningful fraction of the volume.
    const dstDims = [32, 32, 32];
    const r = principalAxisAlign(phantom.mask, phantom.dims, phantom.srcAffine, {
      mniDims: dstDims, mniCenterVox: [16, 16, 16]
    });
    const aligned = resampleAffine(
      phantom.mask, phantom.dims, phantom.srcAffine,
      dstDims, r.dstAffine, 'nearest'
    );

    // Voxel count + per-axis third central moment around the centroid.
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (let z = 0; z < dstDims[2]; z++)
      for (let y = 0; y < dstDims[1]; y++)
        for (let x = 0; x < dstDims[0]; x++)
          if (aligned[x + y * dstDims[0] + z * dstDims[0] * dstDims[1]]) {
            n++; sx += x; sy += y; sz += z;
          }
    if (n === 0) return { n: 0, mx: 0, my: 0, mz: 0 };
    const cx = sx / n, cy = sy / n, cz = sz / n;
    let mx = 0, my = 0, mz = 0;
    for (let z = 0; z < dstDims[2]; z++)
      for (let y = 0; y < dstDims[1]; y++)
        for (let x = 0; x < dstDims[0]; x++)
          if (aligned[x + y * dstDims[0] + z * dstDims[0] * dstDims[1]]) {
            const dx = x - cx, dy = y - cy, dz = z - cz;
            mx += dx * dx * dx;
            my += dy * dy * dy;
            mz += dz * dz * dz;
          }
    return {
      n, cx, cy, cz,
      mx: mx / n, my: my / n, mz: mz / n
    };
  }

  const upright = alignAndSkew(makePhantom());
  const flipped = alignAndSkew(makePhantom({ flipZ: true }));

  console.log(
    `Upright phantom: n=${upright.n}, centroid=(${upright.cx.toFixed(1)},${upright.cy.toFixed(1)},${upright.cz.toFixed(1)}), ` +
    `m3=(${upright.mx.toFixed(1)},${upright.my.toFixed(1)},${upright.mz.toFixed(1)})`
  );
  console.log(
    `Flipped phantom: n=${flipped.n}, centroid=(${flipped.cx.toFixed(1)},${flipped.cy.toFixed(1)},${flipped.cz.toFixed(1)}), ` +
    `m3=(${flipped.mx.toFixed(1)},${flipped.my.toFixed(1)},${flipped.mz.toFixed(1)})`
  );

  // Both phantoms must survive the resample with similar voxel counts.
  assert.ok(upright.n > 0 && flipped.n > 0,
    `both phantoms must produce non-empty resampled outputs (got n=${upright.n}, ${flipped.n})`);
  const nDiff = Math.abs(upright.n - flipped.n);
  assert.ok(nDiff < 0.1 * Math.max(upright.n, flipped.n),
    `resampled voxel counts must be within 10%; got ${upright.n} vs ${flipped.n}`);

  // The principal-axis third-moment magnitudes must be similar (same
  // anatomy means same skewness magnitude — the only question is sign).
  // Take the largest |moment| component as the principal-axis skew.
  function principalSkew(s) {
    const cands = [s.mx, s.my, s.mz];
    let best = 0;
    for (const v of cands) if (Math.abs(v) > Math.abs(best)) best = v;
    return best;
  }
  const upSkew = principalSkew(upright);
  const flSkew = principalSkew(flipped);
  console.log(`Principal-axis 3rd moment: upright=${upSkew.toFixed(2)}, flipped=${flSkew.toFixed(2)}`);

  // Magnitudes should be similar (same anatomy).
  const magDiff = Math.abs(Math.abs(upSkew) - Math.abs(flSkew));
  assert.ok(magDiff < 0.2 * Math.max(Math.abs(upSkew), Math.abs(flSkew), 1),
    `principal-skew magnitudes must match within 20%; got ${upSkew} vs ${flSkew}`);

  // Phase 36: HARD ASSERTION. Both poses must produce the same-sign
  // principal-axis skew because they are anatomically the same brain
  // — only the storage convention (NIfTI affine) differs. The Phase 36
  // fix uses the source affine as an orientation prior, which is
  // exactly the disambiguation needed here.
  const sameSign = Math.sign(upSkew) === Math.sign(flSkew);
  assert.ok(
    sameSign,
    `Phase 36 regression: upside-down acquisition produces a mirror-image ` +
    `prealigned brain. Upright skew=${upSkew.toFixed(2)}, ` +
    `flipped skew=${flSkew.toFixed(2)}. The source NIfTI affine encodes ` +
    `the flip; principalAxisAlign must use it to pick consistent column ` +
    `signs for R.`
  );
  console.log('prealign-pca orientation OK: source-affine prior correctly resolves 180° ambiguity.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
