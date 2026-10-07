import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readVolume } from '@neurodesk/synthsr';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { dice } from '../../../test-utils/dice.mjs';
import { BET_MIN_DICE, loadHeadReference } from '../../../packages/brain-extraction/test/head-reference.mjs';

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const source = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function adopt(page, files) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(files);
  await dispatch(page, 'adopt', { role: 'image' });
}

test('BET operation returns a mask matching the FreeSurfer SynthSeg reference and retained viewer uses millimetre coordinates', async ({ page }) => {
  const reference = await loadHeadReference();
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  expect((await dispatch(page, 'describe')).schemaVersion).toBe(2);
  await adopt(page, reference.imagePath);
  const started = await dispatch(page, 'start', { operation: 'extract', parameters: { method: 'bet', threshold: 0.5 } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 120000 }).toBe('succeeded');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.runId).toBe(started.runId);
  const download = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'mask' });
  const bytes = await readFile(await (await download).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.report.artifacts.mask.sha256);
  const mask = readVolume(source(bytes));
  expect(snapshot.report.inputs.image[0]?.sha256 ?? snapshot.report.inputs.image.sha256).toBe(reference.imageSha256);
  expect(mask.dims).toEqual(reference.volume.dims);
  expect(mask.affine).toEqual(reference.volume.affine);
  expect(dice(Uint8Array.from(mask.data), reference.mask)).toBeGreaterThanOrEqual(BET_MIN_DICE);
  expect((await dispatch(page, 'viewers.list'))[0].capabilities.crosshair).toBe(true);
  for (const fractions of [[0.25, 0.4, 0.7], [0.7, 0.6, 0.3]]) {
    const voxel = mask.dims.map((size, axis) => Math.floor(size * fractions[axis]));
    const mm = mask.affine.slice(0, 3).map(row => row[0] * voxel[0] + row[1] * voxel[1] + row[2] * voxel[2] + row[3]);
    expect(mm.some(value => Math.abs(value) > 1)).toBe(true);
    const moved = await dispatch(page, 'viewers.crosshair', { viewerId: 'main', position: { frame: 'mm', value: mm } });
    expect(moved.position.frame).toBe('mm');
    moved.position.value.forEach((value, axis) => expect(value).toBeCloseTo(mm[axis], 3));
    const readBack = await dispatch(page, 'viewers.state', { viewerId: 'main' });
    expect(readBack.position).toEqual(moved.position);
  }
  const tab = await dispatch(page, 'viewers.tab', { viewerId: 'main', tabId: 'mask' });
  expect(tab.tabs.find(entry => entry.id === 'mask').active).toBe(true);
});

test('ambiguous DICOM input lists actual series instead of starting extraction', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, [...dicomSeries({ series: 40 }), ...dicomSeries({ series: 41 })]);
  await dispatch(page, 'start', { parameters: { method: 'bet' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 30000 }).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.code, JSON.stringify(snapshot.error)).toBe('SERIES_SELECTION_REQUIRED');
  expect(snapshot.error.candidates).toHaveLength(2);
  expect(snapshot.error.candidates.every(candidate => /^[0-9a-f]{64}$/.test(candidate.sha256))).toBe(true);
  expect(snapshot.report).toBeUndefined();
});

test('DICOM series with repeated slice basenames remain separate conversion candidates', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  const series = [40, 41];
  const files = series.flatMap(series => dicomSeries({ series }).map((file, index) => ({ ...file, name: `image${index}.dcm` })));
  await adopt(page, files);
  await dispatch(page, 'start', { parameters: { method: 'bet' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 30000 }).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.code, JSON.stringify(snapshot.error)).toBe('SERIES_SELECTION_REQUIRED');
  expect(snapshot.error.candidates.map(candidate => candidate.metadata.SeriesNumber).sort()).toEqual(series);
  expect(snapshot.error.candidates.every(candidate => candidate.dimensions.join(',') === '16,16,4')).toBe(true);
  expect(snapshot.report).toBeUndefined();
});
