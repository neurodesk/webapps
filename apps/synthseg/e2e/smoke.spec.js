// Real browser smoke test against the built, header-served output (see playwright.config.js).
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createNiftiFromData, createNiftiHeaderFromVolume, extractNiftiHeader, readNiftiImageData } from '../../../packages/components/src/file-io/NiftiUtils.js';

async function fakeInference(page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes('inference-worker')) {
          const fake = { postMessage() {}, terminate() {} };
          window.inferenceWorker = fake;
          return fake;
        }
        super(url, options);
      }
    };
  });
}

test('app boots with the shared bar', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#controls')).toBeVisible();
  await expect(page.locator("#imageInput[data-neurodesk-input='image']")).toHaveCount(1);
  await expect(page.locator('.nd-app-bar')).toHaveCount(1);
  for (const name of ['About', 'Cite', 'Privacy']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
});

test('About opens from the shared bar and the theme toggles', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#controls > #aboutBtn')).toBeHidden();
  await page.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('.nd-app-dialog[data-dialog="about"]')).toBeVisible();
  await page.locator('.nd-app-dialog[data-dialog="about"] .nd-app-dialog__close').click();
  await expect(page.locator('.nd-app-dialog[data-dialog="about"]')).toBeHidden();
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
});

test('a browser without WebGPU explains itself and keeps Run disabled', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }); });
  await page.goto('./');
  await expect(page.locator('#statusText')).toContainText('WebGPU');
  await expect(page.locator('#processButton')).toBeDisabled();
});

test('WebGPU is available in this Chromium', async ({ page }) => {
  await page.goto('./');
  expect(await page.evaluate(() => Boolean(navigator.gpu))).toBe(true);
});

test('local image parsing stays busy until it can commit the selected scan', async ({ page }) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'small.nii.gz') {
        await new Promise((resolve) => { window.finishImageRead = resolve; });
      }
      return read.call(this);
    };
  });
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles('../../exes/synthseg/test/fixtures/small.nii.gz');
  await expect.poll(() => page.evaluate(() => Boolean(window.finishImageRead))).toBe(true);
  await expect(page.locator('#imageInput')).toBeDisabled();
  await expect(page.locator('#cancelBtn')).toBeVisible();
  await page.evaluate(() => window.finishImageRead());
  await expect(page.locator('#statusText')).toContainText('Image loaded');
  await expect(page.locator('#imageInput')).toBeEnabled();
});

test('cancelled inference cannot publish a stale worker message', async ({ page }) => {
  await fakeInference(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles('../../exes/synthseg/test/fixtures/small.nii.gz');
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await expect(page.locator('#cancelBtn')).toBeVisible();
  await page.locator('#cancelBtn').click();
  await page.evaluate(() => window.inferenceWorker.onmessage({ data: { type: 'error', message: 'stale result' } }));
  await expect(page.locator('#statusText')).toContainText('Processing cancelled');
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'cancelled');
  expect(JSON.parse(await page.locator('#neurodesk-run').textContent()).report).toBeUndefined();
  await expect(page.locator('#reportBtn')).toBeDisabled();
});

test('worker results publish a checksummed report and label volumes; replacement clears it', async ({ page }) => {
  await fakeInference(page);
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles('../../exes/synthseg/test/fixtures/small.nii.gz');
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'ready');
  const inputRun = await page.locator('#statusText').getAttribute('data-neurodesk-run-id');
  await page.locator('#processButton').click();
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'running');
  expect(await page.locator('#statusText').getAttribute('data-neurodesk-run-id')).not.toBe(inputRun);
  const header = createNiftiHeaderFromVolume({
    dims: [2, 2, 1],
    hdr: { affine: [[-2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0], [0, 0, 0, 1]] },
  });
  const labels = gzipSync(createNiftiFromData(new Uint16Array([0, 2, 2, 3]), header));
  await page.evaluate(async bytes => {
    await window.inferenceWorker.onmessage({
      data: { type: 'result', buffer: new Uint8Array(bytes).buffer, provenance: { outputShape: [2, 2, 1], seconds: 0 } },
    });
  }, [...labels]);
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'succeeded');
  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  expect(report.measurements.labels.find(label => label.id === 2)).toEqual({
    id: 2, name: 'Left-Cerebral-White-Matter', voxels: 2, volumeMl: 0.048,
  });
  const downloads = [];
  page.on('download', download => downloads.push(download));
  const outputDownload = page.waitForEvent('download');
  await page.locator('#saveBtn').click();
  const outputBytes = await readFile(await (await outputDownload).path());
  expect(createHash('sha256').update(outputBytes).digest('hex')).toBe(report.artifacts.labels.sha256);
  expect(outputBytes.length).toBe(report.artifacts.labels.bytes);
  const reportDownload = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  expect(JSON.parse(await readFile(await (await reportDownload).path(), 'utf8'))).toEqual(report);
  expect(downloads.map(download => download.suggestedFilename())).toEqual([
    report.artifacts.labels.filename,
    report.artifacts.labels.filename.replace(/\.nii\.gz$/, '.json'),
  ]);
  await page.locator('#imageInput').setInputFiles({ name: 'invalid.nii', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') });
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'failed');
  expect(JSON.parse(await page.locator('#neurodesk-run').textContent()).report).toBeUndefined();
  await expect(page.locator('#reportBtn')).toBeDisabled();
  await expect(page.locator('#saveBtn')).toBeDisabled();
});

const SMALL = '../../exes/synthseg/test/fixtures/small.nii.gz';

async function segmentWith(page, labels) {
  await fakeInference(page);
  // SwiftShader's WebGPU loses NiiVue's device after the first volume load; with no adapter the viewer falls back
  // to WebGL2, while the app's WebGPU check still passes.
  await page.addInitScript(() => {
    GPU.prototype.requestAdapter = async () => null;
  });
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(SMALL);
  await expect(page.locator('#processButton')).toBeEnabled();
  await page.locator('#processButton').click();
  await page.evaluate(async bytes => {
    await window.inferenceWorker.onmessage({
      data: { type: 'result', buffer: new Uint8Array(bytes).buffer, provenance: { outputShape: [1, 1, 1], seconds: 0 } },
    });
  }, [...labels]);
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'succeeded');
}

async function paintAcrossAxialCentre(page) {
  await page.getByRole('button', { name: 'Axial', exact: true }).click();
  const box = await page.locator('#gl1').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 60, y - 10);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) await page.mouse.move(x - 60 + step * 10, y - 10 + step * 2);
  await page.mouse.up();
}

async function download(page, button) {
  const pending = page.waitForEvent('download');
  await button.click();
  const file = await pending;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

const decode = bytes => readNiftiImageData(gunzipSync(bytes));

test('labels on the input grid can be edited, cancelled and applied, and Download returns the edit', async ({ page }) => {
  const input = gunzipSync(await readFile(SMALL));
  const { dims } = readNiftiImageData(input);
  const [nx, ny, nz] = dims;
  const voxels = new Uint16Array(nx * ny * nz);
  for (let z = nz / 2 - 3; z < nz / 2 + 3; z++)
    for (let y = ny / 2 - 3; y < ny / 2 + 3; y++)
      for (let x = nx / 2 - 3; x < nx / 2 + 3; x++) voxels[x + nx * (y + ny * z)] = 17;
  const pipelineLabels = gzipSync(createNiftiFromData(voxels, extractNiftiHeader(input)));
  await segmentWith(page, pipelineLabels);
  const row = page.locator('#resultList [data-stage="labels"]');
  const editor = page.locator('nd-mask-editor');
  await expect(row.locator('.nd-stage-label')).toHaveText('FreeSurfer labels');

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toHaveText('Editing FreeSurfer labels. Left-drag paints; Apply keeps the changes.');
  await expect(editor.locator('option', { hasText: '17 — Left-Hippocampus' })).toHaveCount(1);
  await expect(row.getByRole('button', { name: 'Edit' })).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(row.locator('.nd-stage-label')).toHaveText('FreeSurfer labels');
  await expect(page.locator('#statusText')).toContainText('Edits discarded');

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await paintAcrossAxialCentre(page);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(row.locator('.nd-stage-label')).toHaveText('FreeSurfer labels (edited)');
  await expect(page.locator('#statusText')).toContainText('Labels edited');

  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  const edited = await download(page, page.locator('#saveBtn'));
  expect(edited.name).toBe(report.artifacts.labels.filename);
  const image = decode(edited.bytes);
  expect(image.header.datatype).toBe(2);
  expect(image.dims).toEqual(dims);
  expect(image.data).not.toEqual(decode(pipelineLabels).data);
  expect(createHash('sha256').update(pipelineLabels).digest('hex')).toBe(report.artifacts.labels.sha256);

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await page.locator('#processButton').click();
  await expect(editor).toBeHidden();
  await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('labels on the 1 mm SynthSeg grid are edited on that grid', async ({ page }) => {
  const pipelineLabels = await readFile('../../exes/synthseg/test/fixtures/small_fast.nii.gz');
  await segmentWith(page, pipelineLabels);
  const row = page.locator('#resultList [data-stage="labels"]');
  const editor = page.locator('nd-mask-editor');
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toContainText("resampled to SynthSeg's 1 mm label grid");
  await paintAcrossAxialCentre(page);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(row.locator('.nd-stage-label')).toHaveText('FreeSurfer labels (edited)');
  const image = decode((await download(page, page.locator('#saveBtn'))).bytes);
  expect(image.header.datatype).toBe(2);
  expect(image.dims).toEqual(decode(pipelineLabels).dims);
  expect(image.data).not.toEqual(decode(pipelineLabels).data);
});
