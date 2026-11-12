import { expect, test } from '@playwright/test';

test('the workspace starts when no other host answers', async ({ page }) => {
  const errors = [];
  const refused = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = new URL(test.info().project.use.baseURL).origin;
  await page.route(url => url.origin !== origin, route => {
    refused.push(route.request().url());
    return route.abort('connectionrefused');
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  expect(await page.evaluate(() => typeof globalThis.niivue.Niivue)).toBe('function');
  expect(errors).toEqual([]);
  expect(refused.filter(url => /niivue/i.test(url))).toEqual([]);
});
