import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accumulatePatch3D,
  cOrderToNifti,
  connectedComponents3D,
  computeForegroundBBox,
  computeOtsuThreshold,
  computePatchPositions3D,
  computeResampledDims,
  computeTilePositions2D,
  cropCenteredVolume,
  cropVolume,
  dilateMask3D,
  erodeMask3D,
  extractPatch3D,
  fillHoles3D,
  flipVolumeAxes,
  getOrientationTransform,
  inverseOrient,
  keepLargestComponent,
  keepLargestComponentAndFill,
  niftiToCOrder,
  orientToRAS,
  p99Normalize,
  padVolumeCentered,
  perLabelLargestComponent,
  removeSmallComponents,
  resampleLabelsNearest,
  resampleVolume,
  transposeXYZToZYX,
  transposeZYXToXYZ,
  uncropVolume,
  zScoreNormalize
} from '../src/volume/index.js';

// Expected arrays in this file are literals worked out by hand or with numpy,
// SciPy and scikit-image, never with the functions under test. A 2x3x4 volume
// whose voxel (x, y, z) holds x + 2y + 6z is numpy's
// `np.arange(24).reshape((2, 3, 4), order='F')`: no two axes have the same
// length, so a swapped axis cannot pass.
const ARANGE_2X3X4 = Float32Array.from({ length: 24 }, (_, index) => index);
const ARANGE_2X3X4_C_ORDER = [
  0, 6, 12, 18, 2, 8, 14, 20, 4, 10, 16, 22,
  1, 7, 13, 19, 3, 9, 15, 21, 5, 11, 17, 23
];

test('connectedComponents3D labels separated regions', () => {
  const mask = new Uint8Array(27);
  mask[0] = 1;
  mask[26] = 1;
  const { labels, numComponents } = connectedComponents3D(mask, [3, 3, 3]);
  assert.equal(numComponents, 2);
  assert.notEqual(labels[0], labels[26]);
});

test('crop and uncrop preserve voxel placement', () => {
  const data = new Float32Array(27);
  data[13] = 5;
  const cropped = cropVolume(data, [3, 3, 3], { origin: [1, 1, 1], end: [2, 2, 2] });
  assert.deepEqual(cropped.dims, [1, 1, 1]);
  assert.equal(cropped.data[0], 5);
  const restored = uncropVolume(cropped.data, cropped.dims, [3, 3, 3], cropped.origin, Float32Array);
  assert.equal(restored[13], 5);
});

test('nearest label resampling samples the voxel under each target centre', () => {
  // Upsampling repeats each label; a 3-to-1 reduction keeps the middle voxel.
  assert.deepEqual(Array.from(resampleLabelsNearest(new Uint8Array([3, 7]), [2, 1, 1], [4, 1, 1])), [3, 3, 7, 7]);
  assert.deepEqual(Array.from(resampleLabelsNearest(new Uint8Array([1, 2, 3]), [1, 3, 1], [1, 1, 1])), [2]);
  assert.deepEqual(
    Array.from(resampleLabelsNearest(new Uint8Array([4, 9]), [1, 1, 2], [1, 1, 6])),
    [4, 4, 4, 9, 9, 9]
  );
});

test('morphology fills a closed interior hole', () => {
  const mask = new Uint8Array(27).fill(1);
  mask[13] = 0;
  const filled = fillHoles3D(mask, [3, 3, 3], Uint8Array);
  assert.equal(filled[13], 1);
  const dilated = dilateMask3D(new Uint8Array([1, 0, 0]), [3, 1, 1], 1, Uint8Array);
  assert.deepEqual(Array.from(dilated), [1, 1, 0]);
});

test('Otsu threshold matches scikit-image on a bimodal image', () => {
  // skimage.filters.threshold_otsu(x, nbins=256) for 50x10, 50x12, 30x200, 30x210.
  const data = new Float32Array([
    ...new Array(50).fill(10),
    ...new Array(50).fill(12),
    ...new Array(30).fill(200),
    ...new Array(30).fill(210)
  ]);
  const threshold = computeOtsuThreshold(data);
  assert.ok(Math.abs(threshold.thresholdValue - 11.953125) < 1e-9, `got ${threshold.thresholdValue}`);
  assert.equal(threshold.minVal, 10);
  assert.equal(threshold.maxVal, 210);
  assert.equal(threshold.thresholdPercent, 6);
  assert.equal(computeOtsuThreshold(new Float32Array([4, 4, 4])).error, 'constant image');
});

test('2D tiles step by the overlap and clamp the last tile to the edge', () => {
  const coordinates = positions => positions.map(({ x, y }) => [x, y]);
  // 4-pixel tiles at 50 % overlap step by 2 and end flush with the 10-pixel edge.
  const overlapping = computeTilePositions2D(10, 10, 4, 4, 0.5);
  assert.equal(overlapping.length, 16);
  assert.deepEqual([...new Set(overlapping.map(tile => tile.x))], [0, 2, 4, 6]);
  assert.deepEqual([...new Set(overlapping.map(tile => tile.y))], [0, 2, 4, 6]);
  // A 10 x 7 image (height x width) does not divide by 4: the last row and column move inwards.
  assert.deepEqual(coordinates(computeTilePositions2D(10, 7, 4, 4, 0)), [
    [0, 0], [3, 0],
    [0, 4], [3, 4],
    [0, 6], [3, 6]
  ]);
  assert.deepEqual(coordinates(computeTilePositions2D(3, 3, 4, 4, 0)), [[0, 0]]);
});

test('3D patches cover the volume, and overlapping outputs blend by weight', () => {
  assert.deepEqual(computePatchPositions3D([5, 4, 4], [4, 4, 4], 0), [[0, 0, 0], [1, 0, 0]]);
  const volume = new Float32Array([7, 8, 9]);
  assert.deepEqual(Array.from(extractPatch3D(volume, [3, 1, 1], [1, 0, 0], [2, 1, 1])), [8, 9]);

  const accum = new Float32Array(3);
  const weights = new Float32Array(3);
  accumulatePatch3D(accum, weights, [3, 1, 1], [0, 0, 0], new Float32Array([10, 20]), new Float32Array([1, 1]), [2, 1, 1]);
  accumulatePatch3D(accum, weights, [3, 1, 1], [1, 0, 0], new Float32Array([40, 50]), new Float32Array([3, 1]), [2, 1, 1]);
  // Middle voxel: (20 * 1 + 40 * 3) / (1 + 3) = 35.
  assert.deepEqual(Array.from(accum, (value, index) => value / weights[index]), [10, 35, 50]);
});

test('centered padding places the volume in the middle of the target', () => {
  const padded = padVolumeCentered(new Float32Array([1, 2, 3, 4]), [2, 2, 1], [4, 4, 1]);
  assert.deepEqual(Array.from(padded), [
    0, 0, 0, 0,
    0, 1, 2, 0,
    0, 3, 4, 0,
    0, 0, 0, 0
  ]);
  const numbered = Float32Array.from({ length: 16 }, (_, index) => index);
  assert.deepEqual(Array.from(cropCenteredVolume(numbered, [4, 4, 1], [2, 2, 1])), [5, 6, 9, 10]);
  assert.throws(() => padVolumeCentered(numbered, [4, 4, 1], [2, 2, 1]), /targetDims must contain sourceDims/);
});

test('NIfTI (x fastest) and C (z fastest) layouts match numpy ravel orders', () => {
  // np.arange(24).reshape((2, 3, 4), order='F').ravel(order='C')
  assert.deepEqual(Array.from(niftiToCOrder(ARANGE_2X3X4, [2, 3, 4])), ARANGE_2X3X4_C_ORDER);
  assert.deepEqual(
    Array.from(cOrderToNifti(Float32Array.from(ARANGE_2X3X4_C_ORDER), [2, 3, 4])),
    Array.from(ARANGE_2X3X4)
  );
});

test('axis transposition reverses the axis order and reports the new dims', () => {
  // a.transpose(2, 1, 0).ravel(order='F') for the same numpy array.
  const transposed = transposeXYZToZYX(ARANGE_2X3X4, [2, 3, 4]);
  assert.deepEqual(transposed.dims, [4, 3, 2]);
  assert.deepEqual(Array.from(transposed.data), ARANGE_2X3X4_C_ORDER);
  const restored = transposeZYXToXYZ(Float32Array.from(ARANGE_2X3X4_C_ORDER), [4, 3, 2]);
  assert.deepEqual(restored.dims, [2, 3, 4]);
  assert.deepEqual(Array.from(restored.data), Array.from(ARANGE_2X3X4));
  // a[::-1].ravel(order='F') starts 1, 0, 3, 2, 5, 4.
  const flipped = flipVolumeAxes(ARANGE_2X3X4, [2, 3, 4], [0]);
  assert.deepEqual(Array.from(flipped.data.slice(0, 6)), [1, 0, 3, 2, 5, 4]);
  assert.deepEqual(Array.from(flipVolumeAxes(new Uint8Array([1, 2, 3]), [1, 1, 3], [2]).data), [3, 2, 1]);
});

test('orientation transform reads axis order and flips from the affine', () => {
  const lps = [[-1, 0, 0, 90], [0, -1, 0, 126], [0, 0, 1, -72], [0, 0, 0, 1]];
  assert.deepEqual(getOrientationTransform(lps), { perm: [0, 1, 2], flip: [true, true, false] });
  // Voxel j runs left-to-right, k posterior-to-anterior, i superior-to-inferior.
  const rotated = [[0, 2, 0, 0], [0, 0, 2, 0], [-2, 0, 0, 0], [0, 0, 0, 1]];
  assert.deepEqual(getOrientationTransform(rotated), { perm: [1, 2, 0], flip: [false, false, true] });
});

test('reorienting permutes and flips voxels, and the inverse restores the input', () => {
  const source = Float32Array.from({ length: 6 }, (_, index) => index);
  // np.arange(6).reshape((2, 3, 1), order='F').transpose(1, 0, 2).ravel(order='F')
  const swapped = orientToRAS(source, [2, 3, 1], [1, 0, 2], [false, false, false]);
  assert.deepEqual(swapped.dims, [3, 2, 1]);
  assert.deepEqual(Array.from(swapped.data), [0, 2, 4, 1, 3, 5]);
  // Flipping the output x axis of the swapped volume reverses each row of three.
  const flipped = orientToRAS(source, [2, 3, 1], [1, 0, 2], [true, false, false]);
  assert.deepEqual(Array.from(flipped.data), [4, 2, 0, 5, 3, 1]);
  assert.deepEqual(
    Array.from(inverseOrient(Float32Array.from([4, 2, 0, 5, 3, 1]), [3, 2, 1], [1, 0, 2], [true, false, false], [2, 3, 1])),
    [0, 1, 2, 3, 4, 5]
  );
});

test('linear resampling matches scipy.ndimage.zoom', () => {
  assert.deepEqual(computeResampledDims([10, 10, 10], [1, 1, 2.5], [1, 1, 1]), [10, 10, 25]);
  // scipy.ndimage.zoom([0, 10], 2, order=1) -> [0, 3.3333, 6.6667, 10]
  const doubled = resampleVolume(new Float32Array([0, 10]), [2, 1, 1], [2, 1, 1], [1, 1, 1]);
  assert.deepEqual(doubled.dims, [4, 1, 1]);
  assert.deepEqual(Array.from(doubled.data, value => Number(value.toFixed(4))), [0, 3.3333, 6.6667, 10]);
  // zoom([[0, 10], [20, 30]], (1.5, 1), order=1) -> [[0, 10], [10, 20], [20, 30]]; x is the first axis.
  const stretched = resampleVolume(new Float32Array([0, 20, 10, 30]), [2, 2, 1], [1.5, 1, 1], [1, 1, 1]);
  assert.deepEqual(stretched.dims, [3, 2, 1]);
  assert.deepEqual(Array.from(stretched.data), [0, 10, 20, 10, 20, 30]);
  // A negative target spacing keeps that axis at its source spacing.
  assert.deepEqual(resampleVolume(new Float32Array([0, 10]), [2, 1, 1], [2, 1, 1], [-1, 1, 1]).spacing, [2, 1, 1]);
});

test('intensity normalization produces the textbook z-scores and clips outliers', () => {
  // Mean 5, population standard deviation 2.
  assert.deepEqual(
    Array.from(zScoreNormalize(new Float32Array([2, 4, 4, 4, 5, 5, 7, 9]))),
    [-1.5, -0.5, -0.5, -0.5, 0, 0, 1, 2]
  );
  // Background zeros stay zero and do not enter the statistics: mean 2, deviation 1.
  assert.deepEqual(Array.from(zScoreNormalize(new Float32Array([0, 1, 3]), { nonzeroOnly: true })), [0, -1, 1]);

  // One bright outlier among 198 equal voxels must not set the scale.
  const image = new Float32Array([5, ...new Array(198).fill(15), 1005]);
  const normalized = p99Normalize(image);
  assert.equal(normalized.min, 5);
  assert.equal(normalized.p99, 10);
  assert.deepEqual([normalized.data[0], normalized.data[1], normalized.data[199]], [0, 1, 1]);
});

test('foreground bounding box is half-open and clamps its margin to the volume', () => {
  const data = new Uint8Array(64);
  data[1 + 2 * 4 + 3 * 16] = 1;
  data[2 + 2 * 4 + 3 * 16] = 1;
  assert.deepEqual(computeForegroundBBox(data, [4, 4, 4]), { origin: [1, 2, 3], end: [3, 3, 4] });
  assert.deepEqual(computeForegroundBBox(data, [4, 4, 4], 1), { origin: [0, 1, 2], end: [4, 4, 4] });
  assert.equal(computeForegroundBBox(new Uint8Array(64), [4, 4, 4]), null);
});

test('erosion and dilation match SciPy binary morphology with a 6-neighbour element', () => {
  // scipy.ndimage.binary_erosion of a 3x3x3 cube inside 5x5x5 leaves only the centre voxel.
  const cube = new Uint8Array(125);
  for (let z = 1; z <= 3; z++) {
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) cube[x + y * 5 + z * 25] = 1;
    }
  }
  const eroded = erodeMask3D(cube, [5, 5, 5]);
  assert.deepEqual(Array.from(eroded.keys()).filter(index => eroded[index]), [62]);
  // The volume edge counts as foreground (border_value=1): a full mask is not eaten away.
  assert.equal(erodeMask3D(new Uint8Array(27).fill(1), [3, 3, 3]).reduce((sum, value) => sum + value, 0), 27);
  // binary_dilation of one voxel: 7 voxels after one pass, 25 after two in an unbounded grid.
  const seed = new Uint8Array(125);
  seed[62] = 1;
  assert.equal(dilateMask3D(seed, [5, 5, 5], 1).reduce((sum, value) => sum + value, 0), 7);
  assert.equal(dilateMask3D(seed, [5, 5, 5], 2).reduce((sum, value) => sum + value, 0), 25);
});

test('largest-component filters keep one island per label', () => {
  // x line of 5: label 1 at 0 and 3..4, label 2 at 1.
  const labels = new Uint8Array([1, 2, 0, 1, 1]);
  assert.deepEqual(Array.from(keepLargestComponent(new Uint8Array([1, 0, 0, 1, 1]), [5, 1, 1])), [0, 0, 0, 1, 1]);
  assert.deepEqual(Array.from(perLabelLargestComponent(labels, [5, 1, 1], 2)), [0, 2, 0, 1, 1]);
  assert.deepEqual(Array.from(keepLargestComponent(new Uint8Array(5), [5, 1, 1])), [0, 0, 0, 0, 0]);
});

test('shared connected-component cleanup applies app policies', () => {
  const mask = new Uint8Array(27);
  mask[0] = 1;
  mask[1] = 1;
  mask[26] = 1;
  assert.deepEqual(Array.from(removeSmallComponents(mask, [3, 3, 3], 2)), [1, 1, ...new Array(25).fill(0)]);
  assert.deepEqual(Array.from(keepLargestComponentAndFill(mask, [3, 3, 3])), [1, 1, ...new Array(25).fill(0)]);
});
