#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const fixtures = require('./batch-parity-fixtures.cjs');
const { loadNifti } = require('./batch-parity-lib.cjs');
const { ensureSctBatchFixtures } = require('./huggingface-fixtures.cjs');
const manifest = require('../web/models/manifest.json');
const lesionAnalysis = loadClassicScript(path.join(__dirname, '../web/js/modules/lesion-analysis.js'));

const ROOT = path.resolve(__dirname, '..');

const CRITICAL_BROWSER_OUTPUTS = Object.freeze([
  {
    id: 'batch_t2_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_t2_label_vertebrae',
    taskId: 'vertebrae',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15,
    mode: 'multilabel',
    minPositiveLabels: 10
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_sc',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'segmentation',
    taskId: 'lesion_sci_t2',
    minDice: 0.8,
    foregroundRatioTolerance: 0.35
  },
  {
    id: 'batch_t2_deepseg_lesion_sci_t2_lesion',
    fixtureId: 'batch_t2_deepseg_lesion_sci_t2',
    stage: 'lesion',
    taskId: 'lesion_sci_t2',
    minDice: 0.6,
    foregroundRatioTolerance: 0.75
  },
  {
    id: 'batch_dmri_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.8,
    foregroundRatioTolerance: 0.5
  },
  {
    id: 'batch_t2s_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t2s_deepseg_graymatter',
    taskId: 'graymatter',
    minDice: 0.7,
    foregroundRatioTolerance: 0.15
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t1',
    taskId: 'spinalcord',
    minDice: 0.9,
    foregroundRatioTolerance: 0.2
  },
  {
    id: 'batch_t1_deepseg_spinalcord_t2',
    taskId: 'spinalcord',
    minDice: 0.95,
    foregroundRatioTolerance: 0.1
  },
  {
    id: 'batch_mt_deepseg_spinalcord',
    taskId: 'spinalcord',
    minDice: 0.85,
    foregroundRatioTolerance: 0.2
  }
]);

function fixtureForCheck(check) {
  return fixtures.FIXTURE_CASES.find(item => item.id === (check.fixtureId || check.id));
}

function browserOutputPathForCheck(check, fixture) {
  if (check.stage && fixture.browserOutputPaths?.[check.stage]) {
    return path.join(ROOT, fixture.browserOutputPaths[check.stage]);
  }
  return path.join(ROOT, path.dirname(fixture.inputPath), 'browser_output.nii.gz');
}

function expectedOutputPathForCheck(check, fixture) {
  if (check.stage && fixture.expectedOutputPaths?.[check.stage]) {
    return path.join(ROOT, fixture.expectedOutputPaths[check.stage]);
  }
  return path.join(ROOT, fixture.expectedOutputPath);
}

function diceStats(expected, produced, mode = 'binary') {
  if (mode === 'multilabel') return multilabelDiceStats(expected, produced);
  let expectedNz = 0;
  let producedNz = 0;
  let intersection = 0;
  for (let i = 0; i < expected.data.length; i++) {
    const e = expected.data[i] > 0;
    const p = produced.data[i] > 0;
    if (e) expectedNz++;
    if (p) producedNz++;
    if (e && p) intersection++;
  }
  return {
    expectedNz,
    producedNz,
    intersection,
    dice: expectedNz + producedNz ? (2 * intersection) / (expectedNz + producedNz) : 1
  };
}

function positiveLabels(data) {
  const labels = new Set();
  for (let i = 0; i < data.length; i++) {
    const label = Math.round(data[i]);
    if (label > 0) labels.add(label);
  }
  return labels;
}

function multilabelDiceStats(expected, produced) {
  let expectedNz = 0;
  let producedNz = 0;
  const labels = new Set([...positiveLabels(expected.data), ...positiveLabels(produced.data)]);
  let diceSum = 0;
  for (const label of labels) {
    let labelExpectedNz = 0;
    let labelProducedNz = 0;
    let labelIntersection = 0;
    for (let i = 0; i < expected.data.length; i++) {
      const e = Math.round(expected.data[i]) === label;
      const p = Math.round(produced.data[i]) === label;
      if (e) labelExpectedNz++;
      if (p) labelProducedNz++;
      if (e && p) labelIntersection++;
    }
    diceSum += labelExpectedNz + labelProducedNz ? (2 * labelIntersection) / (labelExpectedNz + labelProducedNz) : 1;
  }
  for (let i = 0; i < expected.data.length; i++) {
    if (expected.data[i] > 0) expectedNz++;
    if (produced.data[i] > 0) producedNz++;
  }
  return {
    expectedNz,
    producedNz,
    intersection: null,
    positiveLabels: labels.size,
    dice: labels.size ? diceSum / labels.size : 1
  };
}

function assertMetadataComparable(fixture, expected, produced) {
  assert.equal(
    expected.header.dims.slice(0, 4).join('x'),
    produced.header.dims.slice(0, 4).join('x'),
    `${fixture.id}: browser output dimensions match test_data reference`
  );
  assert.equal(
    expected.header.pixDims.slice(1, 4).join('x'),
    produced.header.pixDims.slice(1, 4).join('x'),
    `${fixture.id}: browser output spacing matches test_data reference`
  );
  assert.equal(produced.header.datatypeCode, 2, `${fixture.id}: browser output is uint8 label data`);
}

function lesionMetricsFor(scPath, lesionPath) {
  const spinalCord = loadNifti(scPath);
  const lesion = loadNifti(lesionPath);
  return lesionAnalysis.analyzeLesions({
    spinalCord: spinalCord.data,
    lesion: lesion.data,
    dims: spinalCord.header.dims.slice(1, 4),
    spacing: spinalCord.header.pixDims.slice(1, 4).map(value => Math.abs(value) || 1)
  });
}

function assertRelativeClose(actual, expected, tolerance, label) {
  const allowed = Math.max(Math.abs(expected) * tolerance, tolerance);
  assert.ok(Math.abs(actual - expected) <= allowed, `${label}: ${actual} is within ${tolerance * 100}% of ${expected}`);
}

function assertLesionMetricsFixture() {
  const fixture = fixtures.FIXTURE_CASES.find(item => item.id === 'batch_t2_deepseg_lesion_sci_t2');
  assert.ok(fixture, 'SCI lesion fixture exists for metrics validation');
  const expectedMetrics = lesionMetricsFor(
    expectedOutputPathForCheck({ stage: 'segmentation' }, fixture),
    expectedOutputPathForCheck({ stage: 'lesion' }, fixture)
  );
  const producedMetrics = lesionMetricsFor(
    browserOutputPathForCheck({ stage: 'segmentation' }, fixture),
    browserOutputPathForCheck({ stage: 'lesion' }, fixture)
  );
  assert.ok(producedMetrics.csv.includes('dorsal_bridge_width_mm'), 'browser lesion metrics CSV includes tissue-bridge columns');
  assert.ok(producedMetrics.summary.lesion_count >= expectedMetrics.summary.lesion_count, 'browser metrics preserve the expected SCI lesion component');
  assert.ok(producedMetrics.summary.lesion_count <= expectedMetrics.summary.lesion_count + 1, 'browser metrics do not add more than one small extra component on the fake-lesion fixture');
  assertRelativeClose(producedMetrics.summary.total_volume_mm3, expectedMetrics.summary.total_volume_mm3, 0.25, 'lesion total volume');
  assertRelativeClose(producedMetrics.summary.total_length_mm, expectedMetrics.summary.total_length_mm, 0.25, 'lesion total length');
  assertRelativeClose(producedMetrics.summary.max_width_mm, expectedMetrics.summary.max_width_mm, 0.30, 'lesion max width');
}

const supportedTasks = new Set(
  manifest.tasks
    .filter(task => task.supportStatus === 'supported' && task.validationStatus === 'passed')
    .filter(task => task.id !== 'vertebrae' || task.browserParityRequired !== false)
    .map(task => task.id)
);

function missingBrowserOutputs() {
  return CRITICAL_BROWSER_OUTPUTS
    .map(check => ({ check, fixture: fixtureForCheck(check) }))
    .filter(item => item.fixture)
    .map(({ check, fixture }) => browserOutputPathForCheck(check, fixture))
    .filter(filePath => !fs.existsSync(filePath));
}

function staleBrowserOutputs() {
  const stale = [];
  for (const check of CRITICAL_BROWSER_OUTPUTS) {
    const fixture = fixtureForCheck(check);
    if (!fixture) continue;
    const producedPath = browserOutputPathForCheck(check, fixture);
    if (!fs.existsSync(producedPath)) continue;
    const produced = loadNifti(producedPath);
    if ((check.mode || 'binary') === 'multilabel') {
      const labels = positiveLabels(produced.data);
      if (labels.size < (check.minPositiveLabels || 2)) stale.push(producedPath);
      continue;
    }
    let producedNz = 0;
    for (let i = 0; i < produced.data.length; i++) {
      if (produced.data[i] > 0) producedNz++;
    }
    if (producedNz === 0) {
      const expectedPath = expectedOutputPathForCheck(check, fixture);
      if (!fs.existsSync(expectedPath)) continue;
      const expected = loadNifti(expectedPath);
      let expectedNz = 0;
      for (let i = 0; i < expected.data.length; i++) {
        if (expected.data[i] > 0) expectedNz++;
      }
      if (expectedNz > 0) stale.push(producedPath);
    }
  }
  return stale;
}

function ensureBrowserOutputs() {
  const force = process.env.BROWSER_FIXTURE_REGENERATE === '1';
  if (!force && missingBrowserOutputs().length === 0 && staleBrowserOutputs().length === 0) return;

  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/run_browser_fixture_outputs.cjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'browser fixture output generation exits successfully');
}

(async () => {
  await ensureSctBatchFixtures(ROOT);
  ensureBrowserOutputs();

  for (const taskId of supportedTasks) {
    assert.ok(
      CRITICAL_BROWSER_OUTPUTS.some(item => item.taskId === taskId),
      `supported task ${taskId} has at least one browser-output parity fixture`
    );
  }

  const results = [];
  for (const check of CRITICAL_BROWSER_OUTPUTS) {
    const fixture = fixtureForCheck(check);
    assert.ok(fixture, `${check.id} fixture exists`);

    const expectedPath = expectedOutputPathForCheck(check, fixture);
    const producedPath = browserOutputPathForCheck(check, fixture);
    assert.notEqual(path.resolve(expectedPath), path.resolve(producedPath), `${check.id}: produced output is not the expected fixture`);
    assert.ok(fs.existsSync(producedPath), `${check.id}: browser output exists at ${path.relative(ROOT, producedPath)}`);

    const expected = loadNifti(expectedPath);
    const produced = loadNifti(producedPath);
    assertMetadataComparable(fixture, expected, produced);

    const stats = diceStats(expected, produced, check.mode || 'binary');
    const lower = stats.expectedNz * (1 - check.foregroundRatioTolerance);
    const upper = stats.expectedNz * (1 + check.foregroundRatioTolerance);
    assert.ok(stats.producedNz >= lower && stats.producedNz <= upper, `${check.id}: foreground ${stats.producedNz} is within tolerance of ${stats.expectedNz}`);
    if (check.minPositiveLabels) {
      assert.ok(stats.positiveLabels >= check.minPositiveLabels, `${check.id}: ${stats.positiveLabels} positive labels >= ${check.minPositiveLabels}`);
    }
    assert.ok(stats.dice >= check.minDice, `${check.id}: Dice ${stats.dice.toFixed(4)} >= ${check.minDice.toFixed(4)}`);
    results.push(`${check.id}: dice=${stats.dice.toFixed(4)} expectedNz=${stats.expectedNz} producedNz=${stats.producedNz}`);
  }
  assertLesionMetricsFixture();

  console.log(`Browser fixture parity passed:\n${results.join('\n')}`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
