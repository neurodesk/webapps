import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';

// Replace this pass-through check with the implemented method's output check.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Input copy ready');
  const result = await download('#resultList .nd-download-btn');
  assert.deepEqual(result.bytes, await readFile(fixture));
  return { filename: result.filename, bytes: result.bytes.length };
}
