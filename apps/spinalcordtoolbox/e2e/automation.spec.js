import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { diceCoefficient } from '../scripts/lib/dice.mjs';

const require = createRequire(import.meta.url);
const { loadNifti } = require('../scripts/batch-parity-lib.cjs');
const { CRITICAL_BROWSER_OUTPUTS } = require('../scripts/batch-parity-fixtures.cjs');

const sha256 = '97638eee6df7c75b4de8921163e708420587de28b03eefb3fb1efbcdad659506';
const filename = 'sct_T2_spinalcord.nii.gz';
const parameters = { task: 'spinalcord' };

// Native SCT reference for this exact input: `sct_deepseg spinalcord` run by
// SCT's batch_processing.sh on t2.nii.gz. The example input above is
// byte-identical to the nightly fixture batch_t2_deepseg_spinalcord/input.nii.gz
// (same sha256), so the nightly gate for that fixture applies here unchanged.
const reference = {
  url: 'https://huggingface.co/datasets/sbollmann/sct-webapp-data/resolve/55c9462a14bc9c84cf093c348cffda9148099df9/test_data/batch_t2_deepseg_spinalcord/batch_output.nii.gz',
  sha256: '9bde73cd25d7f03a8ecebb09f14414f7213d3d016438b6efb948daebdf26bdb0',
  filename: 'sct_T2_spinalcord_native_sct_seg.nii.gz'
};
const gate = CRITICAL_BROWSER_OUTPUTS.find(check => check.id === 'batch_t2_deepseg_spinalcord');

async function pinnedDownload(directory, name, url, expectedSha256) {
  const path = join(directory, name);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expectedSha256);
    await writeFile(path, bytes);
  }
  return path;
}

test('typed automation completes the real SCT T2 workflow and its cord mask matches native SCT', async ({ page }) => {
  test.setTimeout(600000);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-sct-automation');
  await mkdir(directory, { recursive: true });
  const path = await pinnedDownload(
    directory,
    filename,
    `https://huggingface.co/datasets/neurodeskorg/webapps/resolve/560955bf9a1a669bbf2a89709b64f3e64eefe008/examples/spinalcordtoolbox/t2-cord/${filename}`,
    sha256
  );
  const referencePath = await pinnedDownload(directory, reference.filename, reference.url, reference.sha256);
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), parameters);
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
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
  const outputName = download.suggestedFilename().endsWith('.gz') ? 'app_seg.nii.gz' : 'app_seg.nii';
  const outputPath = join(directory, outputName);
  await writeFile(outputPath, output);
  const produced = loadNifti(outputPath);
  const expected = loadNifti(referencePath);
  expect(produced.header.dims.slice(1, 4)).toEqual(expected.header.dims.slice(1, 4));
  expect(produced.header.datatypeCode).toBe(2);
  const overlap = diceCoefficient(expected.data, produced.data);
  console.log(`SCT T2 cord mask: Dice ${overlap.dice.toFixed(4)} against native SCT (gate ${gate.minDice}); voxels app=${overlap.candidateCount} sct=${overlap.referenceCount}`);
  expect(gate.minDice).toBe(0.95);
  expect(overlap.dice).toBeGreaterThanOrEqual(gate.minDice);
  expect(overlap.candidateCount).toBeGreaterThanOrEqual(overlap.referenceCount * (1 - gate.foregroundRatioTolerance));
  expect(overlap.candidateCount).toBeLessThanOrEqual(overlap.referenceCount * (1 + gate.foregroundRatioTolerance));

  // The report's own label count describes the same mask.
  const cord = snapshot.report.measurements.segmentation.labels.find(label => label.id === 1);
  expect(cord.voxels).toBe(overlap.candidateCount);
  expect(cord.volumeMl).toBeGreaterThan(0);
  await writeFile(join(directory, 'report.json'), JSON.stringify(snapshot.report, null, 2));
});
