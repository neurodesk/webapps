import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import examples from '../examples.json' with { type: 'json' };
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

async function loadExample(page) {
  await page.locator('select[data-neurodesk-example]').selectOption(examples[0].id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
}

test('workspace exposes four v4.0 models and shared information controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#method option')).toHaveCount(4);
  await expect(page.locator('#method')).not.toContainText(/extract|mask/i);
  await expect(page.locator('.nd-app-bar')).toHaveCount(1);
  await expect(page.locator('#runButton')).toBeDisabled();
});

test('example download failure permits retry', async ({ page }) => {
  test.setTimeout(180000);
  const exampleUrl = examples[0].files[0].url;
  let attempts = 0;
  const abortDownload = route => {
    attempts += 1;
    return route.abort();
  };
  await page.context().route(exampleUrl, abortDownload);
  try {
    await page.goto('/');
    await page.locator('select[data-neurodesk-example]').selectOption(examples[0].id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'error');
    await expect(page.locator('#runButton')).toBeDisabled();
    await expect(page.locator('select[data-neurodesk-example]')).toBeEnabled();
    expect(attempts).toBe(1);
    await page.context().unroute(exampleUrl, abortDownload);
    await loadExample(page);
  } finally {
    await page.context().unroute(exampleUrl, abortDownload).catch(() => {});
  }
});

test('cancelling inference terminates the worker and allows another run', async ({ page }) => {
  test.setTimeout(180000);
  const held = [];
  let fetches = 0;
  const holdAsset = route => {
    fetches += 1;
    held.push(route);
  };
  await page.context().route('**/brainchop/brainchop-*.wasm', holdAsset);
  try {
    await page.goto('/');
    await loadExample(page);
    await page.locator('#advancedSettings > summary').click();
    await page.locator('#backend').selectOption('cpu');
    await page.locator('#method').selectOption('mindmap-fast');
    for (const run of [1, 2]) {
      await page.locator('#runButton').click();
      await expect(page.locator('#cancelButton')).toBeVisible();
      await expect
        .poll(() => fetches, { timeout: 60000, message: `Expected run ${run} to fetch WASM` })
        .toBeGreaterThanOrEqual(run);
      await page.locator('#cancelButton').click();
      await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30000 });
      await expect(page.locator('#statusText')).toHaveText('Cancelled');
      await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(1);
      // Release the held request from this cancelled worker so Chromium does not coalesce the next run onto it.
      while (held.length) await held.pop().abort().catch(() => {});
    }
  } finally {
    for (const route of held) await route.abort().catch(() => {});
    await page.context().unroute('**/brainchop/brainchop-*.wasm', holdAsset).catch(() => {});
  }
});

test('real mindmap-fast model segments the example on native grid with downloadable NIfTI', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('/');
  await loadExample(page);
  await page.locator('#method').selectOption('mindmap-fast');
  await page.locator('#runButton').click();
  const downloadBtn = page.locator('#resultList .nd-volume-toggle:nth-child(2) .nd-download-btn');
  await expect(downloadBtn).toBeVisible({ timeout: 240000 });
  const pending = page.waitForEvent('download');
  await downloadBtn.click();
  const download = await pending;
  const bytes = await readFile(await download.path());
  expect(bytes.readInt32LE(0)).toBe(348);
  expect(download.suggestedFilename()).toMatch(/_mindmap-fast\.nii$/);
  const offset = bytes.readFloatLE(108);
  const labels = new Set(bytes.subarray(offset));
  expect(labels.has(0)).toBe(true);
  expect(labels.size).toBeGreaterThan(2);
  expect([...labels].every(label => label < 18)).toBe(true);
});

test('DICOM import and collapsed settings retain the selected model', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('#method').selectOption('mindsnap');
  await page.locator('#imageInput').setInputFiles(dicomSeries());
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#taskSection > summary').click();
  await page.locator('#taskSection > summary').click();
  await expect(page.locator('#method')).toHaveValue('mindsnap');
});
