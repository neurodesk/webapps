import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { serveSite } from '../../../test-utils/serve-site.mjs';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const site = await serveSite(fileURLToPath(new URL('../dist', import.meta.url)));
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
let finishCatalog;
const catalogResponse = new Promise(resolve => { finishCatalog = resolve; });
let catalogRequested = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/examples.json', async route => {
    catalogRequested = true;
    await catalogResponse;
    await route.fulfill({ status: 503, body: 'Catalog unavailable' });
  });
  await page.goto(site.origin);
  await expect.poll(() => catalogRequested, { timeout: 30000 }).toBe(true);
  await expect(page.locator('#unifiedFiles')).toBeEnabled();
  await page.locator('#unifiedFiles').setInputFiles(dicomSeries({ extension: '.IMA' }));
  await expect(page.locator('#consoleOutput')).toContainText('Magnitude (Echo 1) loaded', { timeout: 30000 });
  finishCatalog();
  await expect(page.locator('#consoleOutput')).toContainText('Could not load the example catalog.');
  await page.locator('#maskFiles').setInputFiles(dicomSeries());
  await expect.poll(() => page.evaluate(() => window.app?.fileIOController?.maskFile?.[0]?.name)).toMatch(/\.nii/);
  assert.deepEqual(errors, []);
  console.log('PASS QSMbly: DICOM uploads work while the example catalog is pending and after it fails');
} finally {
  finishCatalog();
  await browser.close();
  await site.close();
}
