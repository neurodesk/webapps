import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { readVolume } from '../../../packages/synthsr/src/volume.js';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const source = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
async function adopt(page, role, files) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(files);
  await dispatch(page, 'adopt', { role });
}
async function download(page, artifactId) {
  const downloading = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId });
  return readFile(await (await downloading).path());
}

test('CPU segmentation can be cancelled and retried to produce native-grid labels and actual QC metrics', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, 'image', fixture);
  const created = page.waitForEvent('worker', { predicate: worker => worker.url().includes('segmentation-worker-') });
  await dispatch(page, 'start', { operation: 'quality-control', parameters: { backend: 'cpu', model: '16chan18cls' } });
  const worker = await created;
  const closed = new Promise(resolve => worker.once('close', resolve));
  await dispatch(page, 'cancel');
  await closed;
  expect((await dispatch(page, 'snapshot')).state).toBe('cancelled');
  await adopt(page, 'image', fixture);
  await adopt(page, 'sidecar', { name: 'scan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ EchoTime: 0.003, RepetitionTime: 2.1 })) });
  await dispatch(page, 'start', { operation: 'quality-control', parameters: { backend: 'cpu', model: '16chan18cls' } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 840000, intervals: [1000, 2000, 5000] }).toBe('succeeded');
  const labels = readVolume(source(await download(page, 'labels')));
  const input = readVolume(source(await readFile(fixture)));
  expect(labels.dims).toEqual(input.dims);
  expect(labels.affine).toEqual(input.affine);
  const ids = [...new Set(labels.data)].sort((left, right) => left - right);
  expect(ids.every(id => Number.isInteger(id) && id >= 0 && id < 18)).toBe(true);
  expect(ids.length).toBeGreaterThan(10);
  const qc = JSON.parse((await download(page, 'qc')).toString());
  for (const key of ['cjv', 'cnr', 'snr_total', 'efc_brain', 'vol_gm_mm3', 'vol_wm_mm3']) expect(Number.isFinite(qc[key]), `${key}: ${qc[key]}`).toBe(true);
  expect(qc.bids_meta).toEqual({ EchoTime: 0.003, RepetitionTime: 2.1 });
  const { report } = await dispatch(page, 'snapshot');
  expect(report.provenance.segmentation.backend).toBe('cpu');
  const regions = await dispatch(page, 'viewers.regions', { viewerId: 'main' });
  expect(regions).toEqual(report.measurements.labels);
  expect(regions.find(region => region.name === 'Hippocampus').voxels).toBeGreaterThan(0);
});

test('QC failure after real segmentation fails the operation instead of publishing a partial report', async ({ page }) => {
  await page.route('**/browserqc/avg152T1.nii.gz', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, 'image', fixture);
  await adopt(page, 'sidecar', { name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('null') });
  await dispatch(page, 'start', { parameters: { backend: 'cpu', model: '16chan18cls' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state).toBe('failed');
  expect((await dispatch(page, 'snapshot')).error.message).toContain('JSON object');
  await adopt(page, 'image', fixture);
  await dispatch(page, 'start', { parameters: { backend: 'cpu', model: '16chan18cls' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 840000, intervals: [1000, 2000, 5000] }).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.message).toContain('fetch avg152T1.nii.gz failed: 503');
  expect(snapshot.report).toBeUndefined();
  const regions = await dispatch(page, 'viewers.regions', { viewerId: 'main' });
  expect(regions.find(region => region.name === 'Hippocampus').voxels).toBeGreaterThan(0);
  await expect(page.locator('#saveBtn')).toBeDisabled();
});

test('an air template with other bytes fails QC instead of publishing metrics', async ({ page }) => {
  await page.route('**/browserqc/avg152T1.nii.gz', route => route.fulfill({ status: 200, contentType: 'application/gzip', body: Buffer.from('not the template') }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, 'image', fixture);
  await dispatch(page, 'start', { parameters: { backend: 'cpu', model: '16chan18cls' } });
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 840000, intervals: [1000, 2000, 5000] }).toBe('failed');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.error.message).toMatch(/avg152T1\.nii\.gz has SHA-256 [0-9a-f]{64}, not the pinned/);
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator('#saveBtn')).toBeDisabled();
});

test('default PVE analysis publishes native-grid fractions and an independent mask', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, 'image', fixture);
  await dispatch(page, 'start', { parameters: { backend: 'cpu' } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 840000, intervals: [1000, 2000, 5000] }).toBe('succeeded');
  const input = readVolume(source(await readFile(fixture)));
  for (const name of ['csf', 'gm', 'wm', 'mask']) {
    const volume = readVolume(source(await download(page, name)));
    expect(volume.dims).toEqual(input.dims);
    expect(volume.affine).toEqual(input.affine);
    expect(volume.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    expect(volume.data.some(value => value > 0)).toBe(true);
    if (name !== 'mask') expect(volume.data.some(value => value > 0 && value < 1)).toBe(true);
  }
  const qc = JSON.parse((await download(page, 'qc')).toString());
  expect(qc.provenance.segmentation).toContain('mindmap-pve');
  for (const key of ['cjv', 'cnr', 'vol_gm_mm3', 'vol_wm_mm3']) expect(Number.isFinite(qc[key])).toBe(true);
  const regions = await dispatch(page, 'viewers.regions', { viewerId: 'main' });
  expect(regions).toEqual([]);
});
