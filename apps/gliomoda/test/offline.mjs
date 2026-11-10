import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';

// The installed desktop app segments the bundled example on the CPU with the bundled
// four-sequence model, without mirroring, and writes BraTS labels on the atlas grid. The generic
// fixture is off that grid, so it must be refused first.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#statusText')).toContainText('GlioMODA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid', { timeout: 60000 });
  await expect(page.locator('#runButton')).toBeDisabled();
  await page.getByLabel('Input', { exact: true }).selectOption('upenn-gbm-00002');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#advancedSettings').evaluate((section) => { section.open = true; });
  await page.locator('#mirror').uncheck();
  await page.locator('#backend').selectOption('wasm');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText(/^Segmentation complete · whole tumour [\d.]+ ml$/, { timeout: 1800000 });
  const segmentation = await download('#resultList .nd-volume-toggle:has-text("Tumour labels") .nd-download-btn');
  assert.equal(segmentation.filename, 'UPENN-GBM-00002_11_gliomoda_seg.nii.gz');
  const nifti = gunzipSync(segmentation.bytes);
  assert.deepEqual([nifti.readInt16LE(42), nifti.readInt16LE(44), nifti.readInt16LE(46)], [240, 240, 155]);
  assert.equal(nifti.readInt16LE(70), 2, 'the labels are uint8');
  const labels = new Set(nifti.subarray(352));
  assert.ok(labels.has(2), 'the example has oedema');
  return { filename: segmentation.filename, labels: [...labels].sort() };
}
