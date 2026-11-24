import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';

// Segments the bundled CT abdominal example on CPU with the 3 mm fast model and verifies
// the returned multilabel NIfTI mask and per-structure TSV statistics.
export async function verifyOffline(page, { download }) {
  await page.getByLabel('Input', { exact: true }).selectOption('ct-abdomen');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#taskSelect').selectOption('total');
  await page.locator('#resolutionSelect').selectOption('fast');
  await page.locator('#advancedSettings').evaluate((section) => { section.open = true; });
  await page.locator('#backend').selectOption('wasm');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Segmentation complete', { timeout: 600000 });

  const segmentation = await download('#resultList .nd-volume-toggle:has-text("Segmentation mask") .nd-download-btn');
  assert.equal(segmentation.filename, 'example_ct_sm_totalseg_total.nii.gz');
  const nifti = gunzipSync(segmentation.bytes);
  assert.deepEqual([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)], [122, 101, 30]);
  assert.equal(nifti.readInt16LE(70), 2, 'labels are uint8');
  const labels = new Set(nifti.subarray(352));
  assert.ok(labels.size >= 25, `expected >= 25 structures, got ${labels.size}`);

  const stats = await download('#resultList .nd-volume-toggle:has-text("Structure statistics") .nd-download-btn');
  assert.equal(stats.filename, 'example_ct_sm_totalseg_total_stats.tsv');
  const tsvText = Buffer.from(stats.bytes).toString('utf8');
  assert.ok(tsvText.includes('mean_hu'), 'TSV includes mean_hu column');
  assert.ok(tsvText.includes('liver'), 'TSV includes liver row');
  return { filename: segmentation.filename, statsFilename: stats.filename, structures: labels.size - 1 };
}
