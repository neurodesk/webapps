import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
});

test('the app root shows the landing page, which opens the workspace and the schema library', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByRole('heading', { name: 'MRI Protocol Validation for Global Collaboration' })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Schema Library' }).click();
  await page.waitForURL('**/dicompare/schema');
  await expect(page.getByPlaceholder('Search schemas, acquisitions, tags...')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'dicompare' });
  await nav.getByRole('link', { name: 'Workspace' }).click();
  await page.waitForURL('**/dicompare/workspace');
  await expect(page.getByRole('button', { name: 'From data', exact: true })).toBeVisible();
  await nav.getByRole('link', { name: 'Home' }).click();
  await expect(page.getByRole('heading', { name: 'MRI Protocol Validation for Global Collaboration' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('files handed over from another app open the workspace, not the landing page', async ({ page }) => {
  await page.goto('./#handoff=missing');
  await page.waitForURL(url => url.pathname.endsWith('/dicompare/workspace'));
  await expect(page.getByRole('button', { name: 'From data', exact: true })).toBeVisible();
});
