import { expect, test } from './fixtures.js';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNiftiFromVolume, readNifti } from '../../../packages/components/src/file-io/NiftiUtils.js';
import { dice, maskVoxels } from '../../../test-utils/dice.mjs';
import { markerComponents, matchComponentsToSeeds } from '../test/marker-components.mjs';
import { compareDetections } from '../../../packages/seedseg/validation/detection-parity.mjs';
import { compareV2Outputs } from '../../../packages/seedseg/validation/v2-parity.mjs';
import { assertHardwareAdapter, hardwareGpu, readAdapterInfo } from '../../../test-utils/hardware-gpu.mjs';
import { createProstateFixture, createProstateSeedMask, PROSTATE_FIXTURE_DIMS, PROSTATE_FIXTURE_SEEDS } from '../test/prostate-fixture.mjs';

const image = createProstateFixture();

// Ground truth is the fixture's own geometry (three planted cylinders), not an earlier app output.
// Measured 2026-10-03 (ONNX Runtime Web 1.21.0, WASM): three components of 280, 233 and 280 voxels,
// centroids 0.14, 0.18 and 0.20 voxels from the planted coordinates, every planted voxel marked.
// Dice against the 117 planted voxels is only 0.26 because the models outline a wider artefact than
// the planted void, so localisation, count and coverage are asserted and Dice is logged, not gated.
const MAX_CENTROID_DISTANCE_VOXELS = 1;
const MIN_PLANTED_RECALL = 0.9;
const MAX_MARKER_VOXELS_PER_PLANTED_VOXEL = 10;

async function runEnsemble(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), undefined, { timeout: 30000 });
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters: { pipeline: 'legacy-v1', backend: 'wasm' } }));
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  return page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
}

// GitHub's macOS runners give Chromium a virtualised Metal GPU. The nnU-Net v2 networks outlast its
// command-buffer watchdog: WebGPU loses the device, and at times the whole GPU process, which then
// leaves the shared browser without WebGPU or WebGL2 for every later test. There, v2 runs on
// WebAssembly and its WebGPU parity waits for a real Mac (NEURODESK_HARDWARE_GPU=1 outside Actions).
const virtualGpu = hardwareGpu && process.env.GITHUB_ACTIONS === 'true';

// A start consumes the adopted inputs, so each run adopts the image again.
async function adoptImage(page) {
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
}

async function downloadRow(page, row) {
  const waiting = page.waitForEvent('download');
  await row.locator('.download-btn').click();
  const download = await waiting;
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

test('NIfTI inputs remain usable when the optional DICOM report host is unavailable', async ({ page }) => {
  await page.route('https://webapps.neurodesk.org/dicompare/**', route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), undefined, { timeout: 15000 });
  await page.locator('#unifiedFiles').setInputFiles({ name: 'synthetic-prostate-T1w.nii', mimeType: 'application/x-nifti', buffer: image });
  await expect(page.locator('#runSegmentation')).toBeEnabled();
});

test('DICOM conversion completes while the optional report host stalls', async ({ page }) => {
  test.setTimeout(60000);
  const held = [];
  await page.route('https://webapps.neurodesk.org/dicompare/**', route => { held.push(route); });
  try {
    await page.goto('/');
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    await page.locator('#unifiedFiles').setInputFiles(dicomSeries());
    await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('#dicompareReportBtn')).toBeEnabled();
  } finally {
    await Promise.all(held.map(route => route.abort().catch(() => {})));
  }
});

test('DICOM reports load local assets and show a recoverable error when Python is unavailable', async ({ page }) => {
  test.setTimeout(60000);
  const remoteRequests = [];
  const localResponses = new Map();
  await page.context().route('https://webapps.neurodesk.org/dicompare/**', route => {
    remoteRequests.push(route.request().url());
    return route.abort();
  });
  await page.context().route('https://cdn.jsdelivr.net/pyodide/**', route => route.abort());
  page.on('response', response => {
    if (response.url().includes('/vendor/dicompare/')) localResponses.set(new URL(response.url()).pathname.split('/').at(-1), response.status());
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation), undefined, { timeout: 15000 });
  await page.locator('#unifiedFiles').setInputFiles(dicomSeries());
  await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 30000 });
  await page.locator('#dicompareReportBtn').click();
  await expect(page.locator('#dicompareModalBody')).toContainText('Validation failed', { timeout: 15000 });
  expect(localResponses.get('DicompareController.js')).toBe(200);
  expect(localResponses.get('dicompare-worker.js')).toBe(200);
  expect(remoteRequests).toEqual([]);
  const schema = await page.request.get('/vendor/dicompare/SeedSeg_Prostate_T1w_v1.0.json');
  expect(schema.status()).toBe(200);
  expect((await schema.json()).name).toBe('SeedSeg Prostate T1-Weighted Protocol');
});

test('real legacy SeedSeg ensemble finds the three planted fiducials of the synthetic prostate fixture', async ({ page }) => {
  test.setTimeout(600000);
  const snapshot = await runEnsemble(page);
  expect(snapshot.error).toBeUndefined();
  expect(snapshot.state).toBe('succeeded');
  expect(snapshot.report.inputs.image[0].sha256).toBe(createHash('sha256').update(image).digest('hex'));
  expect(snapshot.report.provenance.models).toHaveLength(4);
  expect(Object.values(snapshot.report.artifacts).filter(artifact => artifact.role === 'probability')).toHaveLength(5);
  let markerMasks = 0;
  for (const [id, artifact] of Object.entries(snapshot.report.artifacts)) {
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    const volume = await readNifti(bytes);
    expect(volume.dims).toEqual(PROSTATE_FIXTURE_DIMS);
    expect(volume.data.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    if (artifact.role !== 'markers') continue;
    expect(volume.data.every(value => value === 0 || value === 1)).toBe(true);
    const components = markerComponents(volume.data, PROSTATE_FIXTURE_DIMS);
    const planted = createProstateSeedMask();
    const seedDice = dice(volume.data, planted);
    const plantedVoxels = maskVoxels(planted);
    const plantedRecall = planted.reduce((sum, value, index) => sum + (value && volume.data[index] ? 1 : 0), 0) / plantedVoxels;
    console.log(JSON.stringify({ seedDice, plantedRecall, plantedVoxels, components }));
    expect(components).toHaveLength(PROSTATE_FIXTURE_SEEDS.length);
    for (const match of matchComponentsToSeeds(components, PROSTATE_FIXTURE_SEEDS)) {
      expect(match.distance, `marker for planted seed ${match.seed.join(',')}`).toBeLessThanOrEqual(MAX_CENTROID_DISTANCE_VOXELS);
    }
    expect(plantedRecall).toBeGreaterThanOrEqual(MIN_PLANTED_RECALL);
    expect(maskVoxels(volume.data)).toBeLessThanOrEqual(MAX_MARKER_VOXELS_PER_PLANTED_VOXEL * plantedVoxels);
    markerMasks++;
  }
  expect(markerMasks).toBe(1);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-seedseg-automation');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'report.json'), JSON.stringify({ validation: 'Synthetic fixture with three planted fiducials; marker localisation is checked against the planted coordinates. No clinical accuracy claim.', report: snapshot.report }, null, 2));
});

test('the consensus mask can be corrected in the viewer and downloads edited', async ({ page }) => {
  test.setTimeout(600000);
  expect((await runEnsemble(page)).state).toBe('succeeded');
  const row = page.locator('#stage-item-consensus');
  const label = row.locator('.stage-btn');
  const edit = row.getByRole('button', { name: 'Edit', exact: true });
  const editor = page.locator('nd-mask-editor');
  const original = await downloadRow(page, row);

  await edit.click();
  await expect(editor).toBeVisible();
  await expect(page.locator('#statusText')).toHaveText('Editing Consensus. Left-drag paints; Apply keeps the changes.');
  await expect(edit).toBeDisabled();
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await expect(label).toHaveText('Consensus');
  await expect(edit).toBeEnabled();
  expect((await downloadRow(page, row)).bytes.equals(original.bytes)).toBe(true);

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
  await expect(label).toHaveText('Consensus (edited)');
  await expect(page.locator('#statusText')).toHaveText('Ready');

  const edited = await downloadRow(page, row);
  expect(edited.name).toBe(original.name);
  const header = new DataView(edited.bytes.buffer, edited.bytes.byteOffset, edited.bytes.byteLength);
  expect(header.getInt16(70, true)).toBe(2);
  const before = await readNifti(original.bytes);
  const after = await readNifti(edited.bytes);
  expect(after.dims).toEqual(PROSTATE_FIXTURE_DIMS);
  expect(after.data.some((value, index) => value !== before.data[index])).toBe(true);

  await edit.click();
  await expect(editor).toBeVisible();
  await page.locator('#clearResults').click();
  await expect(editor).toBeHidden();
  await expect(row).toHaveCount(0);
});


test('default nnU-Net v2 produces native-grid probabilities, ranked markers and a detection report', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  await page.route('https://webapps.neurodesk.org/dicompare/**', route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: image });
  await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), virtualGpu ? { backend: 'wasm' } : {});
  await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
  const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
  expect(snapshot.report.provenance.pipeline).toBe('nnunet-v2');
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
    return { exposed: Boolean(navigator.gpu), adapter: Boolean(adapter), fallback: adapter?.info?.isFallbackAdapter ?? adapter?.isFallbackAdapter ?? null };
  });
  console.log(JSON.stringify({ seedsegBackend: snapshot.report.provenance.executionProvider, onnxRuntime: snapshot.report.provenance.onnxRuntime, gpu }));
  if (hardwareGpu && !virtualGpu) {
    assertHardwareAdapter(await readAdapterInfo(page));
    expect(snapshot.report.provenance.executionProvider).toBe('webgpu');
  }
  expect(snapshot.report.provenance.models.map(model => model.id)).toEqual(['fold0-web']);
  expect(snapshot.report.measurements.detections.folds).toEqual(['0']);
  expect(Object.keys(snapshot.report.artifacts).sort()).toEqual(['detections', 'markers', 'probability']);
  await page.locator('#detectionsPanel button[data-world]').first().click();
  const position = await page.evaluate(() => Array.from(window.app.nv.frac2mm(window.app.nv.scene.crosshairPos)));
  snapshot.report.measurements.detections.markers[0].centroidWorldMm.forEach((value, axis) => expect(position[axis]).toBeCloseTo(value, 3));
  for (const id of ['markers', 'probability', 'detections']) {
    const waiting = page.waitForEvent('download');
    await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
    const bytes = await readFile(await (await waiting).path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(snapshot.report.artifacts[id].sha256);
    if (id === 'detections') {
      expect(JSON.parse(bytes).countFlag).toBe(snapshot.report.measurements.detections.countFlag);
    } else {
      const volume = await readNifti(bytes);
      expect(volume.dims).toEqual(PROSTATE_FIXTURE_DIMS);
      expect(volume.data.every(value => Number.isFinite(value) && value >= 0 && value <= (id === 'markers' ? 3 : 1))).toBe(true);
    }
  }
  if (hardwareGpu && !virtualGpu) {
    await adoptImage(page);
    await page.evaluate(() => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters: { backend: 'wasm' } }));
    await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: 540000 }).toMatch(/succeeded|failed/);
    const cpu = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
    expect(cpu.state, JSON.stringify(cpu.error)).toBe('succeeded');
    expect(cpu.report.provenance.executionProvider).toBe('wasm');
    const parity = compareDetections(cpu.report.measurements.detections, snapshot.report.measurements.detections);
    console.log(JSON.stringify({ hardwareDetectionParity: parity }));
    expect(parity.sameTopK && parity.sameOrder && parity.sameCandidateCount && parity.sameCountFlag).toBe(true);
  }
  const row = page.locator('#stage-item-markers');
  const original = await downloadRow(page, row);
  await page.locator('.view-tab[data-view="axial"]').click();
  await row.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.locator('nd-mask-editor');
  await expect(editor).toBeVisible();
  const labels = editor.getByLabel('Label');
  await expect(labels.locator('option')).toHaveText(['1 — Marker 1', '2 — Marker 2', '3 — Marker 3']);
  await labels.selectOption('3');

  const box = await page.locator('#gl1').boundingBox();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(editor).toBeHidden();
  await expect(row.locator('.stage-btn')).toHaveText('Markers (edited)');
  const edited = await downloadRow(page, row);
  expect(edited.name).toBe(original.name);
  const before = await readNifti(original.bytes);
  const after = await readNifti(edited.bytes);
  expect(after.dims).toEqual(before.dims);
  expect(after.data.some((value, index) => value !== before.data[index])).toBe(true);
  const panel = page.locator('#detectionsPanel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('From the edited mask');
  const counts = new Map();
  for (const value of after.data) if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  expect(ranks).toContain(3);
  await expect(panel.locator('tbody tr')).toHaveCount(ranks.length);
  for (const [index, rank] of ranks.entries()) await expect(panel.locator('tbody tr').nth(index).locator('td').nth(2)).toHaveText(String(counts.get(rank)));
  const editedDetections = await page.evaluate(() => window.app.inferenceExecutor.report.detections);
  expect(editedDetections.markers.map(marker => marker.nVoxels)).toEqual(ranks.map(rank => counts.get(rank)));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`seedseg-v2-edited-${width}.png`), fullPage: true });
  }
});

for (const settings of [
  { name: 'five-fold ensemble', folds: [0, 1, 2, 3, 4], mirror: false },
  { name: 'mirrored fold', folds: [0], mirror: true },
]) {
  test(`hardware WebGPU and WASM agree for the ${settings.name}`, async ({ page }) => {
    test.skip(!hardwareGpu, 'Requires a hardware WebGPU adapter.');
    test.skip(virtualGpu, "GitHub's virtual Metal GPU cannot run nnU-Net v2; run on a real Mac.");
    // On an M1 Max one network pass takes about 2.5 minutes on WebGPU and 3 on WASM.
    const runTimeout = settings.folds.length * (settings.mirror ? 2 : 1) * 360000;
    test.setTimeout(2 * runTimeout + 120000);
    await page.goto('/');
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    assertHardwareAdapter(await readAdapterInfo(page));
    const reports = [];
    const outputs = [];
    for (const backend of ['auto', 'wasm']) {
      await adoptImage(page);
      await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), {
        folds: settings.folds, mirror: settings.mirror, backend,
      });
      await expect.poll(() => page.evaluate(async () => (await neurodeskAutomation.dispatch('snapshot')).state), { timeout: runTimeout }).toMatch(/succeeded|failed/);
      const snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
      expect(snapshot.state, JSON.stringify(snapshot.error)).toBe('succeeded');
      expect(snapshot.report.provenance.executionProvider).toBe(backend === 'auto' ? 'webgpu' : 'wasm');
      expect(snapshot.report.provenance.models.map(model => model.id)).toEqual(settings.folds.map(fold => `fold${fold}-web`));
      expect(snapshot.report.measurements.detections.folds).toEqual(settings.folds.map(String));
      expect(snapshot.report.measurements.detections.mirror).toBe(settings.mirror);
      expect(snapshot.report.measurements.detections.markers.length).toBeGreaterThan(0);
      reports.push(snapshot.report.measurements.detections);
      const output = {};
      for (const artifactId of ['probability', 'markers']) {
        const waiting = page.waitForEvent('download');
        await page.evaluate(id => neurodeskAutomation.dispatch('download', { artifactId: id }), artifactId);
        const volume = await readNifti(await readFile(await (await waiting).path()));
        expect(volume.dims).toEqual(PROSTATE_FIXTURE_DIMS);
        output[artifactId] = volume.data;
      }
      outputs.push(output);
    }
    const parity = compareDetections(reports[0], reports[1]);
    console.log(JSON.stringify({ hardwareCase: settings.name, hardwareDetectionParity: parity }));
    expect(parity.sameTopK && parity.sameOrder && parity.sameCandidateCount && parity.sameCountFlag).toBe(true);
    const agreement = compareV2Outputs({ native: outputs[1], browser: outputs[0], dims: PROSTATE_FIXTURE_DIMS, mirror: settings.mirror });
    console.log(JSON.stringify({ hardwareCase: settings.name, hardwareOutputParity: agreement }));
  });
}

// NiiVue shows volumes reoriented to RAS. On an x-flipped image, native voxel x = 10 is displayed at
// x = 53 of 64, so marker navigation must go through world millimetres.
test('Show marker places the crosshair on the marker of an oriented image', async ({ page }) => {
  const n = 64;
  const img = new Float32Array(n ** 3).map((_, index) => 100 + (index % n));
  const affine = [[-1, 0, 0, 31], [0, 0, 1.5, -40], [0, 2, 0, -60], [0, 0, 0, 1]];
  const bytes = Buffer.from(createNiftiFromVolume({ img, hdr: { dims: [n, n, n], pixDims: [1, 2, 1.5], affine } }));
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
  await page.evaluate(data => window.app.fileIOController.setFile(new File([new Uint8Array(data)], 'oriented.nii')), [...bytes]);
  await page.waitForFunction(() => window.app.nv.volumes?.length === 1);
  const voxel = [10, 20, 30];
  const mm = [0, 1, 2].map(r => affine[r][0] * voxel[0] + affine[r][1] * voxel[1] + affine[r][2] * voxel[2] + affine[r][3]);
  await page.evaluate(([centroidVox, centroidWorldMm]) => window.app.showDetections({
    k: 1, nCandidates: 1, countFlag: false, others: [], folds: [0], mirror: false, backend: 'wasm', timing: { total: 1 },
    markers: [{ rank: 1, meanProb: 0.9, nVoxels: 1, volumeMm3: 3, centroidVox, centroidWorldMm }],
  }), [voxel, mm]);
  // A run reveals the Results section before its detections arrive.
  await page.evaluate(() => document.getElementById('resultsSection').classList.remove('hidden'));
  await page.locator('#detectionsPanel').getByRole('button', { name: 'Show marker 1' }).click();
  const crosshair = await page.evaluate(() => Array.from(window.app.nv.frac2mm(window.app.nv.scene.crosshairPos)).slice(0, 3));
  for (let axis = 0; axis < 3; axis++) expect(Math.abs(crosshair[axis] - mm[axis]), `axis ${axis}: ${crosshair} vs ${mm}`).toBeLessThan(0.01);
});
