// Browser tests against the built app (see playwright.config.js): the shell, the example
// through indexing, conversion, the header explorer and dicompare, and their failure,
// cancellation and retry paths.
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { PREFIX_BYTES } from '../src/dicom-index.js';

const [example] = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const exampleUrls = new Set(example.files.map((file) => file.url));
const EXAMPLE_SERIES = 'Series 2: t1_mpr_tra_gk_v4 · 1 image';

const picker = (page) => page.getByRole('combobox', { name: 'Input', exact: true });
const exampleState = (page) => page.locator('[data-neurodesk-examples]');
const status = (page) => page.locator('#statusText');
const headerRows = (page) => page.locator('#headerRows tr');

// The example's downloads, failed where respond() answers. Routed on the context so
// requests made by the app's service worker are caught too.
async function routeExample(page, respond) {
  const order = example.files.map((file) => file.url);
  await page.context().route((url) => exampleUrls.has(url.href), (route) => {
    const index = order.indexOf(route.request().url());
    return respond(index, route) ?? route.continue();
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
  const background = (selector) => page.locator(selector).evaluate((node) => getComputedStyle(node).backgroundColor);
  await expect(page.locator('#seriesList .nd-view-btn.active')).toHaveCount(1);
  expect(await background('#seriesList .nd-view-btn.active')).not.toBe(await background('#seriesList .nd-download-btn'));
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
  // Live workers started from blob: URLs: dicompare's, and inlined ones the viewer may start.
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.blobWorkers = new Set();
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        if (String(url).startsWith('blob:')) window.blobWorkers.add(this);
      }

      terminate() {
        window.blobWorkers.delete(this);
        super.terminate();
      }

      postMessage(message, transfer) {
        if (message?.type === 'analyzeFiles') {
          const sizes = message.payload.fileContents.map((buffer) => buffer.byteLength);
          window.analyzed = { files: sizes.length, bytes: sizes.reduce((sum, size) => sum + size, 0), transferred: transfer?.length ?? 0 };
        }
        super.postMessage(message, transfer);
      }
    };
  });
  await page.goto('./');
  await picker(page).selectOption(example.id);
  await expect(status(page)).toHaveText(EXAMPLE_SERIES, { timeout: 180000 });
  await page.locator('#protocolSection > summary').click();
  const button = page.locator('#protocolButton');
  await expect(button).toHaveText('Summarize protocol');

  const workerScript = '**/assets/dicompare-worker-*.js';
  await page.context().route(workerScript, (route) => route.fulfill({ status: 503, body: '' }));
  await button.click();
  await expect(status(page)).toContainText('Failed to load dicompare worker');
  await expect(status(page)).toHaveClass(/error/);
  await page.context().unroute(workerScript);

  // Hold each fetch of the worker script, so the cancel lands while start-up is still
  // fetching and the retry's fetch completes after the cancelled one's.
  const held = [];
  await page.context().route(workerScript, (route) => { held.push(route); });
  const workersBefore = await page.evaluate(() => window.blobWorkers.size);
  await button.click();
  await expect.poll(() => held.length).toBe(1);
  await page.locator('#cancelButton').click();
  await expect(status(page)).toHaveText('Protocol summary cancelled');
  await expect(button).toBeEnabled();
  await button.click();
  await expect.poll(() => held.length).toBe(2);
  await held[0].continue();
  await held[1].continue();
  await page.context().unroute(workerScript);
  await expect(status(page)).toHaveText('1 acquisition summarised', { timeout: 600000 });
  expect(await page.evaluate(() => window.blobWorkers.size), 'the cancelled start-up created no worker').toBe(workersBefore + 1);
  await expect(page.locator('#protocolReport')).toBeVisible();
  await expect(page.locator('#protocolSummary caption')).toHaveText('acq-t1mprtragkv4 · 120 files');
  await expect(page.locator('#protocolSummary tr', { hasText: 'RepetitionTime' })).toContainText('1900');
  const analyzed = await page.evaluate(() => window.analyzed);
  expect(analyzed.files).toBe(120);
  expect(analyzed.transferred, 'the buffers move to the worker').toBe(120);
  expect(analyzed.bytes, 'headers only: 120 slices of 512 × 512 16-bit pixels are 63 MB').toBeLessThan(120 * 512 * 512 * 2 / 10);

  await page.locator('#schemaSelect').selectOption({ label: 'QSM Consensus Guidelines' });
  await expect(button).toHaveText('Check compliance');
  // Cancelling a check ends the worker; the next check must start a new one.
  await button.click();
  await page.locator('#cancelButton').click({ timeout: 2000 }).catch(() => {});
  await expect(status(page)).toHaveText(/cancelled|checked against/, { timeout: 120000 });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(status(page)).toHaveText('1 acquisition checked against QSM Consensus Guidelines', { timeout: 120000 });
  await expect(page.locator('#complianceReport .dicompare-error')).toHaveCount(0);
  await expect(page.locator('#complianceReport .dicompare-summary')).toContainText('5 Passed');
  await expect(page.locator('#complianceReport .dicompare-status-fail').first()).toBeVisible();
});

for (const failure of ['download', 'corrupt download']) {
  test(`a failed example (${failure}) can be retried`, async ({ page }) => {
    let failing = true;
    await routeExample(page, (index, route) => {
      if (!failing) return null;
      if (failure === 'download') return index === 0 ? route.fulfill({ status: 503, body: '' }) : null;
      return route.fulfill({ body: 'not a DICOM file' });
    });
    await page.goto('./');
    await picker(page).selectOption(example.id);
    await expect(exampleState(page)).toHaveAttribute('data-example-state', 'error', { timeout: 60000 });
    if (failure === 'corrupt download') await expect(status(page)).toContainText('size mismatch');
    await expect(page.locator('#protocolButton')).toBeDisabled();
    await expect(picker(page)).toBeEnabled();
    failing = false;
    await picker(page).selectOption(example.id);
    await expect(exampleState(page)).toHaveAttribute('data-example-state', 'ready', { timeout: 60000 });
    await expect(status(page)).toHaveText(EXAMPLE_SERIES, { timeout: 60000 });
  });
}

test('cancelling while headers are read commits nothing and permits a retry', async ({ page }) => {
  await page.goto('./');
  await page.evaluate((prefixBytes) => {
    const read = Blob.prototype.arrayBuffer;
    // Only a header read: the example's checksum reads take whole files.
    Blob.prototype.arrayBuffer = function () {
      if (this.size !== prefixBytes) return read.call(this);
      const blob = this;
      return new Promise((resolve, reject) => {
        window.finishRead = () => {
          Blob.prototype.arrayBuffer = read;
          read.call(blob).then(resolve, reject);
        };
      });
    };
  }, PREFIX_BYTES);
  await picker(page).selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishRead === 'function', null, { timeout: 60000 });
  await page.getByRole('button', { name: 'Cancel example download', exact: true }).click();
  await page.evaluate(() => window.finishRead());
  await expect(exampleState(page)).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#fileInfo')).toBeHidden();
  await expect(page.locator('#seriesList .nd-volume-toggle')).toHaveCount(0);
  await picker(page).selectOption(example.id);
  await expect(exampleState(page)).toHaveAttribute('data-example-state', 'ready', { timeout: 60000 });
  await expect(status(page)).toHaveText(EXAMPLE_SERIES, { timeout: 60000 });
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

test('a downloaded sidecar leaves out the patient\'s name and birth date', async ({ page }) => {
  await page.goto('./');
  const files = dicomSeries({ series: 7, slices: 4, patient: { birthDate: '19800101', studyDate: '20240102' } })
    .map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));
  await page.locator('#dicomInput').setInputFiles(files);
  await expect(status(page)).toHaveText('Series 7: test_scan_7 · 1 image', { timeout: 60000 });
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#seriesList').getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads.length).toBe(2);
  const sidecar = JSON.parse(readFileSync(await downloads[1].path(), 'utf8'));
  expect(sidecar.SeriesDescription).toBe('test_scan_7');
  expect(sidecar).not.toHaveProperty('PatientName');
  expect(sidecar).not.toHaveProperty('PatientBirthDate');
});

test('protocol actions wait while a replacement folder is read', async ({ page }) => {
  await page.goto('./');
  const files = (series) => dicomSeries({ series, slices: 2 }).map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));
  await page.locator('#dicomInput').setInputFiles(files(1));
  await expect(page.locator('#fileInfo')).toHaveText('2 images · 1 series');
  await page.locator('#protocolSection > summary').click();
  const button = page.locator('#protocolButton');
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    const pending = [];
    window.pendingReads = () => pending.length;
    Blob.prototype.arrayBuffer = function () {
      return new Promise((resolve, reject) => pending.push(() => read.call(this).then(resolve, reject)));
    };
    window.finishRead = () => {
      Blob.prototype.arrayBuffer = read;
      for (const release of pending) release();
    };
  });
  await page.locator('#dicomInput').setInputFiles(files(2));
  await page.waitForFunction(() => window.pendingReads() > 0);
  await expect(button).toBeDisabled();
  await page.evaluate(() => window.finishRead());
  await expect(page.locator('#seriesList')).toContainText('test_scan_2');
  await expect(button).toBeEnabled();
});

test('a folder whose series fails to convert never keeps the previous folder\'s image', async ({ page }) => {
  await page.goto('./');
  const valid = dicomSeries({ series: 7, slices: 4 }).map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer }));
  await page.locator('#dicomInput').setInputFiles(valid);
  await expect(status(page)).toHaveText('Series 7: test_scan_7 · 1 image', { timeout: 60000 });
  await expect(page.locator('#emptyState')).toBeHidden();
  const pixelData = 12 + 16 * 16 * 2;
  const headersOnly = dicomSeries({ series: 3, slices: 4 })
    .map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer: buffer.subarray(0, buffer.length - pixelData) }));
  await page.locator('#dicomInput').setInputFiles(headersOnly);
  await expect(page.locator('#fileInfo')).toHaveText('4 images · 1 series');
  await expect(page.locator('#statusText')).not.toContainText('converting', { timeout: 60000 });
  await expect(page.locator('#emptyState')).toBeVisible();
  await expect(page.locator('#imageLabel')).toHaveText('');
});

test('Choose folder reads every series in a directory tree', async ({ page }, testInfo) => {
  const root = testInfo.outputPath('session');
  for (const series of [4, 9]) {
    const dir = path.join(root, `series-${series}`);
    mkdirSync(dir, { recursive: true });
    for (const { name, buffer } of dicomSeries({ series, slices: 3 })) writeFileSync(path.join(dir, name), buffer);
  }
  await page.goto('./');
  await page.locator('#folderInput').setInputFiles(root);
  await expect(page.locator('#fileInfo')).toHaveText('6 images · 2 series');
  await expect(page.locator('#seriesList .nd-volume-toggle')).toHaveCount(2);
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
