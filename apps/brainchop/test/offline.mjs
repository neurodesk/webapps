import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#method').selectOption('mindmap-fast');
  await page.locator('#runButton').click();
  const downloadBtn = '#resultList .nd-volume-toggle:nth-child(2) .nd-download-btn';
  await expect(page.locator(downloadBtn)).toBeVisible({ timeout: 600000 });
  const result = await download(downloadBtn);
  assert.equal(new DataView(result.bytes.buffer, result.bytes.byteOffset).getInt32(0, true), 348);
  assert.ok(result.bytes.length > 352);
  return { filename: result.filename, bytes: result.bytes.length };
}
