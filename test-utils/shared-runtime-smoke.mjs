import { test, expect } from '@playwright/test';

test('import map resolves shared components in-browser', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('/harness.html');
  await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });
  expect(await page.evaluate(() => document.getElementById('progressBar').style.width)).toBe('50%');
  expect(await page.evaluate(() => window.__fromSharedPackage === true)).toBe(true);
  expect(await page.evaluate(() => window.__fileIoOk === true)).toBe(true);
  expect(errors).toEqual([]);
});
