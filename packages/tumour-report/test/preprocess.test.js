import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  binaryFillHoles6,
  brainOverlapRefinement,
  clipAndNormalize,
  cropBackgroundMinimum,
  invertAffine4,
  labelComponents26,
  multiplyAffine4,
  percentileLinear,
  resampleFromTo,
  resampleToOutput,
  resizeLinear3d,
  uncropMask,
  validateVolume,
  vox2OutVox,
  voxelIndex,
} from '../src/preprocess.js';

function makeBoxVolume(dims, affine, fillFn) {
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        data[voxelIndex(x, y, z, dims)] = fillFn(x, y, z);
      }
    }
  }
  return { data, dims, affine };
}

test('invertAffine4 and multiplyAffine4 recover identity on rotated anisotropic affine', () => {
  const aff = [
    [0, -0.5, 0, 120],
    [0.5, 0, 0, -80],
    [0, 0, 1.25, 42],
    [0, 0, 0, 1],
  ];
  const inv = invertAffine4(aff);
  const id = multiplyAffine4(aff, inv);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      assert.ok(Math.abs(id[r][c] - (r === c ? 1 : 0)) < 1e-12);
    }
  }
});

test('validateVolume rejects degenerate affines and mismatched dimensions', () => {
  const good = {
    data: new Float32Array(8),
    dims: [2, 2, 2],
    affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  };
  assert.deepEqual(validateVolume(good), [1, 1, 1]);
  assert.throws(() => validateVolume({ ...good, dims: [2, 2] }), /3D/);
  assert.throws(() => validateVolume({ ...good, data: new Float32Array(4) }), /voxel count/);
  assert.throws(
    () => validateVolume({ ...good, affine: [[0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }),
    /unsupported voxel spacing|singular/,
  );
});

test('binaryFillHoles6 fills enclosed cavity without altering exterior background', () => {
  const dims = [5, 5, 5];
  const mask = new Uint8Array(125);
  for (let z = 1; z <= 3; z++) {
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) {
        if (x === 2 && y === 2 && z === 2) continue;
        mask[voxelIndex(x, y, z, dims)] = 1;
      }
    }
  }
  const filled = binaryFillHoles6(mask, dims);
  assert.equal(filled[voxelIndex(2, 2, 2, dims)], 1);
  assert.equal(filled[voxelIndex(0, 0, 0, dims)], 0);
});

test('cropBackgroundMinimum crops tight bounding box and uncropMask restores coordinates', () => {
  const dims = [10, 10, 10];
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const vol = makeBoxVolume(dims, affine, (x, y, z) => (
    x >= 2 && x <= 6 && y >= 3 && y <= 7 && z >= 1 && z <= 5 ? 100 : 0
  ));
  const { volume: cropped, cropBbox } = cropBackgroundMinimum(vol);
  assert.deepEqual(cropBbox, [2, 3, 1, 7, 8, 6]);
  assert.deepEqual(cropped.dims, [5, 5, 5]);

  const maskCrop = new Uint8Array(125).fill(1);
  const full = uncropMask(maskCrop, cropBbox, dims);
  assert.equal(full[voxelIndex(2, 3, 1, dims)], 1);
  assert.equal(full[voxelIndex(1, 3, 1, dims)], 0);
  assert.equal(full[voxelIndex(6, 7, 5, dims)], 1);
});

test('vox2OutVox and resampleToOutput round-trip LPS anisotropic image to canonical 1mm RAS', () => {
  const dims = [10, 10, 8];
  const affine = [
    [-2, 0, 0, 20],
    [0, -2, 0, 20],
    [0, 0, 2, 0],
    [0, 0, 0, 1],
  ];
  const { dims: outDims, affine: outAff } = vox2OutVox(dims, affine, [1, 1, 1]);
  assert.deepEqual(outDims, [19, 19, 15]);
  assert.equal(outAff[0][0], 1);
  assert.equal(outAff[0][3], 2);
  assert.equal(outAff[1][3], 2);
  assert.equal(outAff[2][3], 0);

  // Linear ramp in physical RAS X: f(X) = X should be preserved by linear resampling & inverse.
  const vol = makeBoxVolume(dims, affine, (x) => 20 - 2 * x);
  const res = resampleToOutput(vol, [1, 1, 1], 1);
  const back = resampleFromTo(res, dims, affine, 1);
  for (let z = 1; z < dims[2] - 1; z++) {
    for (let y = 1; y < dims[1] - 1; y++) {
      for (let x = 1; x < dims[0] - 1; x++) {
        const idx = voxelIndex(x, y, z, dims);
        assert.ok(Math.abs(back.data[idx] - vol.data[idx]) < 1e-4);
      }
    }
  }
});

test('resizeLinear3d preserves constant fields and resizes cleanly', () => {
  const src = new Float32Array(8 * 8 * 8).fill(3.5);
  const down = resizeLinear3d(src, [8, 8, 8], [4, 4, 4]);
  assert.equal(down.length, 64);
  for (const v of down) assert.ok(Math.abs(v - 3.5) < 1e-5);
  const up = resizeLinear3d(down, [4, 4, 4], [6, 8, 10]);
  assert.equal(up.length, 480);
  for (const v of up) assert.ok(Math.abs(v - 3.5) < 1e-5);
});

test('clipAndNormalize clips negative values, 99.5th percentile, and z-scores nonzero with ddof=1', () => {
  const data = new Float32Array([-5, 0, 0, 10, 20, 30, 40]);
  assert.equal(percentileLinear(new Float32Array([0, 10, 20, 30]), 50), 15);
  const norm = clipAndNormalize(data, 100);
  assert.equal(norm[0], 0);
  assert.equal(norm[1], 0);
  const nz = [norm[3], norm[4], norm[5], norm[6]];
  const mean = nz.reduce((a, b) => a + b, 0) / nz.length;
  const std = Math.sqrt(nz.reduce((a, b) => a + (b - mean) ** 2, 0) / (nz.length - 1));
  assert.ok(Math.abs(mean) < 1e-6);
  assert.ok(Math.abs(std - 1) < 1e-6);
});

test('labelComponents26 connects diagonal neighbours and brainOverlapRefinement drops extra-cranial components', () => {
  const dims = [6, 6, 6];
  const tumour = new Uint8Array(216);
  const brain = new Uint8Array(216);
  // Component 1: diagonal pair inside brain
  tumour[voxelIndex(1, 1, 1, dims)] = 1;
  tumour[voxelIndex(2, 2, 2, dims)] = 1;
  brain[voxelIndex(1, 1, 1, dims)] = 1;
  // Component 2: isolated voxel outside brain
  tumour[voxelIndex(5, 5, 5, dims)] = 1;

  const cc = labelComponents26(tumour, dims);
  assert.equal(cc.count, 2);
  const ref = brainOverlapRefinement(tumour, brain, dims);
  assert.equal(ref.raw, 2);
  assert.equal(ref.kept, 1);
  assert.equal(ref.mask[voxelIndex(2, 2, 2, dims)], 1);
  assert.equal(ref.mask[voxelIndex(5, 5, 5, dims)], 0);
});
