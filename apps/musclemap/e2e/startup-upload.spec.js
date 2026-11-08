import { expect, test } from '@playwright/test';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

test('the scan picker waits for viewer startup before accepting DICOM files', async ({ page }) => {
  await page.route('**/niivue.umd.js', async route => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}
        const originalAttach = niivue.Niivue.prototype.attachTo;
        niivue.Niivue.prototype.attachTo = async function (...args) {
          await new Promise(resolve => { window.releaseViewerStartup = resolve; });
          return originalAttach.apply(this, args);
        };`,
    });
  });
  await page.goto('/index.html');
  await page.waitForFunction(() => typeof window.releaseViewerStartup === 'function');
  const input = page.locator('#fileInput');
  await expect(input).toBeDisabled();
  await page.evaluate(() => window.releaseViewerStartup());
  await expect(input).toBeEnabled();
  await input.setInputFiles(dicomSeries({ extension: '.IMA' }));
  await expect(page.locator('#fileList .file-name')).toContainText(['.nii']);
  await expect(page.locator('#runSegmentation')).toBeEnabled();
});
