import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affineDifference,
  applyAffine,
  displaceVolume,
  downsampleVolume,
  encodeNifti,
  invertAffine,
  meanSquaredError,
  multiplyAffine,
  ncc,
  readVolume,
  resampleToGrid,
  resampleVolume,
  rigidVoxelMatrix,
  transformErrorMm,
} from '../test-utils/registration-similarity.mjs';

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test('ncc is 1 for identical arrays, -1 for negated ones and ignores gain and offset', () => {
  const a = [3, 1, 4, 1, 5, 9];
  close(ncc(a, a), 1);
  close(ncc(a, a.map((value) => -value)), -1);
  close(ncc(a, a.map((value) => 2 * value + 7)), 1);
});

test('ncc matches a hand-worked four-element case', () => {
  // Means are 2.5. Deviations a: -1.5 -0.5 0.5 1.5, b: -1.5 0.5 -0.5 1.5.
  // Cross sum 2.25 - 0.25 - 0.25 + 2.25 = 4; each sum of squares is 5; 4 / 5 = 0.8.
  close(ncc([1, 2, 3, 4], [1, 3, 2, 4]), 0.8);
});

test('ncc is 0 against a constant array and rejects mismatched lengths', () => {
  assert.equal(ncc([1, 2, 3], [5, 5, 5]), 0);
  assert.throws(() => ncc([1, 2], [1, 2, 3]), /Length mismatch/);
  assert.throws(() => ncc([], []), /at least one sample/);
});

test('mean squared error matches a hand-worked case', () => {
  // Differences 0 -1 1 0, squares sum to 2, over four samples.
  assert.equal(meanSquaredError([1, 2, 3, 4], [1, 3, 2, 4]), 0.5);
  assert.equal(meanSquaredError([1, 2], [1, 2]), 0);
});

test('affine inverse and product agree with a worked example', () => {
  const affine = [
    [-2, 0, 0, 90],
    [0, 2, 0, -126],
    [0, 0, 2, -72],
    [0, 0, 0, 1],
  ];
  assert.deepEqual(applyAffine(affine, [1, 2, 3]), [88, -122, -66]);
  assert.deepEqual(applyAffine(invertAffine(affine), [88, -122, -66]), [1, 2, 3]);
  assert.equal(affineDifference(multiplyAffine(affine, invertAffine(affine)), identity), 0);
});

test('downsampling averages each block and moves the origin to the block centre', () => {
  const volume = { data: Float32Array.from({ length: 4 * 2 * 2 }, (_, index) => index), dims: [4, 2, 2], affine: identity };
  const half = downsampleVolume(volume, 2);
  assert.deepEqual(half.dims, [2, 1, 1]);
  // First block holds 0 1 4 5 8 9 12 13 (mean 6.5), the second 2 3 6 7 10 11 14 15 (mean 8.5).
  assert.deepEqual(Array.from(half.data), [6.5, 8.5]);
  assert.deepEqual(applyAffine(half.affine, [0, 0, 0]), [0.5, 0.5, 0.5]);
  assert.deepEqual(applyAffine(half.affine, [1, 0, 0]), [2.5, 0.5, 0.5]);
});

test('a whole-voxel shift moves samples exactly and a half-voxel shift interpolates linearly', () => {
  const volume = { data: Float32Array.from({ length: 27 }, (_, index) => index), dims: [3, 3, 3], affine: identity };
  const shift = rigidVoxelMatrix(volume.dims, { translationVoxels: [1, 0, 0], rotationDegreesZ: 0 });
  assert.equal(resampleVolume(volume, shift).data[0], 1);
  const half = rigidVoxelMatrix(volume.dims, { translationVoxels: [0.5, 0, 0], rotationDegreesZ: 0 });
  assert.equal(resampleVolume(volume, half).data[0], 0.5);
});

test('a 90 degree rotation about the centre maps the x axis onto the y axis', () => {
  const matrix = rigidVoxelMatrix([3, 3, 3], { translationVoxels: [0, 0, 0], rotationDegreesZ: 90 });
  const [x, y, z] = applyAffine(matrix, [2, 1, 1]);
  close(x, 1);
  close(y, 2);
  close(z, 1);
});

test('the expected transform of a displaced copy undoes the displacement and has zero error against itself', () => {
  const affine = [
    [-2, 0, 0, 90],
    [0, 2, 0, -126],
    [0, 0, 2, -72],
    [0, 0, 0, 1],
  ];
  const fixed = { data: new Float32Array(8 * 8 * 8), dims: [8, 8, 8], affine };
  fixed.data[(3 * 8 + 3) * 8 + 5] = 1;
  const { moving, fixedToMoving } = displaceVolume(fixed, { translationVoxels: [2, 0, 0], rotationDegreesZ: 0 });
  // moving(v) = fixed(v + 2 voxels in x), so the bright voxel sits at x = 3 and, with a -2 mm x axis, 4 mm further along +x.
  assert.equal(moving.data[(3 * 8 + 3) * 8 + 3], 1);
  assert.deepEqual(applyAffine(fixedToMoving, [0, 0, 0]), [4, 0, 0]);
  assert.equal(transformErrorMm(fixedToMoving, fixedToMoving, fixed), 0);
  close(transformErrorMm(identity, fixedToMoving, fixed), 4);
});

test('encoded volumes round-trip through the shared NIfTI reader and resample onto another grid', async () => {
  const affine = [
    [-2, 0, 0, 90],
    [0, 2, 0, -126],
    [0, 0, 2, -72],
    [0, 0, 0, 1],
  ];
  const volume = { data: Float32Array.from({ length: 24 }, (_, index) => index), dims: [2, 3, 4], affine };
  const decoded = await readVolume(encodeNifti(volume));
  assert.deepEqual(decoded.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(decoded.data), Array.from(volume.data));
  assert.equal(affineDifference(decoded.affine, affine), 0);
  // A grid whose origin is one voxel (-2 mm) along x: its voxel 0 shows the source's voxel 1.
  const source = { data: Float32Array.from({ length: 24 }, (_, index) => index), dims: [3, 2, 4], affine };
  const shifted = { dims: [1, 1, 1], affine: [[-2, 0, 0, 88], affine[1], affine[2], affine[3]] };
  const onShifted = resampleToGrid(source, shifted);
  assert.deepEqual(onShifted.dims, [1, 1, 1]);
  assert.deepEqual(Array.from(onShifted.data), [1]);
});
