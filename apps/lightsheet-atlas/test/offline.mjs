import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// The installed desktop app takes TIFF stacks, not the shared NIfTI fixture, so it runs the
// bundled cellfinder crop example offline and must find cellfinder's 38 candidates.
export async function verifyOffline(page, { download }) {
  const reference = JSON.parse(await readFile(new URL('../validation/cellfinder-crop-reference.json', import.meta.url), 'utf8'));
  await page.locator('select[data-neurodesk-example]').selectOption('cellfinder-crop');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('38 cell candidates', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Cell candidates") .nd-download-btn');
  assert.equal(result.filename, 'cellfinder-crop_candidates.csv');
  const rows = result.bytes.toString('utf8').trim().split('\n').slice(1).map((line) => line.split(',').slice(0, 3).join(','));
  assert.deepEqual(rows.sort(), reference.cells.map((cell) => cell.slice(0, 3).join(',')).sort());
  return { filename: result.filename, cells: rows.length };
}
