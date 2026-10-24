import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
async function start(page, command) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(fixture);
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { parameters: { command } });
}

test('binarize exports a typed mask with positive labels set to one', async ({ page }) => {
  await page.goto('./');
  const labels = [-2, 0, 1, 4];
  await page.locator('#neurodesk-input-transfer').setInputFiles({
    name: 'labels.nii.gz',
    mimeType: 'application/gzip',
    buffer: syntheticNifti({ value: (index) => labels[index % labels.length] }),
  });
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'binarize' });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 60000 }).not.toBe('running');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
  expect(snapshot.report.artifacts.mask.type).toBe('neuro:mask');
  const download = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'mask' });
  const actual = await readNifti(await readFile(await (await download).path()), Float32Array);
  expect(Array.from(actual.data)).toEqual(Array.from({ length: 64 }, (_, index) => labels[index % labels.length] > 0 ? 1 : 0));
  expect(snapshot.report.provenance.commands).toEqual(['-bin']);
});

test('NiiMath operation applies real image arithmetic and returns the exact worker output', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await start(page, '-add 2 -mul 3');
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 60000 }).not.toBe('running');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
  const download = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'result' });
  const bytes = await readFile(await (await download).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.report.artifacts.result.sha256);
  const original = await readNifti(await readFile(fixture), Float32Array);
  const actual = await readNifti(bytes, Float32Array);
  expect(actual.dims).toEqual(original.dims);
  let maximumError = 0;
  for (let i = 0; i < actual.data.length; i++) maximumError = Math.max(maximumError, Math.abs(actual.data[i] - (original.data[i] + 2) * 3));
  expect(maximumError).toBeLessThan(0.001);
  expect(snapshot.report.provenance.commands).toEqual(['-add', '2', '-mul', '3']);
});

test('cancelled work exposes no old artifact and a subsequent operation succeeds', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await start(page, '-kernel box 51 -fmean');
  await expect.poll(async () => (await dispatch(page, 'snapshot')).message).toBe('Running NiiMath');
  await dispatch(page, 'cancel');
  expect((await dispatch(page, 'snapshot')).state).toBe('cancelled');
  await expect.poll(() => page.locator('#niftiInput').isEnabled()).toBe(true);
  await start(page, '-add 1');
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 60000 }).not.toBe('running');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
});
