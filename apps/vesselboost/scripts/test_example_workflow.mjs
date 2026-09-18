import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import * as nifti from 'nifti-reader-js';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const site = await serveSite(new URL('../../../dist/', import.meta.url).pathname);
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const artifacts = join(process.env.TMPDIR || process.env.RUNNER_TEMP || 'test-results', 'vesselboost-example');
await mkdir(artifacts, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => console.error(error));
  page.on('console', message => {
    if (message.type() === 'error') console.error(message.text());
  });
  await page.route(/googletagmanager\.com|google-analytics\.com/, route => route.fulfill({ body: '' }));
  await page.goto(`${site.origin}/vesselboost/`);
  const openSection = async id => {
    const toggle = page.locator(`#${id} [data-disclosure-toggle]`);
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  };
  await page.locator('#enterAppButton').click();
  console.log('Workspace opened');
  await page.locator('select[data-neurodesk-example]').selectOption('lausanne-tof');
  console.log('Example selected');
  await expect(page.locator('#skipDownsampleBtn')).toBeEnabled({ timeout: 180000 });
  await expect(page.locator('#modelSelect')).toHaveValue('manual');
  await page.screenshot({ path: join(artifacts, 'desktop-tof.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'phone-tof.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSection('stepDownsampleSection');
  await page.locator('#downsampleFactor').selectOption('4');
  await page.locator('#runDownsampleBtn').click();
  await expect(page.locator('#skipN4Btn')).toBeEnabled({ timeout: 180000 });
  await openSection('stepN4Section');
  await page.locator('#skipN4Btn').click();
  await expect(page.locator('#skipDenoiseBtn')).toBeEnabled();
  await openSection('stepDenoiseSection');
  await page.locator('#skipDenoiseBtn').click();
  await expect(page.locator('#runSegmentation')).toBeEnabled();
  await page.locator('#runSegmentation').click();
  await page.waitForFunction(() => !!window.app.inferenceExecutor.getResult('segmentation'), null, { timeout: 600000 });
  const downloadEvent = page.waitForEvent('download');
  await page.evaluate(() => window.app.inferenceExecutor.downloadStage('segmentation'));
  const download = await downloadEvent;
  const path = join(artifacts, download.suggestedFilename());
  await download.saveAs(path);
  const bytes = await readFile(path);
  let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  const header = nifti.readHeader(buffer);
  assert.equal(header.datatypeCode, 2, 'Expected uint8 vessel labels');
  const labels = new Uint8Array(nifti.readImage(header, buffer));
  const vessels = labels.reduce((count, label) => count + (label > 0 ? 1 : 0), 0);
  assert.ok(vessels > 0 && vessels < labels.length / 2, 'Expected sparse, nonempty vessel segmentation');
  await page.screenshot({ path: join(artifacts, 'segmentation.png'), fullPage: true });
  console.log(`Example loaded, segmented at 4x downsampling, and downloaded: ${path} (${vessels} vessel voxels)`);
} finally {
  await browser.close();
  await site.close();
}
