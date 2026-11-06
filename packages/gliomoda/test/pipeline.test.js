import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundingBox,
  checkAtlasGrid,
  f16round,
  flip,
  gaussianWeights,
  mirrorCombinations,
  modeFor,
  nonzeroMask,
  normalize,
  predictLogits,
  regionLabels,
  segmentGlioma,
  windowStarts,
} from '../src/pipeline.js';
import { caseName, compareLabels, volumeRows, volumeTable } from '../src/results.js';

const atlasAffine = [[-1, 0, 0, 0], [0, -1, 0, 239], [0, 0, 1, 0], [0, 0, 0, 1]];

test('window origins follow compute_steps_for_sliding_window, halves rounding to even', () => {
  assert.deepEqual(windowStarts(110, 64), [0, 23, 46]);
  assert.deepEqual(windowStarts(128, 128), [0]);
  assert.deepEqual(windowStarts(213, 128), [0, 42, 85]);
  assert.deepEqual(windowStarts(140, 128), [0, 12]);
});

test('float16 rounding is nearest, ties to even, with subnormals and overflow', () => {
  assert.equal(f16round(1 + 2 ** -11), 1);
  assert.equal(f16round(1 + 3 * 2 ** -11), 1 + 2 ** -9);
  assert.equal(f16round(2 ** -25), 0);
  assert.equal(f16round(3 * 2 ** -26), 2 ** -24);
  assert.equal(f16round(65519), 65504);
  assert.equal(f16round(-65520), -Infinity);
  assert.equal(f16round(0.1), 0.0999755859375);
  if (Math.f16round) {
    for (let i = 0; i < 200000; i++) {
      const x = (Math.random() - 0.5) * 2 ** (Math.random() * 40 - 28);
      assert.equal(f16round(x), Math.f16round(x), String(x));
    }
  }
});

test('mirror passes come in nnU-Net order', () => {
  assert.deepEqual(mirrorCombinations([0, 1, 2]), [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]]);
  assert.deepEqual(mirrorCombinations([]), []);
});

test('a flip reverses the chosen axes and undoes itself', () => {
  const patch = [2, 3, 4];
  const tile = Float32Array.from({ length: 2 * 24 }, (_, i) => i);
  const flipped = flip(tile, 2, patch, [0, 2]);
  assert.equal(flipped[0], tile[(1 * 3 + 0) * 4 + 3]);
  assert.equal(flipped[24], tile[24 + (1 * 3 + 0) * 4 + 3]);
  assert.deepEqual(flip(flipped, 2, patch, [0, 2]), tile);
});

test('the Gaussian peaks at 10 in the patch centre and has no zero weight', () => {
  const weights = gaussianWeights([128, 160, 112]);
  assert.equal(weights[(64 * 160 + 80) * 112 + 56], 10);
  assert.ok(weights.every((w) => w > 0));
});

test('the nonzero mask fills enclosed holes but not open ones', () => {
  const shape = [5, 5, 5];
  const data = new Float32Array(125);
  for (let z = 1; z < 4; z++) for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) data[(z * 5 + y) * 5 + x] = 1;
  data[(2 * 5 + 2) * 5 + 2] = 0;
  const mask = nonzeroMask([data], shape);
  assert.equal(mask[(2 * 5 + 2) * 5 + 2], 1);
  assert.equal(mask.reduce((a, b) => a + b, 0), 27);
  assert.deepEqual(boundingBox(mask, shape), { lo: [1, 1, 1], hi: [4, 4, 4], shape: [3, 3, 3] });
});

test('normalization is a z-score inside the mask and zero outside', () => {
  const out = normalize(Float32Array.of(1, 3, 100), Uint8Array.of(1, 1, 0));
  assert.deepEqual([...out], [-1, 1, 0]);
});

test('labels follow regions_class_order, later regions overwriting earlier ones', () => {
  const voxels = 4;
  const logits = Float32Array.of(
    -1, 1, 1, 1,
    -1, -1, 1, 1,
    -1, -1, -1, 1,
  );
  assert.deepEqual([...regionLabels(logits, voxels, [2, 1, 3])], [0, 2, 1, 3]);
});

test('an identity network returns its input through windows, mirrors and float16 averaging', async () => {
  const shape = [20, 22, 24];
  const patch = [8, 8, 8];
  const image = Float32Array.from({ length: 20 * 22 * 24 }, (_, i) => Math.sin(i) * 3);
  const { logits, windows, passes } = await predictLogits({
    image,
    channels: 1,
    shape,
    patch,
    regions: 1,
    mirrorAxes: [0, 1, 2],
    runPatch: async (tile) => Float32Array.from(tile),
  });
  assert.equal(windows, 4 * 5 * 5);
  assert.equal(passes, 4 * 5 * 5 * 8);
  // Near the border only a window's edge, whose float16 weight is subnormal, covers a voxel.
  for (let z = 2; z < 18; z++) {
    for (let y = 2; y < 20; y++) {
      for (let x = 2; x < 22; x++) {
        const i = (z * 22 + y) * 24 + x;
        assert.ok(Math.abs(logits[i] - image[i]) < 0.01, `voxel ${z},${y},${x}: ${logits[i]} for ${image[i]}`);
      }
    }
  }
});

test('modes are named in GlioMODA order whatever order the roles arrive in', () => {
  assert.equal(modeFor(['t2w', 't1c', 't2f', 't1n']), 't1c-t2f-t1n-t2w');
  assert.equal(modeFor(['t2f', 't1n']), 't2f-t1n');
  assert.throws(() => modeFor([]), /at least one/);
});

test('images off the atlas grid are refused by role', () => {
  assert.throws(() => checkAtlasGrid('t1c', { dims: [240, 240, 155, 1].slice(0, 3).map((n, a) => (a === 2 ? 160 : n)), affine: atlasAffine }), /T1C image is 240 × 240 × 160/);
  const coarse = atlasAffine.map((row, r) => row.map((v, c) => (r < 3 && c < 3 ? v * 2 : v)));
  assert.throws(() => checkAtlasGrid('t2f', { dims: [240, 240, 155], affine: coarse }), /T2F image has 2.00/);
  checkAtlasGrid('t1n', { dims: [240, 240, 155], affine: atlasAffine });
});

test('segmentGlioma places the labels back on the full grid', async () => {
  const dims = [240, 240, 155];
  const data = new Float32Array(240 * 240 * 155);
  const inside = (x, y, z) => x >= 60 && x < 180 && y >= 50 && y < 190 && z >= 20 && z < 140;
  for (let z = 0; z < 155; z++) for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) if (inside(x, y, z)) data[(z * 240 + y) * 240 + x] = 100 + (x % 7);
  const model = { id: 't1c', channels: ['t1c'], patch: [128, 160, 112], mirror_axes: [0, 1, 2], regions_class_order: [2, 1, 3] };
  const voxels = 128 * 160 * 112;
  // Positive whole-tumour score everywhere, negative core and enhancing scores.
  const runPatch = async () => Float32Array.from({ length: 3 * voxels }, (_, i) => (i < voxels ? 2 : -2) + (i % 3) * 1e-3);
  const result = await segmentGlioma({ volumes: { t1c: { data, dims, affine: atlasAffine } }, model, runPatch, mirror: false });
  assert.deepEqual(result.box.shape, [120, 140, 120]);
  assert.equal(result.passes, result.windows);
  for (const [x, y, z] of [[60, 50, 20], [179, 189, 139], [59, 100, 100], [100, 100, 140]]) {
    assert.equal(result.labels[(z * 240 + y) * 240 + x], inside(x, y, z) ? 2 : 0, `voxel ${x},${y},${z}`);
  }
});

test('volumes, the table and the comparison count BraTS labels and regions', () => {
  const labels = Uint8Array.of(0, 1, 2, 2, 3, 3, 3);
  const rows = volumeRows(labels, atlasAffine);
  assert.deepEqual(rows.map((r) => [r.id, r.voxels]), [['1', 1], ['2', 2], ['3', 3], ['WT', 6], ['TC', 4], ['ET', 3]]);
  assert.match(volumeTable(rows), /^label\tstructure\tvoxels\tvolume_ml\n1\tNecrotic tumour core\t1\t0\.001\n/);
  const reference = Uint8Array.of(0, 1, 2, 2, 3, 3, 0);
  assert.deepEqual(compareLabels(labels, reference), {
    counts: [1, 1, 2, 3],
    referenceCounts: [2, 1, 2, 2],
    dice: { WT: 0.90909, TC: 0.85714, ET: 0.8 },
    differing: 1,
  });
});

test('the case name is the inputs’ shared stem', () => {
  assert.equal(caseName(['BraTS-GLI-00001-000-t1c.nii.gz', 'BraTS-GLI-00001-000-t2f.nii.gz']), 'BraTS-GLI-00001-000');
  assert.equal(caseName(['TCGA-DU-7294_t1c.nii.gz']), 'TCGA-DU-7294_t1c');
  assert.equal(caseName(['t1c.nii.gz', 'flair.nii.gz']), 'gliomoda');
});

test('segmentation refuses translated and reflected modalities before inference', async () => {
  for (const alter of [
    (a) => { a[0][3] += 100; },
    (a) => { a[0][0] *= -1; },
  ]) {
    const shifted = structuredClone(atlasAffine);
    alter(shifted);
    const volume = { dims: [240, 240, 155], affine: atlasAffine };
    await assert.rejects(segmentGlioma({
      volumes: { t1c: volume, t2f: { ...volume, affine: shifted } },
      model: { id: 't1c-t2f', channels: ['t1c', 't2f'] },
      runPatch() { assert.fail('must not infer on misaligned channels'); },
    }), /T2F image is not aligned with T1C/);
  }
});

test('atlas grids reject non-finite and degenerate spatial transforms', () => {
  for (const affine of [
    [[NaN, 0, 0, 0], ...atlasAffine.slice(1)],
    [[1, 1, 0, 0], [0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  ]) assert.throws(() => checkAtlasGrid('t2f', { dims: [240, 240, 155], affine }), /spatial transform/);
});
