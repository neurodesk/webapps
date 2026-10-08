import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';

const [example] = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));
const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-mp2rage-automation');

async function loadRole(page, role) {
  const source = example.files.find(file => file.role === role);
  const path = join(directory, source.name);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    const response = await fetch(source.url);
    expect(response.ok).toBe(true);
    bytes = Buffer.from(await response.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256);
    await writeFile(path, bytes);
  }
  await page.locator('#neurodesk-input-transfer').setInputFiles(path);
  await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
}

async function finish(page, operation, parameters, evidenceName = operation) {
  await mkdir(directory, { recursive: true });
  await page.evaluate(({ operation, parameters }) => neurodeskAutomation.dispatch('start', { operation, parameters }), { operation, parameters });
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 300000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  await writeFile(join(directory, `${evidenceName}-report.json`), JSON.stringify(snapshot.report, null, 2));
  return snapshot.report;
}

async function downloadVolume(page, report, role) {
  const [id, artifact] = Object.entries(report.artifacts).find(([, artifact]) => artifact.role === role);
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const bytes = await readFile(await (await waiting).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  const volume = await readNifti(bytes);
  expect(volume.dims).toEqual([218, 220, 143]);
  expect(volume.data.every(Number.isFinite)).toBe(true);
  return volume;
}

test('real MP2RAGE example completes correction and denoising through explicit roles', async ({ page }) => {
  test.setTimeout(600000);
  await mkdir(directory, { recursive: true });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  for (const role of ['uni', 'inv2', 'b1']) await loadRole(page, role);
  const report = await finish(page, 'correct', {
    mp2rage: ['tr', 'ti1', 'ti2', 'fa1', 'fa2', 'nz1', 'nz2', 'trflash', 'inveff'].map(key => example.parameters.mp[key]),
    b1Type: 'relative',
  });
  await downloadVolume(page, report, 't1');
  expect(report.measurements.t1.nonzeroVoxels).toBeGreaterThan(1000000);
  expect(report.measurements.t1.median).toBeGreaterThan(800);
  expect(report.measurements.t1.median).toBeLessThan(2500);
  for (const role of ['uni', 'inv1', 'inv2']) await loadRole(page, role);
  const denoised = await finish(page, 'denoise', { regularization: 6 });
  const volume = await downloadVolume(page, denoised, 'unic');
  expect(volume.data.some(value => value > 0)).toBe(true);
});

test('SA2RAGE automation matches the pinned Python phantom golden', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  for (const [role, name] of [['uni', 'UNI'], ['inv2', 'INV2'], ['sa2rage', 'SA2RAGE']]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(new URL(`../tools/phantom/phantom_${name}.nii.gz`, import.meta.url).pathname);
    await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  const report = await finish(page, 'correct', {
    mp2rage: [4.3, 0.840, 2.370, 5, 6, 64, 128, 0.007, 0.96],
    sa2rage: [2.4, 0.150, 1.500, 6, 6, 24, 24, 0.005, 1.5],
  }, 'sa2rage');
  const [id] = Object.entries(report.artifacts).find(([, artifact]) => artifact.role === 't1');
  const waiting = page.waitForEvent('download');
  await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
  const result = await readNifti(await readFile(await (await waiting).path()));
  const golden = await readFile(new URL('../tools/golden/v_corr_T1_ms.npy', import.meta.url));
  const offset = 10 + golden.readUInt16LE(8);
  const [nx, ny, nz] = result.dims;
  let worst = 0;
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    worst = Math.max(worst, Math.abs(result.data[x + nx * (y + ny * z)] - golden.readDoubleLE(offset + 8 * (x * ny * nz + y * nz + z))));
  }
  expect(worst).toBeLessThan(0.1);
});

test('non-default B1-map options match the Python pipeline and are recorded in parameters.json', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  for (const [role, name] of [['uni', 'UNI'], ['inv2', 'INV2'], ['b1', 'B1map_tfl']]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(new URL(`../tools/phantom/phantom_${name}.nii.gz`, import.meta.url).pathname);
    await page.evaluate(role => neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  const report = await finish(page, 'correct', {
    mp2rage: [4.3, 0.840, 2.370, 5, 6, 64, 128, 0.007, 0.96],
    b1Type: 'tfl',
    referenceAngle: 40,
    extendFov: false,
    fallbackUncorrected: true,
  }, 'tfl-reference-40-fallback');
  const download = async (role) => {
    const [id] = Object.entries(report.artifacts).find(([, artifact]) => artifact.role === role);
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    return readFile(await (await waiting).path());
  };
  const result = await readNifti(await download('t1'));
  const golden = await readNifti(await readFile(new URL('../tools/golden/cli/tfl-reference-40-fallback/T1map.nii.gz', import.meta.url)));
  expect(result.dims).toEqual(golden.dims);
  let worst = 0;
  for (let i = 0; i < golden.data.length; i++) worst = Math.max(worst, Math.abs(result.data[i] - golden.data[i]));
  expect(worst).toBeLessThan(0.1);
  const parameters = JSON.parse((await download('parameters')).toString('utf8'));
  expect(parameters).toMatchObject({
    mode: 'b1map',
    b1_map_type: 'tfl',
    b1_reference_angle_deg: 40,
    extend_fov: false,
    fallback_uncorrected: true,
    mask_source: 'INV2',
  });
});
