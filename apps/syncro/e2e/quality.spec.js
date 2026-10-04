import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { readVolume } from '@neurodesk/synthsr';
import { asBuffer, sameGeometry } from '../../../packages/syncro/src/pipeline.js';

test.beforeEach(async ({ page }, testInfo) => {
  if (!process.env.SYNCRO_HARDWARE_GPU) return;
  await page.goto('./');
  const info = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    return { vendor: adapter.info.vendor, architecture: adapter.info.architecture, isFallbackAdapter: adapter.info.isFallbackAdapter };
  });
  expect(info, 'Hardware WebGPU requires an available adapter').not.toBeNull();
  await testInfo.attach('webgpu-adapter', { body: JSON.stringify(info), contentType: 'application/json' });
  expect(info.isFallbackAdapter, 'A software adapter cannot validate hardware WebGPU').toBe(false);
});

test('pinned T1 example completes with the WASM SynthSR backend', async ({ page }) => {
  test.skip(!process.env.SYNCRO_SCIENTIFIC_TESTS, 'Set SYNCRO_SCIENTIFIC_TESTS to run real inference and registration.');
  test.setTimeout(2 * 60 * 60 * 1000);
  if (process.env.SYNTHSR_MODEL) {
    await page.route('**/synthsr-v2.onnx', route => route.fulfill({ path: process.env.SYNTHSR_MODEL }));
  }
  await page.goto('./');
  await page.locator('#tutorial').selectOption('trace-t1');
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 120000 });
  await page.locator('#settingsSection > summary').click();
  await page.locator('#synthsrBackend').selectOption('wasm');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Normalization complete', { timeout: 110 * 60 * 1000 });
  await expect(page.locator('#download')).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await page.locator('#download').click();
  const download = await downloading;
  const files = unzipSync(await readFile(await download.path()));
  const template = readVolume(asBuffer(await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url))));
  const names = [
    'wbt1sub-101_T1w.nii.gz',
    'wsub-101_T1w.nii.gz',
    'wbsub-101_T1w.nii.gz',
    'wsub-101_rec-TRACE_dwi.nii.gz',
    'wsub-101_space-TRACE_desc-lesion_mask.nii.gz',
  ];
  for (const name of names) {
    expect(files[name], `Missing ${name}`).toBeDefined();
    const image = readVolume(asBuffer(files[name]));
    expect(sameGeometry(image, template), `${name} must use the MNI template grid`).toBe(true);
    expect(image.data.some(value => value > 0), `${name} must contain image content`).toBe(true);
  }
  const brain = readVolume(asBuffer(files[names[0]]));
  let templateSupport = 0;
  let overlap = 0;
  for (let index = 0; index < template.data.length; index += 1) {
    if (template.data[index] > 0) {
      templateSupport += 1;
      if (brain.data[index] > 0) overlap += 1;
    }
  }
  expect(templateSupport).toBeGreaterThan(0);
  expect(overlap / templateSupport).toBeGreaterThanOrEqual(0.1);
  const provenance = JSON.parse(new TextDecoder().decode(files['provenance.json']));
  expect(provenance.stages.synthsr).toMatchObject({ backend: 'wasm', flip: true, tiled: false });
  if (process.env.SYNCRO_HARDWARE_GPU) expect(provenance.stages.mindgrab.backend).toBe('webgpu');
});

test('cropped head fixture cannot publish nearly empty normalized outputs', async ({ page }) => {
  test.skip(!process.env.SYNCRO_SCIENTIFIC_TESTS, 'Set SYNCRO_SCIENTIFIC_TESTS to run real inference and registration.');
  test.setTimeout(20 * 60 * 1000);
  if (process.env.SYNTHSR_MODEL) {
    await page.route('**/synthsr-v2.onnx', route => route.fulfill({ path: process.env.SYNTHSR_MODEL }));
  }
  await page.route('**/MNI152_T1_1mm_brain.nii.gz', route => route.fulfill({
    path: fileURLToPath(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url)),
  }));
  await page.goto('./');
  await page.locator('#input').setInputFiles(fileURLToPath(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url)));
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#synthsrBackend')).toHaveValue('webgpu');
  await expect(page.locator('#brainExtractor')).toHaveValue('mindgrab');
  await expect(page.locator('#normalization')).toHaveValue('greedy');
  await page.locator('#settingsSection > summary').click();
  await page.locator('#synthsrBackend').selectOption('wasm');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toContainText('Normalization failed', { timeout: 19 * 60 * 1000 });
  await expect(page.locator('#download')).toBeDisabled();
  await expect(page.locator('#downloadSelected')).toBeDisabled();
  await expect(page.locator('#runButton')).toBeEnabled();
});
