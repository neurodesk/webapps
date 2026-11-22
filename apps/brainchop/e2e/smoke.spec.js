import { test, expect } from '@playwright/test';
import { hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';
import { readFile } from 'node:fs/promises';
import examples from '../examples.json' with { type: 'json' };
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

async function loadExample(page) {
  await page.locator('select[data-neurodesk-example]').selectOption(examples[0].id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
}

test('workspace exposes six segmentation models and shared information controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#method option')).toHaveCount(6);
  await expect(page.locator('#method')).not.toContainText(/extract|mask/i);
  await expect(page.locator('.nd-app-bar')).toHaveCount(1);
  await expect(page.locator('#runButton')).toBeDisabled();
});

test('example download failure permits retry', async ({ page }) => {
  test.setTimeout(180000);
  const exampleUrl = examples[0].files[0].url;
  let attempts = 0;
  // Route on the browser context so requests forwarded by coi-serviceworker.js are intercepted.
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

test('cancelling inference allows another run', async ({ page }) => {
  test.setTimeout(180000);
  const held = [];
  // Route on the browser context so worker fetches forwarded by coi-serviceworker.js are held.
  const holdModel = route => {
    held.push(route);
  };
  await page.context().route('**/models/**/model.json', holdModel);
  try {
    await page.goto('/');
    await loadExample(page);
    for (const run of [1, 2]) {
      const workerPromise = page.waitForEvent('worker', {
        predicate: worker => worker.url().includes('brainchop-webworker'),
        timeout: 60000,
      });
      await page.locator('#runButton').click();
      await expect(page.locator('#cancelButton')).toBeVisible();
      const worker = await workerPromise;
      const workerClosed = worker.waitForEvent('close', { timeout: 30000 });
      await expect
        .poll(() => held.length, { timeout: 60000, message: `Expected run ${run} to request model.json` })
        .toBe(run);
      await page.locator('#cancelButton').click();
      await workerClosed;
      await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30000 });
      await expect(page.locator('#statusText')).toHaveText('Cancelled');
      await expect(page.locator('#resultList .nd-download-btn')).toHaveCount(0);
    }
  } finally {
    for (const route of held) await route.abort().catch(() => {});
    await page.context().unroute('**/models/**/model.json', holdModel).catch(() => {});
  }
});

for (const [model, classes] of [['tissue-light', 3], ['tissue', 3], ['subcortical', 18], ['subcortical-small', 18], ['aparc50', 50], ['aparc104', 104]]) {
  test(`real ${model} model produces a downloadable NIfTI label map`, async ({ page }, testInfo) => {
    test.skip(!hardwareGpu && testInfo.project.use.channel !== 'chromium', 'Full inference requires hardware WebGL or the local Mesa runner.');
    test.setTimeout(1200000);
    await page.goto('/');
    await loadExample(page);
    await page.locator('#method').selectOption(model);
    await page.locator('#runButton').click();
    await expect(page.locator('#runButton')).toBeEnabled({ timeout: 1100000 });
    await expect(page.locator('#resultList .nd-download-btn'), await page.locator('#statusText').innerText()).toBeVisible();
    const pending = page.waitForEvent('download');
    await page.locator('#resultList .nd-download-btn').click();
    const bytes = await readFile(await (await pending).path());
    expect(bytes.readInt32LE(0)).toBe(348);
    expect(bytes.readInt16LE(70)).toBe(2);
    expect([42, 44, 46].map(offset => bytes.readInt16LE(offset))).toEqual([256, 256, 256]);
    const labels = new Set(bytes.subarray(bytes.readFloatLE(108)));
    expect(labels.has(0)).toBe(true);
    expect(labels.size).toBeGreaterThan(1);
    expect([...labels].every(label => label < classes)).toBe(true);
  });
}

test('DICOM import and collapsed settings retain the selected model', async ({ page }) => {
  await page.goto('/');
  await page.locator('#method').selectOption('aparc50');
  await page.locator('#imageInput').setInputFiles(dicomSeries());
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#taskSection > summary').click();
  await page.locator('#taskSection > summary').click();
  await expect(page.locator('#method')).toHaveValue('aparc50');
});
