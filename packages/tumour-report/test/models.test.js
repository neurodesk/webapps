import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSETS, TUMOUR_TYPES, assetById, manifest } from '../src/models.js';
import { caseName, lesionsTable, outputNames, radsSummaryTable } from '../src/results.js';

test('manifest declares both v1.3 models and all 8 ICBM2009a atlas assets with sha256', () => {
  assert.equal(manifest.app, 'tumour-report');
  assert.equal(ASSETS.length, 10);
  const brain = assetById('mri-brain');
  const tumour = assetById('mri-tumorcore-t1c');
  const bcb = assetById('bcb-tracts');
  assert.match(brain.sha256, /^[0-9a-f]{64}$/);
  assert.match(tumour.sha256, /^[0-9a-f]{64}$/);
  assert.equal(bcb.tract_count, 64);
  assert.throws(() => assetById('nonexistent'), /no asset/);
});

test('TUMOUR_TYPES enables resectability only for glioblastoma', () => {
  const byId = Object.fromEntries(TUMOUR_TYPES.map((t) => [t.id, t]));
  assert.equal(byId.glioblastoma.resectability, true);
  assert.equal(byId.meningioma.resectability, false);
  assert.equal(byId.metastasis.resectability, false);
});

test('caseName, outputNames, and TSV serializers produce well-formed tables', () => {
  assert.equal(caseName('Dataset_A_038.nii.gz'), 'Dataset_A_038');
  assert.equal(caseName(''), 'tumour-report');
  const names = outputNames('case01');
  assert.equal(names.reportJson, 'case01_report.json');
  assert.equal(names.lesionsTsv, 'case01_lesions.tsv');

  const tsv = lesionsTable([]);
  assert.match(tsv, /^lesion_id\tvoxels\tvolume_ml/);
  const summary = radsSummaryTable({
    tumourType: 'glioblastoma',
    morphometry: {
      status: 'no_lesions_segmented',
      lesionCount: 0,
      totalVolumeMl: 0,
      brainVolumeMl: 1300,
      brainPercentage: 0,
      multifocal: false,
      multifocalCount: 0,
      maxMinFociDistanceMm: -1,
      largestDiameters: null,
    },
    rads: null,
  });
  assert.match(summary, /summary\tstatus\tno_lesions_segmented/);
});
