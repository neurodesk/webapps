import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { writeTiffStack } from '@neurodesk/webapp-components/file-io/tiff';
import { analyseField } from '../src/core/field.js';
import { smallField } from './synthetic.js';

// The offline desktop check. The shared fixture is a NIfTI volume, so the app measures its own
// small synthetic field image and downloads the metrics.
export async function verifyOffline(page, { download }) {
  const { width, height, data } = smallField();
  const buffer = Buffer.from(writeTiffStack({ width, height, data }));
  await page.locator('#imageInput').setInputFiles({ name: 'offline-field.tif', mimeType: 'image/tiff', buffer });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Quality control complete', { timeout: 120000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Field metrics (CSV)") .nd-download-btn');
  const expected = analyseField(data, { width, height, dtype: 'uint16' });
  const uniformity = Number(result.bytes.toString('utf8').split('\n')[1].split(',')[1]);
  assert.ok(Math.abs(uniformity - expected.uniformity) < 1e-6);
  return { filename: result.filename, bytes: result.bytes.length };
}
