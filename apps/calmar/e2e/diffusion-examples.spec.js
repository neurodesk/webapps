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

async function checkNamedCases(page) {
  test.setTimeout(240000);
  await page.goto('/');
  await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
  const selector = page.locator('[data-neurodesk-examples]');
  // Each entry loads the scan it names; choosing one again repeats it, and switching replaces the previous case.
  for (const id of ['stroke-dwi-adc-soop', 'stroke-dwi-adc-isles2022', 'stroke-dwi-adc-isles2022', 'stroke-dwi-adc-soop']) {
    await page.locator('select[data-neurodesk-example]').selectOption(id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', id);
    const example = examples.find(item => item.id === id);
    await expect(selector.locator('[role="status"]')).toHaveText(`${example.label} loaded.`);
    expect(await page.evaluate(() => [app.deepIslesDwiFile.name, app.deepIslesAdcFile.name])).toEqual(example.files.map(file => file.name));
    expect(await page.evaluate(() => app.maskReviewActive)).toBe(false);
    await expect(page.locator('#downloadEditedLesionMaskButton')).toBeDisabled();
    // Behavioural context is the loaded case's published values: sex for both; imaging age stays in notes, no time since onset for either.
    await expect(page.locator('#patientAge')).toHaveValue('');
    await expect(page.locator('#patientSex')).toHaveValue(example.patientContext.sex);
    await expect(page.locator('#patientTpo')).toHaveValue('');
  }
}

test('each acute entry loads the scan it names with its published context', async ({ page }) => {
  await checkNamedCases(page);
});

test.describe('phone acute examples', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('each acute entry loads the scan it names on a phone', async ({ page }) => {
    await checkNamedCases(page);
    await page.screenshot({ path: test.info().outputPath('acute-phone.png'), fullPage: true });
  });
});

test.describe('download fault injection', () => {
  // Requests must reach Playwright's routes rather than the production service worker.
  test.use({ serviceWorkers: 'block' });
  test('a failed or cancelled acute download keeps the previous inputs and can be retried', async ({ page }) => {
    test.setTimeout(240000);
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
    const selector = page.locator('[data-neurodesk-examples]');
    const menu = page.locator('select[data-neurodesk-example]');
    const soop = examples.find(item => item.id === 'stroke-dwi-adc-soop');
    const isles = examples.find(item => item.id === 'stroke-dwi-adc-isles2022');
    await page.route(soop.files[0].url, route => route.abort('failed'));
    await menu.selectOption(soop.id);
    await expect(selector).toHaveAttribute('data-example-state', 'error', { timeout: 30000 });
    expect(await page.evaluate(() => app.deepIslesDwiFile)).toBeNull();
    await page.unroute(soop.files[0].url);
    await menu.selectOption(soop.id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', soop.id);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(isles.files[0].url, async route => {
      await gate;
      await route.abort('failed').catch(() => {});
    });
    const requested = page.waitForRequest(isles.files[0].url);
    await menu.selectOption(isles.id);
    await requested;
    await selector.getByRole('button', { name: 'Cancel example download' }).click();
    await expect(selector).toHaveAttribute('data-example-state', 'cancelled');
    expect(await page.evaluate(() => app.deepIslesDwiFile.name)).toBe(soop.files[0].name);
    await expect(page.locator('#patientAge')).toHaveValue('');
    release();
    await page.unroute(isles.files[0].url);
    await menu.selectOption(isles.id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(selector).toHaveAttribute('data-example-id', isles.id);
  });

  test('a cancelled example whose download or import finishes late leaves the next example in place', async ({ page }) => {
    test.setTimeout(240000);
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
    const selector = page.locator('[data-neurodesk-examples]');
    const menu = page.locator('select[data-neurodesk-example]');
    const cancel = selector.getByRole('button', { name: 'Cancel example download' });
    const first = examples.find(item => item.id === 'stroke-lesion');
    const second = examples.find(item => item.id === 'stroke-lesion-m2001');
    const soop = examples.find(item => item.id === 'stroke-dwi-adc-soop');
    const loaded = () => page.evaluate(() => ({
      structural: app.nativeStructuralFile?.name,
      dwi: app.deepIslesDwiFile?.name ?? null,
      viewer: app.nv.volumes.map(volume => volume.name),
      age: document.getElementById('patientAge').value,
      report: document.getElementById('patientBehaviorReportBody').textContent.includes('87.1'),
    }));
    const secondLoaded = { structural: second.files[0].name, dwi: null, viewer: [second.files[0].name], age: '38', report: true };

    // Cancelling aborts the first participant's download, so its response cannot arrive later.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route(first.files[0].url, async route => {
      await gate;
      await route.continue().catch(() => {});
    });
    const requested = page.waitForRequest(first.files[0].url);
    await menu.selectOption(first.id);
    const aborted = (await requested).response().catch(() => null);
    await cancel.click();
    await menu.selectOption(second.id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(page.locator('#patientAge')).toHaveValue('38');
    release();
    expect(await aborted).toBeNull();
    await expect(selector).toHaveAttribute('data-example-id', second.id);
    expect(await loaded()).toEqual(secondLoaded);
    await page.unroute(first.files[0].url);

    // An acute scan that is still being decoded when it is cancelled must not join the next participant.
    const held = soop.files[0].name;
    await page.evaluate(name => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = async function arrayBuffer() {
        if (this.name === name) {
          await new Promise(resolve => {
            globalThis.releaseStaleRead = resolve;
          });
        }
        return read.call(this);
      };
      const setInput = app.setDeepIslesInput.bind(app);
      app.setDeepIslesInput = (kind, file, ...rest) => {
        const result = setInput(kind, file, ...rest);
        if (file.name === name) globalThis.staleImport = result.catch(() => {});
        return result;
      };
    }, held);
    await menu.selectOption(soop.id);
    await page.waitForFunction(() => globalThis.releaseStaleRead, null, { timeout: 120000 });
    await cancel.click();
    await menu.selectOption(second.id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    await expect(page.locator('#patientAge')).toHaveValue('38');
    await page.evaluate(() => {
      globalThis.releaseStaleRead();
      return globalThis.staleImport;
    });
    await expect(selector).toHaveAttribute('data-example-id', second.id);
    expect(await loaded()).toEqual(secondLoaded);
  });
});
