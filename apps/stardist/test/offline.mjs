import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { writeLabelTiff } from '../src/image-io.js';

// Nine bright discs (radius 8 px, soft edges) on a dim background: a synthetic 16-bit
// fluorescence image whose nuclei StarDist must find with the bundled model.
export function syntheticNuclei() {
  const size = 160;
  const image = new Int32Array(size * size);
  const centres = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) centres.push([30 + 50 * row, 30 + 50 * col]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let value = 200 + ((x * 7 + y * 13) % 17);
      for (const [cy, cx] of centres) {
        const r = Math.hypot(y - cy, x - cx);
        value += 3000 / (1 + Math.exp((r - 8) * 1.5));
      }
      image[y * size + x] = Math.round(value);
    }
  }
  return { name: 'synthetic-nuclei.tif', mimeType: 'image/tiff', buffer: Buffer.from(writeLabelTiff(image, size, size)) };
}

// The installed desktop app segments the synthetic image with the bundled model and returns a
// label image and a table with one row per disc.
export async function verifyOffline(page, { download }) {
  await page.locator('#imageInput').setInputFiles(syntheticNuclei());
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('9 nuclei segmented', { timeout: 300000 });
  const row = (name) => `#resultList .nd-volume-toggle:has-text("${name}") .nd-download-btn`;
  const table = await download(row('Nucleus table'));
  assert.equal(table.filename, 'synthetic-nuclei_stardist_nuclei.csv');
  const rows = table.bytes.toString('utf8').trim().split('\n').slice(1).map((line) => line.split(',').map(Number));
  assert.equal(rows.length, 9);
  for (const [, x, y, area] of rows) {
    assert.ok(Math.abs((x - 30) % 50) < 1.5 || Math.abs((x - 30) % 50 - 50) < 1.5, `centroid x ${x}`);
    assert.ok(Math.abs((y - 30) % 50) < 1.5 || Math.abs((y - 30) % 50 - 50) < 1.5, `centroid y ${y}`);
    assert.ok(area > 150 && area < 260, `area ${area} of a radius-8 disc`);
  }
  const labels = await download(row('Nucleus labels'));
  assert.equal(labels.filename, 'synthetic-nuclei_stardist_labels.tif');
  return { filename: table.filename, nuclei: rows.length };
}
