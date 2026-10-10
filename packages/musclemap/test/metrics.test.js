import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { createMuscleMapPipeline } from '../src/pipeline.js';
import { MODELS } from '../src/model-catalog.generated.js';
import { metricsCsv, outputNames } from '../src/results.js';
const model = MODELS.find(model => model.id === 'abdomen');
const nifti = img => createNiftiFromVolume({ dims: [10, 10, 2], pixDims: [1, 1, 1],
  hdr: { affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }, img });
const pipeline = () => createMuscleMapPipeline({ decompress: gunzipSync });
const dense = new Uint16Array(200).fill(1);
const config = { segmentationInputs: [{ data: nifti(dense), labelSpaceId: model.labelSpaceId,
  labelSpace: model.labelSpace, encoding: 'class-index' }] };
test('volume and Dixon fat fraction have independently known values', async () => {
  const result = await pipeline().metrics({ ...config,
    dixonFatData: nifti(new Float32Array(200).fill(20)), dixonWaterData: nifti(new Float32Array(200).fill(80)),
    settings: { imfMetrics: { enabled: true, mode: 'dixon' } } });
  assert.equal(result.metrics.totalVolumeMl, 0.2);
  assert.equal(result.metrics.labelSliceCounts[1], 2);
  assert.equal(result.metrics.imfDixon.labelFatPercentages[1], 20);
  assert.equal(result.metrics.imfDixon.labelMusclePercentages[1], 80);
  assert.ok(Math.abs(result.metrics.imfDixon.totalFatVolumeMl - 0.04) < 1e-12);
  const csv = metricsCsv(result.metrics, [model.labelSpace.labels[1]]);
  assert.match(csv, /dixon,dixon,,80\.00,20\.00,0\.2000,0\.0400,0\.1600/);
  assert.deepEqual(outputNames('image.nii.gz'), { segmentation: 'image_segmentation.nii', display: 'image_segmentation_display.nii', metrics: 'musclemap_metrics.csv' });
});
for (const method of ['kmeans', 'gmm']) {
  for (const components of [2, 3]) {
    test(`${method} ${components}-component IMF recovers separated synthetic tissues`, async () => {
      const source = Float32Array.from({ length: 200 }, (_, i) => components === 2 ? (i < 100 ? 10 : 100) : (i < 80 ? 10 : i < 120 ? 50 : 100));
      const result = await pipeline().metrics({ ...config, metricSourceData: nifti(source),
        settings: { imfMetrics: { enabled: true, mode: 'threshold', method, components } } });
      // Preserve the browser's three-component strict percentage boundary and
      // inclusive volume boundary: all low-cluster values equal muscleMax.
      assert.equal(result.metrics.imfThreshold.labelMusclePercentages[1], components === 2 ? 50 : 0);
      assert.equal(result.metrics.imfThreshold.labelFatPercentages[1], components === 2 ? 50 : 40);
      if (components === 3) {
        assert.equal(result.metrics.imfThreshold.labelUndefinedPercentages[1], 60);
        assert.equal(result.metrics.imfThreshold.labelMuscleVolumesMl[1], 0.08);
        assert.equal(result.metrics.imfThreshold.labelUndefinedVolumesMl[1], 0.04);
      }
      assert.deepEqual(result.metrics.imfThreshold.skippedLabels, []);
    });
  }
}
test('metrics refuse unattributed labels and mismatched Dixon geometry', async () => {
  await assert.rejects(pipeline().metrics({ segmentationInputs: [{ data: nifti(dense) }] }), /attribution/);
  const wrong = createNiftiFromVolume({ dims: [2, 2, 2], img: new Float32Array(8).fill(1) });
  await assert.rejects(pipeline().metrics({ ...config, dixonFatData: wrong, dixonWaterData: wrong,
    settings: { imfMetrics: { enabled: true, mode: 'dixon' } } }), /geometry/);
});
