import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { syntheticTiles } from '../e2e/fixtures.mjs';
import { parseTileConfiguration, positionsFromConfiguration } from '../src/core/tile-layout.js';
import { maxPositionDifference } from '../src/core/pipeline.js';

// The offline desktop check. The shared fixture is a NIfTI volume, so the app stitches its own
// synthetic 2 × 2 mosaic (exact ground truth) and downloads the registered TileConfiguration.
export async function verifyOffline(page, { download }) {
  const { files, truth } = syntheticTiles();
  await page.locator('#tileInput').setInputFiles(files);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#columns').fill('2');
  await page.locator('#rows').fill('2');
  await page.locator('#overlap').fill('20');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Stitched', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("TileConfiguration.registered.txt") .nd-download-btn');
  const configuration = parseTileConfiguration(result.bytes.toString('utf8'));
  const positions = positionsFromConfiguration(configuration, files.map((file) => file.name), 2);
  assert.ok(maxPositionDifference(positions, truth) < 0.5);
  return { filename: result.filename, bytes: result.bytes.length };
}
