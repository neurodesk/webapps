// Conversions are owned by the store, not by the view: quick switching converts each series
// once (a done series is marked ✓), Convert all converts the rest in the background, and saved conversions open after
// a reload without dcm2niix. Each dcm2niix run is one `worker.jpeg` Worker.
import { test, expect } from '@playwright/test';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const status = (page) => page.locator('#statusText');
const row = (page, series) => page.locator('#seriesList .nd-volume-toggle', { hasText: `test_scan_${series}` });
const view = (page, series) => row(page, series).getByRole('button', { name: 'View' });
const shown = (page, series) => expect(status(page)).toHaveText(`Series ${series}: test_scan_${series} · 1 image`, { timeout: 60000 });
const workers = (page) => page.evaluate(() => window.dcm2niixWorkers);
const files = (...series) => series.flatMap((number) => dicomSeries({ series: number, slices: 40 }))
  .map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));

// Counts dcm2niix workers for the life of the context, and can hold each run's start
// (the message carrying the files) until the test releases it.
async function instrument(page) {
  await page.addInitScript(() => {
    window.dcm2niixWorkers = 0;
    window.heldRuns = [];
    window.holdRuns = false;
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        if (/worker\.jpeg/.test(String(url))) window.dcm2niixWorkers += 1;
      }

      postMessage(message, transfer) {
        if (window.holdRuns && message?.fileList && message?.cmd) {
          window.heldRuns.push(() => super.postMessage(message, transfer));
          return;
        }
        super.postMessage(message, transfer);
      }
    };
    window.releaseRuns = () => {
      window.holdRuns = false;
      for (const release of window.heldRuns.splice(0)) release();
    };
  });
}

test('switching series while one converts keeps that conversion; each series converts once', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.evaluate(() => { window.holdRuns = true; });
  await page.locator('#dicomInput').setInputFiles(files(3, 7));
  await expect(status(page)).toHaveText('Series 3: test_scan_3 · converting…', { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => window.heldRuns.length)).toBe(1);
  await view(page, 7).click();
  await view(page, 3).click();
  await view(page, 7).click();
  await expect(status(page)).toHaveText('Series 7: test_scan_7 · converting…');
  await expect(row(page, 3)).not.toContainText('✓');
  await page.evaluate(() => window.releaseRuns());
  await shown(page, 7);
  await expect(row(page, 3), 'series 3 finished although it was no longer selected').toContainText('✓');
  await expect(row(page, 7)).toContainText('✓');
  await view(page, 3).click();
  await shown(page, 3);
  await expect(page.locator('#imageLabel')).toHaveText(/\.nii$/);
  expect(await workers(page)).toBe(2);
});

test('Convert all converts every series once in the background, after which viewing starts no worker', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.locator('#dicomInput').setInputFiles(files(1, 2, 3));
  await shown(page, 1);
  await page.locator('#convertAllButton').click();
  await expect(status(page)).toHaveText('2 series converted · 1 already converted', { timeout: 60000 });
  await expect(page.locator('#progress')).toHaveAttribute('value', '1');
  for (const series of [1, 2, 3]) await expect(row(page, series)).toContainText('✓');
  expect(await workers(page)).toBe(3);
  for (const series of [2, 3, 1]) {
    await view(page, series).click();
    await shown(page, series);
    await expect(page.locator('#imageLabel')).toHaveText(new RegExp(`test_scan_${series}.*\\.nii$`));
  }
  expect(await workers(page)).toBe(3);
  await page.locator('#convertAllButton').click();
  await expect(status(page)).toHaveText('0 series converted · 3 already converted');
});

test('saved conversions open after a reload without dcm2niix; Clear saved converts again', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.locator('#dicomInput').setInputFiles(files(3, 7));
  await shown(page, 3);
  await view(page, 7).click();
  await shown(page, 7);
  expect(await workers(page)).toBe(2);

  await page.reload();
  await expect(status(page)).toHaveText('Drag and drop files');
  await page.locator('#dicomInput').setInputFiles(files(3, 7));
  await shown(page, 3);
  await expect(page.locator('#imageLabel')).toHaveText(/test_scan_3.*\.nii$/);
  await expect(page.locator('#technicalLog')).toContainText('opened from the saved conversion');
  await view(page, 7).click();
  await shown(page, 7);
  await expect(page.locator('#imageLabel')).toHaveText(/test_scan_7.*\.nii$/);
  await expect(page.locator('#emptyState')).toBeHidden();
  expect(await workers(page), 'both series came from the saved store').toBe(0);
  for (const series of [3, 7]) await expect(row(page, series)).toContainText('✓');

  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await row(page, 7).getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  expect(downloads.map((download) => download.suggestedFilename()).sort()).toEqual(['series7_test_scan_7.json', 'series7_test_scan_7.nii']);

  await page.locator('#forgetButton').click();
  await expect(status(page)).toHaveText('Saved images removed from this browser');
  for (const series of [3, 7]) await expect(row(page, series)).not.toContainText('✓');
  await view(page, 3).click();
  await shown(page, 3);
  expect(await workers(page), 'a forgotten series converts again').toBe(1);
  await page.reload();
  await page.locator('#dicomInput').setInputFiles(files(3, 7));
  await shown(page, 3);
  expect(await workers(page), 'the conversion after Forget was saved again').toBe(0);
});

test('a changed file gives a series a new fingerprint, so a stale conversion is never shown', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.locator('#dicomInput').setInputFiles(files(3));
  await shown(page, 3);
  await page.reload();
  const changed = files(3);
  changed[0].buffer = Buffer.from(changed[0].buffer);
  const echoTime = changed[0].buffer.indexOf(Buffer.from([0x81, 0x00, 0x44, 0x53]));
  changed[0].buffer.write('30', echoTime + 8, 'latin1');
  await page.locator('#dicomInput').setInputFiles(changed);
  await shown(page, 3);
  expect(await workers(page)).toBe(1);
});

test('× during Convert all stops the batch and keeps the series that finished', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.locator('#dicomInput').setInputFiles(files(1, 2, 3));
  await shown(page, 1);
  await page.evaluate(() => { window.holdRuns = true; });
  await page.locator('#convertAllButton').click();
  await expect(status(page)).toHaveText('Converting 1 of 2 series');
  await expect(page.locator('#convertAllButton')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.heldRuns.length)).toBe(1);
  await page.locator('#cancelButton').click();
  await expect(status(page)).toHaveText('Convert all cancelled');
  await expect(page.locator('#convertAllButton')).toBeEnabled();
  await page.evaluate(() => window.releaseRuns());
  await page.waitForTimeout(500);
  await expect(row(page, 1)).toContainText('✓');
  await expect(row(page, 2)).not.toContainText('✓');
  await expect(row(page, 3)).not.toContainText('✓');
  expect(await workers(page), 'series 1 and the cancelled series 2').toBe(2);
  await view(page, 1).click();
  await shown(page, 1);
  expect(await workers(page), 'series 1 stayed cached').toBe(2);
  await view(page, 2).click();
  await shown(page, 2);
  expect(await workers(page)).toBe(3);
});

test('× while a chosen series converts cancels that conversion; View converts it again', async ({ page }) => {
  await instrument(page);
  await page.goto('./');
  await page.evaluate(() => { window.holdRuns = true; });
  await page.locator('#dicomInput').setInputFiles(files(7));
  await expect.poll(() => page.evaluate(() => window.heldRuns.length)).toBe(1);
  await page.locator('#cancelButton').click();
  await expect(status(page)).toHaveText('Series 7: test_scan_7 · conversion cancelled');
  await page.evaluate(() => window.releaseRuns());
  await page.waitForTimeout(500);
  await expect(row(page, 7)).not.toContainText('✓');
  await view(page, 7).click();
  await shown(page, 7);
  expect(await workers(page)).toBe(2);
});
