import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { writeLabelTiff } from '../src/image-io.js';

const SIZE = 128;
const RADIUS = 12;
const CENTRES = [[32, 32], [96, 32], [32, 96], [96, 96]];

// Four bright discs on a dim, slightly textured background: a synthetic 16-bit fluorescence image.
export function syntheticDiscs() {
  const image = new Int32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let value = 300 + ((x * 7 + y * 13) % 23);
      for (const [cx, cy] of CENTRES) value += 4000 / (1 + Math.exp((Math.hypot(x - cx, y - cy) - RADIUS) * 1.5));
      image[y * SIZE + x] = Math.round(value);
    }
  }
  return { name: 'synthetic-discs.tif', mimeType: 'image/tiff', buffer: Buffer.from(writeLabelTiff(image, SIZE, SIZE)) };
}

// The installed desktop app computes the embedding with the bundled model, segments one disc
// from a click and one from a box, and writes a table with one row per disc.
export async function verifyOffline(page, { download }) {
  await page.locator('#imageInput').setInputFiles(syntheticDiscs());
  await expect(page.locator('#embedButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#embedButton').click();
  await expect(page.locator('#statusText')).toHaveText(/^Embeddings ready/, { timeout: 300000 });
  const box = await page.locator('#canvas').boundingBox();
  const scale = Math.min(box.width, box.height) / SIZE;
  const at = (x, y) => [box.x + (box.width - SIZE * scale) / 2 + x * scale, box.y + (box.height - SIZE * scale) / 2 + y * scale];
  await page.mouse.click(...at(32.5, 32.5));
  await expect(page.locator('#acceptButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#acceptButton').click();
  await page.mouse.move(...at(96 - 2 * RADIUS, 32 - 2 * RADIUS));
  await page.mouse.down();
  await page.mouse.move(...at(96, 32), { steps: 4 });
  await page.mouse.move(...at(96 + 2 * RADIUS, 32 + 2 * RADIUS), { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#acceptButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#acceptButton').click();
  await expect(page.locator('#statusText')).toHaveText('Object 2 accepted · 2 objects');
  const row = (name) => `#resultList .nd-volume-toggle:has-text("${name}") .nd-download-btn`;
  const table = await download(row('Object table'));
  assert.equal(table.filename, 'synthetic-discs_microsam-objects.csv');
  const rows = table.bytes.toString('utf8').trim().split('\n').slice(1).map((line) => line.split(','));
  assert.equal(rows.length, 2);
  const disc = Math.PI * RADIUS * RADIUS;
  rows.forEach(([, area, x, y], index) => {
    const [cx, cy] = CENTRES[index];
    assert.ok(Math.abs(Number(x) - cx) < 2 && Math.abs(Number(y) - cy) < 2, `object ${index + 1} centroid ${x}, ${y}`);
    assert.ok(Number(area) > 0.7 * disc && Number(area) < 1.4 * disc, `object ${index + 1} area ${area} of a radius-${RADIUS} disc`);
  });
  const labels = await download(row('Object labels'));
  assert.equal(labels.filename, 'synthetic-discs_microsam-labels.tif');
  return { filename: table.filename, objects: rows.length };
}
