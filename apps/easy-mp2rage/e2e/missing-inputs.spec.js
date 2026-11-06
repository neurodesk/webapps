import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

for (const width of [1440, 390]) {
  test(`missing inputs are visible and update at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const run = page.locator('#run');
    await expect(run).toHaveText('Compute T1 map');
    await expect(run).toBeDisabled();
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../tools/phantom/phantom_INV2.nii.gz', import.meta.url)));
    const role = page.getByRole('combobox', { name: 'Role for phantom_INV2.nii.gz', exact: true });
    await role.selectOption('(ignore)');
    await expect(run).toHaveText('Missing: UNI, SA2RAGE or B1 map');
    await page.locator('#taskSel').selectOption('denoise');
    await expect(run).toHaveText('Missing: UNI, INV1, INV2');
    await expect(page.locator('#statusText')).toHaveText('Load or assign UNI, INV1, INV2 to continue.');
    await role.selectOption('INV2');
    await page.locator('#taskSel').selectOption('t1');
    await expect(run).toHaveText('Missing: UNI, SA2RAGE or B1 map');
    await expect(page.locator('#statusText')).toHaveText('Load or assign UNI, SA2RAGE or B1 map to continue.');
    await run.scrollIntoViewIfNeeded();
    expect(await run.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('missing-inputs.png') });
    await page.locator('#taskSel').selectOption('denoise');
    await expect(run).toHaveText('Missing: UNI, INV1');
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../tools/phantom/phantom_UNI.nii.gz', import.meta.url)));
    await expect(run).toHaveText('Missing: INV1');
    await page.locator('#taskSel').selectOption('b1only');
    await expect(run).toHaveText('Missing: SA2RAGE');
    await page.locator('#file').setInputFiles(fileURLToPath(new URL('../tools/phantom/phantom_SA2RAGE.nii.gz', import.meta.url)));
    await expect(run).toHaveText('Compute B1 map');
    await expect(run).toBeEnabled();
  });
}
