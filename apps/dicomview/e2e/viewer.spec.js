// The FreeBrowse viewer on the built app: the example's image is windowed from the
// keyboard through FreeBrowse's Volumes panel, and the rendered image follows.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const [example] = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));

// The canvas as rendered, once two captures half a second apart agree.
async function settledCanvas(canvas) {
  let previous = await canvas.screenshot();
  for (;;) {
    await canvas.page().waitForTimeout(500);
    const next = await canvas.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
}

test('the example image can be windowed from the keyboard in FreeBrowse', async ({ page }) => {
  test.setTimeout(300000);
  await page.goto('./');
  await page.getByRole('combobox', { name: 'Input', exact: true }).selectOption(example.id);
  await expect(page.locator('#statusText')).toHaveText('Series 2: t1_mpr_tra_gk_v4 · 1 image', { timeout: 240000 });
  const viewer = page.locator('#freebrowseViewer');
  const canvas = viewer.locator('canvas');
  await expect(canvas).toHaveAttribute('aria-label', 'Image of the selected series');
  await expect(canvas).toBeVisible();
  await expect(page.locator('#emptyState')).toBeHidden();

  const volume = viewer.getByRole('button', { name: 'series2_t1_mpr_tra_gk_v4.nii', exact: true });
  await expect(volume, 'FreeBrowse lists the volume under its date-free name').toHaveAttribute('aria-pressed', 'false');
  await volume.focus();
  await page.keyboard.press('Enter');
  await expect(volume).toHaveAttribute('aria-pressed', 'true');

  const contrastMax = viewer.getByRole('slider', { name: 'Contrast Max' });
  const contrastMaxField = viewer.getByRole('spinbutton', { name: 'Contrast Max' });
  await expect(contrastMax).toBeVisible();
  const before = Number(await contrastMax.getAttribute('aria-valuenow'));
  const lowest = Number(await contrastMax.getAttribute('aria-valuemin'));
  expect(before).toBeGreaterThan(lowest);
  const unwindowed = await settledCanvas(canvas);

  await contrastMax.focus();
  for (let step = 0; step < 5; step += 1) await page.keyboard.press('PageDown');
  await expect.poll(async () => Number(await contrastMax.getAttribute('aria-valuenow'))).toBeLessThan(before);
  const after = Number(await contrastMax.getAttribute('aria-valuenow'));
  await expect(contrastMaxField).toHaveValue(String(Number(after.toFixed(1))));
  const windowed = await settledCanvas(canvas);
  expect(windowed.equals(unwindowed), 'the image is redrawn with the narrower window').toBe(false);

  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: box.width / 4, y: box.height / 4 } });
  await expect(page.locator('#location')).not.toHaveText('');

  await page.locator('[data-view="header"]').click();
  await expect(page.locator('#headerReport')).toBeVisible();
  await page.locator('[data-view="image"]').click();
  await expect(page.locator('#headerReport')).toBeHidden();
  await expect(contrastMax, 'the window survives a visit to the header').toHaveAttribute('aria-valuenow', String(after));

  const shown = await settledCanvas(canvas);
  const eye = viewer.getByRole('button', { name: 'Toggle visibility' });
  await eye.click();
  expect((await settledCanvas(canvas)).equals(shown), 'the eye button hides the image').toBe(false);
  await eye.click();
  expect((await settledCanvas(canvas)).equals(shown), 'showing it again restores the windowed image').toBe(true);
});
