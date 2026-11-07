import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { decodeNiftiBuffer, parseNiftiVolume } from '@neurodesk/webapp-components/file-io';
import { analyse } from '../src/tensor.js';
import { DEFAULT_SETTINGS } from '../src/config.js';

// The installed desktop app analyses the small 3D fixture with the default settings; its summary
// must give the dominant fibre direction the same numerics give under Node.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Orientation maps ready', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Summary") .nd-download-btn');
  const summary = JSON.parse(result.bytes.toString('utf8'));
  const volume = parseNiftiVolume(await decodeNiftiBuffer(await readFile(fixture)), { OutputCtor: Float64Array });
  const expected = analyse({ data: volume.imageData, dims: volume.dims, spacing: volume.voxelSize }, DEFAULT_SETTINGS);
  assert.deepEqual(summary.dims, volume.dims);
  for (const key of ['azimuth', 'elevation', 'coherency']) {
    assert.ok(Math.abs(summary.dominant[key] - expected.dominant[key]) < 1e-9, `${key}: ${summary.dominant[key]} vs ${expected.dominant[key]}`);
  }
  assert.equal(summary.countedVoxels, expected.distributions.azimuth.total);
  return { filename: result.filename, bytes: result.bytes.length };
}
