import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// The installed desktop app loads the bundled example (six GIfTI runs, apertures, labels and
// surfaces), runs a reverse-correlation pRF analysis and writes SamSrf's polar angle GIfTI with
// one value per vertex of the example's surface. The single-image fixture does not fit SamSrf.
export async function verifyOffline(page, { download }) {
  await page.getByRole('combobox', { name: 'Input', exact: true }).selectOption('x001-bars');
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 300000 });
  await page.locator('#analysis').selectOption('rc');
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('maps ready', { timeout: 1800000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Polar angle") .nd-download-btn');
  assert.equal(result.filename, 'lh_pRF_Rcp_pol.gii');
  assert.match(result.bytes.subarray(0, 4096).toString('utf8'), /Dim0="134260"/);
  return { filename: result.filename, bytes: result.bytes.length };
}
