#!/usr/bin/env node
// Pure-JS tests for web/js/modules/prealign.js. Pins:
//   - centroidOfMask: voxel-space centroid of a binary mask, ignoring zeros.
//   - applyAffineToVoxel: 4x4 affine * voxel coord.
//   - computePrealignAffine: returns the 4x4 destination affine that, when
//     used by resampleAffine to walk the MNI160 1mm grid, places the
//     source brain centroid at MNI voxel (80, 80, 96) under canonical
//     FSL orientation (-x, +y, +z).

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, '..', 'web/js/modules/prealign.js')
  );
  const { centroidOfMask, applyAffineToVoxel, computePrealignAffine } =
    await import(moduleUrl);

  // ---- centroidOfMask: simple cube centroid ----
  // 4x4x4 mask: a 2x2x2 cube at (1,1,1)..(2,2,2) -> centroid (1.5, 1.5, 1.5).
  {
    const dims = [4, 4, 4];
    const mask = new Uint8Array(64);
    for (let z = 1; z <= 2; z++)
      for (let y = 1; y <= 2; y++)
        for (let x = 1; x <= 2; x++)
          mask[x + y * 4 + z * 16] = 1;
    const c = centroidOfMask(mask, dims);
    assert.ok(Math.abs(c[0] - 1.5) < 1e-9, `cx ${c[0]}`);
    assert.ok(Math.abs(c[1] - 1.5) < 1e-9, `cy ${c[1]}`);
    assert.ok(Math.abs(c[2] - 1.5) < 1e-9, `cz ${c[2]}`);
  }

  // Empty mask -> throws.
  {
    assert.throws(
      () => centroidOfMask(new Uint8Array(64), [4, 4, 4]),
      /empty/i
    );
  }

  // Dim mismatch -> throws.
  {
    assert.throws(
      () => centroidOfMask(new Uint8Array(8), [4, 4, 4]),
      /size|length|dim/i
    );
  }

  // ---- applyAffineToVoxel: identity round-trip + scaled+translated ----
  {
    const I = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1]
    ];
    const w = applyAffineToVoxel(I, [3, 4, 5]);
    assert.deepEqual(w, [3, 4, 5]);
  }
  {
    const A = [
      [-1, 0, 0, 79],
      [0, 1, 0, -98],
      [0, 0, 1, -114],
      [0, 0, 0, 1]
    ];
    const w = applyAffineToVoxel(A, [80, 80, 96]);
    assert.deepEqual(w, [-1, -18, -18]);
  }

  // ---- computePrealignAffine: places centroid at MNI160 voxel (80, 80, 96) ----
  // If source brain centroid is at world (5, -10, 12) mm, the resulting
  // destination affine, when applied to MNI voxel (80, 80, 96), must
  // return (5, -10, 12).
  {
    const srcCentroidWorld = [5, -10, 12];
    const dstAffine = computePrealignAffine(srcCentroidWorld);
    // 4x4 expected.
    assert.equal(dstAffine.length, 4);
    assert.equal(dstAffine[3].length, 4);

    const back = applyAffineToVoxel(dstAffine, [80, 80, 96]);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i] - srcCentroidWorld[i]) < 1e-9,
        `axis ${i} did not round-trip: got ${back[i]}, want ${srcCentroidWorld[i]}`);
    }
  }

  // Custom MNI grid + center options (e.g. for testing resilience to a
  // different reference template).
  {
    const dst = computePrealignAffine([0, 0, 0], {
      mniDims: [200, 200, 200],
      mniCenterVox: [100, 100, 100]
    });
    const back = applyAffineToVoxel(dst, [100, 100, 100]);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(back[i]) < 1e-9, `axis ${i} centroid drift ${back[i]}`);
    }
  }

  // Diagonal must be canonical FSL: (-1, +1, +1) per voxel mm.
  {
    const dst = computePrealignAffine([0, 0, 0]);
    assert.equal(dst[0][0], -1);
    assert.equal(dst[1][1], 1);
    assert.equal(dst[2][2], 1);
    // Off-diagonal must be zero.
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        if (r !== c) assert.equal(dst[r][c], 0);
  }

  console.log('prealign OK: centroidOfMask + applyAffineToVoxel + computePrealignAffine.');
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
