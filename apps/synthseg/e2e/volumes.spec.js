// The age-normative volume report on a faked worker result: FreeSurfer 8.2.0's own volumes for T1_head.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import manifest from '../../../packages/synthseg/model.manifest.json' with { type: 'json' };
import { parseVolumesCsv } from '../../../packages/synthseg/src/results.js';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';

const FIXTURES = '../../packages/synthseg/test/fixtures/';
const SMALL = '../../exes/synthseg/test/fixtures/small.nii.gz';
const freesurferTable = await readFile(`${FIXTURES}T1_head_fast_vol.csv`, 'utf8');
const { volumes } = parseVolumesCsv(freesurferTable);

async function fakeInference(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes('inference-worker')) {
          const fake = { postMessage(job) { window.inferenceJob = job; }, terminate() {} };
          window.inferenceWorker = fake;
          return fake;
        }
        super(url, options);
      }
    };
  });
}

async function serveNorms(page, status = 200) {
  const body = await readFile(`${FIXTURES}brainquant_norms.json`);
  let requests = 0;
  await page.route(manifest.norms.url, (route) => {
    requests++;
    return status === 200 ? route.fulfill({ status, body, contentType: 'text/plain' }) : route.fulfill({ status, body: 'missing' });
  });
  return () => requests;
}

async function segment(page) {
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  const labels = await readFile('../../exes/synthseg/test/fixtures/small_fast.nii.gz');
  await page.evaluate(async ({ bytes, volumes }) => {
    await window.inferenceWorker.onmessage({
      data: { type: 'result', buffer: new Uint8Array(bytes).buffer, volumes, provenance: { outputShape: [1, 1, 1], seconds: 0 } },
    });
  }, { bytes: [...labels], volumes });
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'succeeded');
}

test('fast mode is the default processing mode', async ({ page }) => {
  await fakeInference(page);
  await page.goto('./');
  await expect(page.locator('#mode')).toHaveValue('fast');
  await page.locator('#imageInput').setInputFiles(SMALL);
  await page.locator('#processButton').click();
  expect(await page.evaluate(() => window.inferenceJob.options.fast)).toBe(true);
});

test('the Volumes view charts each structure against age and follows the Age and Sex fields', async ({ page }) => {
  await fakeInference(page);
  const requests = await serveNorms(page);
  await page.goto('./');
  const volumesTab = page.getByRole('button', { name: 'Volumes', exact: true });
  await expect(volumesTab).toBeHidden();
  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#age')).toHaveValue('');
  await expect(page.locator('#subjectHint')).toBeHidden();
  await page.locator('#age').fill('72');
  await page.locator('#sex').selectOption('male');
  await segment(page);

  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  expect(report.parameters).toMatchObject({ mode: 'fast', age: 72, sex: 'male' });
  expect(report.measurements.softVolumesMm3).toEqual(volumes);
  expect(report.measurements.volumeReport.norms).toEqual({
    version: 'b23bda1938a5',
    url: manifest.norms.url,
    sha256: manifest.norms.sha256,
  });
  const hippocampus = report.measurements.volumeReport.results[0];
  expect(hippocampus).toMatchObject({ id: 'hippocampus_left', flag: '>95th' });
  expect(hippocampus.percentile).toBeCloseTo(98.79403632302876, 9);

  await expect(volumesTab).toBeVisible();
  await volumesTab.click();
  const panel = page.locator('#volumeReport');
  await expect(panel).toBeVisible();
  await expect(volumesTab).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('figure')).toHaveCount(10);
  await expect(panel.locator('figure').first().locator('figcaption')).toHaveText('Left hippocampus: 99th');
  await expect(panel.locator('figure[data-flag]').first().locator('figcaption')).toHaveCSS('font-weight', '600');
  await expect(panel.locator('figure svg circle.nd-chart-marker')).toHaveCount(10);
  // Markup outside the SVG namespace keeps the elements but draws nothing.
  expect(await panel.locator('figure svg').first().evaluate((svg) => svg instanceof SVGSVGElement && svg.getBoundingClientRect().height > 100)).toBe(true);
  await expect(panel.locator('figure svg circle.nd-chart-marker').first()).toBeVisible();
  await expect(panel.locator('tbody tr')).toHaveCount(10);
  await expect(panel.locator('tbody tr').first()).toHaveAttribute('data-flag', '>95th');
  await expect(panel).toContainText('Research use only. Not for diagnostic use.');
  await expect(panel).toContainText('Total intracranial volume 1592 mL.');
  await expect(panel).toContainText('Population data: IXI, version b23bda1938a5.');

  await page.locator('#age').fill('');
  await page.locator('#sex').selectOption('');
  await expect(panel.locator('figure svg line.nd-chart-level')).toHaveCount(10);
  await expect(panel.locator('figure svg circle.nd-chart-marker')).toHaveCount(0);
  await expect(panel).toContainText('Sex unknown: compared with the combined female and male reference.');
  await page.locator('#age').fill('95');
  await expect(panel.locator('figure svg rect.nd-chart-range')).toHaveCount(10);
  expect(requests()).toBe(1);

  await page.getByRole('button', { name: 'Axial', exact: true }).click();
  await expect(panel).toBeHidden();
  await volumesTab.click();
  await expect(panel).toBeVisible();

  const csv = page.waitForEvent('download');
  await page.locator('#volumesBtn').click();
  const download = await csv;
  expect(download.suggestedFilename()).toBe('small_synthseg_vol.csv');
  expect(await readFile(await download.path(), 'utf8')).toBe(freesurferTable.replace(/^(.*\r\n)T1_head,/, '$1small,'));
  const json = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  const saved = JSON.parse(await readFile(await (await json).path(), 'utf8'));
  expect(saved.measurements.volumeReport.subject).toEqual({ age: 95, sex: null });
  expect(saved.measurements.volumeReport.outsideReferenceAge).toBe(true);
  expect(saved.measurements.volumeReport.norms.version).toBe('b23bda1938a5');

  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'ready');
  await expect(volumesTab).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(page.locator('#age')).toHaveValue('');
  await expect(page.locator('#volumesBtn')).toBeDisabled();
});

test('without the reference volumes the Volumes view says why and the table still downloads', async ({ page }) => {
  await fakeInference(page);
  await serveNorms(page, 404);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(SMALL);
  await segment(page);
  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  expect(report.measurements.volumeReport.unavailable).toBeTruthy();
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  await expect(page.locator('#volumeReport .nd-message.error')).toContainText('The reference volumes could not be loaded');
  const csv = page.waitForEvent('download');
  await page.locator('#volumesBtn').click();
  expect(await readFile(await (await csv).path(), 'utf8')).toContain('total intracranial');
});

test('a DICOM series fills Age and Sex from its header, and an edit overrides them', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(dicomSeries({ slices: 4, patient: { birthDate: '19700615', sex: 'F', studyDate: '20200614' } }));
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', /ready|failed/, { timeout: 60000 });
  await expect(page.locator('#age')).toHaveValue('49');
  await expect(page.locator('#sex')).toHaveValue('female');
  await expect(page.locator('#subjectHint')).toHaveText('From DICOM header');
  await page.locator('#age').fill('50');
  await expect(page.locator('#subjectHint')).toBeHidden();
  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#age')).toHaveValue('');
  await expect(page.locator('#sex')).toHaveValue('');
});
