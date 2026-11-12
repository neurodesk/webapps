import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { readVolume } from '../src/input.js';
import { DEFAULT_OPTICS, stackNifti } from '../src/config.js';
import { deconvolveInNode, sha256 } from '../e2e/reference.mjs';

/** Three blurred points on a 0.1 × 0.1 × 0.25 µm grid: the shared fixture is a 2 mm MRI, which the app refuses. */
function pointsNifti() {
  const dims = [9, 20, 17];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (const [z, y, x, v] of [[4, 6, 5, 900], [3, 13, 11, 600], [6, 10, 3, 400]]) {
    for (let k = 0; k < data.length; k += 1) {
      const zz = Math.floor(k / (dims[1] * dims[2]));
      const yy = Math.floor(k / dims[2]) % dims[1];
      const xx = k % dims[2];
      data[k] += v * Math.exp(-((zz - z) ** 2 / 2 + (yy - y) ** 2 / 3 + (xx - x) ** 2 / 3));
    }
  }
  return Buffer.from(stackNifti(data.map(v => Math.round(v + 10)), dims, { x: 0.1, y: 0.1, z: 0.25 }));
}

// The installed desktop app deconvolves a small NIfTI stack (two iterations, default widefield
// optics) and downloads the voxels the Node build of the same module computes.
export async function verifyOffline(page, { download }) {
  const input = pointsNifti();
  await page.locator('#imageInput').setInputFiles({ name: 'points.nii', mimeType: 'application/octet-stream', buffer: input });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#iterations').fill('2');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Stack deconvolved', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Deconvolved (NIfTI)") .nd-download-btn');
  assert.match(result.filename, /_deconvolved\.nii\.gz$/);
  const volume = await readVolume(new File([input], 'points.nii'));
  const { estimate } = deconvolveInNode(volume, { optics: DEFAULT_OPTICS, iterations: 2 });
  const raw = gunzipSync(result.bytes);
  const offset = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(108, true);
  assert.equal(sha256(new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.byteLength))), sha256(estimate));
  return { filename: result.filename, bytes: result.bytes.length };
}
