import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';
import { inspectMz3, inspectStl, voxelVolume } from './mesh-geometry.js';

// The web pipeline's files on this template with the CPU backend, which the brain2print command line's
// release check is also held to (packages/brain2print/validation/browser-reference.json).
const reference = JSON.parse(await readFile(new URL('../../../packages/brain2print/validation/browser-reference.json', import.meta.url), 'utf8')).cases['mni152-pve'];
const ROLE_FILES = { segmentation: 'brain-fraction.nii', mesh: 'brain2print.stl', geometry: 'brain2print.mz3' };

const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });
const small = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
// The MNI152 2 mm template: a whole brain, so the mesh volume can be held to an anatomical range.
const brain = await readFile(new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url));

async function start(page, buffer, parameters = {}) {
  await page.goto('/');
  await expect(page.locator('#imageInput')).toBeEnabled();
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'brain.nii.gz', mimeType: 'application/gzip', buffer });
  await dispatch(page, 'adopt', { role: 'image' });
  await dispatch(page, 'start', { operation: 'create-mesh', parameters });
}

async function finished(page) {
  await expect.poll(async () => {
    const snapshot = await dispatch(page, 'snapshot');
    if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
    return snapshot.state;
  }, { timeout: 840_000, intervals: [1000, 2000, 5000] }).toBe('succeeded');
  const { report } = await dispatch(page, 'snapshot');
  const files = {};
  for (const [artifactId, artifact] of Object.entries(report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await dispatch(page, 'download', { artifactId });
    files[artifact.role] = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(files[artifact.role]).digest('hex')).toBe(artifact.sha256);
  }
  return { report, files };
}

// Everything here is measured from the downloaded files, not read from the app's report.
function expectPrintableBrain(files, input) {
  expect(Object.keys(files).sort()).toEqual(['geometry', 'mesh', 'segmentation']);
  const source = voxelVolume(input, Infinity);
  const fraction = voxelVolume(files.segmentation, 0.5);
  expect(fraction.dims).toEqual(source.dims);
  for (const [row, values] of fraction.affine.entries()) {
    for (const [column, value] of values.entries()) expect(value).toBeCloseTo(source.affine[row][column], 3);
  }
  expect(fraction.minimum).toBeGreaterThanOrEqual(0);
  expect(fraction.maximum).toBeLessThanOrEqual(1.001);
  // GM + WM of an adult brain. The MNI152 average is larger than most single subjects.
  expect(fraction.volume).toBeGreaterThan(1_000_000);
  expect(fraction.volume).toBeLessThan(1_800_000);

  const stl = inspectStl(files.mesh);
  expect(stl.triangles).toBeGreaterThan(1000);
  expect(stl.openEdges).toBe(0);
  expect(stl.misorientedEdges).toBe(0);
  expect(stl.contradicting).toBe(0);
  // The 0.5 isosurface of the brain fraction encloses the voxels at or above 0.5.
  expect(stl.volume).toBeGreaterThan(fraction.volume * 0.95);
  expect(stl.volume).toBeLessThan(fraction.volume * 1.05);

  const mz3 = inspectMz3(files.geometry);
  expect(mz3.triangles).toBe(stl.triangles);
  expect(mz3.vertices).toBe(stl.vertices);
  expect(mz3.openEdges).toBe(0);
  expect(mz3.misorientedEdges).toBe(0);
  expect(mz3.volume).toBeCloseTo(stl.volume, 0);
  return { stl, fraction };
}

test('automation can cancel the real segmentation worker while its runtime is loading', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/brainchop/**', () => {});
  const runtime = page.waitForRequest(/brainchop\//);
  await start(page, small);
  await runtime;
  await dispatch(page, 'cancel');
  await expect.poll(async () => (await dispatch(page, 'snapshot')).state).toBe('cancelled');
  await expect(page.locator('#imageInput')).toBeEnabled();
  expect((await dispatch(page, 'snapshot')).report).toBeUndefined();
});

test('CPU inference returns a watertight STL enclosing the segmented brain volume, and a matching MZ3', async ({ page }) => {
  test.setTimeout(900_000);
  await start(page, brain, { backend: 'cpu' });
  const { report, files } = await finished(page);
  expect(report.provenance.segmentation.backend).toBe('cpu');
  const { stl, fraction } = expectPrintableBrain(files, brain);
  expect(reference.settings).toEqual({ model: 'pve', backend: 'cpu', simplify: 20, smooth: 0, largestOnly: true, fillBubbles: true });
  for (const [role, name] of Object.entries(ROLE_FILES)) {
    expect(createHash('sha256').update(files[role]).digest('hex'), `${name} as pinned in browser-reference.json`).toBe(reference.sha256[name]);
  }
  console.log(`cpu: ${stl.triangles} triangles, mesh ${stl.volume.toFixed(0)} mm^3, voxels ${fraction.volume.toFixed(0)} mm^3`);
});

// The hardware variant: scripts/desktop/verify-scientific-macos.sh selects it by title and
// launches Chromium on Metal. The software adapter has no shader-f16, so it cannot run there.
test('hardware inference returns corrected STL, matching MZ3 and the segmented image', async ({ page }) => {
  test.skip(!hardwareGpu, 'Hardware variant: needs a WebGPU adapter with shader-f16 (NEURODESK_HARDWARE_GPU=1 on macOS).');
  await page.goto('/');
  test.setTimeout(600_000);
  await start(page, brain);
  const { report, files } = await finished(page);
  expect(report.provenance.segmentation.backend).toBe('webgpu');
  expectPrintableBrain(files, brain);
});
