import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';

const fixture = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
async function start(page, parameters = {}) {
  await page.goto('/');
  await expect(page.locator('#imageInput')).toBeEnabled();
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'brain.nii.gz', mimeType: 'application/gzip', buffer: fixture });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate((parameters) => globalThis.neurodeskAutomation.dispatch('start', { operation: 'create-mesh', parameters }), parameters);
}

test('automation can cancel the real segmentation worker while its runtime is loading', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/brainchop/**', () => {});
  const runtime = page.waitForRequest(/brainchop\//);
  await start(page);
  await runtime;
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('cancel'));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('cancelled');
  await expect(page.locator('#imageInput')).toBeEnabled();
  expect((await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).report).toBeUndefined();
});

test('hardware inference returns corrected STL, matching MZ3 and the segmented image', async ({ page }) => {
  test.skip(!hardwareGpu, 'Requires a hardware WebGPU adapter for MindGrab inference.');
  test.setTimeout(600_000);
  await start(page, { model: '16chan18cls' });
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 540_000 }).toBe('succeeded');
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(Object.values(report.artifacts).map(({ role }) => role).sort()).toEqual(['geometry','mesh','segmentation']);
  expect(report.measurements.triangles).toBeGreaterThan(0);
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  }
});
