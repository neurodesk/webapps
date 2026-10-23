import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
async function adopt(page, role, files) {
  await page.locator('#neurodesk-input-transfer').setInputFiles(files);
  await dispatch(page, 'adopt', { role });
}
async function completed(page) {
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state, { timeout: 30000 }).not.toBe('running');
  return dispatch(page, 'snapshot');
}

test('volume operation produces a playable WebM with matching frame count and checksum', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await adopt(page, 'image', fixture);
  await dispatch(page, 'start', { parameters: { orientation: 'axial', format: 'webm', start: 0, end: 3, fps: 10 } });
  const snapshot = await completed(page);
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
  expect(snapshot.report.summary.frames).toBe(3);
  expect(snapshot.report.summary.container).toBe('webm');
  expect(snapshot.report.provenance.sliceIndices).toEqual([0, 1, 2]);
  const download = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'video' });
  const bytes = await readFile(await (await download).path());
  expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.report.artifacts.video.sha256);
  await expect.poll(() => page.locator('#resultVideo').evaluate(video => video.readyState)).toBeGreaterThanOrEqual(1);
  expect(await page.locator('#resultVideo').evaluate(video => [video.videoWidth, video.videoHeight]))
    .toEqual([snapshot.report.summary.width, snapshot.report.summary.height]);
});

test('multiple DICOM series require an explicit UID before encoding', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  const files = [...dicomSeries({ series: 70 }), ...dicomSeries({ series: 71 })];
  await adopt(page, 'series', files);
  await dispatch(page, 'start', { operation: 'encode-dicom' });
  const ambiguous = await completed(page);
  expect(ambiguous.error.code).toBe('SERIES_SELECTION_REQUIRED');
  expect(ambiguous.error.candidates).toHaveLength(2);
  await adopt(page, 'series', files);
  await dispatch(page, 'start', { operation: 'encode-dicom', parameters: { seriesUid: ambiguous.error.candidates[0].seriesUid, orientation: 'axial' } });
  const selected = await completed(page);
  expect(selected.state, JSON.stringify(selected.error)).toBe('succeeded');
  expect(selected.report.provenance.source.seriesUid).toBe(ambiguous.error.candidates[0].seriesUid);
});
