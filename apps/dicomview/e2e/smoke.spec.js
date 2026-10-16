// Browser tests against the built app (see playwright.config.js): the shell, the example
// through indexing, conversion, the header explorer and dicompare, and their failure,
// cancellation and retry paths.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const [example] = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const exampleUrls = new Set(example.files.map((file) => file.url));
const EXAMPLE_SERIES = 'Series 2: t1_mpr_tra_gk_v4 · 1 image';
const SYNTHETIC_SERIES = 'Series 2: test_scan_2 · 1 image';

const picker = (page) => page.getByRole('combobox', { name: 'Input', exact: true });
const exampleState = (page) => page.locator('[data-neurodesk-examples]');
const status = (page) => page.locator('#statusText');
const headerRows = (page) => page.locator('#headerRows tr');

// Synthetic 16 × 16 slices in place of the example's files: the failure paths need no network.
async function serveSynthetic(page, respond = () => null) {
  const slices = dicomSeries({ series: 2, slices: example.files.length });
  const order = example.files.map((file) => file.url);
  await page.route((url) => exampleUrls.has(url.href), (route) => {
    const index = order.indexOf(route.request().url());
    return respond(index, route) ?? route.fulfill({ body: slices[index].buffer });
  });
}

function niftiDims(bytes) {
  expect(bytes.readInt32LE(0)).toBe(348);
  return [1, 2, 3].map((axis) => bytes.readInt16LE(40 + 2 * axis));
}

test('the shared app bar owns information actions and the page is cross-origin isolated', async ({ page }) => {
  await page.goto('./');
  await expect(status(page)).toHaveText('Drag and drop files');
  const bar = page.locator('.nd-app-bar:visible');
  await expect(bar).toHaveCount(1);
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('dcm2niix');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test('the example opens as one series that converts, downloads and explains its header', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('./');
  await picker(page).selectOption(example.id);
  await expect(exampleState(page)).toHaveAttribute('data-example-state', 'ready', { timeout: 180000 });
  await expect(page.locator('#fileInfo')).toHaveText('120 images · 1 series');
  await expect(status(page)).toHaveText(EXAMPLE_SERIES, { timeout: 120000 });
  await expect(page.locator('#seriesList')).toContainText('2 · t1_mpr_tra_gk_v4 · MR · 120 images');
  await expect(page.locator('#seriesList .nd-view-btn.active')).toHaveCount(1);
  await expect(page.locator('#seriesInfo')).toHaveText('T1 · 512 × 512 · TR 1900 ms · TE 2.97 ms · TI 1100 ms · FA 15° · slice 1.5 mm · 9 fields vary');
  await expect(page.locator('#imageLabel')).toHaveText(/\.nii$/);

  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#seriesList').getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  const [image, sidecar] = downloads;
  expect(image.suggestedFilename()).toMatch(/t1_mpr_tra_gk_v4.*\.nii$/);
  expect(niftiDims(readFileSync(await image.path()))).toEqual([512, 512, 120]);
  expect(JSON.parse(readFileSync(await sidecar.path(), 'utf8')).EchoTime).toBe(0.00297);

  await page.locator('[data-view="header"]').click();
  await expect(page.locator('#headerReport')).toBeVisible();
  await expect(page.locator('#headerNote')).toContainText('1-001.dcm');
  expect(await headerRows(page).count()).toBeGreaterThan(150);
  await page.locator('#headerFilter').fill('SliceLocation');
  await expect(headerRows(page)).toHaveCount(1);
  const first = await headerRows(page).locator('td').nth(3).textContent();
  await page.locator('#instanceSlider').fill('59');
  await expect(page.locator('#instanceLabel')).toHaveText('60 of 120');
  await expect(headerRows(page).locator('td').nth(3)).not.toHaveText(first);
  await page.locator('#headerFilter').fill('');
  await page.locator('#varyingOnly').check();
  await expect(headerRows(page)).toHaveCount(9);
  await expect(page.locator('#headerRows tr:not([data-flag])')).toHaveCount(0);
  await expect(page.locator('#headerRows')).toContainText('ImagePositionPatient');

  await page.locator('#headerSource').selectOption('sidecar');
  await expect(page.locator('#instanceSlider')).toBeDisabled();
  await page.locator('#headerFilter').fill('EchoTime');
  await expect(headerRows(page).first()).toContainText('0.00297');
  const csv = page.waitForEvent('download');
  await page.locator('#downloadHeader').click();
  const table = await csv;
  expect(table.suggestedFilename()).toBe('series2_sidecar.csv');
  expect(readFileSync(await table.path(), 'utf8')).toMatch(/^tag,keyword,vr,value,depth,varies\n,EchoTime,,0.00297,0,false\n/);
});

test('dicompare fails, cancels and retries, then summarises the example and checks a schema', async ({ page }) => {
  test.setTimeout(900000);
  await page.goto('./');
  await picker(page).selectOption(example.id);
  await expect(status(page)).toHaveText(EXAMPLE_SERIES, { timeout: 180000 });
  await page.locator('#protocolSection > summary').click();
  const button = page.locator('#protocolButton');
  await expect(button).toHaveText('Summarize protocol');

  const workerScript = '**/assets/dicompare-worker-*.js';
  await page.route(workerScript, (route) => route.fulfill({ status: 503, body: '' }));
  await button.click();
  await expect(status(page)).toContainText('Failed to load dicompare worker');
  await expect(status(page)).toHaveClass(/error/);
  await page.unroute(workerScript);

  await button.click();
  await expect(page.locator('#cancelButton')).toBeVisible();
  await page.locator('#cancelButton').click();
  await expect(status(page)).toHaveText('Protocol summary cancelled');
  await expect(button).toBeEnabled();

  await button.click();
  await expect(status(page)).toHaveText('1 acquisition summarised', { timeout: 600000 });
  await expect(page.locator('#protocolReport')).toBeVisible();
  await expect(page.locator('#protocolSummary caption')).toHaveText('acq-t1mprtragkv4 · 120 files');
  await expect(page.locator('#protocolSummary tr', { hasText: 'RepetitionTime' })).toContainText('1900');

  await page.locator('#schemaSelect').selectOption({ label: 'QSM Consensus Guidelines' });
  await expect(button).toHaveText('Check compliance');
  await button.click();
  await expect(status(page)).toHaveText('1 acquisition checked against QSM Consensus Guidelines', { timeout: 120000 });
  await expect(page.locator('#complianceReport .dicompare-summary')).toContainText('Passed');
  await expect(page.locator('#complianceReport .dicompare-status-fail').first()).toBeVisible();
});

for (const failure of ['download', 'unreadable files']) {
  test(`a failed example (${failure}) can be retried`, async ({ page }) => {
    let failing = true;
    await serveSynthetic(page, (index, route) => {
      if (!failing) return null;
      if (failure === 'download') return index === 0 ? route.fulfill({ status: 503, body: '' }) : null;
      return route.fulfill({ body: 'not a DICOM file' });
    });
    await page.goto('./');
    await picker(page).selectOption(example.id);
    await expect(exampleState(page)).toHaveAttribute('data-example-state', 'error', { timeout: 60000 });
    if (failure === 'unreadable files') await expect(status(page)).toHaveText(/No DICOM images in 120 files/);
    await expect(page.locator('#protocolButton')).toBeDisabled();
    await expect(picker(page)).toBeEnabled();
    failing = false;
    await picker(page).selectOption(example.id);
    await expect(exampleState(page)).toHaveAttribute('data-example-state', 'ready', { timeout: 60000 });
    await expect(status(page)).toHaveText(SYNTHETIC_SERIES, { timeout: 60000 });
  });
}

test('cancelling while headers are read commits nothing and permits a retry', async ({ page }) => {
  await serveSynthetic(page);
  await page.goto('./');
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function () {
      const blob = this;
      return new Promise((resolve, reject) => {
        window.finishRead = () => {
          Blob.prototype.arrayBuffer = read;
          read.call(blob).then(resolve, reject);
        };
      });
    };
  });
  await picker(page).selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishRead === 'function', null, { timeout: 60000 });
  await page.getByRole('button', { name: 'Cancel example download', exact: true }).click();
  await page.evaluate(() => window.finishRead());
  await expect(exampleState(page)).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#fileInfo')).toBeHidden();
  await expect(page.locator('#seriesList .nd-volume-toggle')).toHaveCount(0);
  await picker(page).selectOption(example.id);
  await expect(exampleState(page)).toHaveAttribute('data-example-state', 'ready', { timeout: 60000 });
  await expect(status(page)).toHaveText(SYNTHETIC_SERIES, { timeout: 60000 });
});

test('chosen files list every series, skip what is not DICOM, and switch series on View', async ({ page }) => {
  await page.goto('./');
  const files = [...dicomSeries({ series: 7, slices: 4 }), ...dicomSeries({ series: 3, slices: 4 })]
    .map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));
  files.push({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes') });
  await page.locator('#dicomInput').setInputFiles(files);
  await expect(page.locator('#fileInfo')).toHaveText('8 images · 2 series · 1 skipped');
  await expect(status(page)).toHaveText('Series 3: test_scan_3 · 1 image', { timeout: 60000 });
  await page.locator('#seriesList .nd-volume-toggle', { hasText: 'test_scan_7' }).getByRole('button', { name: 'View' }).click();
  await expect(status(page)).toHaveText('Series 7: test_scan_7 · 1 image', { timeout: 60000 });
  await expect(page.locator('#seriesInfo')).toContainText('16 × 16 · TR 2000 ms · TE 20 ms');
  await expect(page.locator('#technicalLog')).toContainText('Skipped notes.txt: not a DICOM file');
});

test('the automation operation returns the series index and the converted image', async ({ page }) => {
  await page.goto('./');
  const files = [...dicomSeries({ series: 5, slices: 4 }), ...dicomSeries({ series: 6, slices: 4 })]
    .map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));
  await page.locator('#neurodesk-input-transfer').setInputFiles(files);
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch('adopt', { role: 'dicom' });
    await globalThis.neurodeskAutomation.dispatch('start', {});
  });
  await expect.poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).state), { timeout: 60000 }).toBe('succeeded');
  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).report);
  expect(Object.keys(report.artifacts).sort()).toEqual(['image', 'series']);
  const download = page.waitForEvent('download');
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('download', { artifactId: 'series' }));
  const series = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  expect(series.map((entry) => [entry.number, entry.images, entry.rows, entry.cols])).toEqual([[5, 4, 16, 16], [6, 4, 16, 16]]);
});
