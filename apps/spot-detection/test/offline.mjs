import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { analyse } from '../src/pipeline.js';
import { syntheticImage } from '../src/synthetic.js';
import { writeTiffStack } from './tiff-fixture.mjs';

// The installed desktop app detects spots in a synthetic stack (the NIfTI fixture is not
// microscopy) and downloads the spots table the same pipeline writes in Node.
export async function verifyOffline(page, { download }) {
  const image = syntheticImage([8, 48, 56], 25, 9);
  await page.locator('#imageInput').setInputFiles({ name: 'synthetic.tif', mimeType: 'image/tiff', buffer: writeTiffStack(image) });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText(/^\d+ spots detected$/, { timeout: 120000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Spots") .nd-download-btn');
  assert.equal(result.filename, 'synthetic_spots.csv');
  const expected = analyse(image, { voxelSize: [300, 103, 103], spotRadius: [350, 150, 150] });
  assert.equal(result.bytes.toString('utf8'), expected.spotsCsv);
  return { filename: result.filename, spots: expected.spots.length };
}
