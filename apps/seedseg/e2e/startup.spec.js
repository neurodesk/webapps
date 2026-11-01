import { expect, test } from './fixtures.js';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

test.use({ serviceWorkers: 'block' });

test('DICOM conversion completes while the optional report host remains stalled', async ({ page }) => {
  test.setTimeout(120000);
  const pending = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://webapps.neurodesk.org/dicompare/**', route => {
    pending.push(route);
  });
  try {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    // Keep a real request to the report's module unresolved during conversion.
    await page.evaluate(() => {
      fetch('https://webapps.neurodesk.org/dicompare/embed/DicompareController.js').catch(() => {});
    });
    await expect.poll(() => pending.length).toBe(1);
    await page.locator('#unifiedFiles').setInputFiles(dicomSeries({ series: 609, extension: '' }));
    await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 90000 });
    const converted = await page.evaluate(async () => {
      const file = window.app.fileIOController.getActiveFile();
      return { name: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), retained: window.app.dicompareFiles.length };
    });
    expect(converted.name).toMatch(/\.nii(\.gz)?$/);
    expect(converted.retained).toBe(4);
    expect((await readNifti(Uint8Array.from(converted.bytes))).dims).toEqual([16, 16, 4]);
    expect(pending).toHaveLength(1);
    await expect(page.locator('#dicompareReportBtn')).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(pending.map(route => route.abort().catch(() => {})));
  }
});


test('inference help opens from the keyboard through shared tooltips', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#seedseg-section-2 [data-disclosure-toggle]').click();
  const icon = page.getByLabel('About networks', { exact: true });
  const tooltip = icon.getByRole('tooltip');
  await icon.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.locator('#probThreshold').focus();
  await expect(tooltip).toBeHidden();
});
