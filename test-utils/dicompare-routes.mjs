import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

// Run against the assembled production site, served with Pages-style 404.html,
// never a Vite/dev-server SPA fallback.
export async function verifyDicompareRoutes(browser, origin) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors = [];
  const failedAssets = [];
  const scientificRequests = [];
  const externalUrl = 'https://schema.example.test/custom.json?a=1&b=two%20words';
  const schema = { name: 'Static route fixture', version: '1.0', acquisitions: {
    Example: { fields: [{ field: 'Modality', value: 'MR' }] },
  } };
  await context.route('**/*', route => {
    const url = route.request().url();
    if (/pyodide\.asm\.|python_stdlib|\.whl(?:\?|$)/.test(url)) {
      scientificRequests.push(url);
      return route.abort();
    }
    if (url === externalUrl) return route.fulfill({ json: schema });
    if (!url.startsWith(origin + '/')) return route.fulfill({ status: 200, body: '' });
    return route.continue();
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => {
    if (response.status() >= 400 && ['script', 'stylesheet', 'font'].includes(response.request().resourceType())) {
      failedAssets.push(response.url());
    }
  });
  const catalog = page.getByPlaceholder('Search schemas, acquisitions, tags...');
  const detail = '/dicompare/schema/ASL_Clinical_Guidelines_v1.0';
  async function open(route, ready) {
    await page.goto(origin + route);
    await ready();
    await expect(page).toHaveURL(origin + route);
    await page.reload();
    await ready();
    await expect(page).toHaveURL(origin + route);
    await expect(page.locator('.nd-app-bar')).toHaveCount(1);
  }
  try {
    const directResponse = await context.request.get(origin + '/dicompare/schema');
    assert.equal(directResponse.status(), 404, 'server must serve a real Pages-style 404, not an SPA fallback');
    assert.match(await directResponse.text(), /dicompare-routes\.js/);
    await open('/dicompare/schema?tag=a%26b#catalog', () => expect(catalog).toBeVisible());
    await catalog.fill('ASL');
    await page.getByTitle('Open schema', { exact: true }).first().click();
    await expect(page).toHaveURL(origin + detail);
    await page.goBack();
    await expect(catalog).toBeVisible();
    await expect(page).toHaveURL(origin + '/dicompare/schema?tag=a%26b#catalog');
    await page.goForward();
    await expect(page.getByRole('link', { name: 'All schemas', exact: true })).toBeVisible();
    await expect(page).toHaveURL(origin + detail);
    await open(detail + '?acq=0#details', () => expect(page.getByRole('link', { name: 'All schemas', exact: true })).toBeVisible());

    // Exercise pointer controls at both sizes after a cold deep link/reload.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const toggle = page.getByRole('button', { name: 'Technical log', exact: true });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await page.locator('#technicalLogClear').click();
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const theme = page.locator('[data-neurodesk-theme-toggle]');
      await theme.click();
      const selected = await page.locator('html').getAttribute('data-neurodesk-theme');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', selected);
      await expect(toggle).toBeVisible();
    }

    // IDs are not limited to the shipped catalog: restore browser-local uploads.
    await page.evaluate(async schema => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('DicompareSchemasDB', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('schemas', 'readwrite');
        transaction.objectStore('schemas').put({
          metadata: { id: 'uploaded_route_fixture', filename: 'fixture.json', title: schema.name,
            version: '1.0', authors: [], uploadDate: new Date().toISOString(), fileSize: 100,
            format: 'json', isValid: true },
          content: JSON.stringify(schema),
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    }, schema);
    const fixtureReady = () => expect(page.getByRole('heading', { name: 'Static route fixture', level: 2, exact: true })).toBeVisible();
    await open('/dicompare/schema/uploaded_route_fixture', fixtureReady);
    await open('/dicompare/schema?url=' + encodeURIComponent(externalUrl) + '#external', fixtureReady);
    await open('/dicompare/schema/missing_route_fixture', () => expect(page.getByText('Schema "missing_route_fixture" not found.', { exact: true })).toBeVisible());

    for (const path of ['/missing-route-fixture', '/dicompare/missing-route-fixture', '/dicompare/assets/missing.js']) {
      const response = await page.goto(origin + path);
      assert.equal(response.status(), 404);
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      await expect(page).toHaveURL(origin + path);
    }
    await open('/dicompare/schema', () => expect(catalog).toBeVisible());
    await page.locator('.nd-app-bar').getByTitle('More Neurodesk web apps').click();
    await expect(page).toHaveURL(origin + '/');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedAssets, []);
    assert.deepEqual(scientificRequests, []);
  } finally {
    await context.close();
  }
}
