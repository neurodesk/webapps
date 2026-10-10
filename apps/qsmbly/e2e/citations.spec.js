import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const information = YAML.parse(await readFile(new URL('../../../registry/app-information.yml', import.meta.url), 'utf8'));
let site;
test.beforeAll(async () => {
  site = await serveSite(new URL('../dist/', import.meta.url).pathname);
});
test.afterAll(async () => {
  await site?.close();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Cite displays registry papers and closes at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(site.origin);
    const cite = page.locator('[data-neurodesk-shell-control="cite"]');
    await cite.click();
    const dialog = page.locator('.nd-app-dialog[data-dialog="cite"]');
    await expect(dialog).toBeVisible();
    for (const item of information.apps.qsmbly.citations) {
      await expect(dialog).toContainText(item.title);
      if (item.doi) await expect(dialog.locator(`a[href="https://doi.org/${item.doi}"]`)).toHaveCount(1);
    }
    await expect(dialog).toContainText('Renton');
    expect(await page.locator('#citationsModal, #openCitations').count()).toBe(0);
    const bounds = await dialog.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    await dialog.locator('.nd-app-dialog__close').click();
    await expect(dialog).toBeHidden();
    await cite.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
}
