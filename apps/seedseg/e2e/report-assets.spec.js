import { expect, test } from './fixtures.js';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

test.use({ serviceWorkers: 'block', userAgent: 'NeurodeskOffline/1' });

test('optional report uses bundled assets and local Python without remote requests', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#unifiedFiles').setInputFiles(dicomSeries({ series: 609 }));
  await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 90000 });

  const served = new Map();
  const missing = [];
  const pythonRequests = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/_offline/python/pyodide.js') pythonRequests.push(request.url());
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (path.includes('/vendor/dicompare/')) served.set(path.split('/').at(-1), response.status());
  });
  await page.context().route('https://**/*', route => {
    missing.push(route.request().url());
    return route.abort();
  });

  await page.locator('#dicompareReportBtn').click();
  // This focused fixture omits Python; the real report worker must reach its local runtime.
  await expect(page.locator('#dicompareModalBody')).toContainText('Validation failed');
  expect(missing).toEqual([]);
  expect(served.get('DicompareController.js')).toBe(200);
  expect(served.get('dicompare-worker.js')).toBe(200);
  expect(pythonRequests).toHaveLength(1);
  const schema = await page.request.get('/vendor/dicompare/SeedSeg_Prostate_T1w_v1.0.json');
  expect(schema.status()).toBe(200);
  expect((await schema.json()).name).toBe('SeedSeg Prostate T1-Weighted Protocol');
});
