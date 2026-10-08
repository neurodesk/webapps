import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { readVolume } from '../../../packages/synthsr/src/index.js';
import { sameGeometry } from '../../../packages/syncro/src/pipeline.js';

const inferenceTimeout = Number(process.env.SYNCRO_AUTOMATION_TIMEOUT_MS || 1_800_000);
// Measured on the pinned sub-101 T1 with WASM SynthSR, SynthStrip and Greedy (issue #211):
// brain Dice 0.974, correlations 0.944 (normalized) and 0.950 (synthetic), from 0.554 unregistered.
const PINNED_FLOOR = { overlap: 0.95, correlation: 0.9, gain: 0.2 };
const image = gunzipSync(await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url)));
const shifted = Buffer.from(image);
shifted.fill(0, 352);
shifted[352] = 1;
shifted.writeInt16LE(2, 70);
shifted.writeInt16LE(8, 72);
shifted.writeInt16LE(1, 254);
shifted.writeFloatLE(1000, 292);

test.beforeEach(async ({ page }) => {
  await page.route('**/MNI152_T1_1mm_brain.nii.gz', async (route) => route.fulfill({
    body: await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url)),
  }));
  for (const [filename, path] of [
    ['synthsr-v2.onnx', process.env.SYNTHSR_MODEL],
    ['synthstrip-browser.onnx', process.env.SYNTHSTRIP_MODEL],
  ]) {
    if (path) await page.route(`**/${filename}`, (route) => route.fulfill({ path }));
  }
});

test('automation rejects an explicitly paired lesion on the wrong grid before inference', async ({ page }) => {
  test.setTimeout(90_000);
  const models = [];
  page.on('request', (request) => { if (request.url().includes('.onnx')) models.push(request.url()); });
  await page.goto('./');
  for (const [role, buffer] of [['primary', image], ['lesion', shifted]]) {
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: `${role}.nii`, mimeType: 'application/nifti', buffer });
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('must match');
  expect(result.report).toBeUndefined();
  expect(models).toEqual([]);
  await expect(page.locator('#input')).toBeEnabled();
});

// The fixture ships with the repository and runs entirely on the CPU, so every browser job runs it.
test('cropped brain fails normalization without exporting nearly empty images', async ({ page }) => {
  test.setTimeout(inferenceTimeout);
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'cropped-head.nii', mimeType: 'application/nifti', buffer: image });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: inferenceTimeout - 60_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state).toBe('failed');
  expect(snapshot.error.message).toContain('registered brain covers too little');
  expect(snapshot.report).toBeUndefined();
  await expect(page.locator('#download')).toBeDisabled();
});

test('the pinned T1 example normalizes onto the MNI152 template with WASM SynthSR', async ({ page }) => {
  test.skip(!process.env.SYNCRO_AUTOMATION_IMAGE, 'Set SYNCRO_AUTOMATION_IMAGE to a suitable anatomical scan for full inference.');
  test.setTimeout(inferenceTimeout);
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles(process.env.SYNCRO_AUTOMATION_IMAGE);
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: inferenceTimeout - 60_000 }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(Object.values(snapshot.report.artifacts).map(({ role }) => role).sort()).toEqual(['details','native-synthetic','normalized-brain','normalized-primary','synthetic-brain']);
  const volumes = new Map();
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (['synthetic-brain', 'normalized-primary', 'normalized-brain'].includes(artifact.role)) {
      const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      expect(volume.dims).toEqual([182, 218, 182]);
      volumes.set(artifact.role, volume);
    }
  }
  const templateBytes = await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url));
  const template = readVolume(templateBytes.buffer.slice(templateBytes.byteOffset, templateBytes.byteOffset + templateBytes.byteLength));
  const synthetic = volumes.get('synthetic-brain');
  const primary = volumes.get('normalized-primary');
  const brain = volumes.get('normalized-brain');
  for (const volume of volumes.values()) expect(sameGeometry(volume, template)).toBe(true);
  let maskMismatches = 0;
  let templateSupport = 0;
  let overlap = 0;
  let primaryTissue = 0;
  let tissueMin = Infinity;
  let tissueMax = -Infinity;
  const background = primary.data.reduce((minimum, value) => Math.min(minimum, value), Infinity);
  for (let index = 0; index < template.data.length; index += 1) {
    if (brain.data[index] !== (synthetic.data[index] !== 0 ? primary.data[index] : 0)) maskMismatches += 1;
    if (template.data[index] <= 0) continue;
    templateSupport += 1;
    if (synthetic.data[index] <= 0) continue;
    overlap += 1;
    const value = primary.data[index];
    if (value === background) continue;
    primaryTissue += 1;
    tissueMin = Math.min(tissueMin, value);
    tissueMax = Math.max(tissueMax, value);
  }
  expect(maskMismatches, 'brain extraction preserves primary intensities and clears background').toBe(0);
  expect(overlap / templateSupport, 'positive synthetic brain overlaps the template').toBeGreaterThanOrEqual(0.01);
  expect(primaryTissue / templateSupport, 'primary tissue survives inside the brain, excluding minimum-intensity background').toBeGreaterThanOrEqual(0.01);
  expect(tissueMax, 'brain contains varying primary tissue intensities').toBeGreaterThan(tissueMin);

  // Independent of anything SYNcro reports: the FSL template is the reference. The pinned
  // example is a stroke patient, so its brain cannot match the template as closely as the
  // displaced healthy head below.
  const reference = await readNifti(templateBytes);
  const original = await readNifti(await readFile(process.env.SYNCRO_AUTOMATION_IMAGE));
  const unregistered = correlation(onGrid(original, reference), reference.data);
  const registeredBrain = correlation(brain.data, reference.data);
  const syntheticBrain = correlation(synthetic.data, reference.data);
  const brainDice = dice(synthetic.data, reference.data);
  console.log(`pinned example template correlation: unregistered ${unregistered.toFixed(3)}, normalized brain ${registeredBrain.toFixed(3)}, synthetic brain ${syntheticBrain.toFixed(3)}; brain Dice ${brainDice.toFixed(3)}`);
  expect(brainDice).toBeGreaterThan(PINNED_FLOOR.overlap);
  expect(syntheticBrain).toBeGreaterThan(PINNED_FLOOR.correlation);
  expect(registeredBrain).toBeGreaterThan(PINNED_FLOOR.correlation);
  expect(registeredBrain).toBeGreaterThan(unregistered + PINNED_FLOOR.gain);
});

// The real pipeline on the CPU: SynthSR and SynthStrip on ONNX Runtime WebAssembly, Greedy on
// WebAssembly threads. No GPU is involved, so this runs on a CI machine as it runs on a laptop.
// The default input is the pinned 2 mm T1 head from the SynthStrip fixtures, moved out of MNI space
// by rewriting its header: a head lying 10 and 8 degrees off axis and 12, 9 and 7 mm off centre, as
// a scanner would deliver it.
function displaced(bytes) {
  const nifti = Buffer.from(gunzipSync(bytes));
  const [cz, sz, cx, sx] = [Math.cos(Math.PI / 18), Math.sin(Math.PI / 18), Math.cos(Math.PI / 22.5), Math.sin(Math.PI / 22.5)];
  const motion = [
    [cz, -sz, 0, 12],
    [cx * sz, cx * cz, -sx, -9],
    [sx * sz, sx * cz, cx, 7],
  ];
  const affine = [0, 1, 2].map((row) => [0, 1, 2, 3].map((column) => nifti.readFloatLE(280 + 16 * row + 4 * column)));
  motion.forEach((row, index) => {
    for (let column = 0; column < 4; column++) {
      const value = row[0] * affine[0][column] + row[1] * affine[1][column] + row[2] * affine[2][column] + (column === 3 ? row[3] : 0);
      nifti.writeFloatLE(value, 280 + 16 * index + 4 * column);
    }
  });
  nifti.writeInt16LE(0, 252);
  nifti.writeInt16LE(1, 254);
  return nifti;
}
const world = (affine, [i, j, k]) => affine.slice(0, 3).map((row) => row[0] * i + row[1] * j + row[2] * k + row[3]);
function inverse(affine) {
  const [[a, b, c, tx], [d, e, f, ty], [g, h, i, tz]] = affine.map((row) => Array.from(row));
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const rotation = [
    [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
    [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
    [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
  ];
  return rotation.map((row) => [...row, -(row[0] * tx + row[1] * ty + row[2] * tz)]);
}
// Nearest-neighbour copy of a volume onto another grid through the two headers alone: what the
// scan looks like on the template grid when nothing has been registered.
function onGrid(volume, grid) {
  const toVoxel = inverse(volume.header.affine);
  const [nx, ny, nz] = grid.dims;
  const [mx, my, mz] = volume.dims;
  const result = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const [x, y, z] = world(toVoxel, world(grid.header.affine, [i, j, k])).map(Math.round);
        if (x >= 0 && y >= 0 && z >= 0 && x < mx && y < my && z < mz) result[i + nx * (j + ny * k)] = volume.data[x + mx * (y + my * z)];
      }
    }
  }
  return result;
}
function correlation(a, b) {
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  for (let index = 0; index < a.length; index++) {
    sumA += a[index];
    sumB += b[index];
    sumAA += a[index] * a[index];
    sumBB += b[index] * b[index];
    sumAB += a[index] * b[index];
  }
  const n = a.length;
  return (n * sumAB - sumA * sumB) / Math.sqrt((n * sumAA - sumA * sumA) * (n * sumBB - sumB * sumB));
}
function dice(a, b) {
  let both = 0;
  let either = 0;
  for (let index = 0; index < a.length; index++) {
    both += a[index] > 0 && b[index] > 0;
    either += (a[index] > 0) + (b[index] > 0);
  }
  return 2 * both / either;
}

test('a displaced 2 mm T1 normalizes onto the MNI152 template on the CPU', async ({ page }) => {
  test.setTimeout(1_800_000);
  const input = { name: 'displaced-T1.nii', buffer: displaced(await readFile(new URL('../../calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url))) };
  const template = await readNifti(await readFile(new URL('../../../packages/syncro/data/MNI152_T1_1mm_brain.nii.gz', import.meta.url)));
  await page.goto('./');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ ...input, mimeType: 'application/octet-stream' });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'primary' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'normalize', parameters: { synthsrBackend: 'wasm', brainExtractor: 'synthstrip', keepSynth: true } }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 1_700_000, intervals: [2000] }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(Object.values(snapshot.report.artifacts).map(({ role }) => role).sort()).toEqual(['details','native-synthetic','normalized-brain','normalized-primary','synthetic-brain']);
  const volumes = {};
  let details;
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const bytes = await readFile(await (await downloading).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (artifact.role === 'details') details = JSON.parse(bytes.toString('utf8'));
    else volumes[artifact.role] = await readNifti(bytes);
  }
  expect(details.inputHash).toBe(createHash('sha256').update(input.buffer).digest('hex'));
  expect(details.stages.synthsr).toMatchObject({ backend: 'wasm', onnxRuntime: '1.29.0' });
  expect(details.stages.registration.engine).toBe('Greedy');

  // Every normalized image sits exactly on the MNI152 1 mm grid of the FSL template.
  for (const role of ['normalized-primary', 'normalized-brain', 'synthetic-brain']) {
    expect(volumes[role].dims, role).toEqual([182, 218, 182]);
    const affineError = Math.max(...volumes[role].header.affine.flatMap((row, i) => Array.from(row, (value, j) => Math.abs(value - template.header.affine[i][j]))));
    expect(affineError, `${role} affine`).toBeLessThanOrEqual(1e-4);
  }

  // The reference is the template, not anything SYNcro computed. Registration has to put the
  // brain where the template's brain is, and make it look like it.
  const original = await readNifti(input.buffer);
  const unregistered = correlation(onGrid(original, template), template.data);
  const registeredBrain = correlation(volumes['normalized-brain'].data, template.data);
  const syntheticBrain = correlation(volumes['synthetic-brain'].data, template.data);
  const overlap = dice(volumes['synthetic-brain'].data, template.data);
  console.log(`template correlation: unregistered ${unregistered.toFixed(3)}, normalized brain ${registeredBrain.toFixed(3)}, synthetic brain ${syntheticBrain.toFixed(3)}; brain Dice ${overlap.toFixed(3)}`);
  // Measured on the displaced fixture: Dice 0.979, correlations 0.975 and 0.983, from 0.728
  // unregistered. An identity registration leaves the normalized brain at 0.86.
  const floor = { overlap: 0.95, correlation: 0.95, gain: 0.2 };
  expect(overlap).toBeGreaterThan(floor.overlap);
  expect(syntheticBrain).toBeGreaterThan(floor.correlation);
  expect(registeredBrain).toBeGreaterThan(floor.correlation);
  expect(registeredBrain).toBeGreaterThan(unregistered + floor.gain);
});
