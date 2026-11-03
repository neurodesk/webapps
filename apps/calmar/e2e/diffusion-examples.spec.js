import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// The local-only catalog fixture must reach Playwright's route.
test.use({ serviceWorkers: 'block' });

const examples = JSON.parse(await readFile(new URL('../tests/fixtures/diffusion-examples.json', import.meta.url)));
for (const id of ['stroke-dwi-adc', 'stroke-dwi-b0']) {
  const example = examples.find(item => item.id === id);
  test(`${example.label} produces a downloadable native lesion candidate`, async ({ page }) => {
    // SEALS uses CPU inference; hosted runners can be much slower than a workstation.
    test.setTimeout(1800000);
    await page.route('**/examples.json', route => route.fulfill({ json: examples }));
    await page.goto('/');
    await page.waitForFunction(() => globalThis.app?.nv?.canvas);
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
    }));
    expect(candidate.review).toBe(true);
    expect(candidate.confirmed).toBe(false);
    expect(candidate.voxels).toBeGreaterThan(0);
    const download = page.waitForEvent('download');
    await page.locator('#downloadEditedLesionMaskButton').click();
    const bytes = await readFile(await (await download).path());
    expect(bytes.length).toBeGreaterThan(352);
    expect(bytes.readInt32LE(0)).toBe(348);
    await page.screenshot({ path: test.info().outputPath(`${id}.png`), fullPage: true });
  });
}
