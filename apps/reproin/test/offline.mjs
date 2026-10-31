import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// The installed desktop app converts the public Siemens XA60 ReproIn session from the offline
// bundle: dcm2niix + post-pass into crlab/AgingBrain.
export async function verifyOffline(page, { download }) {
  const [example] = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
  const selector = page.getByRole('combobox', { name: 'Input', exact: true });
  await expect(selector).toBeEnabled({ timeout: 120000 });
  await selector.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('BIDS dataset ready', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:first-child .nd-download-btn');
  assert.equal(result.filename, 'bids.zip');
  assert.ok(result.bytes.includes('bids/crlab/AgingBrain/sub-ro/ses-1/anat/sub-ro_ses-1_T1w.nii.gz'));
  return { filename: result.filename, bytes: result.bytes.length };
}
