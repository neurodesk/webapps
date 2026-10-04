import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Morphometry in the real page and worker, checked against the same SCT 7.3
// reference tables as scripts/test_sct_metrics_parity.cjs. No inference: the
// cord mask is SCT's own t2_seg fixture and the disc labels are rebuilt from
// the SCT disc coordinates, drawn as the small spheres TotalSpineSeg emits.

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test/fixtures/sct-metrics');
const MASK = 'test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz';
const { ensureFixtureFiles } = require('../scripts/huggingface-fixtures.cjs');
const { parseCsv } = require('../scripts/sct-metrics-lib.cjs');

async function maskBytes() {
  await ensureFixtureFiles(ROOT, [MASK]);
  return gunzipSync(await readFile(join(ROOT, MASK)));
}

// The mask is stored with x running left to right (SCT "LPI"), so an RPI x
// coordinate is mirrored; y and z are the same.
async function discBytes(mask) {
  const { points } = JSON.parse(await readFile(join(FIXTURES, 't2_discs.json'), 'utf8'));
  const offset = Math.floor(mask.readFloatLE(108));
  const [nx, ny, nz] = [mask.readInt16LE(42), mask.readInt16LE(44), mask.readInt16LE(46)];
  const out = Buffer.from(mask);
  out.fill(0, offset);
  for (const point of points) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy + dz * dz > 4) continue;
          const x = nx - 1 - point.x + dx;
          const y = point.y + dy;
          const z = point.z + dz;
          if (x < 0 || x >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue;
          out[offset + x + y * nx + z * nx * ny] = point.value;
        }
      }
    }
  }
  return out;
}

async function reference(id) {
  const rows = parseCsv(await readFile(join(FIXTURES, `${id}.csv`), 'utf8'));
  const header = rows[0].map(field => field.text);
  return rows.slice(1).map(row => Object.fromEntries(header.map((name, index) => [name, row[index].text])));
}

function expectRowsMatch(actualRows, expectedRows) {
  expect(actualRows.length).toBe(expectedRows.length);
  expectedRows.forEach((expected, index) => {
    const actual = actualRows[index];
    expect(actual.slices).toBe(expected['Slice (I->S)']);
    expect(actual.vert_level).toBe(expected.VertLevel);
    for (const [column, text] of Object.entries(expected)) {
      if (!/^(MEAN|STD|SUM)\(/.test(column)) continue;
      const sct = Number(text);
      expect(Math.abs(actual[column] - sct), `${column} of slices ${expected['Slice (I->S)']}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(sct)));
    }
  });
}

test('automation measures a mask per vertebral level and matches sct_process_segmentation', async ({ page }) => {
  test.setTimeout(180000);
  const mask = await maskBytes();
  const discs = await discBytes(mask);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  const contract = await page.evaluate(() => neurodeskAutomation.dispatch('describe'));
  expect(Object.keys(contract.operations)).toEqual(['segment', 'morphometry', 'lesion-metrics']);

  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 't2_seg.nii', mimeType: 'application/octet-stream', buffer: mask });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'segmentation' }));
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 't2_discs.nii', mimeType: 'application/octet-stream', buffer: discs });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'discs' }));
  await page.evaluate(() => neurodeskAutomation.dispatch('start', {
    operation: 'morphometry',
    parameters: { aggregate: 'level', levels: '2:8' },
  }));
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 150000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.provenance.equivalentCommand).toBe('sct_process_segmentation -i t2_seg.nii -discfile t2_discs.nii -vert 2:8 -perlevel 1');
  expectRowsMatch(snapshot.report.measurements.morphometry.rows, await reference('t2_perlevel'));

  const waiting = page.waitForEvent('download');
  await page.evaluate(() => neurodeskAutomation.dispatch('download', { artifactId: 'morphometry' }));
  const csv = await readFile(await (await waiting).path(), 'utf8');
  expect(csv.split('\r\n')[0]).toBe((await readFile(join(FIXTURES, 't2_perlevel.csv'), 'utf8')).split('\r\n')[0]);

  // The same result is on screen, and the status footer is the only status.
  await expect(page.locator('#metricsResults [data-metrics-stage="morphometry"] tbody tr')).toHaveCount(7);
  await expect(page.locator('#statusText')).toHaveText('Complete');
});

test('the Morphometry section measures session masks with explicit inputs', async ({ page }) => {
  test.setTimeout(180000);
  const mask = await maskBytes();
  const discs = await discBytes(mask);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.app?.inferenceExecutor));

  const section = page.locator('#morphometrySection');
  await expect(section).toHaveClass(/step-disabled/);
  await expect(section).toHaveClass(/collapsed/);
  await expect(page.locator('#runMorphometry')).toBeDisabled();

  // A segmentation result arrives exactly as the worker posts it.
  const postStage = (stage, taskId, bytes) => page.evaluate(({ stage, taskId, bytes }) => {
    globalThis.app.inferenceExecutor.handleStageData({
      stage, taskId, kind: 'nifti', description: stage, niftiData: new Uint8Array(bytes).buffer,
    });
  }, { stage, taskId, bytes: Array.from(bytes) });
  await postStage('segmentation', 'spinalcord', mask);

  await expect(section).not.toHaveClass(/step-disabled|collapsed/);
  await expect(page.locator('#morphometryMask')).toHaveValue('segmentation');
  await expect(page.locator('#morphometryMask option')).toHaveText(['Spinal cord mask']);
  await expect(page.locator('#morphometryDiscs')).toHaveValue('');
  await expect(page.locator('#morphometryAggregate option[value="level"]')).toBeDisabled();
  await expect(page.locator('#morphometryLevels')).toBeDisabled();

  // Without disc labels: all slices in one row, as SCT does by default.
  await page.locator('#morphometryAggregate').selectOption('all');
  await page.locator('#runMorphometry').click();
  const block = page.locator('#metricsResults [data-metrics-stage="morphometry"]');
  await expect(block.locator('tbody tr')).toHaveCount(1, { timeout: 120000 });
  await expect(page.locator('#statusText')).toHaveText('Complete');
  await expect(block.locator('.metrics-note')).toHaveText('Spinal cord mask, no vertebral levels');
  const all = await page.evaluate(() => globalThis.app.inferenceExecutor.getResult('morphometry').rows);
  expectRowsMatch(all, await reference('t2_all'));

  // Disc labels arrive: they are offered, selected, and named in the result.
  await postStage('spine_discs', 'spine', discs);
  await expect(page.locator('#morphometryDiscs')).toHaveValue('spine_discs');
  await expect(page.locator('#morphometryDiscs option')).toHaveText(['None', 'TotalSpineSeg discs']);
  await expect(page.locator('#morphometryMask')).toHaveValue('segmentation');

  // A bad level list is reported on its field and nothing runs.
  await page.locator('#morphometryAggregate').selectOption('level');
  await page.locator('#morphometrySection details summary').click();
  await page.locator('#morphometryLevels').fill('C2-C5');
  await page.locator('#runMorphometry').click();
  expect(await page.locator('#morphometryLevels').evaluate(input => input.validationMessage)).toContain('2:5');
  await expect(page.locator('#morphometryBadge')).not.toHaveText('Running');

  await page.locator('#morphometryLevels').fill('2:8');
  await page.locator('#runMorphometry').click();
  await expect(block.locator('tbody tr')).toHaveCount(7, { timeout: 120000 });
  await expect(block.locator('.metrics-note')).toHaveText('Spinal cord mask, levels from TotalSpineSeg discs');
  await expect(page.locator('#morphometryBadge')).toHaveText('Done');
  const perLevel = await page.evaluate(() => globalThis.app.inferenceExecutor.getResult('morphometry').rows);
  expectRowsMatch(perLevel, await reference('t2_perlevel'));

  // Closing and reopening the section keeps the chosen values.
  await page.locator('#morphometrySection > .section-title > button').click();
  await expect(section).toHaveClass(/collapsed/);
  await page.locator('#morphometrySection > .section-title > button').click();
  await expect(page.locator('#morphometryLevels')).toHaveValue('2:8');
  await expect(page.locator('#morphometryAggregate')).toHaveValue('level');

  const waiting = page.waitForEvent('download');
  await block.locator('.metrics-download-btn').click();
  const download = await waiting;
  expect(download.suggestedFilename()).toBe('spinalcord_segmentation_morphometry.csv');
  const csv = await readFile(await download.path(), 'utf8');
  expect(csv.split('\r\n').length).toBe(9);

  // Setting the levels back to None is honoured: no level column values.
  await page.locator('#morphometryDiscs').selectOption('');
  await expect(page.locator('#morphometryAggregate')).toHaveValue('slice');
  await page.locator('#morphometrySlices').fill('100:102');
  await page.locator('#runMorphometry').click();
  await expect(block.locator('tbody tr')).toHaveCount(3, { timeout: 120000 });
  await expect(block.locator('.metrics-note')).toHaveText('Spinal cord mask, no vertebral levels');

  // Clear All forgets the session masks.
  await page.locator('#clearResults').click();
  await expect(section).toHaveClass(/step-disabled/);
  await expect(page.locator('#metricsResults')).toHaveClass(/hidden/);
});
