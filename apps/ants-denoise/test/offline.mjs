import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect } from '@playwright/test';
import { loadDenoise } from '@neurodesk/ants-denoise/node';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// The installed desktop app denoises the small fixture with DenoiseImage's defaults and
// downloads the voxels the Node build of the same module writes.
export async function verifyOffline(page, { fixture, download }) {
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 60000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Image denoised', { timeout: 300000 });
  const result = await download('#resultList .nd-volume-toggle:has-text("Denoised image") .nd-download-btn');
  assert.equal(result.filename, 'small_desc-denoised.nii.gz');
  const expected = await (await loadDenoise()).denoise({ image: await readFile(fixture) });
  assert.equal(sha256(gunzipSync(result.bytes)), sha256(expected));
  return { filename: result.filename, bytes: result.bytes.length };
}
