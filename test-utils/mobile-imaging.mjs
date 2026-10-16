import { expect } from '@playwright/test';

export async function verifyMobileImageImport(page) {
  await page.setViewportSize({ width: 320, height: 568 });
  // A NIfTI-1 header followed by a 16×16×16 uint8 volume.
  const buffer = Buffer.alloc(352 + 4096);
  buffer.writeInt32LE(348, 0);
  [3, 16, 16, 16, 1, 1, 1, 1].forEach((value, index) => buffer.writeInt16LE(value, 40 + index * 2));
  buffer.writeInt16LE(2, 70);
  buffer.writeInt16LE(8, 72);
  for (let index = 0; index < 8; index++) buffer.writeFloatLE(1, 76 + index * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.write('n+1\0', 344);
  for (let index = 352; index < buffer.length; index++) buffer[index] = index % 251;
  const name = 'mobile-check-a-long-image-filename-with-many-details-and-no-spaces.nii';
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#fileList')).toContainText(name);
  await page.locator('#gl1').scrollIntoViewIfNeeded();
  const bounds = await page.locator('#gl1').boundingBox();
  expect(bounds.width).toBe(320);
  expect(bounds.height).toBeGreaterThanOrEqual(300);
}

export async function verifyMobileMeasurement(page, origin) {
  await page.setViewportSize({ width: 390, height: 844 });
  const attributes = {
    multiscales: [{
      axes: ['z', 'y', 'x'].map(name => ({ name, unit: 'millimeter' })),
      datasets: [{ path: '0', coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1] }] }],
    }],
  };
  const array = {
    zarr_format: 2,
    shape: [16, 16, 16],
    chunks: [16, 16, 16],
    dtype: '|u1',
    compressor: null,
    fill_value: 0,
    order: 'C',
    filters: null,
  };
  const metadata = {
    '.zgroup': { zarr_format: 2 },
    '.zattrs': attributes,
    '0/.zarray': array,
    '0/.zattrs': {},
  };
  await page.context().route('**/mobile-fixture/**', route => {
    const path = new URL(route.request().url()).pathname.split('/mobile-fixture/')[1];
    if (path === '.zmetadata') return route.fulfill({ json: { zarr_consolidated_format: 1, metadata } });
    if (path in metadata) return route.fulfill({ json: metadata[path] });
    if (path === '0/0.0.0') {
      return route.fulfill({
        contentType: 'application/octet-stream',
        body: Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251)),
      });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${origin}/zarro/?source=custom&url=${encodeURIComponent(origin + '/mobile-fixture/')}&layout=34`);
  await expect(page.locator('#interactionTool')).toBeEnabled({ timeout: 20000 });
  await page.locator('#toolsPanel > summary').tap();
  await page.locator('#interactionTool').tap();
  const canvas = page.locator('.nvslide-pane-main canvas');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toBeVisible();
  const rect = await canvas.boundingBox();
  const session = await page.context().newCDPSession(page);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  // Native touch input catches browser gesture cancellation; dispatchEvent cannot.
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let index = 1; index <= 6; index++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: x + index * 5, y: y + index * 5 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('#clearMeasurements')).toBeEnabled({ timeout: 5000 });
  await expect(page.locator('#measurementStatus')).toContainText('mm');
}
