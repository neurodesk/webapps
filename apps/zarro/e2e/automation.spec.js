import { test, expect } from '@playwright/test';
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test('OME-Zarr operation loads real chunks and retains geometry, crosshair and layout controls', async ({ page }) => {
  let chunks = 0;
  let serviceWorkerRequests = 0;
  await page.context().route('**/automation-store/**', async route => {
    if (route.request().serviceWorker()) serviceWorkerRequests++;
    const path = new URL(route.request().url()).pathname;
    let metadata;
    if (path.endsWith('/.zgroup')) metadata = { zarr_format: 2 };
    if (path.endsWith('/.zattrs')) metadata = path.endsWith('/0/.zattrs') ? {} : { multiscales: [{
      axes: ['z', 'y', 'x'].map(name => ({ name, type: 'space', unit: 'millimeter' })),
      datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
    }] };
    if (path.endsWith('/0/.zarray')) metadata = { zarr_format: 2, shape: [4, 4, 4], chunks: [4, 4, 4], dtype: '<u2', compressor: null, fill_value: 0, order: 'C', filters: null };
    if (metadata) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(metadata) });
    if (path.endsWith('/0/0.0.0')) {
      chunks++;
      const bytes = Buffer.alloc(128);
      for (let index = 0; index < 64; index++) bytes.writeUInt16LE(index * 10, index * 2);
      return route.fulfill({ contentType: 'application/octet-stream', body: bytes });
    }
    return route.fulfill({ status: 404, body: 'missing' });
  });
  await page.goto('./?backend=webgl2');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await dispatch(page, 'start', { operation: 'open-url', inputs: { store: { url: 'http://localhost:4173/automation-store/' } } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 30000 }).toBe('succeeded');
  const { report } = await dispatch(page, 'snapshot');
  expect(report.summary.geometry.dimensions).toEqual([4, 4, 4]);
  expect(chunks).toBeGreaterThan(0);
  expect(serviceWorkerRequests).toBeGreaterThan(0);
  const moved = await dispatch(page, 'viewers.crosshair', { viewerId: 'main', position: { frame: 'mm', value: [1, 2, 1] } });
  expect(moved.position).toEqual({ frame: 'mm', value: [1, 2, 1] });
  expect(await dispatch(page, 'viewers.regions', { viewerId: 'main' })).toEqual([]);
  const original = await dispatch(page, 'viewers.state', { viewerId: 'main' });
  const tab = original.tabs.find(tab => !tab.active);
  const switched = await dispatch(page, 'viewers.tab', { viewerId: 'main', tabId: tab.id });
  expect(switched.tabs.find(entry => entry.id === tab.id).active).toBe(true);
});
