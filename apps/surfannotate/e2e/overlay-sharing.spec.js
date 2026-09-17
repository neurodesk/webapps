import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = (name) => new URL(`../test/fixtures/${name}`, import.meta.url);
const surfaces = (page) => page.locator('#surfaceList li');
const overlays = (page) => page.locator('#overlayList li');

function overlayFile(reversed = false) {
  const count = 1681;
  const buffer = Buffer.alloc(15 + count * 4);
  buffer.fill(255, 0, 3);
  buffer.writeUInt32BE(count, 3);
  buffer.writeUInt32BE(count * 2, 7);
  buffer.writeUInt32BE(1, 11);
  for (let v = 0; v < count; v++) {
    buffer.writeFloatBE((reversed ? count - 1 - v : v) / count, 15 + v * 4);
  }
  return { name: 'lh.thickness', mimeType: 'application/octet-stream', buffer };
}

async function loadSurface(page, name, count) {
  await page.setInputFiles('#surfaceInput', {
    name,
    mimeType: 'application/octet-stream',
    buffer: await readFile(fixture(name))
  });
  await expect(surfaces(page)).toHaveCount(count);
}

async function loadOverlay(page, reversed = false) {
  await page.setInputFiles('#overlayInput', overlayFile(reversed));
  await expect(page.locator('#statusText')).toContainText('Overlay lh.thickness loaded');
}

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.locator('#enterAppButton').click();
  await loadSurface(page, 'lh.flat.surf.gii', 1);
});

test('enabling sharing after loading an overlay includes matching surfaces loaded later', async ({ page }) => {
  await loadOverlay(page);
  await page.check('#overlayShare');
  await expect(page.locator('#statusText')).toContainText('No other loaded surface');
  await loadSurface(page, 'lh.flat.inflated.surf.gii', 2);
  await expect(overlays(page)).toHaveCount(1);
  await expect(overlays(page)).toContainText('lh.thickness');
  expect(await page.evaluate(() => {
    const values = window.__surfannotateUi.activeSurface().overlays[0].baseValues;
    return [values.length, values[0], values[values.length - 1]];
  })).toEqual([1681, 1, 0]);
});

test('shared display settings survive a detour through a different topology', async ({ page }) => {
  await page.check('#overlayShare');
  await loadOverlay(page);
  await loadSurface(page, 'lh.flat.inflated.surf.gii', 2);
  const xml = await readFile(fixture('lh.flat.surf.gii'), 'utf8');
  const different = xml.replace(
    /(<DataArray Intent="NIFTI_INTENT_TRIANGLE"[\s\S]*?<Data>)([\s\S]*?)(<\/Data>)/,
    (_, header, data, end) => header.replace('Dim0="3200"', 'Dim0="3199"')
      + Buffer.from(data.trim(), 'base64').subarray(0, -12).toString('base64') + end
  );
  await page.setInputFiles('#surfaceInput', {
    name: 'other.surf.gii',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(different)
  });
  await expect(surfaces(page)).toHaveCount(3);
  await expect(overlays(page)).toHaveCount(0);
  await surfaces(page).first().locator('input[type=radio]').check();
  await page.selectOption('#overlayColormap', 'viridis');
  await page.fill('#overlayMax', '0.5');
  await page.press('#overlayMax', 'Enter');
  await surfaces(page).nth(2).locator('input[type=radio]').check();
  await surfaces(page).nth(1).locator('input[type=radio]').check();
  await expect(page.locator('#overlayColormap')).toHaveValue('viridis');
  await expect(page.locator('#overlayMax')).toHaveValue('0.5');
  await surfaces(page).first().locator('input[type=radio]').check();
  await expect(page.locator('#overlayMax')).toHaveValue('0.5');
});

test('removing the active surface preserves its shared display settings', async ({ page }) => {
  await page.check('#overlayShare');
  await loadOverlay(page);
  await loadSurface(page, 'lh.flat.inflated.surf.gii', 2);
  await page.selectOption('#overlayColormap', 'viridis');
  await page.fill('#overlayMax', '0.5');
  await page.press('#overlayMax', 'Enter');
  await surfaces(page).nth(1).locator('.layer-remove').click();
  await expect(surfaces(page)).toHaveCount(1);
  await expect(page.locator('#overlayColormap')).toHaveValue('viridis');
  await expect(page.locator('#overlayMax')).toHaveValue('0.5');
});

test('same-named overlays with different values remain separate when sharing is enabled', async ({ page }) => {
  await loadOverlay(page);
  await loadSurface(page, 'lh.flat.inflated.surf.gii', 2);
  await loadOverlay(page, true);
  await page.check('#overlayShare');
  await expect(overlays(page)).toHaveCount(2);
  expect(await page.evaluate(() => window.__surfannotateUi.activeSurface().overlays
    .map((overlay) => overlay.baseValues[0]).sort((a, b) => a - b))).toEqual([0, 1]);
  await surfaces(page).first().locator('input[type=radio]').check();
  await expect(overlays(page)).toHaveCount(2);
  expect(await page.evaluate(() => window.__surfannotateUi.activeSurface().overlays
    .map((overlay) => overlay.baseValues[0]).sort((a, b) => a - b))).toEqual([0, 1]);
  await overlays(page).first().locator('.layer-remove').click();
  await expect(overlays(page)).toHaveCount(1);
  await surfaces(page).nth(1).locator('input[type=radio]').check();
  await expect(overlays(page)).toHaveCount(1);
  expect(await page.evaluate(() => window.__surfannotateUi.activeSurface()
    .overlays[0].baseValues[0])).toBe(0);
});
