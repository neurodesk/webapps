#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const vertebrae = loadClassicScript(path.join(__dirname, '../web/js/modules/vertebrae.js'));
const manifest = require('../web/models/manifest.json');
const { loadNifti } = require('./batch-parity-lib.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const { ensureHostedAsset } = require('./hosted-assets.cjs');

const ROOT = path.resolve(__dirname, '..');
const vertebraeTask = manifest.tasks.find(task => task.id === 'vertebrae');
const pam50LevelsAsset = vertebraeTask?.templateAssets?.find(asset => asset.id === 'pam50-levels');

{
  const modelText = fs.readFileSync(path.join(ROOT, 'web/models/c2c3_disc_models/t2_model.yml'), 'utf8');
  const model = vertebrae.parseOpenCvHogSvm(modelText);
  assert.equal(model.weights.length, 576);
  assert.equal(model.winSize[0], 32);
  assert.ok(Number.isFinite(model.bias));
}

{
  const dims = [3, 3, 6];
  const seg = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) seg[vertebrae.index3D(1, 1, z, dims)] = 1;
  const labels = vertebrae.labelSegmentationFromBoundaries(seg, dims, [
    { z: 1, superiorLabel: 4, inferiorLabel: 3 },
    { z: 3, superiorLabel: 3, inferiorLabel: 2 },
    { z: 4, superiorLabel: 2, inferiorLabel: 1 }
  ], { topLabel: 4, bottomLabel: 1 });
  assert.equal(labels[vertebrae.index3D(1, 1, 0, dims)], 4);
  assert.equal(labels[vertebrae.index3D(1, 1, 2, dims)], 3);
  assert.equal(labels[vertebrae.index3D(1, 1, 4, dims)], 2);
  assert.equal(labels[vertebrae.index3D(1, 1, 5, dims)], 1);
}

(async () => {
  await ensureSctBatchFixtures(ROOT);
  const { path: pam50LevelsPath } = await ensureHostedAsset(ROOT, pam50LevelsAsset);
  const browserOutputPath = path.join(ROOT, 'test_data/batch_t2_label_vertebrae/browser_output.nii.gz');
  if (!fs.existsSync(browserOutputPath)) {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_browser_fixture_outputs.cjs')], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'browser fixture output generation exits successfully');
  }

  const input = vertebrae.parseNifti(fs.readFileSync(path.join(ROOT, 'test_data/batch_t2_label_vertebrae/input.nii.gz')));
  const segNifti = loadNifti(browserOutputPath);
  const segmentation = new Uint8Array(segNifti.data.length);
  for (let i = 0; i < segmentation.length; i++) segmentation[i] = segNifti.data[i] > 0 ? 1 : 0;

  const result = await vertebrae.labelVertebrae({
    anatomy: input.data,
    segmentation,
    dims: input.dims,
    c2c3ModelUrl: path.join(ROOT, 'web/models/c2c3_disc_models/t2_model.yml'),
    pam50LevelsUrl: pam50LevelsPath
  });

  const labels = new Set(result.labels);
  labels.delete(0);
  assert.ok(labels.size >= 10, `expected at least 10 vertebral labels, found ${labels.size}`);
  assert.ok(result.boundaries.length >= 9, `expected propagated vertebral boundaries, found ${result.boundaries.length}`);

  const expected = loadNifti(path.join(ROOT, 'test_data/batch_t2_label_vertebrae/batch_output.nii.gz'));
  let diceSum = 0;
  for (let label = 1; label <= 11; label++) {
    let expectedNz = 0;
    let producedNz = 0;
    let intersection = 0;
    for (let i = 0; i < result.labels.length; i++) {
      const e = Math.round(expected.data[i]) === label;
      const p = result.labels[i] === label;
      if (e) expectedNz++;
      if (p) producedNz++;
      if (e && p) intersection++;
    }
    diceSum += expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1;
  }
  const meanDice = diceSum / 11;
  assert.ok(meanDice >= 0.7, `mean multilabel Dice ${meanDice.toFixed(4)} >= 0.70`);
  console.log(`Vertebrae tests passed: labels=${labels.size} meanDice=${meanDice.toFixed(4)}`);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
