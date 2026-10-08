import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { cropTof, TOF_CROP, TOF_SOURCE } from '../test/tof-crop.mjs';

// Independent reference: upstream VesselBoost (PyTorch, manual_0429 weights) run on the same crop.
// test/fixtures/upstream-reference/README.md records the command, commit and versions.
const reference = {
  url: new URL('../test/fixtures/upstream-reference/lausanne-tof-crop-192x192x64_vesselboost-manual_0429.nii.gz', import.meta.url),
  sha256: '6502ec4c92e57bc98fda8d2c33f6cbd305d147a6d12b9982cf0932a2e37a3a1d',
  vesselVoxels: 33894,
};
// Measured 2026-10-03 (ONNX Runtime Web 1.21.0, WASM): Dice 1.0000, 33 894 voxels on both sides.
// The gate leaves 0.01 for floating-point differences between runtimes at the 0.1 threshold.
const MIN_DICE = 0.99;
const parameters = { model: 'manual', downsample: 1, biasCorrection: false, denoise: 'none' };

// The downsampled full example, for the viewer and editing workflow.
const exampleSha256 = '8e1e772825aafbdf898e0c06e9482640098d9722514b59566957bc3ff22cc2b2';
const exampleFilename = 'sub-000_ses-20110101_angio.nii.gz';
const exampleParameters = { model: 'manual', downsample: 4, biasCorrection: false, denoise: 'none' };

const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-vesselboost-automation');

async function runLausanneExample(page) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, exampleFilename);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== exampleSha256) {
    const response = await fetch(`https://huggingface.co/datasets/neurodeskorg/webapps/resolve/0a35af062d07f36ff2935f8c1454e1ca2f80da86/examples/vesselboost/lausanne-tof/${exampleFilename}`);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(exampleSha256);
    await writeFile(path, bytes);
  }
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), exampleParameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

function resultRow(page, name) {
  return page.locator('#stageButtons .volume-toggle').filter({ has: page.locator('.stage-label', { hasText: new RegExp(`^${name}`) }) });
}

async function downloadRow(row) {
  const waiting = row.page().waitForEvent('download');
  await row.locator('.download-btn').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('typed automation segments a Lausanne TOF crop in agreement with upstream VesselBoost', async ({ page }) => {
  test.setTimeout(600000);
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, TOF_SOURCE.name);
  let source = await readFile(sourcePath).catch(() => null);
  if (!source || createHash('sha256').update(source).digest('hex') !== TOF_SOURCE.sha256) {
    const response = await fetch(TOF_SOURCE.url);
    expect(response.ok).toBe(true);
    source = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(source).digest('hex')).toBe(TOF_SOURCE.sha256);
    await writeFile(sourcePath, source);
  }
  const crop = await cropTof(source);
  const referenceBytes = await readFile(reference.url);
  expect(createHash('sha256').update(referenceBytes).digest('hex')).toBe(reference.sha256);
  const expected = await readNifti(referenceBytes, Uint8Array);
  expect(expected.dims).toEqual(TOF_CROP.dims);
  expect(maskVoxels(expected.data)).toBe(reference.vesselVoxels);

  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: TOF_CROP.name, mimeType: 'application/x-nifti', buffer: crop });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(TOF_CROP.sha256);
  expect(snapshot.report.provenance.executionProvider).toBe('wasm');
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === 'vessels');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const output = await readFile(await (await waiting).path());
  expect(output.length).toBe(artifact.bytes);
  expect(createHash('sha256').update(output).digest('hex')).toBe(artifact.sha256);

  const vessels = await readNifti(output, Uint8Array);
  expect(vessels.dims).toEqual(TOF_CROP.dims);
  const input = await readNifti(crop);
  vessels.header.affine.forEach((row, index) => expect([...row]).toEqual([...input.header.affine[index]]));
  const score = dice(vessels.data, expected.data);
  const voxels = maskVoxels(vessels.data);
  console.log(JSON.stringify({ dice: score, appVoxels: voxels, upstreamVoxels: reference.vesselVoxels }));
  expect(score).toBeGreaterThanOrEqual(MIN_DICE);
  expect(snapshot.report.measurements.labels.find(label => label.id === 1).voxels).toBe(voxels);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));
});

test('the vessel mask can be corrected in the viewer and downloads edited', async ({ page }) => {
  test.setTimeout(600000);
  expect((await runLausanneExample(page)).state).toBe('succeeded');
  const row = resultRow(page, 'Segmentation');
  const label = row.locator('.stage-label');
  const edit = row.getByRole('button', { name: 'Edit' });
  const editor = page.locator('nd-mask-editor');
  const base = await readNifti((await downloadRow(resultRow(page, 'Downsample'))).bytes);
  const original = await downloadRow(row);

  await edit.click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toHaveText('Editing Segmentation. Left-drag paints; Apply keeps the changes.');
  await expect(edit).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Segmentation');
  await expect(edit).toBeEnabled();

  await page.locator('.view-tab[data-view="axial"]').click();
  await edit.click();
  await expect(editor).toBeVisible();
  const box = await page.locator('#gl1').boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(centre.x - 60, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 60, centre.y, { steps: 12 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Segmentation (edited)');
  await expect(page.locator('#statusText')).toHaveText('Ready');

  const edited = await downloadRow(row);
  expect(edited.name).toBe(original.name);
  const header = new DataView(edited.bytes.buffer, edited.bytes.byteOffset, edited.bytes.byteLength);
  expect(header.getInt16(70, true)).toBe(2);
  const before = await readNifti(original.bytes);
  const after = await readNifti(edited.bytes);
  expect(after.dims).toEqual(base.dims);
  expect(after.data.some((value, index) => value !== before.data[index])).toBe(true);

  await edit.click();
  await expect(editor).toBeVisible();
  await page.locator('#thresholdInput').fill('0.2');
  await expect(editor).toBeHidden();
  await expect(resultRow(page, 'Segmentation')).toHaveCount(0);
});
