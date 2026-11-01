import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';

// The installed desktop app classifies every slice of the small fixture on the CPU with the
// bundled model, and its tables agree with each other: tot_df.csv's proportion is the share of
// table.csv's slices flagged, and the map is a uint8 NIfTI on the input grid.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#advancedSettings').evaluate((section) => { section.open = true; });
  await page.locator('#backend').selectOption('wasm');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText(/^(No artifact|Artifact) detected · slices flagged \d+ %$/, { timeout: 900000 });
  const row = (name) => `#resultList .nd-volume-toggle:has-text("${name}") .nd-download-btn`;
  const table = await download(row('table.csv · '));
  const rows = table.bytes.toString('utf8').trim().split('\n');
  assert.equal(table.filename, 'small_table.csv');
  assert.equal(rows[0], 'pred,slice,axis');
  const preds = rows.slice(1).map((line) => Number(line.split(',')[0]));
  const tot = (await download(row('tot_df.csv · '))).bytes.toString('utf8').trim().split('\n');
  const proba = Number(tot[1].split(',')[1]);
  const share = preds.filter((pred) => pred === 1).length / preds.length;
  assert.ok(Math.abs(proba - share) <= 0.005, `tot_df.csv proportion ${proba} against ${share} of table.csv`);
  const map = await download(row('Flagged-slice map'));
  assert.equal(map.filename, 'small_flaggedslices.nii.gz');
  const header = gunzipSync(map.bytes);
  assert.deepEqual([header.readInt16LE(42), header.readInt16LE(44), header.readInt16LE(46)], [44, 52, 44]);
  assert.equal(header.readInt16LE(70), 2, 'the map is uint8');
  return { filename: table.filename, slices: preds.length, proba };
}
