import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
async function start(page) {
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'brain.nii.gz', mimeType: 'application/gzip', buffer: fixture });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'reconstruct' }));
}

test('automation surfaces the real inference worker model-integrity error', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/trega-synth-random.onnx*', (route) => route.fulfill({ body: '' }));
  await start(page);
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 90_000 }).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('Model size mismatch');
  expect(result.report).toBeUndefined();
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('automation cancellation terminates a real worker awaiting its model', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/trega-synth-random.onnx*', () => {});
  const model = page.waitForRequest(/trega-synth-random\.onnx/, { timeout: 90_000 });
  await start(page);
  await model;
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('cancel'));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
  expect((await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).report).toBeUndefined();
});

test('full reconstruction exports every actual surface, QC and processing manifest', async ({ page }) => {
  test.skip(!process.env.TOPOFIT_AUTOMATION_IMAGE, 'Set TOPOFIT_AUTOMATION_IMAGE to a suitable T1 for full model inference.');
  test.setTimeout(900_000);
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles(process.env.TOPOFIT_AUTOMATION_IMAGE);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'reconstruct' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 840_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  const roles = Object.values(snapshot.report.artifacts).map(({ role }) => role);
  expect(roles.filter((role) => role === 'surface')).toHaveLength(6);
  expect(roles.filter((role) => role === 'registration')).toHaveLength(2);
  expect(roles).toContain('qc');
  expect(roles).toContain('metadata');
  expect(snapshot.report.provenance.runtime.assets).toBeTruthy();
  const { createHash } = await import('node:crypto');
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  }
});
