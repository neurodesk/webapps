import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyOffline(page, { download }) {
  await page.locator('select[data-neurodesk-example]').selectOption('rodent-mri');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready', { timeout: 300000 });
  const brain = await download('#resultList .nd-volume-toggle:nth-child(2) .nd-download-btn');
  const mask = await download('#resultList .nd-volume-toggle:nth-child(3) .nd-download-btn');
  assert.equal(new DataView(brain.bytes.buffer, brain.bytes.byteOffset).getInt32(0, true), 348);
  assert.equal(new DataView(mask.bytes.buffer, mask.bytes.byteOffset).getInt32(0, true), 348);
  return { brain: brain.filename, mask: mask.filename, bytes: mask.bytes.length };
}
