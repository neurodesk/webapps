import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { gpuBrowser, hardwareGpu } from '../../../test-utils/hardware-gpu.mjs';

test.use(gpuBrowser);

function diffusion() {
  const directions = [[0,0,0],[1,0,0],[0,1,0],[0,0,1],[Math.SQRT1_2,Math.SQRT1_2,0],[Math.SQRT1_2,0,Math.SQRT1_2],[0,Math.SQRT1_2,Math.SQRT1_2]];
  const buffer = Buffer.alloc(352 + 8 ** 3 * directions.length * 4);
  buffer.writeInt32LE(348, 0);
  [4,8,8,8,directions.length,1,1,1].forEach((value, index) => buffer.writeInt16LE(value, 40 + index * 2));
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  for (let axis = 0; axis < 8; axis++) buffer.writeFloatLE(1, 76 + axis * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.writeInt16LE(1, 254);
  [280,300,320].forEach((offset) => buffer.writeFloatLE(1, offset));
  buffer.write('n+1\0', 344);
  directions.forEach(([x,y,z], direction) => {
    const value = 1000 * Math.exp(-1000 * (.0015*x*x + .0005*y*y + .0005*z*z));
    for (let voxel = 0; voxel < 8 ** 3; voxel++) buffer.writeFloatLE(value, 352 + (direction * 8 ** 3 + voxel) * 4);
  });
  return {
    image: { name: 'image.nii', buffer },
    bval: { name: 'values.bval', buffer: Buffer.from('0 1000 1000 1000 1000 1000 1000') },
    bvec: { name: 'directions.bvec', buffer: Buffer.from([0,1,2].map((axis) => directions.map((direction) => direction[axis]).join(' ')).join('\n')) },
  };
}

test('explicit roles fit a known tensor through the real CPU worker and download measured FA', async ({ page }) => {
  test.setTimeout(180_000);
  // Exercise the documented unmasked fallback without running a full neural model on SwiftShader.
  await page.route('**/brainchop/**', (route) => route.fulfill({ status: 503, body: 'Model unavailable for fallback check' }));
  await page.goto('/');
  for (const [role, file] of Object.entries(diffusion())) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ ...file, mimeType: 'application/octet-stream' });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'fit' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 120_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  const { report } = snapshot;
  expect(report.provenance.tensor.masked).toBe(false);
  expect(report.provenance.tensor.maskFailure).toBeTruthy();
  expect(report.inputs.bvec[0].filename).toBe('directions.bvec');
  const [artifactId, artifact] = Object.entries(report.artifacts).find(([, artifact]) => artifact.role === 'fa');
  const downloading = page.waitForEvent('download');
  await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
  const bytes = await readFile(await (await downloading).path());
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  const fa = gunzipSync(bytes);
  expect(fa.readInt16LE(70)).toBe(16);
  expect(fa.readFloatLE(fa.readFloatLE(108) + 256 * 4)).toBeCloseTo(Math.sqrt(1 / 2.75), 3);
});

test('hardware tractography returns tensor maps and a hashed TRX for the reference DWI', async ({ page }) => {
  test.skip(!hardwareGpu || !process.env.DWI2TRX_FIXTURE_DIR, 'Requires hardware WebGPU with subgroups and DWI2TRX_FIXTURE_DIR.');
  test.setTimeout(600_000);
  await page.goto('/');
  for (const [role, extension] of [['image','nii.gz'],['bval','bval'],['bvec','bvec']]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(`${process.env.DWI2TRX_FIXTURE_DIR}/dwi.${extension}`);
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'tractography' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 540_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(snapshot.report.measurements.streamlines).toBeGreaterThan(0);
  expect(Object.values(snapshot.report.artifacts).map(({ role }) => role).sort()).toEqual(['fa','tracts','v1']);
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
  }
});
