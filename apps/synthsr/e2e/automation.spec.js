import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readVolume } from '../src/volume.js';

const input = fileURLToPath(new URL('../test/fixtures/validation.nii.gz', import.meta.url));

async function adopt(page) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(input);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
}

test('automation cancellation stops the real inference worker before it publishes output', async ({ page }) => {
  await page.route('**/synthsr-v2.onnx*', () => {});
  await page.goto('./');
  await adopt(page);
  const modelRequested = page.waitForRequest('**/synthsr-v2.onnx*');
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'synthesize' }));
  await modelRequested;
  await expect(page.locator('#cancelBtn')).toBeVisible();
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('cancel'));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('cancelled');
  await expect(page.locator('#processButton')).toBeEnabled();
  await expect(page.locator('#saveBtn')).toBeDisabled();
  expect((await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).report).toBeUndefined();
});

test('real CPU inference through automation matches the reference and exports its exact bytes', async ({ page }) => {
  test.skip(!process.env.SYNTHSR_ASSET_DIR, 'Set SYNTHSR_ASSET_DIR to the pinned SynthSR v2 model.');
  test.setTimeout(300_000);
  await page.goto('./');
  await adopt(page);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', {
    operation: 'synthesize', parameters: { backend: 'wasm', ct: false, flip: true, sharpen: true, tiled: false },
  }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 240_000 }).toBe('succeeded');
  const { report } = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(report.provenance.modelSha256).toBe('276151128c666f81eba80a6afb7f307aa3c7d58825748029ba67cf170f1460a3');
  const [artifactId, artifact] = Object.entries(report.artifacts).find(([, artifact]) => artifact.role === 'synthetic');
  const downloaded = page.waitForEvent('download');
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
  const bytes = await readFile(await (await downloaded).path());
  expect(artifact).toMatchObject({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const actual = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const reference = await readFile(new URL('../test/fixtures/validation-reference.nii.gz', import.meta.url));
  const expected = readVolume(reference.buffer.slice(reference.byteOffset, reference.byteOffset + reference.byteLength));
  expect(actual.dims).toEqual(expected.dims);
  let maximumError = 0;
  for (let i = 0; i < actual.data.length; i++) maximumError = Math.max(maximumError, Math.abs(actual.data[i] - expected.data[i]));
  expect(maximumError).toBeLessThanOrEqual(1);
});
