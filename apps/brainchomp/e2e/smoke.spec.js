import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import examples from '../examples.json' with { type: 'json' };
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

async function loadExample(page, id = examples[0].id) {
  await page.locator('select[data-neurodesk-example]').selectOption(id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
}

test('workspace opens with rodent examples, disabled run/reorient, and shared bar', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.nd-app-bar')).toHaveCount(1);
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(page.locator('#reorientButton')).toBeDisabled();
  await expect(page.locator('select[data-neurodesk-example] option[value="rodent-mri"]')).toHaveCount(1);
  await expect(page.locator('select[data-neurodesk-example] option[value="camri-mouse-t2w"]')).toHaveCount(1);
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

test('cancelling extraction stops the worker and allows another run', async ({ page }) => {
  test.setTimeout(180000);
  const held = [];
  let fetches = 0;
  const holdAsset = route => {
    fetches += 1;
    held.push(route);
  };
  await page.context().route('**/brainchomp/brainchomp*.wasm', holdAsset);
  try {
    await page.goto('/');
    await loadExample(page);
    await page.locator('#advancedSettings > summary').click();
    await page.locator('#backend').selectOption('cpu');
    for (const run of [1, 2]) {
      await page.locator('#runButton').click();
      await expect(page.locator('#cancelButton')).toBeVisible();
      await expect
        .poll(() => fetches, { timeout: 60000, message: `Expected run ${run} to fetch WASM` })
        .toBeGreaterThanOrEqual(run);
      await page.locator('#cancelButton').click();
      await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30000 });
      await expect(page.locator('#statusText')).toHaveText('Cancelled');
      while (held.length) await held.pop().abort().catch(() => {});
    }
  } finally {
    for (const route of held) await route.abort().catch(() => {});
    await page.context().unroute('**/brainchomp/brainchomp*.wasm', holdAsset).catch(() => {});
  }
});

test('real rodent extraction produces downloadable brain and binary mask on input grid', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('/');
  await loadExample(page, 'rodent-mri');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready', { timeout: 240000 });
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(3);
  await expect(page.locator('#resultList .nd-edit-btn')).toHaveCount(1);
  await expect(page.locator('#reportBtn')).toBeEnabled();

  const brainDownload = page.waitForEvent('download');
  await page.locator('#resultList .nd-volume-toggle:nth-child(2) .nd-download-btn').click();
  const brain = await brainDownload;
  const brainBytes = await readFile(await brain.path());
  expect(brainBytes.readInt32LE(0)).toBe(348);
  expect(brain.suggestedFilename()).toMatch(/_brainchomp_brain\.nii$/);

  const maskDownload = page.waitForEvent('download');
  await page.locator('#resultList .nd-volume-toggle:nth-child(3) .nd-download-btn').click();
  const mask = await maskDownload;
  const maskBytes = await readFile(await mask.path());
  expect(maskBytes.readInt32LE(0)).toBe(348);
  expect(maskBytes.readInt16LE(70)).toBe(2);
  const voxels = maskBytes.subarray(maskBytes.readFloatLE(108));
  let ones = 0;
  let nonBinary = 0;
  for (let i = 0; i < voxels.length; i += 1) {
    if (voxels[i] === 1) ones += 1;
    else if (voxels[i] !== 0) nonBinary += 1;
  }
  expect(nonBinary).toBe(0);
  expect(ones).toBeGreaterThan(10000);
  expect(ones).toBeLessThan(voxels.length / 2);
});

test('reorient updates the scan header and DICOM import retains collapsed settings', async ({ page }) => {
  test.setTimeout(180000);
  await page.goto('/');
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#opening').fill('2');
  await page.locator('#imageInput').setInputFiles(dicomSeries());
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await expect(page.locator('#reorientButton')).toBeEnabled();
  await page.locator('#reorientButton').click();
  await page.locator('button[data-dir="A"]').click();
  await page.locator('button[data-dir="I"]').click();
  await page.locator('button[data-dir="?"]').click();
  await expect(page.locator('#fileInfo')).toContainText('_reoriented.nii');
  await page.locator('#advancedSettings > summary').click();
  await page.locator('#advancedSettings > summary').click();
  await expect(page.locator('#opening')).toHaveValue('2');
});
