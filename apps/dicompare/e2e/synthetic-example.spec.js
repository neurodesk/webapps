import { test, expect } from '@playwright/test';

test('shared example selector imports the synthetic protocol session', async ({ page }) => {
  await page.goto('./workspace');
  const selector = page.locator('select[data-neurodesk-example]');
  await expect(selector).toBeEnabled({ timeout: 120000 });
  await selector.selectOption('synthetic-session');
  await expect(page.getByText('acq-t1wmpr', { exact: true }).first()).toBeVisible({ timeout: 180000 });
  await expect(page.getByText('acq-qsmmegre', { exact: true }).first()).toBeVisible();
  await expect(selector).toBeEnabled();
});
