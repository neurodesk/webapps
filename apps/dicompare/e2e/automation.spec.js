import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

test('DICOM analysis executes the Python worker and returns real acquisition metadata', async ({ page }) => {
  await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(dicomSeries({ series: 31 }));
  await dispatch(page, 'adopt', { role: 'dicom' });
  await dispatch(page, 'start', { operation: 'analyze' });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 180000, intervals: [250, 1000, 2000] }).toBe('succeeded');
  const snapshot = await dispatch(page, 'snapshot');
  expect(snapshot.report.summary).toEqual({ acquisitions: 1, inputFiles: 4 });
  expect(snapshot.report.inputs.dicom).toHaveLength(4);
  const downloading = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'acquisitions' });
  const result = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(result.acquisitions).toHaveLength(1);
  expect(result.acquisitions[0].protocolName).toBe('acq-testscan31');
  expect(result.acquisitions[0].acquisitionFields.length).toBeGreaterThan(0);
});


test('protocol comparison uses the explicit schema acquisition and reports validation results', async ({ page }) => {
  await page.context().route('**/cloudflareinsights.com/**', route => route.fulfill({ status: 204 }));
  await page.goto('./');
  await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
  await page.locator('#neurodesk-input-transfer').setInputFiles(dicomSeries({ series: 32 }));
  await dispatch(page, 'adopt', { role: 'dicom' });
  const schema = { name: 'Synthetic MR', acquisitions: { MR: { fields: [
    { field: 'Modality', value: 'MR' }, { field: 'Manufacturer', value: 'Synthetic' },
  ] } } };
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'protocol.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(schema)) });
  await dispatch(page, 'adopt', { role: 'schema' });
  await dispatch(page, 'start', { operation: 'compare', parameters: { schemaIndex: 0 } });
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 180000, intervals: [250, 1000, 2000] }).toBe('succeeded');
  const downloading = page.waitForEvent('download');
  await dispatch(page, 'download', { artifactId: 'comparison' });
  const result = JSON.parse(await readFile(await (await downloading).path(), 'utf8'));
  expect(result.schemaIndex).toBe(0);
  expect(result.comparison).toHaveLength(1);
  expect(result.comparison[0].results).toHaveLength(2);
  expect(result.comparison[0].results, JSON.stringify(result.comparison[0].results)).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'pass' })]));
});
