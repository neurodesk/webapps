import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asClosestCanonical,
  canonicalOrientation,
  checkLogits,
  cropBox,
  f16ToF32,
  f32ToF16,
  gaussianWeights,
  keepLargestComponent,
  nonzeroBoundingBox,
  normalizeCT,
  normalizeZScore,
  predictSingleModel,
  resampleZoom,
  roundHalfEven,
  segmentVolume,
  targetShapeForSpacing,
  uncropBox,
  undoCanonical,
  voxelSpacing,
  windows,
  windowStarts,
} from '../src/pipeline.js';
import { colormapForTask, CT_PART_LUTS, labelsForTask, MR_PART_LUTS } from '../src/labels.js';
import { MODELS, resolveTaskPlan, TASKS } from '../src/models.js';
import { caseStem, compareLabels, segmentationResults, statisticsTable, structureStatistics, voxelVolumeMl } from '../src/results.js';

describe('orientation (asClosestCanonical / undoCanonical)', () => {
  it('treats identity RAS affine as a no-op', () => {
    const affine = [
      [3, 0, 0, -10],
      [0, 3, 0, -20],
      [0, 0, 3, -30],
      [0, 0, 0, 1],
    ];
    const orient = canonicalOrientation(affine);
    assert.equal(orient.identity, true);
    const data = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const { volume } = asClosestCanonical({ data, dims: [2, 2, 2], affine });
    assert.deepEqual([...volume.data], [...data]);
    assert.deepEqual(volume.dims, [2, 2, 2]);
  });

  it('reorients LPS to RAS and round-trips exactly through undoCanonical', () => {
    // LPS affine: -x, -y, +z
    const affine = [
      [-2, 0, 0, 10],
      [0, -3, 0, 20],
      [0, 0, 4, 5],
      [0, 0, 0, 1],
    ];
    const dims = [3, 4, 2];
    const data = Float32Array.from({ length: 24 }, (_, i) => i + 1);
    const { volume, orientation } = asClosestCanonical({ data, dims, affine });
    assert.equal(orientation.identity, false);
    assert.deepEqual(orientation.flip, [true, true, false]);
    assert.deepEqual(volume.dims, [3, 4, 2]);
    // Diagonal should now be positive RAS
    assert.equal(volume.affine[0][0], 2);
    assert.equal(volume.affine[1][1], 3);
    assert.equal(volume.affine[2][2], 4);
    assert.equal(volume.affine[0][3], 10 - 2 * 2);
    assert.equal(volume.affine[1][3], 20 - 3 * 3);
    assert.equal(volume.affine[2][3], 5);
    // Voxel (x=0, y=0, z=0) in RAS came from (x=2, y=3, z=0) in LPS
    assert.equal(volume.data[0], data[(0 * 4 + 3) * 3 + 2]);
    const restored = undoCanonical(volume.data, volume.dims, dims, orientation);
    assert.deepEqual([...restored], [...data]);
  });

  it('permutes and flips oblique/permuted axes and round-trips exactly', () => {
    // Sagittal-like permutation: axis 0 -> S (+z), axis 1 -> L (-x), axis 2 -> P (-y)
    const affine = [
      [0, -1.5, 0, 50],
      [0, 0, -2.0, 60],
      [1.0, 0, 0, 10],
      [0, 0, 0, 1],
    ];
    const dims = [2, 3, 4];
    const data = Float32Array.from({ length: 24 }, (_, i) => i + 10);
    const { volume, orientation } = asClosestCanonical({ data, dims, affine });
    assert.deepEqual(volume.dims, [3, 4, 2]);
    assert.deepEqual(voxelSpacing(volume.affine), [1.5, 2.0, 1.0]);
    const restored = undoCanonical(volume.data, volume.dims, dims, orientation);
    assert.deepEqual([...restored], [...data]);
  });
});

describe('resampling and normalization', () => {
  it('matches scipy roundHalfEven and linear zoom endpoints', () => {
    assert.equal(roundHalfEven(2.5), 2);
    assert.equal(roundHalfEven(3.5), 4);
    assert.deepEqual(targetShapeForSpacing([10, 20, 30], [3, 3, 3], [1.5, 1.5, 1.5]), [20, 40, 60]);
    const data = Float32Array.from([0, 10, 0, 10, 0, 10, 0, 10]);
    const up = resampleZoom(data, [2, 2, 2], [2, 2, 3], 1);
    assert.equal(up[0], 0);
    assert.equal(up[1], 5);
    assert.equal(up[2], 10);
    const labels = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const nn = resampleZoom(labels, [2, 2, 2], [2, 2, 4], 0);
    assert.deepEqual([...nn.slice(0, 4)], [1, 1, 2, 2]);
  });

  it('applies CT clip + z-score and MR whole-volume z-score', () => {
    const ct = normalizeCT(Float32Array.from([-2000, 0, 5000]), {
      percentile_00_5: -1000,
      percentile_99_5: 1000,
      mean: 0,
      std: 500,
    });
    assert.deepEqual([...ct], [-2, 0, 2]);

    const mr = normalizeZScore(Float32Array.from([10, 20, 30, 40]));
    const mean = mr.reduce((a, b) => a + b, 0) / mr.length;
    assert.ok(Math.abs(mean) < 1e-6);
  });

  it('round-trips float16 helper accurately', () => {
    for (const v of [0, 1, -1, 0.5, 12.25, -42.5, 1000]) {
      assert.ok(Math.abs(f16ToF32(f32ToF16(v)) - v) <= Math.abs(v) * 1e-3 + 1e-4);
    }
  });
});

describe('cropping, connected components and sliding window', () => {
  it('crops and uncrops nonzero boxes and keeps largest connected component', () => {
    const shape = [4, 4, 4];
    const data = new Float32Array(64);
    data[(1 * 4 + 2) * 4 + 1] = 5;
    data[(2 * 4 + 2) * 4 + 2] = 9;
    const box = nonzeroBoundingBox(data, shape);
    assert.deepEqual(box.lo, [1, 2, 1]);
    assert.deepEqual(box.hi, [3, 3, 3]);
    const cropped = cropBox(data, shape, box);
    const restored = uncropBox(cropped, shape, box);
    assert.deepEqual([...restored], [...data]);

    const mask = new Uint8Array(64);
    // Component A: 3 voxels
    mask[0] = 1;
    mask[1] = 1;
    mask[2] = 1;
    // Component B: 1 isolated voxel
    mask[63] = 1;
    const largest = keepLargestComponent(mask, shape, 1);
    assert.equal(largest[0], 1);
    assert.equal(largest[1], 1);
    assert.equal(largest[2], 1);
    assert.equal(largest[63], 0);
  });

  it('computes sliding window origins and Gaussian weights', () => {
    assert.deepEqual(windowStarts(10, 16), [0]);
    assert.deepEqual(windowStarts(32, 16, 0.5), [0, 8, 16]);
    assert.equal(windows([32, 16, 16], [16, 16, 16]).length, 3);
    const gw = gaussianWeights([8, 8, 8]);
    assert.equal(gw.length, 512);
    assert.ok(gw[(4 * 8 + 4) * 8 + 4] > gw[0]);
    assert.throws(() => checkLogits(new Float32Array(8)));
    assert.throws(() => checkLogits(Float32Array.from([0, NaN])));
  });

  it('runs end-to-end single-model and multi-part segmentVolume with mock runner', async () => {
    const affine = [
      [3, 0, 0, 0],
      [0, 3, 0, 0],
      [0, 0, 3, 0],
      [0, 0, 0, 1],
    ];
    const dims = [4, 4, 4];
    const data = Float32Array.from({ length: 64 }, (_, i) => (i % 7) + 1);
    const mockModel = {
      id: 'total-ct-organs',
      patch: [4, 4, 4],
      spacing: [3, 3, 3],
      normalization: 'ZScoreNormalization',
      num_classes: 25,
    };
    const out = await segmentVolume({
      volume: { data, dims, affine },
      task: 'total',
      models: [mockModel],
      runModel: async (_m, fn) => fn(async () => {
        const logits = new Float32Array(25 * 64);
        // Make local class 1 (spleen -> global 1) win on first half, class 5 (liver -> global 5) on second half.
        for (let i = 0; i < 32; i++) logits[1 * 64 + i] = 10;
        for (let i = 32; i < 64; i++) logits[5 * 64 + i] = 10;
        return logits;
      }),
    });
    assert.equal(out.labels[0], CT_PART_LUTS.organs[1]);
    assert.equal(out.labels[63], CT_PART_LUTS.organs[5]);

    const res = segmentationResults({
      labels: out.labels,
      imageData: data,
      dims,
      affine,
      task: 'total',
      modality: 'ct',
    }, 'case01.nii.gz');
    assert.equal(res.rows.length, 2);
    assert.equal(res.segmentation.name, 'case01_totalseg_total.nii');
    assert.ok(res.table.text.includes('spleen'));
    assert.ok(res.table.text.includes('liver'));
    assert.equal(compareLabels(out.labels, out.labels, 'total').meanDice, 1);
  });

  it('accumulates accurately across multiple Z-slab ring-buffer windows', async () => {
    const shape = [10, 4, 4]; // sz=10 > patch[0]=4 -> 4 overlapping zOrigins [0, 2, 4, 6]
    const image = Float32Array.from({ length: 160 }, (_, i) => i);
    const model = { patch: [4, 4, 4], num_classes: 3 };
    const result = await predictSingleModel({
      image,
      shape,
      model,
      runPatch: async (tile) => {
        const logits = new Float32Array(3 * 64);
        for (let i = 0; i < 64; i++) {
          // Class 1 for first half of z (values < 80), class 2 for second half (values >= 80).
          if (tile[i] < 80) logits[1 * 64 + i] = 10;
          else logits[2 * 64 + i] = 10;
        }
        return logits;
      },
    });
    assert.equal(result.windows, 4);
    for (let i = 0; i < 80; i++) assert.equal(result.labels[i], 1);
    for (let i = 80; i < 160; i++) assert.equal(result.labels[i], 2);
  });
});

describe('manifest, tasks and label maps', () => {
  it('exposes all 12 models and resolves every task and subset plan', () => {
    assert.equal(MODELS.length, 12);
    assert.equal(TASKS.length, 4);
    assert.equal(resolveTaskPlan({ task: 'total', resolution: 'fast' }).models.length, 1);
    assert.equal(resolveTaskPlan({ task: 'total', resolution: 'full', subset: 'all' }).models.length, 5);
    assert.equal(resolveTaskPlan({ task: 'total', resolution: 'full', subset: 'muscles' }).models.length, 1);
    assert.equal(resolveTaskPlan({ task: 'total_mr', resolution: 'fast' }).models.length, 1);
    assert.equal(resolveTaskPlan({ task: 'total_mr', resolution: 'full', subset: 'all' }).models.length, 2);
    assert.equal(resolveTaskPlan({ task: 'vertebrae_mr' }).models.length, 1);
    const abd = resolveTaskPlan({ task: 'abdominal_muscles' });
    assert.equal(abd.models.length, 1);
    assert.equal(abd.cropModel.id, 'body-ct-6mm');
  });

  it('provides complete colormaps and valid LUTs for every task', () => {
    for (const task of ['total', 'total_mr', 'vertebrae_mr', 'abdominal_muscles']) {
      const list = labelsForTask(task);
      const cmap = colormapForTask(task);
      assert.equal(cmap.R.length, list.length + 1);
      assert.equal(cmap.labels.length, list.length + 1);
      assert.equal(cmap.A[0], 0);
      assert.equal(cmap.A[1], 255);
    }
    assert.equal(Object.keys(CT_PART_LUTS).length, 5);
    assert.equal(Object.keys(MR_PART_LUTS).length, 2);
    assert.equal(voxelVolumeMl([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]), 0.008);
    assert.equal(caseStem('my-scan.nii.gz'), 'my-scan');
    const rows = structureStatistics({
      labels: Uint8Array.from([0, 1, 1]),
      imageData: Float32Array.from([0, 40, 60]),
      dims: [3, 1, 1],
      affine: [[10, 0, 0, 0], [0, 10, 0, 0], [0, 0, 10, 0], [0, 0, 0, 1]],
      task: 'total',
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ml, 2);
    assert.equal(rows[0].mean, 50);
    assert.ok(statisticsTable(rows, { modality: 'ct' }).includes('mean_hu'));
  });
});
