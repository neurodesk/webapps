#!/usr/bin/env node --no-warnings
// Executed numerics tests for the inference worker's pure helpers
// (web/js/modules/inference-numerics.js), the sliding-window pipeline
// (web/js/inference-pipeline.js) and the registration math
// (web/js/modules/registration.js).
//
// Every expected value is a literal produced by an independent reference:
// numpy, SciPy or MONAI via scripts/reference_inference_numerics.py (the
// expression is quoted beside each literal), or an analytic / hand-worked
// result. Nothing here recomputes an expectation the way the app does.
//
// Layout: a volume is a flat x-fastest (NIfTI, Fortran-order) array, so the
// numpy twin is flat.reshape((X, Y, Z), order="F"); a model patch is C-order
// over [x, y, z].

import assert from 'node:assert/strict';
import {
  affinesClose,
  binaryMaskFromBuffer,
  collapseBinarySoftmaxLogits,
  dimsEqual,
  extractMultiChannelPatch,
  fOrderToNDHWC,
  foregroundMaskFromScalar,
  nonzeroZScore,
  normaliseSynthMorphExecutionProviders,
  projectedVolumeToLabels,
  robustNormalizeMasked,
  runDeepIslesMultiChannelPipeline,
  shouldUseZYXModelAxisOrder,
  softmaxStrokeChannel,
  zeroPadChannelsToPatchMultiple
} from '../web/js/modules/inference-numerics.js';
import {
  accumulatePatch3D,
  computeGaussianWeightMap3D,
  computePatchPositions3D,
  extractPatch3D,
  removeSmallComponents,
  connectedComponents3D,
  runInferencePipeline,
  sigmoid,
  zScoreNormalize
} from '../web/js/inference-pipeline.js';
import {
  integrateSvf,
  inverseWarpVolume,
  upsampleDisplacementField,
  warpVolume
} from '../web/js/modules/registration.js';

function assertClose(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= tolerance,
      `${label}[${i}]: got ${actual[i]}, expected ${expected[i]} (tolerance ${tolerance})`
    );
  }
}

function assertSame(actual, expected, label) {
  assert.deepEqual(Array.from(actual), expected, label);
}

// (i * multiplier) % modulus, the deterministic input pattern shared with
// the Python reference script's ramp().
function ramp(count, multiplier, modulus) {
  return Array.from({ length: count }, (_, i) => (i * multiplier) % modulus);
}

function sortedPositions(positions) {
  return positions
    .map(position => [...position])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

// ---- robustNormalizeMasked: percentile clip-and-scale inside a mask ----
{
  const data = Float32Array.from(ramp(60, 37, 211));
  const mask = Uint8Array.from({ length: 60 }, (_, i) => (i % 3 !== 0 ? 1 : 0));

  // numpy: lo, hi = np.percentile(data[mask], [10, 90], method="lower")
  const [lo, hi] = [18, 185];
  const kept = robustNormalizeMasked(data, mask, { lowerQuantile: 0.1, upperQuantile: 0.9 });
  assert.equal(kept.lo, lo, 'masked 10th percentile');
  assert.equal(kept.hi, hi, 'masked 90th percentile');
  assert.equal(kept.selected, 40, 'mask voxel count');
  // numpy: np.clip((data - lo) / (hi - lo), 0, 1)
  assertClose(kept.data, [
    0, 0.113772, 0.335329, 0.556886, 0.778443, 1, 0, 0.179641, 0.401198, 0.622754, 0.844311, 1,
    0.023952, 0.245509, 0.467066, 0.688623, 0.91018, 1, 0.08982, 0.311377, 0.532934, 0.754491, 0.976048, 0,
    0.155689, 0.377246, 0.598802, 0.820359, 1, 0, 0.221557, 0.443114, 0.664671, 0.886228, 1, 0.065868,
    0.287425, 0.508982, 0.730539, 0.952096, 0, 0.131737, 0.353293, 0.57485, 0.796407, 1, 0, 0.197605,
    0.419162, 0.640719, 0.862275, 1, 0.041916, 0.263473, 0.48503, 0.706587, 0.928144, 1, 0.107784, 0.329341
  ], 2e-6, 'robust normalisation, outside kept');

  // numpy: np.where(mask, np.clip((data - lo) / (hi - lo), 0, 1), 0)
  const zeroed = robustNormalizeMasked(data, mask, { lowerQuantile: 0.1, upperQuantile: 0.9, zeroOutside: true });
  assertClose(zeroed.data, [
    0, 0.113772, 0.335329, 0, 0.778443, 1, 0, 0.179641, 0.401198, 0, 0.844311, 1,
    0, 0.245509, 0.467066, 0, 0.91018, 1, 0, 0.311377, 0.532934, 0, 0.976048, 0,
    0, 0.377246, 0.598802, 0, 1, 0, 0, 0.443114, 0.664671, 0, 1, 0.065868,
    0, 0.508982, 0.730539, 0, 0, 0.131737, 0, 0.57485, 0.796407, 0, 0, 0.197605,
    0, 0.640719, 0.862275, 0, 0.041916, 0.263473, 0, 0.706587, 0.928144, 0, 0.107784, 0.329341
  ], 2e-6, 'robust normalisation, outside zeroed');

  // Defaults are the 1st and 99th percentile over every voxel when no mask
  // is given. numpy: np.percentile(ramp(300, 37, 211), [1, 99], method="lower")
  const all = Float32Array.from(ramp(300, 37, 211));
  const defaults = robustNormalizeMasked(all);
  assert.deepEqual([defaults.lo, defaults.hi], [1, 208], 'default 1st/99th percentiles');
  // numpy: np.clip((x - lo) / (hi - lo), 0, 1).astype(np.float32).sum()
  const sum = defaults.data.reduce((total, value) => total + value, 0);
  assertClose([sum], [150.101449], 1e-4, 'default normalisation sum');
  assert.equal(Math.min(...defaults.data), 0, 'values below the 1st percentile clip to 0');
  assert.equal(Math.max(...defaults.data), 1, 'values above the 99th percentile clip to 1');

  // maxSamples caps the percentile sample by striding the masked voxels.
  // numpy: np.percentile(data[mask][::4], [10, 90], method="lower")
  const strided = robustNormalizeMasked(data, mask, { lowerQuantile: 0.1, upperQuantile: 0.9, maxSamples: 10 });
  assert.deepEqual([strided.lo, strided.hi], [37, 125], 'strided percentiles');
  assert.equal(strided.sampleCount, 10, 'strided sample count');

  // A constant image has hi == lo; the range falls back to 1 instead of
  // dividing by zero, so every voxel normalises to 0.
  assertSame(robustNormalizeMasked(new Float32Array(5).fill(7)).data, [0, 0, 0, 0, 0], 'constant image');
  assert.throws(
    () => robustNormalizeMasked(data, new Uint8Array(60)),
    /empty normalization mask/,
    'an empty mask is rejected'
  );
}

// ---- nonzeroZScore: MONAI NormalizeIntensity(nonzero=True) ----
{
  const input = Float32Array.from([0, 4, 0, 10, 7, 0, 1, 2, 0, 12]);
  // MONAI: NormalizeIntensity(nonzero=True)(torch.tensor(input)[None])[0]
  // (mean 6 and population std 4.041452 over the six nonzero voxels; zero
  // background voxels stay zero).
  assertClose(nonzeroZScore(input), [0, -0.494872, 0, 0.989743, 0.247436, 0, -1.237179, -0.989743, 0, 1.484615], 2e-6, 'nonzero z-score');

  // Non-finite voxels neither enter the statistics nor survive as NaN.
  const withNaN = nonzeroZScore(Float32Array.from([0, 4, NaN, 10, 7, Infinity, 1, 2, 0, 12]));
  assertClose(withNaN, [0, -0.494872, 0, 0.989743, 0.247436, 0, -1.237179, -0.989743, 0, 1.484615], 2e-6, 'nonzero z-score ignores non-finite voxels');

  // All-zero input: nothing to normalise, nothing to divide by.
  assertSame(nonzeroZScore(new Float32Array(4)), [0, 0, 0, 0], 'all-zero channel');
  // A constant nonzero channel has std 0, which falls back to 1.
  assertSame(nonzeroZScore(Float32Array.from([0, 3, 3, 3])), [0, 0, 0, 0], 'constant nonzero channel');
}

// ---- zScoreNormalize: all voxels, population standard deviation ----
{
  const input = Float32Array.from([0, 4, 0, 10, 7, 0, 1, 2, 0, 12]);
  // numpy: (x - x.mean()) / x.std()
  assertClose(zScoreNormalize(input), [
    -0.838344, 0.093149, -0.838344, 1.490389, 0.791769, -0.838344, -0.60547, -0.372597, -0.838344, 1.956135
  ], 2e-6, 'whole-volume z-score');
}

// ---- softmaxStrokeChannel and the 2-channel logit collapse ----
{
  const background = [0, 2, -1.5, 800, -800, 3.25];
  const stroke = [0, -1, 4, -800, 800, 3];
  const raw = Float32Array.from([...background, ...stroke]);

  // scipy: softmax(np.stack([background, stroke]), axis=0)[1]
  const expectedStroke = [0.5, 0.0474259, 0.9959299, 0, 1, 0.4378235];
  assertClose(softmaxStrokeChannel(raw, 6, 2, 1), expectedStroke, 2e-7, 'stroke-channel softmax');
  // scipy: softmax(np.stack([background, stroke]), axis=0)[0]
  assertClose(softmaxStrokeChannel(raw, 6, 2, 0), [0.5, 0.9525741, 0.0040701, 1, 0, 0.5621765], 2e-7, 'background-channel softmax');
  // scipy: expit(stroke): a 1-channel output is a plain sigmoid.
  assertClose(softmaxStrokeChannel(Float32Array.from(stroke), 6), [0.5, 0.2689414, 0.9820138, 0, 1, 0.9525741], 2e-7, 'one-channel sigmoid');
  // scipy: softmax(np.stack([background, stroke, ones]), axis=0)[2]
  const three = Float32Array.from([...background, ...stroke, 1, 1, 1, 1, 1, 1]);
  assertClose(softmaxStrokeChannel(three, 6, 3, 2), [0.5761169, 0.2594965, 0.047242, 0, 0, 0.0559384], 2e-7, 'three-channel softmax');
  assert.throws(() => softmaxStrokeChannel(new Float32Array(7), 6), /Unexpected DeepISLES output length 7/);

  // SynthStroke route: the worker collapses [bg, stroke] logits to
  // stroke - bg and the pipeline applies a sigmoid. That must equal the
  // stroke softmax probability above; reading the output as a 1-channel
  // logit instead is the whole-brain-coverage regression.
  const collapsed = collapseBinarySoftmaxLogits(raw, 6, 'logits');
  assertClose(sigmoid(collapsed), expectedStroke, 2e-7, 'sigmoid(stroke - background) == softmax stroke');
  const oneChannel = Float32Array.from(stroke);
  assert.equal(collapseBinarySoftmaxLogits(oneChannel, 6, 'logits'), oneChannel, '1-channel logits pass through');
  assert.throws(
    () => collapseBinarySoftmaxLogits(new Float32Array(18), 6, 'logits'),
    /Unexpected logits length 18; expected 6 \(1-channel\) or 12 \(binary softmax\)/
  );
}

// ---- layout helpers ----
{
  // numpy: np.arange(24).reshape((2, 3, 4), order="F").ravel(order="C")
  assertSame(
    fOrderToNDHWC(Float32Array.from({ length: 24 }, (_, i) => i), [2, 3, 4]),
    [0, 6, 12, 18, 2, 8, 14, 20, 4, 10, 16, 22, 1, 7, 13, 19, 3, 9, 15, 21, 5, 11, 17, 23],
    'x-fastest volume to row-major tensor'
  );

  const dims = [5, 4, 3];
  const channelA = Float32Array.from(ramp(60, 7, 61));
  const channelB = Float32Array.from(ramp(60, 11, 59));
  // numpy: np.stack([a[2:5, 1:3, 0:2], b[2:5, 1:3, 0:2]]).ravel(order="C")
  assertSame(
    extractMultiChannelPatch([channelA, channelB], dims, [2, 1, 0], [3, 2, 2]),
    [49, 6, 23, 41, 56, 13, 30, 48, 2, 20, 37, 55, 18, 2, 14, 57, 29, 13, 25, 9, 40, 24, 36, 20],
    'two-channel NCDHW patch'
  );

  // numpy: padded = np.pad(a, ((0, 3), (0, 0), (0, 1)))  -> shape (8, 4, 4)
  const padded = zeroPadChannelsToPatchMultiple([channelA, channelB], dims, [4, 4, 4]);
  assert.deepEqual(padded.dims, [8, 4, 4], 'padded dims');
  const paddedA = padded.channels[0];
  const at = (x, y, z) => paddedA[x + y * 8 + z * 32];
  // numpy: [padded.sum(), padded[4, 3, 2], padded[7, 3, 3], padded[5, 0, 0]]
  assert.deepEqual(
    [paddedA.reduce((total, value) => total + value, 0), at(4, 3, 2), at(7, 3, 3), at(5, 0, 0)],
    [1776, 47, 0, 0],
    'padding keeps voxels in place and fills with zeros'
  );
  const untouched = zeroPadChannelsToPatchMultiple([channelA], [4, 4, 4], [4, 4, 4]);
  assert.equal(untouched.channels[0], channelA, 'a patch-sized volume is not copied');
}

// ---- small decision helpers (hand-worked) ----
{
  assert.deepEqual(normaliseSynthMorphExecutionProviders(undefined), ['wasm'], 'no providers -> wasm');
  assert.deepEqual(normaliseSynthMorphExecutionProviders([]), ['wasm'], 'empty list -> wasm');
  assert.deepEqual(normaliseSynthMorphExecutionProviders(['webgpu']), ['webgpu', 'wasm'], 'wasm is always the fallback');
  assert.deepEqual(
    normaliseSynthMorphExecutionProviders([{ name: 'webgpu' }, 'webgpu', '', null, 'wasm', 'webnn']),
    ['webgpu', 'wasm', 'webnn'],
    'object entries are read by name, duplicates and blanks dropped, order kept'
  );

  assert.equal(shouldUseZYXModelAxisOrder({ modelAxisOrder: 'zyx' }, [10, 10, 10], [4, 4, 4]), true);
  assert.equal(shouldUseZYXModelAxisOrder({}, [10, 10, 10], [4, 4, 4]), false);
  assert.equal(shouldUseZYXModelAxisOrder(undefined, [10, 10, 10], [4, 4, 4]), false);
  const conditional = { modelAxisOrder: 'zyx-if-x-short-z-long' };
  assert.equal(shouldUseZYXModelAxisOrder(conditional, [3, 10, 8], [4, 4, 4]), true, 'x shorter than patch, z long enough');
  assert.equal(shouldUseZYXModelAxisOrder(conditional, [4, 10, 8], [4, 4, 4]), false, 'x fits the patch');
  assert.equal(shouldUseZYXModelAxisOrder(conditional, [3, 10, 3], [4, 4, 4]), false, 'z too short as well');

  assert.equal(dimsEqual([1, 2, 3], [1, 2, 3]), true);
  assert.equal(dimsEqual([1, 2, 3], [1, 2, 4]), false);
  assert.equal(dimsEqual([1, 2, 3], [1, 2]), false);
  const affine = [[1, 0, 0, -80], [0, 1, 0, -90], [0, 0, 1, -70], [0, 0, 0, 1]];
  const nudged = affine.map(row => [...row]);
  nudged[1][3] += 0.0005;
  assert.equal(affinesClose(affine, nudged, 1e-3), true, 'half a micron apart is the same grid');
  nudged[1][3] += 0.01;
  assert.equal(affinesClose(affine, nudged, 1e-3), false, '10 microns apart is a different grid');
  assert.equal(affinesClose(affine, null), false);

  // foregroundMaskFromScalar: voxels strictly above 5 % of the maximum.
  const foreground = foregroundMaskFromScalar(Float32Array.from([0, 5, 5.1, 100, -3, 50]), 0.05);
  assertSame(foreground.mask, [0, 0, 1, 1, 0, 1], 'foreground above 5 % of max (threshold 5)');
  assert.equal(foreground.count, 3);
  assert.throws(() => foregroundMaskFromScalar(new Float32Array(4)), /foreground mask is empty/);

  // binaryMaskFromBuffer: any nonzero byte is foreground; dims must match.
  const binary = binaryMaskFromBuffer(Uint8Array.from([0, 2, 0, 255, 1, 0, 0, 0]).buffer, [2, 2, 2], [2, 2, 2], 'mask');
  assertSame(binary.mask, [0, 1, 0, 1, 1, 0, 0, 0], 'binarised mask');
  assert.equal(binary.count, 3);
  assert.equal(binaryMaskFromBuffer(null, null, [2, 2, 2], 'mask'), null, 'no mask is allowed');
  assert.throws(() => binaryMaskFromBuffer(new ArrayBuffer(8), [2, 2], [2, 2, 2], 'mask'), /mask dims must be \[X,Y,Z\]/);
  assert.throws(() => binaryMaskFromBuffer(new ArrayBuffer(8), [2, 2, 3], [2, 2, 2], 'mask'), /mask dims 2x2x3 must match registration grid 2x2x2/);
  assert.throws(() => binaryMaskFromBuffer(new ArrayBuffer(7), [2, 2, 2], [2, 2, 2], 'mask'), /mask length 7 != 8/);
  assert.throws(() => binaryMaskFromBuffer(new ArrayBuffer(8), [2, 2, 2], [2, 2, 2], 'mask'), /mask is empty/);

  // projectedVolumeToLabels: label maps round and keep labels above 255;
  // binary masks threshold at 0.5.
  const projected = Float32Array.from([0, 0.4, 0.6, 1, 399.6, -2, 17.2]);
  const binaryOut = projectedVolumeToLabels(projected);
  assert.ok(binaryOut instanceof Uint8Array);
  assertSame(binaryOut, [0, 0, 1, 1, 1, 0, 1], 'binary projection');
  const labels16 = projectedVolumeToLabels(projected, { labelMap: true, labelDataType: 'uint16' });
  assert.ok(labels16 instanceof Uint16Array, 'Schaefer labels need 16 bits');
  assertSame(labels16, [0, 0, 1, 1, 400, 0, 17], 'label-map projection keeps integer labels');
  assert.ok(projectedVolumeToLabels(projected, { labelMap: true }) instanceof Uint8Array, 'label maps default to 8 bits');
}

// ---- sliding window: patch positions (MONAI dense_patch_slices) ----
{
  // MONAI: dense_patch_slices(image, roi, tuple(int(r * (1 - overlap)) for r in roi))
  assert.deepEqual(
    sortedPositions(computePatchPositions3D([10, 7, 5], [4, 4, 4], 0.25)),
    [
    [0, 0, 0], [0, 0, 1], [0, 3, 0], [0, 3, 1], [3, 0, 0], [3, 0, 1],
    [3, 3, 0], [3, 3, 1], [6, 0, 0], [6, 0, 1], [6, 3, 0], [6, 3, 1]
  ],
    '10x7x5 volume, 4-voxel patches, overlap 0.25'
  );
  assert.deepEqual(
    sortedPositions(computePatchPositions3D([8, 4, 4], [4, 4, 4], 0.5)),
    [[0, 0, 0], [2, 0, 0], [4, 0, 0]],
    '8x4x4 volume, overlap 0.5'
  );
  // The production SynthStroke geometry: MNI160 grid, 128-voxel patches.
  assert.deepEqual(
    sortedPositions(computePatchPositions3D([160, 160, 192], [128, 128, 128], 0.25)),
    [[0, 0, 0], [0, 0, 64], [0, 32, 0], [0, 32, 64], [32, 0, 0], [32, 0, 64], [32, 32, 0], [32, 32, 64]],
    'MNI160 grid, 128-voxel patches, overlap 0.25'
  );
  // The DeepISLES geometry on a padded 384x384x256 grid.
  assert.equal(
    computePatchPositions3D([384, 384, 256], [192, 192, 128], 0.625).length,
    64,
    'DeepISLES patch count'
  );
}

// ---- sliding window: Gaussian importance map (MONAI compute_importance_map) ----
{
  // MONAI: compute_importance_map((4, 4, 4), mode="gaussian", sigma_scale=2.0)
  // (sigma = 2.0 * 4 = 8 voxels, the app's fixed sigma).
  const weights = computeGaussianWeightMap3D(4, 4, 4, 8);
  assertClose(weights.subarray(0, 4), [0.948632, 0.9635708, 0.9635708, 0.948632], 2e-7, 'importance map first row');
  // [map[0, 0, 0], map[1, 2, 1]]
  assertClose([weights[0], weights[1 * 16 + 2 * 4 + 1]], [0.948632, 0.9941578], 2e-7, 'importance map corner and centre');
  // MONAI: compute_importance_map((3, 3, 3), mode="gaussian", sigma_scale=1/3)
  assertClose(computeGaussianWeightMap3D(3, 3, 3, 1), [
    0.2231302, 0.3678795, 0.2231302, 0.3678795, 0.6065307, 0.3678795, 0.2231302, 0.3678795, 0.2231302, 0.3678795, 0.6065307, 0.3678795,
    0.6065307, 1, 0.6065307, 0.3678795, 0.6065307, 0.3678795, 0.2231302, 0.3678795, 0.2231302, 0.3678795, 0.6065307, 0.3678795,
    0.2231302, 0.3678795, 0.2231302
  ], 2e-7, 'importance map, sigma 1');
}

// ---- sliding window: Gaussian blending (MONAI sliding_window_inference) ----
const SLIDING_DIMS = [8, 4, 4];
const PATCH = [4, 4, 4];
// numpy: np.linspace(-2.0, 3.0, 64, dtype=np.float32)
const POSITION_GAIN = Float32Array.from({ length: 64 }, (_, i) => -2 + (5 * i) / 63);
{
  // numpy: (ramp(128, 29, 127) / 127.0 - 0.5).astype(np.float32)
  const volume = Float32Array.from(ramp(128, 29, 127), value => value / 127 - 0.5);
  // Stand-in model whose logit depends on the position inside the patch, so
  // overlapping patches disagree and the blend weights decide the result.
  // MONAI predictor: torch.sigmoid(batch * 4.0 * gain + 0.25 * gain)
  const logitsFor = patch => patch.map((value, i) => value * 4 * POSITION_GAIN[i] + 0.25 * POSITION_GAIN[i]);

  // MONAI: sliding_window_inference(volume[None, None], roi_size=(4, 4, 4),
  //   sw_batch_size=1, predictor=predictor, overlap=0.5, mode="gaussian",
  //   sigma_scale=2.0)[0, 0].ravel(order="F")
  const expectedProbability = [
    0.970688, 0.648137, 0.486213, 0.589866, 0.381854, 0.406664, 0.463678, 0.762202, 0.067871, 0.652769, 0.553148, 0.560466,
    0.429325, 0.63883, 0.304685, 0.473855, 0.235112, 0.457778, 0.514063, 0.393344, 0.490155, 0.716337, 0.125147, 0.140145,
    0.455266, 0.559968, 0.534028, 0.245007, 0.489955, 0.711522, 0.921598, 0.018643, 0.731433, 0.436609, 0.385938, 0.584921,
    0.60316, 0.506888, 0.644158, 0.971697, 0.875137, 0.525077, 0.457499, 0.668772, 0.553374, 0.374923, 0.5619, 0.930963,
    0.063543, 0.503945, 0.500119, 0.692333, 0.500684, 0.270916, 0.3692, 0.773315, 0.205026, 0.37548, 0.452076, 0.553923,
    0.554565, 0.818795, 0.146775, 0.357261, 0.213961, 0.283786, 0.597994, 0.416388, 0.452154, 0.62281, 0.821631, 0.145461,
    0.494751, 0.441403, 0.464914, 0.318665, 0.519385, 0.62552, 0.820216, 0.02558, 0.694082, 0.503718, 0.513593, 0.762199,
    0.486821, 0.463132, 0.744262, 0.988607, 0.771993, 0.456429, 0.540903, 0.803297, 0.435513, 0.25675, 0.544563, 0.95184,
    0.032004, 0.637989, 0.528026, 0.607057, 0.418889, 0.362888, 0.388238, 0.662205, 0.142561, 0.407005, 0.527121, 0.495194,
    0.473261, 0.7018, 0.197938, 0.297068, 0.350019, 0.552046, 0.473687, 0.303369, 0.507622, 0.744431, 0.946196, 0.055426,
    0.52905, 0.58766, 0.579045, 0.180533, 0.447715, 0.663713, 0.909912, 0.00522
  ];
  const probabilitySum = new Float32Array(128);
  const weightSum = new Float32Array(128);
  const weights = computeGaussianWeightMap3D(4, 4, 4, 8);
  for (const position of computePatchPositions3D(SLIDING_DIMS, PATCH, 0.5)) {
    const patch = extractPatch3D(volume, SLIDING_DIMS, position, PATCH);
    accumulatePatch3D(probabilitySum, weightSum, SLIDING_DIMS, position, sigmoid(logitsFor(patch)), weights, PATCH);
  }
  const blended = probabilitySum.map((value, i) => value / weightSum[i]);
  assertClose(blended, expectedProbability, 5e-6, 'Gaussian-blended probability map');

  // The same run through the whole pipeline: (blended >= 0.5) and its
  // min / max / mean.
  const seen = [];
  const result = await runInferencePipeline(
    { data: volume, dims: SLIDING_DIMS, patchSize: PATCH },
    async (patch, patchDims) => {
      seen.push(patchDims.join('x'));
      return logitsFor(patch);
    },
    { overlap: 0.5, threshold: 0.5, minComponentSize: 1, normalizeInput: false }
  );
  assert.deepEqual(seen, ['4x4x4', '4x4x4', '4x4x4'], 'three overlapping patches are inferred');
  assertSame(result.labels, [
    1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1,
    0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0,
    0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1,
    1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1,
    0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1,
    1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0,
    0, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 1,
    0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 1,
    0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 0,
    1, 1, 1, 0, 0, 1, 1, 0
  ], 'thresholded blended labels');
  const [min, max, mean] = [0.00522, 0.988607, 0.501921];
  assertClose([result.probStats.min, result.probStats.max, result.probStats.mean], [min, max, mean], 5e-6, 'blended probability statistics');
  assert.deepEqual(result.dims, SLIDING_DIMS);

  // Test-time augmentation on one patch. numpy: the mean over the 8 axis-flip
  // combinations of np.flip(predictor(np.flip(patch, axes)), axes).
  const single = volume.slice(0, 64);
  // volume[:4] of the (8, 4, 4) array, flattened x-fastest.
  const firstHalf = Float32Array.from({ length: 64 }, (_, i) => volume[(i % 4) + Math.floor(i / 4) * 8]);
  assert.notDeepEqual(Array.from(single), Array.from(firstHalf), 'the 4x4x4 sub-volume is not a prefix of the flat array');
  let calls = 0;
  const withTta = await runInferencePipeline(
    { data: firstHalf, dims: PATCH, patchSize: PATCH },
    async patch => {
      calls++;
      return logitsFor(patch);
    },
    { threshold: 0.5, minComponentSize: 1, normalizeInput: false, testTimeAugmentation: true }
  );
  assert.equal(calls, 8, 'TTA runs the identity plus 7 flips');
  assertSame(withTta.labels, [
    0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0,
    1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1,
    1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0,
    1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1,
    1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0,
    0, 1, 1, 0
  ], 'TTA-averaged labels');
  assertClose(
    [withTta.probStats.min, withTta.probStats.max, withTta.probStats.mean],
    [0.347153, 0.672749, 0.509395],
    5e-6,
    'TTA-averaged probability statistics'
  );
  const withoutTta = await runInferencePipeline(
    { data: firstHalf, dims: PATCH, patchSize: PATCH },
    async patch => logitsFor(patch),
    { threshold: 0.5, minComponentSize: 1, normalizeInput: false }
  );
  assertSame(withoutTta.labels, [
    1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0,
    0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1,
    0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0,
    0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1,
    0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
    1, 1, 1, 0
  ], 'labels without TTA');
}

// ---- DeepISLES two-channel route (MONAI normalise + sliding window) ----
{
  // numpy: adc = ramp(128, 31, 113); adc[::5] = 0
  //        trace = ramp(128, 17, 101); trace[::7] = 0
  const adc = Float32Array.from(ramp(128, 31, 113), (value, i) => (i % 5 === 0 ? 0 : value));
  const trace = Float32Array.from(ramp(128, 17, 101), (value, i) => (i % 7 === 0 ? 0 : value));
  // MONAI: channels = NormalizeIntensity(nonzero=True, channel_wise=True)(stack)
  //   predictor: softmax([trace * 0.25, adc * gain - trace * 0.5], dim=1)[:, 1:2]
  //   sliding_window_inference(channels[None], roi_size=(4, 4, 4),
  //     sw_batch_size=1, overlap=0.5, mode="gaussian", sigma_scale=2.0) >= 0.5
  const patchShapes = [];
  const result = await runDeepIslesMultiChannelPipeline(
    { channels: [adc, trace], dims: SLIDING_DIMS, patchSize: PATCH, channelOrder: ['ADC', 'TRACE'] },
    async (patch, patchDims) => {
      patchShapes.push(`${patch.length}/${patchDims.join('x')}`);
      const raw = new Float32Array(128);
      for (let i = 0; i < 64; i++) {
        const adcValue = patch[i];
        const traceValue = patch[64 + i];
        raw[i] = traceValue * 0.25;
        raw[64 + i] = adcValue * POSITION_GAIN[i] - traceValue * 0.5;
      }
      return softmaxStrokeChannel(raw, 64, 2, 1);
    },
    { overlap: 0.5, threshold: 0.5, minComponentSize: 1 }
  );
  assert.deepEqual(patchShapes, ['128/4x4x4', '128/4x4x4', '128/4x4x4'], 'each patch carries two channels');
  assertSame(result.labels, [
    1, 1, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0,
    1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0,
    1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 1,
    1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1,
    1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0,
    1, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0,
    0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0,
    0, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0,
    1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1,
    1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 1, 1, 1
  ], 'DeepISLES seed labels');
  assertClose([result.probStats.max], [0.980481], 5e-6, 'DeepISLES peak probability');
  assert.deepEqual(result.dims, SLIDING_DIMS);
}

// ---- connected components (scipy.ndimage.label, 26-connectivity) ----
{
  const dims = [5, 4, 3];
  // numpy: ((ramp(60, 23, 7) < 3) & (np.arange(60) % 4 != 1)).astype(np.uint8)
  const mask = Uint8Array.from(ramp(60, 23, 7), (value, i) => (value < 3 && i % 4 !== 1 ? 1 : 0));
  assertSame(mask, [
    1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
    0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0
  ], 'test mask matches the reference input');
  // scipy: labels, count = ndimage.label(volume, structure=np.ones((3, 3, 3)))
  //        sizes = ndimage.sum(volume, labels, index=range(1, count + 1))
  const { labels, numComponents } = connectedComponents3D(mask, dims);
  assert.equal(numComponents, 2, 'component count');
  const sizes = new Array(numComponents).fill(0);
  for (const label of labels) {
    if (label > 0) sizes[label - 1]++;
  }
  assert.deepEqual(sizes.sort((a, b) => a - b), [1, 18], 'component sizes');
  // scipy: np.isin(labels, np.flatnonzero(sizes >= 3) + 1)
  const keptLarge = [
    0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1,
    0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1,
    1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0
  ];
  assertSame(removeSmallComponents(mask, dims, 3), keptLarge, 'components under 3 voxels removed');
  // The size limit is inclusive: the 18-voxel component survives a minimum
  // of 18 and is dropped at 19.
  assertSame(removeSmallComponents(mask, dims, 18), keptLarge, 'an 18-voxel component meets a minimum of 18');
  assertSame(removeSmallComponents(mask, dims, 19), new Array(60).fill(0), 'and fails a minimum of 19');
}

// ---- warpVolume (scipy.ndimage.map_coordinates, order=1, constant 0) ----
{
  const dims = [4, 3, 2];
  // numpy: (ramp(24, 5, 23) + 1).reshape((4, 3, 2), order="F")
  const volume = Float32Array.from(ramp(24, 5, 23), value => value + 1);
  const field = (dx, dy, dz) => {
    const out = new Float32Array(24 * 3);
    for (let i = 0; i < 24; i++) {
      out[i * 3] = dx;
      out[i * 3 + 1] = dy;
      out[i * 3 + 2] = dz;
    }
    return out;
  };

  // Integer shift: output(x, y, z) = input(x + 1, y - 1, z), zero where that
  // leaves the grid. scipy: map_coordinates(volume, grid + [1, -1, 0],
  //   order=1, mode="constant", cval=0).ravel(order="F")
  assertSame(warpVolume(volume, dims, field(1, -1, 0), dims), [0, 0, 0, 0, 6, 11, 16, 0, 3, 8, 13, 0, 0, 0, 0, 0, 20, 2, 7, 0, 17, 22, 4, 0], 'integer-voxel shift');

  // Half-voxel shift along x: the mean of each voxel and its +x neighbour,
  // e.g. (1 + 6) / 2 = 3.5 at the origin, and 0 for the last column, whose
  // sample point x = 3.5 lies outside the grid. scipy as above with [0.5, 0, 0].
  assertClose(warpVolume(volume, dims, field(0.5, 0, 0), dims), [
    3.5, 8.5, 13.5, 0, 12, 5.5, 10.5, 0, 20.5, 14, 7.5, 0,
    17.5, 11, 4.5, 0, 14.5, 19.5, 13, 0, 11.5, 16.5, 10, 0
  ], 1e-6, 'half-voxel shift');

  // The mirror image, shifting by -0.5: the first column samples x = -0.5,
  // outside the grid, and is 0. scipy as above with [-0.5, 0, 0].
  assertClose(
    warpVolume(volume, dims, field(-0.5, 0, 0), dims),
    [
      0, 3.5, 8.5, 13.5, 0, 12, 5.5, 10.5, 0, 20.5, 14, 7.5,
      0, 17.5, 11, 4.5, 0, 14.5, 19.5, 13, 0, 11.5, 16.5, 10
    ],
    1e-6,
    'negative half-voxel shift'
  );

  // Spatially varying fractional displacement that stays inside the grid:
  // dx = 0.5 - 0.25 x, dy = 0.5 (1 - y), dz = 0.5 - z, stored channel-last
  // in row-major [x, y, z] order. numpy: np.moveaxis(varying, 0, -1).ravel()
  const varying = Float32Array.from([
    0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0, 0.5, 0.5, 0, -0.5,
    0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.25, 0.5, 0.5, 0.25, 0.5, -0.5,
    0.25, 0, 0.5, 0.25, 0, -0.5, 0.25, -0.5, 0.5, 0.25, -0.5, -0.5,
    0, 0.5, 0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0, 0, -0.5,
    0, -0.5, 0.5, 0, -0.5, -0.5, -0.25, 0.5, 0.5, -0.25, 0.5, -0.5,
    -0.25, 0, 0.5, -0.25, 0, -0.5, -0.25, -0.5, 0.5, -0.25, -0.5, -0.5
  ]);
  assertClose(warpVolume(volume, dims, varying, dims), [
    11.875, 11.3125, 10.75, 10.1875, 13.25, 11.25, 15, 10.125, 14.625, 14.0625, 13.5, 8.625,
    11.875, 11.3125, 10.75, 10.1875, 13.25, 11.25, 15, 10.125, 14.625, 14.0625, 13.5, 8.625
  ], 1e-6, 'trilinear warp, varying field');

  // inverseWarpVolume undoes an integer shift exactly inside the overlap:
  // warp samples input(x + 1), so the inverse of that result puts voxel x
  // back from x - 1; the first column has no source and is 0 (hand-worked).
  const shifted = warpVolume(volume, dims, field(1, 0, 0), dims);
  const restored = inverseWarpVolume(shifted, dims, field(1, 0, 0), dims, { mode: 'nearest' });
  const expectedRestored = Array.from(volume, (value, i) => (i % 4 === 0 ? 0 : value));
  assertSame(restored, expectedRestored, 'inverse warp of an integer shift');
}

// ---- upsampleDisplacementField (scipy.ndimage.zoom, order=1) ----
{
  // numpy: field = (ramp(36, 13, 17) / 4).reshape((2, 3, 2, 3))
  const field = Float32Array.from(ramp(36, 13, 17), value => value / 4);
  // scipy, per channel c: ndimage.zoom(field[..., c], 2, order=1,
  //   grid_mode=False) * (target[c] / source[c])
  // Displacements are in voxels, so doubling the grid doubles them.
  const up = upsampleDisplacementField(field, [2, 3, 2], [4, 6, 4]);
  const sums = [0, 0, 0];
  for (let i = 0; i < up.length; i++) sums[i % 3] += up[i];
  assertClose(sums, [381.6, 373.2, 385.2], 1e-3, 'upsampled field channel sums');
  const at = (x, y, z, c) => up[((x * 6 + y) * 4 + z) * 3 + c];
  // [up[0, 0, 0, 0], up[3, 5, 3, 2], up[1, 2, 1, 1], up[2, 4, 3, 0]]
  assertClose(
    [at(0, 0, 0, 0), at(3, 5, 3, 2), at(1, 2, 1, 1), at(2, 4, 3, 0)],
    [0, 6.5, 3.488889, 4.066667],
    2e-6,
    'upsampled field samples'
  );
}

// ---- integrateSvf: flows with a closed-form solution ----
{
  const fieldFrom = (dims, velocity) => {
    const [X, Y, Z] = dims;
    const out = new Float32Array(X * Y * Z * 3);
    for (let x = 0; x < X; x++) {
      for (let y = 0; y < Y; y++) {
        for (let z = 0; z < Z; z++) {
          const v = velocity(x, y, z);
          const i = ((x * Y + y) * Z + z) * 3;
          out[i] = v[0];
          out[i + 1] = v[1];
          out[i + 2] = v[2];
        }
      }
    }
    return out;
  };

  // A constant velocity is a pure translation: the flow after unit time is
  // that same vector everywhere, exactly (all values are dyadic).
  {
    const dims = [5, 4, 3];
    const disp = integrateSvf(fieldFrom(dims, () => [1.5, -0.75, 0.25]), dims, 7);
    for (let i = 0; i < disp.length; i += 3) {
      assert.deepEqual([disp[i], disp[i + 1], disp[i + 2]], [1.5, -0.75, 0.25], `constant translation at voxel ${i / 3}`);
    }
  }

  // Linear contraction v(x) = a (x - c) per axis. The ODE x' = a (x - c)
  // has the solution c + (x - c) e^a, so the displacement is
  // (x - c) (e^a - 1). numpy: np.exp([-0.3, -0.1, -0.5]) - 1
  {
    const dims = [9, 7, 5];
    const centre = [4, 3, 2];
    const rates = [-0.3, -0.1, -0.5];
    const factors = [-0.2591818, -0.0951626, -0.3934693];
    const disp = integrateSvf(
      fieldFrom(dims, (x, y, z) => [rates[0] * (x - centre[0]), rates[1] * (y - centre[1]), rates[2] * (z - centre[2])]),
      dims,
      7
    );
    let worst = 0;
    for (let x = 0; x < 9; x++) {
      for (let y = 0; y < 7; y++) {
        for (let z = 0; z < 5; z++) {
          const i = ((x * 7 + y) * 5 + z) * 3;
          const offset = [x - 4, y - 3, z - 2];
          for (let c = 0; c < 3; c++) {
            worst = Math.max(worst, Math.abs(disp[i + c] - offset[c] * factors[c]));
          }
        }
      }
    }
    // Scaling and squaring with 7 steps computes (1 + a / 128)^128 instead
    // of e^a, a relative error below 1e-3 for these rates.
    assert.ok(worst < 2e-3, `contraction flow error ${worst} must stay below 2e-3 voxels`);

    // Fewer steps integrate less accurately: with 0 steps the "flow" is
    // just the velocity itself, far from the closed form.
    const unintegrated = integrateSvf(
      fieldFrom(dims, (x, y, z) => [rates[0] * (x - centre[0]), 0, 0]),
      dims,
      0
    );
    const edge = ((8 * 7 + 3) * 5 + 2) * 3;
    assertClose([unintegrated[edge]], [-1.2], 1e-6, 'nbSteps = 0 returns the velocity (a (x - c) = -0.3 * 4)');
  }

  // Rotation about z: v = theta * (-(y - c), (x - c), 0) integrates to a
  // rotation by theta. Displacement = R(theta) r - r.
  // numpy: [np.cos(0.3), np.sin(0.3)]
  {
    const dims = [13, 13, 3];
    const theta = 0.3;
    const [cos, sin] = [0.9553365, 0.2955202];
    const disp = integrateSvf(
      fieldFrom(dims, (x, y) => [-theta * (y - 6), theta * (x - 6), 0]),
      dims,
      7
    );
    let worst = 0;
    let compared = 0;
    for (let x = 0; x < 13; x++) {
      for (let y = 0; y < 13; y++) {
        const rx = x - 6;
        const ry = y - 6;
        // Stay away from the border, where clamped sampling bends the flow.
        if (Math.hypot(rx, ry) > 3) continue;
        const i = ((x * 13 + y) * 3 + 1) * 3;
        worst = Math.max(
          worst,
          Math.abs(disp[i] - (cos * rx - sin * ry - rx)),
          Math.abs(disp[i + 1] - (sin * rx + cos * ry - ry)),
          Math.abs(disp[i + 2])
        );
        compared++;
      }
    }
    assert.equal(compared, 29, 'voxels within 3 of the rotation centre');
    assert.ok(worst < 2e-3, `rotation flow error ${worst} must stay below 2e-3 voxels`);
  }
}

console.log('inference numerics OK: expectations from numpy / SciPy / MONAI / closed forms.');
