import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Lesion metrics in the real page and worker on SCT's own fake-lesion masks,
// checked against the `sct_analyze_lesion` tables in test/fixtures/sct-metrics.
// The masks are stored AIL, so this also covers the worker's reorientation
// and the slice numbers SCT reports in the stored orientation.

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test/fixtures/sct-metrics');
const FILES = {
  image: 'test_data/batch_t2_deepseg_lesion_sci_t2/input.nii.gz',
  cord: 'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_sc.nii.gz',
  lesion: 'test_data/batch_t2_deepseg_lesion_sci_t2/batch_output_lesion.nii.gz',
};
const { ensureFixtureFiles } = require('../scripts/huggingface-fixtures.cjs');
const { parseCsv } = require('../scripts/sct-metrics-lib.cjs');

async function fixture(role) {
  await ensureFixtureFiles(ROOT, [FILES[role]]);
  return gunzipSync(await readFile(join(ROOT, FILES[role])));
}

async function reference(id) {
  const rows = parseCsv(await readFile(join(FIXTURES, `${id}.csv`), 'utf8'));
  const header = rows[0].map(field => field.text);
  return { header, rows: rows.slice(1).map(row => Object.fromEntries(header.map((name, index) => [name, row[index].text]))) };
}

function expectLesionsMatch(actualRows, expected) {
  expect(actualRows.length).toBe(expected.rows.length);
  expected.rows.forEach((row, index) => {
    for (const [column, text] of Object.entries(row)) {
      const actual = actualRows[index][column];
      if (text === '') {
        expect(actual === undefined || Number.isNaN(actual), `${column} of lesion ${row.label} is empty in SCT`).toBe(true);
        continue;
      }
      const sct = Number(text);
      expect(Math.abs(actual - sct), `${column} of lesion ${row.label}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(sct)));
    }
  });
}

async function run(page, files) {
  for (const [role, file] of Object.entries(files)) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: file.buffer });
    await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'lesion-metrics' }));
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 120000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  return snapshot;
}

test('automation measures lesion masks and matches sct_analyze_lesion', async ({ page }) => {
  test.setTimeout(300000);
  const [image, cord, lesion] = await Promise.all([fixture('image'), fixture('cord'), fixture('lesion')]);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));

  // -m lesion -s cord -i image
  const withImage = await run(page, {
    lesion: { name: 'les_lesion.nii', buffer: lesion },
    cord: { name: 'les_sc.nii', buffer: cord },
    image: { name: 'les.nii', buffer: image },
  });
  const expected = await reference('fake_lesion_image');
  expect(withImage.report.provenance.equivalentCommand).toBe('sct_analyze_lesion -m les_lesion.nii -s les_sc.nii -i les.nii');
  expectLesionsMatch(withImage.report.measurements.lesion_metrics.rows, expected);

  const waiting = page.waitForEvent('download');
  await page.evaluate(() => neurodeskAutomation.dispatch('download', { artifactId: 'lesion_metrics' }));
  const csv = await readFile(await (await waiting).path(), 'utf8');
  expect(csv.split('\n')[0]).toBe(expected.header.join(','));

  // The table is on screen with the summary SCT prints.
  const block = page.locator('#metricsResults [data-metrics-stage="lesion_metrics"]');
  await expect(block.locator('tbody tr')).toHaveCount(1);
  await expect(block.locator('.metrics-summary-item').first()).toContainText('Lesions');
  await expect(page.locator('#statusText')).toHaveText('Complete');

  // Four lesions: a parasagittal one that sticks out of the cord and two that touch by a corner.
  const stored = JSON.parse(await readFile(join(FIXTURES, 'les_multi.json'), 'utf8'));
  const offset = Math.floor(lesion.readFloatLE(108));
  const multi = Buffer.from(lesion);
  multi.fill(0, offset);
  for (const index of stored.indices) multi[offset + index] = 1;
  const several = await run(page, {
    lesion: { name: 'les_multi.nii', buffer: multi },
    cord: { name: 'les_sc.nii', buffer: cord },
  });
  expectLesionsMatch(several.report.measurements.lesion_metrics.rows, await reference('multi_lesion'));
  await expect(block.locator('tbody tr')).toHaveCount(4);
});
