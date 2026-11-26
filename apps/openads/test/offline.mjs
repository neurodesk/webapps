import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function verifyOffline(page, { download }) {
  await page.locator('select[data-neurodesk-example]').selectOption('strokefair-sub-02e8eb42-mni');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60_000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#reportView')).toContainText('Automatic Radiological Report', { timeout: 120_000 });
  const result = await download('#resultList .nd-download-btn');
  assert.ok(result.bytes.length > 0);
  return { filename: result.filename, bytes: result.bytes.length };
}
