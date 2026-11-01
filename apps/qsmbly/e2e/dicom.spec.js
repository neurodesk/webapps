import { expect, test } from '@playwright/test';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

test('a multi-echo DICOM series converts and classifies by echo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#unifiedFiles')).toBeEnabled();
  await page.evaluate(() => {
    const original = window.app._onDicomConversionComplete.bind(window.app);
    window.app._onDicomConversionComplete = classified => {
      window.dicomBatch = classified.magnitude.map(entry => ({ name: entry.name, echoTime: entry.echoTime }));
      return original(classified);
    };
  });
  await page.locator('#unifiedFiles').setInputFiles(dicomSeries({ series: 7, extension: '', echoTimes: ['10', '20'] }));
  const batch = await page.waitForFunction(() => window.dicomBatch, null, { timeout: 90000 }).then(handle => handle.jsonValue());
  expect(batch.map(entry => entry.echoTime)).toEqual([10, 20]);
  for (const { name } of batch) expect(name).toMatch(/\.nii(\.gz)?$/);
});
