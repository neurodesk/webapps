import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect(page.locator('#resultList .nd-download-btn')).toBeVisible({ timeout: 1100000 });
  const result = await download('#resultList .nd-download-btn');
  assert.equal(new DataView(result.bytes.buffer, result.bytes.byteOffset).getInt32(0, true), 348);
  assert.ok(result.bytes.length >= 256 ** 3 + 352);
  return { filename: result.filename, bytes: result.bytes.length };
}
