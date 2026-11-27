// Real browser e2e test for VesselCharter running against the built production preview.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const automation = JSON.parse(readFileSync(new URL('../automation.json', import.meta.url), 'utf8'));
const fixturePath = fileURLToPath(
  new URL(
    '../../vesselboost/test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
    import.meta.url,
  ),
);

test('app boots with cross-origin isolation and shared app bar', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#viewer')).toBeVisible();
  const isolated = await page.evaluate(() => self.crossOriginIsolated === true);
  expect(isolated).toBe(true);

  const bar = page.locator('.nd-app-bar:visible');
  await expect(bar).toHaveCount(1);
  await expect(page.locator('#controls > #aboutBtn')).toBeHidden();
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#infoDialog')).toBeVisible();
  await expect(
    page.locator('#infoDialog').getByRole('heading', { name: `About ${automation.title}`, exact: true }),
  ).toBeVisible();
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  await bar.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
});

test('automation characterize operation produces verified summary and CSV artifacts', async ({ page }) => {
  test.setTimeout(120000);
  const bytes = readFileSync(fixturePath);
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles({
    name: 'lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz',
    mimeType: 'application/gzip',
    buffer: bytes,
  });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch('adopt', { role: 'vessels' });
    await globalThis.neurodeskAutomation.dispatch('start', {});
  });
  await expect
    .poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).state), {
      timeout: 60000,
    })
    .toBe('succeeded');

  const report = await page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).report);
  expect(report.measurements.segmentCount).toBeGreaterThan(80);
  expect(report.measurements.totalLengthMm).toBeGreaterThan(800);
  expect(report.artifacts.summary).toBeTruthy();
  expect(report.artifacts.segments).toBeTruthy();
  expect(report.artifacts.junctions).toBeTruthy();
  expect(report.artifacts['diameter-map']).toBeTruthy();

  const downloadPromise = page.waitForEvent('download');
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('download', { artifactId: 'summary' }));
  const download = await downloadPromise;
  const parsed = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(parsed.input.inputVesselVoxels).toBe(33894);
  expect(parsed.network.segmentCount).toBe(report.measurements.segmentCount);
});

for (const example of examples) {
  test(`example ${example.id} loads hosted bytes, runs characterisation, opens Report and downloads CSV`, async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/');
    const responsePromise = page.waitForResponse((response) => {
      let request = response.request();
      while (request.redirectedFrom()) request = request.redirectedFrom();
      return request.url() === example.files[0].url && response.ok();
    });
    await page.locator('select[data-neurodesk-example]').selectOption(example.id);
    await expect(page.locator('#fileInfo')).toContainText(example.files[0].name, { timeout: 120000 });
    await expect(page.locator('#runButton')).toBeEnabled();
    const inputBytes = await (await responsePromise).body();
    expect(inputBytes.length).toBe(example.files[0].bytes);

    await page.locator('#runButton').click();
    await expect(page.locator('#outputSection')).toHaveJSProperty('open', true, { timeout: 60000 });
    await expect(page.locator('#statusText')).toContainText('segments');

    // Colour scale legend and colormap selector appear for the 3D Vessel Tree.
    const legend = page.locator('#colorLegend');
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('data-kind', 'diameter');
    await expect(legend).toContainText('Diameter (mm)');
    await expect(legend).toContainText('Turbo');

    // Clicking View on a report row and returning to the 3D tab preserves the 3D legend and label.
    await page
      .locator('#resultList .nd-volume-toggle')
      .filter({ hasText: 'Summary Metrics (JSON)' })
      .getByRole('button', { name: 'View', exact: true })
      .click();
    await expect(legend).toBeHidden();
    await page.locator('.nd-view-tab[data-view="3d"]').click();
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('data-kind', 'diameter');
    await expect(page.locator('#imageLabel')).toContainText('3D Vessel Tree');

    // Switching to Diameter Map (NIfTI) keeps the diameter legend and updates NiiVue's volume colormap/range.
    await page
      .locator('#resultList .nd-volume-toggle')
      .filter({ hasText: 'Diameter Map (NIfTI)' })
      .getByRole('button', { name: 'View', exact: true })
      .click();
    await expect(page.locator('#imageLabel')).toContainText('Diameter map', { timeout: 30000 });
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('data-kind', 'diameter');
    const colormapSelect = page.locator('select[aria-label="Diameter colormap"]');
    await expect(colormapSelect).toBeVisible();
    await colormapSelect.selectOption('viridis');
    await expect(legend).toContainText('Viridis');

    await page.locator('#diameterScaleSection summary').click();
    await page.locator('#diameterMax').fill('2.5');
    await page.locator('#diameterMax').dispatchEvent('change');
    await expect(legend).toContainText('2.50 mm');

    // Verify NiiVue's actual volume display state reflects the chosen colormap and calMax.
    await expect
      .poll(
        async () => {
          const volumes = await page.evaluate(() =>
            globalThis.neurodeskAutomation.dispatch('viewers.volumes', { viewerId: 'main' }),
          );
          if (!volumes[0]) return null;
          return {
            colormap: volumes[0].colormap.toLowerCase(),
            calMaxOk: Math.abs(volumes[0].calMax - 2.5) < 0.05,
          };
        },
        { timeout: 15000 },
      )
      .toEqual({ colormap: 'viridis', calMaxOk: true });

    // Invalid scale (max <= min) flags validation without overwriting the active range.
    await page.locator('#diameterMax').fill('0.005');
    await page.locator('#diameterMax').dispatchEvent('change');
    const maxValid = await page.locator('#diameterMax').evaluate((el) => el.validity.valid);
    expect(maxValid).toBe(false);
    await expect(legend).toContainText('2.50 mm');

    // Raising min above dataMin notes hidden thin voxels on the Diameter Map legend.
    await page.locator('#diameterMax').fill('2.5');
    await page.locator('#diameterMin').fill('1.0');
    await page.locator('#diameterMin').dispatchEvent('change');
    await expect(legend).toContainText('< 1.00 mm hidden');

    await page.locator('#resetDiameterScaleBtn').click();
    await expect(legend).not.toContainText('2.50 mm');
    await expect(legend).not.toContainText('hidden');

    // Switching to Skeleton Topology (NIfTI) renders the categorical topology legend.
    await page
      .locator('#resultList .nd-volume-toggle')
      .filter({ hasText: 'Skeleton Topology (NIfTI)' })
      .getByRole('button', { name: 'View', exact: true })
      .click();
    await expect(legend).toBeVisible();
    await expect(legend).toHaveAttribute('data-kind', 'skeleton');
    await expect(legend).toContainText('Segment');
    await expect(legend).toContainText('Junction');

    // Open the quantitative Report tab and verify tables populated (legend hides in Report view).
    await page.locator('.nd-view-tab[data-view="report"]').click();
    await expect(legend).toBeHidden();
    await expect(page.locator('#resultsReport')).toBeVisible();
    await expect(page.locator('#resultsReport')).toContainText('Network summary');
    await expect(page.locator('#resultsReport')).toContainText('Diameter-stratified distribution');

    // Download the per-segment CSV and verify header + data rows.
    const downloadPromise = page.waitForEvent('download');
    await page
      .locator('#resultList .nd-volume-toggle')
      .filter({ hasText: 'Segments Table' })
      .getByRole('button', { name: 'Download', exact: true })
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('_vesselcharter_segments.csv');
    const csvText = readFileSync(await download.path(), 'utf8');
    expect(csvText).toContain('segment_id,component_id,kind');
    expect(csvText.trim().split('\n').length).toBeGreaterThan(80);
  });
}

for (const failure of ['download', 'empty image']) {
  test(`a failed ${failure} can retry the same example`, async ({ page }) => {
    const example = examples[0];
    const validBytes = readFileSync(fixturePath);
    let attempts = 0;
    await page.context().route(example.files[0].url, (route) => {
      attempts += 1;
      return attempts === 1
        ? route.fulfill({ status: failure === 'download' ? 503 : 200, body: '' })
        : route.fulfill({ body: validBytes });
    });
    await page.goto('/');
    const picker = page.getByRole('combobox', { name: 'Input', exact: true });
    await picker.selectOption(example.id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error', {
      timeout: 30000,
    });
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(picker).toBeEnabled();
    await picker.selectOption(example.id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', {
      timeout: 30000,
    });
    await expect(page.locator('#runButton')).toBeEnabled();
    expect(attempts).toBe(2);
  });
}

test('optional brain/ROI mask reports vascular volume fraction and length density in UI and JSON', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(fixturePath);
  await expect(page.locator('#runButton')).toBeEnabled();

  // Open Optional context and attach the same-grid mask as a trivial ROI (vessel volume fraction = 100%).
  await page.locator('#contextSection summary').click();
  await page.locator('#brainMaskInput').setInputFiles(fixturePath);
  await expect(page.locator('#brainMaskInfo')).toBeVisible();

  await page.locator('#runButton').click();
  await expect(page.locator('#outputSection')).toHaveJSProperty('open', true, { timeout: 60000 });
  await page.locator('.nd-view-tab[data-view="report"]').click();
  await expect(page.locator('#resultsReport')).toContainText('Brain / ROI vascular density');
  await expect(page.locator('#resultsReport')).toContainText('Vessel length density');
});

test('cancelling during image reading prevents a late commit and permits retry', async ({ page }) => {
  const example = examples[0];
  const validBytes = readFileSync(fixturePath);
  await page.context().route(example.files[0].url, (route) => route.fulfill({ body: validBytes }));
  await page.goto('/');
  await page.evaluate(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      const file = this;
      return new Promise((resolve, reject) => {
        window.finishExampleRead = () => {
          File.prototype.arrayBuffer = read;
          read.call(file).then(resolve, reject);
        };
      });
    };
  });
  const picker = page.getByRole('combobox', { name: 'Input', exact: true });
  await picker.selectOption(example.id);
  await page.waitForFunction(() => typeof window.finishExampleRead === 'function');
  await page.getByRole('button', { name: 'Cancel example download', exact: true }).click();
  await page.evaluate(() => window.finishExampleRead());
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#fileInfo')).toBeHidden();
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready');
});

test('cancelling an active characterisation run via footer × settles automation cleanly', async ({ page }) => {
  const bytes = readFileSync(fixturePath);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  // Hold only the VesselCharter characterisation worker open until cancelled by footer ×.
  await page.evaluate(() => {
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = class DelayedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this._isCharWorker = /worker-[^/]+\.js|\/worker\.js/i.test(String(url));
      }
      postMessage(...args) {
        if (this._isCharWorker) {
          return;
        }
        return super.postMessage(...args);
      }
    };
  });
  await page.locator('#neurodesk-input-transfer').setInputFiles({
    name: 'lausanne-tof.nii.gz',
    mimeType: 'application/gzip',
    buffer: bytes,
  });
  await page.evaluate(async () => {
    await globalThis.neurodeskAutomation.dispatch('adopt', { role: 'vessels' });
    await globalThis.neurodeskAutomation.dispatch('start', {});
  });

  await expect(page.locator('#statusText')).toContainText('Characterising vessels', { timeout: 15000 });
  await expect(page.locator('#cancelButton')).toBeVisible({ timeout: 10000 });
  await page.locator('#cancelButton').click();
  await expect
    .poll(() => page.evaluate(async () => (await globalThis.neurodeskAutomation.dispatch('snapshot')).state), {
      timeout: 10000,
    })
    .not.toBe('running');
  await expect(page.locator('#statusText')).toContainText('Characterisation cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
});
