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

test('typed automation segments a Lausanne TOF crop in agreement with upstream VesselBoost', async ({ page }) => {
  test.setTimeout(600000);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-vesselboost-automation');
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
