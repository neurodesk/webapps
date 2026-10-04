import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { readVolume } from '../../../packages/synthsr/src/index.js';
import { sameGeometry } from '../../../packages/syncro/src/pipeline.js';

const inferenceTimeout = Number(process.env.SYNCRO_AUTOMATION_TIMEOUT_MS || 1_800_000);
const image = gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url)));
const shifted = Buffer.from(image);
shifted.fill(0, 352);
shifted[352] = 1;
shifted.writeInt16LE(2, 70);
shifted.writeInt16LE(8, 72);
shifted.writeInt16LE(1, 254);
shifted.writeFloatLE(1000, 292);

test.beforeEach(async ({ page }) => {
  await page.route('**/MNI152_T1_1mm_brain.nii.gz', async (route) => route.fulfill({
    body: await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url)),
  }));
  for (const [filename, path] of [
    ['synthsr-v2.onnx', process.env.SYNTHSR_MODEL],
    ['synthstrip-browser.onnx', process.env.SYNTHSTRIP_MODEL],
  ]) {
    if (path) await page.route(`**/${filename}`, (route) => route.fulfill({ path }));
  }
});

test('automation rejects an explicitly paired lesion on the wrong grid before inference', async ({ page }) => {
  test.setTimeout(90_000);
  const models = [];
  page.on('request', (request) => { if (request.url().includes('.onnx')) models.push(request.url()); });
  await page.goto('./');
  for (const [role, buffer] of [['primary', image], ['lesion', shifted]]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: `${role}.nii`, mimeType: 'application/nifti', buffer });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('must match');
  expect(result.report).toBeUndefined();
  expect(models).toEqual([]);
  await expect(page.locator('#input')).toBeEnabled();
});

test('cropped brain fails normalization without exporting nearly empty images', async ({ page }) => {
  test.skip(!process.env.SYNCRO_AUTOMATION_IMAGE, 'Enable the full inference suite with SYNCRO_AUTOMATION_IMAGE.');
  test.setTimeout(inferenceTimeout);
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'cropped-head.nii', mimeType: 'application/nifti', buffer: image });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: inferenceTimeout - 60_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state).toBe('failed');
  expect(snapshot.error.message).toContain('registered brain covers too little');
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator('#download')).toBeDisabled();
});

test('full normalization exports all required MNI images and the real pipeline manifest', async ({ page }) => {
  test.skip(!process.env.SYNCRO_AUTOMATION_IMAGE, 'Set SYNCRO_AUTOMATION_IMAGE to a suitable anatomical scan for full inference.');
  test.setTimeout(inferenceTimeout);
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles(process.env.SYNCRO_AUTOMATION_IMAGE);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: inferenceTimeout - 60_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(Object.values(snapshot.report.artifacts).map(({ role }) => role).sort()).toEqual(['details','native-synthetic','normalized-brain','normalized-primary','synthetic-brain']);
  const { createHash } = await import('node:crypto');
  const volumes = new Map();
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (['synthetic-brain', 'normalized-primary', 'normalized-brain'].includes(artifact.role)) {
      const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      expect(volume.dims).toEqual([182, 218, 182]);
      volumes.set(artifact.role, volume);
    }
  }
  const templateBytes = await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url));
  const template = readVolume(templateBytes.buffer.slice(templateBytes.byteOffset, templateBytes.byteOffset + templateBytes.byteLength));
  const synthetic = volumes.get('synthetic-brain');
  const primary = volumes.get('normalized-primary');
  const brain = volumes.get('normalized-brain');
  for (const volume of volumes.values()) expect(sameGeometry(volume, template)).toBe(true);
  let maskMismatches = 0;
  let templateSupport = 0;
  let overlap = 0;
  let primaryTissue = 0;
  let tissueMin = Infinity;
  let tissueMax = -Infinity;
  const background = primary.data.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  for (let index = 0; index < template.data.length; index += 1) {
    if (brain.data[index] !== (synthetic.data[index] !== 0 ? primary.data[index] : 0)) maskMismatches += 1;
    if (template.data[index] <= 0) continue;
    templateSupport += 1;
    if (synthetic.data[index] <= 0) continue;
    overlap += 1;
    const value = primary.data[index];
    if (value === background) continue;
    primaryTissue += 1;
    tissueMin = Math.min(tissueMin, value);
    tissueMax = Math.max(tissueMax, value);
  }
  expect(maskMismatches, 'brain extraction preserves primary intensities and clears background').toBe(0);
  expect(overlap / templateSupport, 'positive synthetic brain overlaps the template').toBeGreaterThanOrEqual(0.01);
  expect(primaryTissue / templateSupport, 'primary tissue survives inside the brain, excluding minimum-intensity background').toBeGreaterThanOrEqual(0.01);
  expect(tissueMax, 'brain contains varying primary tissue intensities').toBeGreaterThan(tissueMin);
});
