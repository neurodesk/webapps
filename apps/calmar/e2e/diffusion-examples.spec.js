import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));
for (const id of ['stroke-dwi-adc-soop', 'stroke-dwi-adc-isles2022']) {
  const example = examples.find(item => item.id === id);
  // SOOP is the untagged completed DWI+ADC path with this model, options and 3D geometry.
  test(`${example.label} produces a downloadable native lesion candidate`, { tag: id === 'stroke-dwi-adc-isles2022' ? '@slow' : [] }, async ({ page }) => {
    // SEALS uses CPU inference; hosted runners can be much slower than a workstation.
    test.setTimeout(1800000);
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
    await page.locator('select[data-neurodesk-example]').selectOption(id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    expect(await page.evaluate(() => app.diffusionSeedReady())).toBe(true);
    expect(await page.evaluate(() => app.structuralFile)).toBeNull();
    await page.locator('#runLesionPreparationButton').click();
    await expect(page.locator('#downloadEditedLesionMaskButton')).toBeEnabled({ timeout: 1740000 });
    const candidate = await page.evaluate(() => ({
      review: app.maskReviewActive,
      confirmed: app.lesionMaskConfirmed,
      voxels: app.nv.drawBitmap.reduce((sum, value) => sum + Number(value > 0), 0),
      dims: app.nativeStructuralInfo.dims,
      affine: app.nativeStructuralInfo.affine,
    }));
    expect(candidate.review).toBe(true);
    expect(candidate.confirmed).toBe(false);
    expect(candidate.voxels).toBeGreaterThan(0);
    expect(candidate.voxels).toBeLessThan(candidate.dims.reduce((a, b) => a * b) / 2);
    const download = page.waitForEvent('download');
    await page.locator('#downloadEditedLesionMaskButton').click();
    const bytes = await readFile(await (await download).path());
    expect(bytes.length).toBeGreaterThan(352);
    expect(bytes.readInt32LE(0)).toBe(348);
    expect([0, 1, 2].map(axis => bytes.readInt16LE(42 + axis * 2))).toEqual(candidate.dims);
    expect(bytes.readInt16LE(70)).toBe(2);
    const offset = bytes.readFloatLE(108);
    expect([...new Set(bytes.subarray(offset))].sort()).toEqual([0, 1]);
    expect(bytes.subarray(offset).reduce((sum, value) => sum + value, 0)).toBe(candidate.voxels);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) {
        expect(bytes.readFloatLE(280 + 16 * row + 4 * col)).toBeCloseTo(candidate.affine[row][col], 4);
      }
    }
    await page.screenshot({ path: test.info().outputPath(`${id}.png`), fullPage: true });
    if (id === 'stroke-dwi-adc-soop') {
      await page.locator('select[data-neurodesk-example]').selectOption('stroke-dwi-adc-isles2022');
      await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
      expect(await page.evaluate(() => app.maskReviewActive)).toBe(false);
      expect(await page.evaluate(() => app.lesionMaskConfirmed)).toBe(false);
      await expect(page.locator('#downloadEditedLesionMaskButton')).toBeDisabled();
    }
  });
}

async function checkRotation(page) {
  test.setTimeout(240000);
  await page.goto('/');
  await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
  const selector = page.locator('[data-neurodesk-examples]');
  for (const [selection, actual] of [
    ['stroke-dwi-adc', 'stroke-dwi-adc-soop'],
    ['stroke-dwi-adc', 'stroke-dwi-adc-isles2022'],
    ['stroke-dwi-adc-isles2022', 'stroke-dwi-adc-isles2022'],
    ['stroke-dwi-adc', 'stroke-dwi-adc-soop'],
  ]) {
    await page.locator('select[data-neurodesk-example]').selectOption(selection);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', actual);
    const example = examples.find(item => item.id === actual);
    await expect(selector.locator('[role="status"]')).toHaveText(`${example.label} loaded.`);
    expect(await page.evaluate(() => [app.deepIslesDwiFile.name, app.deepIslesAdcFile.name])).toEqual(example.files.map(file => file.name));
    expect(await page.evaluate(() => app.maskReviewActive)).toBe(false);
    await expect(page.locator('#downloadEditedLesionMaskButton')).toBeDisabled();
    // Behavioural context is the loaded case's published values: ISLES age and sex, nothing for SOOP sub-1.
    await expect(page.locator('#patientAge')).toHaveValue(String(example.patientContext?.ageAtStroke ?? ''));
    await expect(page.locator('#patientSex')).toHaveValue(example.patientContext?.sex ?? '');
    await expect(page.locator('#patientTpo')).toHaveValue('');
  }
}

test('next acute case alternates datasets and fixed entries repeat the chosen scan', async ({ page }) => {
  await checkRotation(page);
});

test.describe('phone acute examples', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('next acute case alternates on a phone', async ({ page }) => {
    await checkRotation(page);
    await page.screenshot({ path: test.info().outputPath('acute-phone.png'), fullPage: true });
  });
});

test.describe('download fault injection', () => {
  // Requests must reach Playwright's routes rather than the production service worker.
  test.use({ serviceWorkers: 'block' });
  test('acute download failure and cancellation retry the same case', async ({ page }) => {
    test.setTimeout(240000);
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
    const selector = page.locator('[data-neurodesk-examples]');
    const menu = page.locator('select[data-neurodesk-example]');
    const soop = examples.find(item => item.id === 'stroke-dwi-adc-soop');
    const isles = examples.find(item => item.id === 'stroke-dwi-adc-isles2022');
    await page.route(soop.files[0].url, route => route.abort('failed'));
    await menu.selectOption('stroke-dwi-adc');
    await expect(selector).toHaveAttribute('data-example-state', 'error', { timeout: 30000 });
    expect(await page.evaluate(() => app.deepIslesDwiFile)).toBeNull();
    await page.unroute(soop.files[0].url);
    await menu.selectOption('stroke-dwi-adc');
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', soop.id);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(isles.files[0].url, async route => {
      await gate;
      await route.abort('failed').catch(() => {});
    });
    const requested = page.waitForRequest(isles.files[0].url);
    await menu.selectOption('stroke-dwi-adc');
    await requested;
    await selector.getByRole('button', { name: 'Cancel example download' }).click();
    await expect(selector).toHaveAttribute('data-example-state', 'cancelled');
    expect(await page.evaluate(() => app.deepIslesDwiFile.name)).toBe(soop.files[0].name);
    release();
    await page.unroute(isles.files[0].url);
    await menu.selectOption('stroke-dwi-adc');
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', isles.id);
  });
});
