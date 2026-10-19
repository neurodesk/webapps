import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readVolume } from '@neurodesk/synthsr';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const bytesOf = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

// MindGrab's own `auto` runs WebGL2 on a software renderer, which returns a blank mask
// (neurodesk/webapps#394). The shared wrapper must pick the CPU module instead.
export async function mindgrabAutoOnSoftwareRenderer(page, adapter) {
  test.setTimeout(600000);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#method').selectOption('mindgrab');
  await expect(page.locator('#mindgrabBackend')).toHaveValue('auto');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', /succeeded|failed/, { timeout: 540000 });
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#resultList .nd-download-btn').nth(2).click();
  const mask = readVolume(bytesOf(await readFile(await (await downloadPromise).path())));
  const count = mask.data.reduce((sum, value) => sum + value, 0);
  const reportDownload = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  const report = JSON.parse(await readFile(await (await reportDownload).path(), 'utf8'));
  console.log(JSON.stringify({ adapter, backend: report.provenance.backend, maskVoxels: count, voxels: mask.data.length }));
  expect(report.provenance.backend).toBe('cpu');
  // The MNI152 brain fills about a fifth of the 2 mm template's voxels.
  expect(count).toBeGreaterThan(0.1 * mask.data.length);
}
