import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { syntheticMovie, tiff } from '../e2e/fixtures.mjs';

// The offline desktop check. The shared fixture is a NIfTI volume, so the app preprocesses its own
// synthetic TIFF movie (four blinking cells) and downloads the traces.
export async function verifyOffline(page, { download }) {
  await page.locator('#movieInput').setInputFiles(tiff('offline-movie.tif', syntheticMovie()));
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Preprocessing complete', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Traces (CSV)") .nd-download-btn');
  const header = result.bytes.toString('utf8').split('\n')[0];
  assert.match(header, /^frame,time_s,roi1_F,roi1_Fneu,roi1_Fcorrected,roi1_dFF/);
  return { filename: result.filename, bytes: result.bytes.length };
}
