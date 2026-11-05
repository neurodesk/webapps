import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { readVolume } from '../src/input.js';
import { DEFAULT_OPTICS } from '../src/config.js';
import { deconvolveInNode, sha256 } from '../src/reference.mjs';

// The installed desktop app deconvolves the small NIfTI fixture (two iterations, default
// widefield optics) and downloads the voxels the Node build of the same module computes.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#iterations').fill('2');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Stack deconvolved', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Deconvolved (NIfTI)") .nd-download-btn');
  assert.match(result.filename, /_deconvolved\.nii\.gz$/);
  const volume = await readVolume(new File([await readFile(fixture)], basename(fixture)));
  const { estimate } = deconvolveInNode(volume, { optics: DEFAULT_OPTICS, iterations: 2 });
  const raw = gunzipSync(result.bytes);
  const offset = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(108, true);
  assert.equal(sha256(new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.byteLength))), sha256(estimate));
  return { filename: result.filename, bytes: result.bytes.length };
}
