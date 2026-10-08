import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { diceCoefficient } from '../scripts/lib/dice.mjs';

const require = createRequire(import.meta.url);
const { loadNifti } = require('../scripts/batch-parity-lib.cjs');

const sha256 = '97638eee6df7c75b4de8921163e708420587de28b03eefb3fb1efbcdad659506';
const filename = 'sct_T2_spinalcord.nii.gz';
const parameters = { task: 'spinalcord' };

const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-sct-automation');

// Native SCT reference for this exact input: `sct_deepseg spinalcord` run by SCT's
// batch_processing.sh on t2.nii.gz. The example is byte-identical to the nightly fixture
// batch_t2_deepseg_spinalcord/input.nii.gz, so that fixture's nightly gate applies here
// (scripts/test_fixture_parity_outputs.cjs: Dice >= 0.95, foreground within 10 %).
// Measured 2026-10-04 on ONNX Runtime Web WASM: Dice 0.9685, 23 597 voxels against 23 369.
const reference = {
  url: 'https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/55c9462a14bc9c84cf093c348cffda9148099df9/test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz',
  sha256: '9bde73cd25d7f03a8ecebb09f14414f7213d3d016438b6efb948daebdf26bdb0',
  filename: 'sct_T2_spinalcord_native_sct_seg.nii.gz',
};
const gate = { minDice: 0.95, foregroundRatioTolerance: 0.1 };

async function referencePath() {
  await mkdir(directory, { recursive: true });
  const path = join(directory, reference.filename);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
    const response = await fetch(reference.url);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(reference.sha256);
    await writeFile(path, bytes);
  }
  return path;
}

async function fixturePath() {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    const response = await fetch(`https://huggingface.co/datasets/neurodeskorg/webapps/resolve/560955bf9a1a669bbf2a89709b64f3e64eefe008/examples/spinalcordtoolbox/t2-cord/${filename}`);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    await writeFile(path, bytes);
  }
  return path;
}

async function segment(page) {
  const path = await fixturePath();
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

function readNifti(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims = Array.from({ length: 3 }, (_, axis) => view.getInt16(42 + axis * 2, true));
  const datatype = view.getInt16(70, true);
  const offset = Math.ceil(view.getFloat32(108, true));
  const count = dims.reduce((product, dim) => product * dim, 1);
  const readers = {
    2: (i) => view.getUint8(offset + i),
    4: (i) => view.getInt16(offset + i * 2, true),
    16: (i) => view.getFloat32(offset + i * 4, true),
    512: (i) => view.getUint16(offset + i * 2, true),
  };
  expect(Object.keys(readers)).toContain(String(datatype));
  let nonzero = 0;
  for (let i = 0; i < count; i++) if (readers[datatype](i) !== 0) nonzero++;
  return { dims, datatype, nonzero, voxels: bytes.subarray(offset) };
}

async function downloadRow(page, row) {
  const waiting = page.waitForEvent('download');
  await row.locator('.download-btn').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('typed automation completes the real SCT T2 workflow and its cord mask matches native SCT', async ({ page }) => {
  test.setTimeout(600000);
  const snapshot = await segment(page);
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(sha256);
  expect(snapshot.report.provenance.executionProvider).toBe('wasm');
  const [id, artifact] = Object.entries(snapshot.report.artifacts).find(([, value]) => value.role === 'segmentation');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const download = await waiting;
  const output = await readFile(await download.path());
  expect(output.length).toBe(artifact.bytes);
  expect(createHash('sha256').update(output).digest('hex')).toBe(artifact.sha256);

  // Compare the downloaded mask with native SCT, voxel for voxel.
  const outputPath = join(directory, download.suggestedFilename().endsWith('.gz') ? 'app_seg.nii.gz' : 'app_seg.nii');
  await writeFile(outputPath, output);
  const produced = loadNifti(outputPath);
  const expected = loadNifti(await referencePath());
  expect(produced.header.dims.slice(1, 4)).toEqual(expected.header.dims.slice(1, 4));
  expect(produced.header.datatypeCode).toBe(2);
  const overlap = diceCoefficient(expected.data, produced.data);
  expect(overlap.dice).toBeGreaterThanOrEqual(gate.minDice);
  expect(overlap.candidateCount).toBeGreaterThanOrEqual(overlap.referenceCount * (1 - gate.foregroundRatioTolerance));
  expect(overlap.candidateCount).toBeLessThanOrEqual(overlap.referenceCount * (1 + gate.foregroundRatioTolerance));
  const cord = snapshot.report.measurements.segmentation.labels.find(label => label.id === 1);
  expect(cord.voxels).toBe(overlap.candidateCount);
  expect(cord.volumeMl).toBeGreaterThan(0);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));

  // The run is described in the analysis log; machinery stays in the technical log.
  const logs = await page.evaluate(() => ({ analysis: app.log.getText('analysis'), technical: app.log.getText('technical') }));
  expect(logs.analysis).toMatch(/Input volume: \d+x\d+x\d+, spacing: /);
  expect(logs.analysis).toMatch(/Task: .+ on sct_T2_spinalcord\.nii\.gz/);
  expect(logs.analysis).toMatch(/Parameters: model .+, threshold [\d.]+, min component \d+ voxels, overlap [\d.]+, TTA (on|off), patch \d+x\d+x\d+/);
  expect(logs.analysis).toMatch(/segmentation: \d+ voxels \([\d.]+ mm\^3\)/);
  expect(logs.analysis).not.toMatch(/Patch \d+ pos=|InferenceSession|Inference complete in/);
  expect(logs.technical).toMatch(/Creating ONNX InferenceSession/);
  expect(logs.technical).toMatch(/Inference complete in [\d.]+s/);
  expect(logs.technical).not.toMatch(/Task: |segmentation: \d+ voxels/);
  const lines = text => text.split('\n').map(line => line.replace(/^\[[\d:]+\]/, ''));
  expect(lines(logs.analysis).filter(line => lines(logs.technical).includes(line))).toEqual([]);
  await expect(page.locator('#spinalcordtoolbox-log')).toHaveClass(/collapsed/);
});

test('a cord mask edited in the viewer downloads as the edited uint8 NIfTI', async ({ page }) => {
  test.setTimeout(600000);
  const snapshot = await segment(page);
  expect(snapshot.state).toBe('succeeded');
  const row = page.locator('#stageButtons .volume-toggle').filter({ has: page.locator('.nd-edit-btn') });
  await expect(row).toHaveCount(1);
  const label = row.locator('.stage-label');
  await expect(label).toHaveText('SCT Segmentation');
  const original = await downloadRow(page, row);
  const editor = page.locator('main.app-main > .viewer-toolbar + nd-mask-editor');
  const status = page.locator('#statusText');

  await row.locator('.nd-edit-btn').click();
  await expect(editor).toBeVisible();
  await expect(status).toHaveText('Editing SCT Segmentation. Left-drag paints; Apply keeps the changes.');
  await expect(row.locator('.nd-edit-btn')).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('SCT Segmentation');
  await expect(row.locator('.nd-edit-btn')).toBeEnabled();

  // One axial slice fills FreeBrowse's canvas, so the stroke crosses the cord.
  await page.evaluate(() => {
    window.app.nv.sliceType = 0;
    window.app.nv.drawScene();
  });
  await row.locator('.nd-edit-btn').click();
  await expect(editor).toBeVisible();
  const box = await page.locator('#gl1').boundingBox();
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(x, box.y + box.height * 0.5, { steps: 20 });
  await page.mouse.move(x, box.y + box.height * 0.65, { steps: 20 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden({ timeout: 30000 });
  await expect(label).toHaveText('SCT Segmentation (edited)');
  await expect(status).toHaveText('Ready');
  await expect(row.locator('.nd-edit-btn')).toBeEnabled();

  const edited = await downloadRow(page, row);
  const baseDims = await page.evaluate(() => Array.from(window.app.nv.volumes[0].hdr.dims.slice(1, 4)));
  const before = readNifti(original.bytes);
  const after = readNifti(edited.bytes);
  expect(edited.name).toBe(original.name.replace(/\.nii(\.gz)?$/, '_edited.nii$1'));
  expect(after.datatype).toBe(2);
  expect(after.dims).toEqual(baseDims);
  expect(before.dims).toEqual(baseDims);
  expect(Buffer.compare(Buffer.from(after.voxels), Buffer.from(before.voxels))).not.toBe(0);
  expect(after.nonzero).toBeGreaterThan(before.nonzero);
});
