import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const surface = fileURLToPath(new URL('../test/fixtures/lh.flat.surf.gii', import.meta.url));
const theme = fileURLToPath(new URL('../../../site/app-theme.css', import.meta.url));

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('populated ROI list keeps touch actions reachable in both themes', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.addStyleTag({ path: theme });
  await page.locator('#enterAppButton').click();
  await page.setInputFiles('#surfaceInput', surface);
  await expect(page.locator('#statusText')).toContainText('1,681 vertices');
  await page.locator('#roiPanel > summary').click();

  for (const [row, name] of [[2, 'V1'], [5, 'V2']]) {
    await page.evaluate((j) => {
      const { session } = window.__surfannotate;
      session.addClick(j * 41 + 1);
      session.addClick(j * 41 + 39);
      session.closeOnEdge();
      session.fill();
      window.__surfannotateUi.repaint();
    }, row);
    await page.locator('#roiName').fill(name);
    await page.locator('#saveRoi').click();
  }
  await expect(page.locator('#roiList li')).toHaveCount(2);
  await expect(page.locator('#roiList .nd-btn-icon')).toHaveCount(8);
  for (const mode of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.neurodeskApp = 'surfannotate';
      document.documentElement.dataset.neurodeskTheme = value;
    }, mode);
    for (const button of await page.locator('#roiList .nd-btn-icon').all()) {
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: testInfo.outputPath(`roi-touch-${mode}.png`) });
    await page.getByRole('button', { name: 'Move V2 up', exact: true }).tap();
    await expect(page.locator('#roiList li').first().locator('.layer-name')).toHaveText('V2');
    await page.getByRole('button', { name: 'Move V2 down', exact: true }).tap();
  }
  await page.getByRole('button', { name: 'Remove V2', exact: true }).tap();
  await expect(page.locator('#roiList li')).toHaveCount(1);
});
