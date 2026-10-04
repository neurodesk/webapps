import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readVolume } from '@neurodesk/synthsr';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { browserSynthstrip } from '../../../packages/syncro/src/assets.js';

const fixture = new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url).pathname;
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
const bytesOf = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);

test('BET produces the existing Rust mask and downloads images with original geometry', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#method').selectOption('bet');
  await expect(page.locator('#methodHint')).toBeHidden();
  await page.locator('#advancedSettings summary').click();
  await page.locator('#threshold').fill('0');
  await page.locator('#advancedSettings summary').click();
  await page.locator('#advancedSettings summary').click();
  await expect(page.locator('#threshold')).toHaveValue('0');
  await page.locator('#threshold').fill('0.5');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'succeeded');
  const { report } = JSON.parse(await page.locator('#neurodesk-run').textContent());
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(3);
  expect(requests.some(url => /ort-wasm|mindgrab\/|onnxruntime|synthstrip-.*\.js/.test(url))).toBe(false);
  const original = readVolume(bytesOf(await readFile(fixture)));
  const readDownload = async index => {
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#resultList .nd-download-btn').nth(index).click();
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    const role = index === 1 ? 'brain' : 'mask';
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(report.artifacts[role].sha256);
    expect(bytes.length).toBe(report.artifacts[role].bytes);
    return readVolume(bytesOf(bytes));
  };
  const brain = await readDownload(1);
  const mask = await readDownload(2);
  expect(mask.dims).toEqual(original.dims);
  expect(mask.affine).toEqual(original.affine);
  expect(brain.affine).toEqual(original.affine);
  const binary = Uint8Array.from(mask.data);
  expect(binary.reduce((sum, value) => sum + value, 0)).toBe(246875);
  expect(createHash('sha256').update(binary).digest('hex')).toBe('107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862');
  expect(brain.data.every((value, index) => value === (binary[index] ? original.data[index] : 0))).toBe(true);
  const reportDownload = page.waitForEvent('download');
  await page.locator('#reportBtn').click();
  expect(JSON.parse(await readFile(await (await reportDownload).path(), 'utf8'))).toEqual(report);
});

test('editing the BET mask in the viewer replaces its download', async ({ page }) => {
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(fixture);
  await page.locator('#method').selectOption('bet');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
  const maskRow = page.locator('#resultList .nd-volume-toggle').filter({ hasText: 'Brain mask' });
  await expect(page.locator('#resultList .nd-edit-btn')).toHaveCount(1);
  const downloadMask = async () => {
    const pending = page.waitForEvent('download');
    await maskRow.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await pending;
    return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
  };
  const original = await downloadMask();
  const editor = page.locator('nd-mask-editor');
  const strokeAcrossCentre = async () => {
    await page.getByRole('button', { name: 'Axial', exact: true }).click();
    await editor.getByRole('button', { name: 'Erase', exact: true }).click();
    const box = await page.locator('#gl1').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.35, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(box.x + box.width * (0.35 + 0.03 * step), y);
    await page.mouse.up();
  };
  await maskRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toContainText('Editing Brain mask');
  await expect(maskRow.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
  await strokeAcrossCentre();
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(maskRow.locator('.nd-stage-label')).toHaveText('Brain mask');
  expect((await downloadMask()).bytes.equals(original.bytes)).toBe(true);
  await maskRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toBeVisible();
  await strokeAcrossCentre();
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(maskRow.locator('.nd-stage-label')).toHaveText('Brain mask (edited)');
  await expect(maskRow.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  const edited = await downloadMask();
  expect(edited.name).toBe(original.name);
  expect(edited.bytes.readInt16LE(70)).toBe(2);
  const before = readVolume(bytesOf(original.bytes));
  const after = readVolume(bytesOf(edited.bytes));
  expect(after.dims).toEqual(readVolume(bytesOf(await readFile(fixture))).dims);
  expect(after.affine).toEqual(before.affine);
  const changed = after.data.reduce((count, value, index) => count + (value !== before.data[index]), 0);
  expect(changed).toBeGreaterThan(0);
  expect(after.data.reduce((sum, value) => sum + value, 0)).toBeLessThan(before.data.reduce((sum, value) => sum + value, 0));
  await maskRow.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor).toBeVisible();
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(editor).toBeHidden();
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(1);
});

test('examples load through the picker and BET downloads a brain mask', async ({ page }) => {
  for (const example of examples) await page.route(example.files[0].url, route => route.fulfill({ path: fixture }));
  await page.goto('./');
  const picker = page.getByLabel('Example', { exact: true });
  for (const example of examples) {
    await picker.selectOption(example.id);
    await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready');
    await expect(page.locator('#fileInfo')).toContainText(new URL(example.files[0].url).pathname.split('/').pop());
    await expect(page.locator('#outputSection')).not.toHaveAttribute('open', '');
    await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(1);
  }
  await page.locator('#method').selectOption('bet');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#resultList .nd-download-btn').nth(2).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('chris_t2_bet_mask.nii');
  const mask = readVolume(bytesOf(await readFile(await download.path())));
  expect(createHash('sha256').update(Uint8Array.from(mask.data)).digest('hex')).toBe('107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862');
});

test('failed example download can retry the same example', async ({ page }) => {
  const example = examples[0];
  let attempts = 0;
  await page.route(example.files[0].url, route => ++attempts === 1
    ? route.fulfill({ status: 503, body: 'Unavailable' })
    : route.fulfill({ path: fixture }));
  await page.goto('./');
  const picker = page.getByLabel('Example', { exact: true });
  await picker.selectOption(example.id);
  await expect(page.locator('#statusText')).toContainText('HTTP 503');
  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(picker).toBeEnabled();
  await picker.selectOption(example.id);
  await expect(page.locator('#runButton')).toBeEnabled();
  expect(attempts).toBe(2);
});

test('cancelling an example aborts its request and permits the same selection again', async ({ page }) => {
  const example = examples[0];
  let releaseRequest;
  let attempts = 0;
  await page.route(example.files[0].url, async route => {
    if (++attempts === 1) await new Promise(resolve => { releaseRequest = resolve; });
    await route.fulfill({ path: fixture }).catch(() => {});
  });
  await page.goto('./');
  const picker = page.getByLabel('Example', { exact: true });
  await picker.selectOption(example.id);
  await expect(picker).toBeDisabled();
  const failed = page.waitForEvent('requestfailed', request => request.url() === example.files[0].url);
  await page.getByRole('button', { name: 'Cancel example download' }).click();
  await failed;
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'cancelled');
  await expect(page.locator('#runButton')).toBeDisabled();
  releaseRequest();
  await picker.selectOption(example.id);
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'ready');
  await expect(page.locator('#runButton')).toBeEnabled();
  expect(attempts).toBe(2);
});

test('cancel terminates a waiting method load and a fresh BET run succeeds', async ({ page }) => {
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(fixture);
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.route('**/*synthstrip*.js', route => new Promise(resolve => setTimeout(resolve, 1500)).then(() => route.continue().catch(() => {})));
  await page.locator('#method').selectOption('synthstrip');
  await page.locator('#runButton').click();
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toHaveText('Cancelled');
  await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', 'cancelled');
  expect(JSON.parse(await page.locator('#neurodesk-run').textContent()).report).toBeUndefined();
  await page.locator('#method').selectOption('bet');
  await page.locator('#runButton').click();
  await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(3);
});

test('DICOM import accepts extensionless slices and rejects multiple series', async ({ page }) => {
  await page.goto('./');
  await page.locator('#imageInput').setInputFiles(dicomSeries({ extension: '' }));
  await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 4');
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#imageInput').setInputFiles([...dicomSeries(), ...dicomSeries({ series: 2 })]);
  await expect(page.locator('#statusText')).toContainText('one DICOM series at a time');
  await expect(page.locator('#runButton')).toBeDisabled();
});

test('shared app bar owns dialogs, theme and cross-origin isolation', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('.nd-app-bar:visible')).toHaveCount(1);
  const bar = page.locator('.nd-app-bar:visible');
  await bar.getByRole('button', { name: 'About', exact: true }).click();
  await expect(page.locator('#infoDialog')).toBeVisible();
  await page.locator('#infoDialog').getByRole('button', { name: 'Close' }).click();
  await bar.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('html')).toHaveAttribute('data-neurodesk-theme', 'light');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
});

test('MindGrab processing choice survives closing settings and switching methods', async ({ page }) => {
  await page.goto('./');
  await page.locator('#advancedSettings summary').click();
  await page.locator('#mindgrabBackend').selectOption('cpu');
  await page.locator('#advancedSettings summary').click();
  await page.locator('#method').selectOption('bet');
  await page.locator('#method').selectOption('mindgrab');
  await page.locator('#advancedSettings summary').click();
  await expect(page.locator('#mindgrabBackend')).toHaveValue('cpu');
  await expect(page.locator('#betSettings')).toBeHidden();
});

for (const method of ['mindgrab', 'synthstrip']) {
  test(`${method} real model returns a nonempty binary mask in input geometry`, async ({ page }) => {
    test.skip(!process.env.BRAIN_EXTRACTION_REAL_MODELS, 'Set BRAIN_EXTRACTION_REAL_MODELS=1 for model downloads and inference.');
    test.setTimeout(1200000);
    await page.goto('./');
    await page.locator('#imageInput').setInputFiles(fixture);
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#method').selectOption(method);
    if (method === 'mindgrab') {
      await page.locator('#advancedSettings summary').click();
      await page.locator('#mindgrabBackend').selectOption('cpu');
    }
    await page.locator('#runButton').click();
    await expect(page.locator('#statusText')).toHaveAttribute('data-neurodesk-state', /succeeded|failed/, { timeout: 1100000 });
    await expect(page.locator('#statusText')).toHaveText('Brain image and mask ready');
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#resultList .nd-download-btn').nth(2).click();
    const maskBytes = await readFile(await (await downloadPromise).path());
    const mask = readVolume(bytesOf(maskBytes));
    const original = readVolume(bytesOf(await readFile(fixture)));
    expect(mask.dims).toEqual(original.dims);
    expect(mask.affine).toEqual(original.affine);
    expect(mask.data.every(value => value === 0 || value === 1)).toBe(true);
    const count = mask.data.reduce((sum, value) => sum + value, 0);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(mask.data.length);
    const reportDownload = page.waitForEvent('download');
    await page.locator('#reportBtn').click();
    const report = JSON.parse(await readFile(await (await reportDownload).path(), 'utf8'));
    const input = Array.isArray(report.inputs.image) ? report.inputs.image[0] : report.inputs.image;
    const artifact = report.artifacts.mask || Object.values(report.artifacts).find(value => value.role === 'mask');
    expect(report.status).toBe('succeeded');
    expect(input.sha256).toBe(createHash('sha256').update(await readFile(fixture)).digest('hex'));
    expect(artifact.sha256).toBe(createHash('sha256').update(maskBytes).digest('hex'));
    if (method === 'mindgrab') expect(report.provenance.backend).toBe('cpu');
    else expect(report.provenance.modelHash).toBe(browserSynthstrip.sha256);
    console.log(JSON.stringify({ method, maskVoxels: count, comparedVoxels: mask.data.length, provenance: report.provenance, inputSha256: input.sha256, outputSha256: artifact.sha256 }));
  });
}
