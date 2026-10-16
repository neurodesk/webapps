// The age-normative volume report on a faked worker result: FreeSurfer 8.2.0's own volumes for T1_head.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import manifest from '../../../packages/synthseg/model.manifest.json' with { type: 'json' };
import { parseVolumesCsv, VOLUME_COLUMNS, volumesCsv } from '../../../packages/synthseg/src/results.js';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { readVolume, writeFloat32Volume } from '../../../test-utils/nifti-fixture.mjs';

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

// Serves the pinned norms from their checksummed fixtures and counts the requests per reference.
async function serveNorms(page, status = 200) {
  const fixtures = {
    'ixi-fast': 'brainquant_norms.json',
    'ahead-fast': 'brainquant_norms_7t.json',
    'ixi-normal': 'brainquant_norms_normal.json',
    'ahead-normal': 'brainquant_norms_7t_normal.json',
  };
  const requests = Object.fromEntries(Object.keys(fixtures).map((id) => [id, 0]));
  for (const [id, name] of Object.entries(fixtures)) {
    const body = await readFile(`${FIXTURES}${name}`);
    await page.route(manifest.norms[id].url, (route) => {
      requests[id]++;
      return status === 200 ? route.fulfill({ status, body, contentType: 'text/plain' }) : route.fulfill({ status, body: 'missing' });
    });
  }
  return () => requests;
}

async function finishInference(page, resultVolumes = volumes) {
  const labels = await readFile('../../exes/synthseg/test/fixtures/small_fast.nii.gz');
  const { header, data } = readVolume(labels);
  const map = writeFloat32Volume(header, new Float32Array(data.length));
  await page.evaluate(async ({ bytes, mapBytes, volumes }) => {
    await window.inferenceWorker.onmessage({
      data: {
        type: 'result', buffer: new Uint8Array(bytes).buffer, volumes,
        tissues: Object.fromEntries(['gm', 'wm', 'csf'].map((id) => [id, new Uint8Array(mapBytes).buffer])),
        provenance: { outputShape: [1, 1, 1], seconds: 0 },
      },
    });
  }, { bytes: [...labels], mapBytes: [...map], volumes: resultVolumes });
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'succeeded');
}

async function segment(page, resultVolumes = volumes) {
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await finishInference(page, resultVolumes);
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
  expect(report.parameters).toMatchObject({ mode: 'fast', age: 72, sex: 'male', reference: 'auto' });
  expect(report.measurements.softVolumesMm3).toEqual(volumes);
  expect(report.measurements.volumeReport.norms).toEqual({
    id: 'ixi-fast',
    version: '347cf6fb6135',
    url: manifest.norms['ixi-fast'].url,
    sha256: manifest.norms['ixi-fast'].sha256,
  });
  expect(report.measurements.volumeReport.reference).toEqual({
    choice: 'auto',
    fieldStrengthT: null,
    reason: 'the scanner field strength is unknown and SynthSeg ran in fast mode',
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
  await expect(panel).toContainText('Population data: IXI, version 347cf6fb6135.');
  await expect(panel).toContainText('The IXI reference was chosen because the scanner field strength is unknown and SynthSeg ran in fast mode.');

  await page.locator('#age').fill('');
  await page.locator('#sex').selectOption('');
  await expect(panel.locator('figure svg line.nd-chart-level')).toHaveCount(10);
  await expect(panel.locator('figure svg circle.nd-chart-marker')).toHaveCount(0);
  await expect(panel).toContainText('Sex unknown: compared with the combined female and male reference.');
  await page.locator('#age').fill('95');
  await expect(panel.locator('figure svg rect.nd-chart-range')).toHaveCount(10);
  expect(requests()).toMatchObject({ 'ixi-fast': 1, 'ahead-fast': 0 });

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
  expect(saved.measurements.volumeReport.norms.version).toBe('347cf6fb6135');

  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'ready');
  await expect(volumesTab).toBeHidden();
  await expect(panel).toBeHidden();
  await expect(page.locator('#age')).toHaveValue('');
  await expect(page.locator('#volumesBtn')).toBeDisabled();
});

test('the Reference field switches the Volumes view to the AHEAD 7 T norms', async ({ page }) => {
  await fakeInference(page);
  const requests = await serveNorms(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#reference')).toHaveValue('auto');
  await expect(page.locator('#referenceHint')).toHaveText('Auto: IXI (1.5 T / 3 T) · field strength unknown');
  await page.locator('#age').fill('30');
  await segment(page);
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  const panel = page.locator('#volumeReport');
  await expect(panel).toContainText('Reference: IXI 1.5 T and 3 T (n=561,');

  await page.locator('#reference').selectOption('ahead');
  await expect(page.locator('#referenceHint')).toBeHidden();
  await expect(panel).toContainText('Reference: AHEAD 7 T (n=105, 60 F / 45 M, age 18-80 y, CC BY 4.0)');
  await expect(panel).toContainText('Population data: AHEAD, version 347cf6fb6135.');
  await expect(panel).toContainText('The AHEAD reference was chosen because it was selected manually and SynthSeg ran in fast mode.');
  await expect(panel.locator('figure')).toHaveCount(10);
  expect(requests()).toMatchObject({ 'ixi-fast': 1, 'ahead-fast': 1 });

  const json = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  const saved = JSON.parse(await readFile(await (await json).path(), 'utf8'));
  expect(saved.measurements.volumeReport.norms).toEqual({
    id: 'ahead-fast',
    version: '347cf6fb6135',
    url: manifest.norms['ahead-fast'].url,
    sha256: manifest.norms['ahead-fast'].sha256,
  });
  expect(saved.measurements.volumeReport.reference).toEqual({ choice: 'ahead', fieldStrengthT: null, reason: 'it was selected manually and SynthSeg ran in fast mode' });
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
  await expect(page.locator('#volumeReport .nd-message.error')).toContainText('The population report is unavailable');
  await expect(page.locator('#volumeReport tbody tr')).toHaveCount(VOLUME_COLUMNS.length);
  const csv = page.waitForEvent('download');
  await page.locator('#volumesBtn').click();
  expect(await readFile(await (await csv).path(), 'utf8')).toBe(volumesCsv('small', volumes));
});

test('a failed population report preserves raw volumes and downloads and recovers on the next run', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await fakeInference(page);
  await serveNorms(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(SMALL);
  const invalid = { ...volumes, 'left hippocampus': 0 };
  await segment(page, invalid);
  const reason = 'SynthSeg reported no volume for Left hippocampus';
  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  expect(report.measurements.volumeReport.unavailable).toBe(reason);
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  const panel = page.locator('#volumeReport');
  await expect(panel.locator('.nd-message.error')).toContainText(reason);
  await expect(panel.locator('figure')).toHaveCount(0);
  await expect(panel.locator('th')).toHaveText(['Structure', 'Volume (mL)']);
  await expect(panel.locator('tbody tr')).toHaveCount(VOLUME_COLUMNS.length);
  const rows = VOLUME_COLUMNS.map((name) => [name, (invalid[name] / 1000).toFixed(2)]);
  expect(await panel.locator('tbody tr').evaluateAll((lines) => lines.map((line) => [...line.cells].map((cell) => cell.textContent)))).toEqual(rows);

  await page.locator('#age').fill('72');
  await page.locator('#reference').selectOption('ahead');
  await expect(panel.locator('.nd-message.error')).toContainText(reason);
  await page.getByRole('button', { name: 'Axial', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  await expect(panel.locator('tbody tr')).toHaveCount(VOLUME_COLUMNS.length);
  const csv = page.waitForEvent('download');
  await page.locator('#volumesBtn').click();
  const table = await csv;
  expect(table.suggestedFilename()).toBe('small_synthseg_vol.csv');
  expect(await readFile(await table.path(), 'utf8')).toBe(volumesCsv('small', invalid));
  const json = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  const saved = JSON.parse(await readFile(await (await json).path(), 'utf8'));
  expect(saved.measurements.softVolumesMm3).toEqual(invalid);
  expect(saved.measurements.volumeReport.unavailable).toBe(reason);
  const labels = page.waitForEvent('download');
  await page.locator('#saveBtn').click();
  const labelDownload = await labels;
  expect(labelDownload.suggestedFilename()).toBe('small_synthseg.nii.gz');
  expect(await readFile(await labelDownload.path())).toEqual(await readFile('../../exes/synthseg/test/fixtures/small_fast.nii.gz'));

  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(panel).toBeHidden();
  await segment(page);
  await page.getByRole('button', { name: 'Volumes', exact: true }).click();
  await expect(panel.locator('figure')).toHaveCount(10);
  await expect(panel.locator('.nd-message.error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a DICOM series fills Age, Sex and the Auto reference from its header, and an edit overrides them', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(dicomSeries({ slices: 4, patient: { birthDate: '19700615', sex: 'F', studyDate: '20200614' }, fieldStrength: '6.98' }));
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', /ready|failed/, { timeout: 60000 });
  await expect(page.locator('#age')).toHaveValue('49');
  await expect(page.locator('#sex')).toHaveValue('female');
  await expect(page.locator('#subjectHint')).toHaveText('From DICOM header');
  await expect(page.locator('#reference')).toHaveValue('auto');
  await expect(page.locator('#referenceHint')).toHaveText('Auto: AHEAD (7 T) · scanner 6.98 T');
  await page.locator('#age').fill('50');
  await expect(page.locator('#subjectHint')).toBeHidden();
  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#age')).toHaveValue('');
  await expect(page.locator('#sex')).toHaveValue('');
  await expect(page.locator('#referenceHint')).toHaveText('Auto: IXI (1.5 T / 3 T) · field strength unknown');
});

test('automation selects the DICOM reference, preserves demographic overrides and resets for NIfTI', async ({ page }) => {
  test.setTimeout(120000);
  await fakeInference(page);
  await serveNorms(page);
  await page.goto('./');
  const dispatch = (command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
  const run = async (files, parameters = {}) => {
    await page.locator('#neurodesk-input-transfer').setInputFiles(files);
    await dispatch('adopt', { role: 'image' });
    await page.evaluate(() => { window.inferenceJob = null; });
    await dispatch('start', { operation: 'segment', parameters });
    await expect.poll(async () => {
      const snapshot = await dispatch('snapshot');
      if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
      return page.evaluate(() => Boolean(window.inferenceJob));
    }).toBe(true);
    await finishInference(page);
    await expect.poll(async () => (await dispatch('snapshot')).state).toBe('succeeded');
    return (await dispatch('snapshot')).report.measurements.volumeReport;
  };
  const dicom = dicomSeries({ slices: 4, patient: { birthDate: '19700615', sex: 'F', studyDate: '20200614' }, fieldStrength: '6.98' });
  const automatic = await run(dicom);
  expect(automatic.norms.id).toBe('ahead-fast');
  expect(automatic.reference).toEqual({ choice: 'auto', fieldStrengthT: 6.98, reason: 'the scanner field strength is 6.98 T and SynthSeg ran in fast mode' });
  expect(automatic.subject).toEqual({ age: 49, sex: 'female' });

  const ageOverride = await run(dicom, { age: 55, reference: 'ixi' });
  expect(ageOverride.norms.id).toBe('ixi-fast');
  expect(ageOverride.reference).toEqual({ choice: 'ixi', fieldStrengthT: 6.98, reason: 'it was selected manually and SynthSeg ran in fast mode' });
  expect(ageOverride.subject).toEqual({ age: 55, sex: 'female' });
  const sexOverride = await run(dicom, { sex: 'male', reference: 'auto' });
  expect(sexOverride.norms.id).toBe('ahead-fast');
  expect(sexOverride.subject).toEqual({ age: 49, sex: 'male' });
  const defaultMode = await run(dicom, { mode: 'default' });
  expect(defaultMode.norms.id).toBe('ahead-normal');
  expect(defaultMode.reference.reason).toBe('the scanner field strength is 6.98 T and SynthSeg ran in default mode');

  const nifti = await run(SMALL);
  expect(nifti.norms.id).toBe('ixi-fast');
  expect(nifti.reference).toEqual({ choice: 'auto', fieldStrengthT: null, reason: 'the scanner field strength is unknown and SynthSeg ran in fast mode' });
  expect(nifti.subject).toEqual({ age: null, sex: null });
});
