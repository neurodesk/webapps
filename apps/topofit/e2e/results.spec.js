import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { writeSurfaceFiles } from '../../../packages/topofit/src/results.js';
import { analyzeSurfaces } from '../../../packages/topofit/src/surface-analysis.js';
import { readVolume } from '../../../packages/topofit/src/volume.js';

async function patchPixels(page, clip) {
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] > 140 && data[i + 2] < 80) count += 1;
    }
    image.close();
    return count;
  }, screenshot.toString('base64'));
}

function scan() {
  const buffer = Buffer.alloc(352 + 16 ** 3 * 4);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  for (let axis = 1; axis <= 3; axis += 1) {
    buffer.writeInt16LE(16, 40 + axis * 2);
    buffer.writeFloatLE(1, 76 + axis * 4);
  }
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  buffer.writeFloatLE(352, 108);
  buffer.writeInt16LE(1, 254);
  buffer.writeFloatLE(1, 280);
  buffer.writeFloatLE(1, 300);
  buffer.writeFloatLE(1, 320);
  buffer.write('n+1\0', 344, 'ascii');
  for (let i = 0; i < 16 ** 3; i += 1) buffer.writeFloatLE(i % 16, 352 + i * 4);
  return { name: 'scan.nii', mimeType: 'application/nifti', buffer };
}

async function deliverSurfaces(page, analysisResult = { files: [], analysis: null }) {
  const vertices = {};
  const faces = {};
  for (const side of ['lh', 'rh']) {
    vertices[`${side}.white`] = Float32Array.from([2, 2, 2, 12, 2, 2, 2, 12, 2, 2, 2, 12]);
    vertices[`${side}.pial`] = Float32Array.from(vertices[`${side}.white`], (value) => value + 1);
    vertices[`${side}.registration`] = vertices[`${side}.white`];
    faces[side] = Int32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  }
  const surfaceFiles = writeSurfaceFiles(vertices, faces);
  await page.addInitScript(({ surfaceFiles, qc, analysisFiles, analysis }) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        window.lastTopofitJob = job;
        window.reconstructionRuns = (window.reconstructionRuns || 0) + 1;
        for (let i = 0; i < 100; i += 1) this.onmessage({ data: { type: 'progress', value: i / 100, message: 'Loading topofit-t1w-1mm-white-order-6.onnx…' } });
        const files = surfaceFiles.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes).buffer }));
        files.push({ id: 'qc', name: 'qc.nii', mediaType: 'application/nifti', bytes: Uint8Array.from(qc).buffer });
        files.push(...analysisFiles.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes).buffer })));
        const vertices = {};
        const faces = {};
        for (const side of ['lh', 'rh']) {
          vertices[`${side}.white`] = Float32Array.from([2, 2, 2, 12, 2, 2, 2, 12, 2, 2, 2, 12]);
          vertices[`${side}.pial`] = Float32Array.from(vertices[`${side}.white`], (v) => v + 1);
          vertices[`${side}.registration`] = Float32Array.from(vertices[`${side}.white`]);
          faces[side] = Int32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
        }
        this.onmessage({ data: { type: 'result', files, surfaces: { vertices, faces }, provenance: { surfaceVertices: 4, surfaceAnalysis: analysis, runtime: {}, outputSha256: { 'topofit_qc.nii': 'original-qc' } }, elapsedSeconds: 1 } });
      }
    };
  }, {
    surfaceFiles: surfaceFiles.map((file) => ({ ...file, bytes: Array.from(new Uint8Array(file.bytes)) })),
    qc: Array.from(scan().buffer),
    analysis: analysisResult.analysis,
    analysisFiles: analysisResult.files.map((file) => ({ ...file, bytes: Array.from(new Uint8Array(file.bytes)) })),
  });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scan());
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#runButton').click();
  await expect(page.locator('#outputSection')).toHaveAttribute('open', '');
  await expect(page.locator('#imageLabel')).toContainText(analysisResult.analysis ? 'PATCHES' : 'TOPOFIT QC');
  return surfaceFiles;
}

test('anatomical surfaces remain multiplanar, registration outputs are hidden, and repeated progress logs once', async ({ page }, testInfo) => {
  await deliverSurfaces(page);
  await expect(page.locator('#resultList')).not.toContainText(/registration/i);
  await expect(page.locator('.nd-console-message').filter({ hasText: 'Loading topofit-t1w-1mm-white-order-6.onnx' })).toHaveCount(1);
  for (const label of ['Left white surface', 'Left pial surface', 'Right white surface', 'Right pial surface']) {
    const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
    await row.getByRole('checkbox').check();
    await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('#imageLabel')).toContainText(label.includes('white') ? 'WHITE' : 'PIAL');
    await expect(page.locator('#viewerError')).toBeHidden();
    await expect(page.getByRole('radio', { name: 'Multi+Render', exact: true })).toHaveAttribute('data-state', 'on');
  }
  await page.screenshot({ path: testInfo.outputPath('surfaces-desktop.png') });
});

async function expectCorticalOverlay(page, label = 'Left white surface') {
  const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
  await row.getByRole('button', { name: 'View', exact: true }).click();
  await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
  await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
  await expect(page.locator('#viewerError')).toBeHidden();
  const canvas = await page.locator('#gl1').boundingBox();
  const slices = [[0, 0], [1, 0], [0, 1]].map(([column, line]) => ({
    x: canvas.x + column * canvas.width / 2,
    y: canvas.y + line * canvas.height / 2,
    width: Math.floor(canvas.width / 2),
    height: Math.floor(canvas.height / 2),
  }));
  const visible = [];
  for (const clip of slices) visible.push(await page.screenshot({ clip }));
  await row.getByRole('checkbox').uncheck();
  await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
  for (const [index, clip] of slices.entries()) {
    const hidden = await page.screenshot({ clip });
    const fraction = await page.evaluate(async (screenshots) => {
      const pixels = await Promise.all(screenshots.map(async (base64) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        image.close();
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      }));
      let changed = 0;
      for (let i = 0; i < pixels[0].length; i += 4) {
        if ([0, 1, 2].some((channel) => Math.abs(pixels[0][i + channel] - pixels[1][i + channel]) > 10)) changed += 1;
      }
      return changed / (pixels[0].length / 4);
    }, [visible[index], hidden].map((image) => image.toString('base64')));
    expect(fraction, `Surface boundary must intersect slice ${index}`).toBeGreaterThan(0);
    expect(fraction, `Surface boundary must leave the anatomy on slice ${index} exposed`).toBeLessThan(0.15);
  }
  await row.getByRole('checkbox').check();
  await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
}

test('cortical surface boundaries appear on all three slices in 3-Plane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1100 });
  await deliverSurfaces(page);
  await expectCorticalOverlay(page);
  await page.screenshot({ path: testInfo.outputPath('cortical-overlay.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('cortical-overlay-phone.png'), fullPage: true });
});

test('View isolates each surface in 3D while the MRI stays on the 2D slices only', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1100 });
  await deliverSurfaces(page);
  for (const label of ['Left white surface', 'Right pial surface', 'Left mid-surface']) {
    const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
    await row.getByRole('button', { name: 'View', exact: true }).click();
    await expect(row.getByRole('checkbox')).toBeEnabled();
    await expect(row.getByRole('checkbox')).toBeChecked();
    await expect(page.locator('#resultList input:checked')).toHaveCount(1);
    await expect(page.getByRole('radio', { name: 'Render view', exact: true })).toHaveAttribute('data-state', 'on');
    await expect(page.locator('#imageLabel')).toHaveText(label.toUpperCase());
  }
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
  await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
  const canvas = await page.locator('#gl1').boundingBox();
  const render = {
    x: canvas.x + canvas.width / 2,
    y: canvas.y + canvas.height / 2,
    width: Math.floor(canvas.width / 2),
    height: Math.floor(canvas.height / 2),
  };
  const axial = { ...render, x: canvas.x };
  const before3D = await page.screenshot({ clip: render });
  const before2D = await page.screenshot({ clip: axial });
  await page.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await expect.poll(async () => before2D.equals(await page.screenshot({ clip: axial }))).toBe(false);
  expect(before3D.equals(await page.screenshot({ clip: render })), 'MRI visibility must not affect the 3D surface').toBe(true);
  await page.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('surface-boundaries-and-3d.png') });
});

test('bilateral mid-surfaces can be overlaid, viewed in 3D and downloaded without analysis', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1100 });
  const files = await deliverSurfaces(page);
  for (const [side, label] of [['lh', 'Left mid-surface'], ['rh', 'Right mid-surface']]) {
    await expectCorticalOverlay(page, label);
    const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
    const downloading = page.waitForEvent('download');
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(`${side}.mid.white`);
    expect(await readFile(await download.path())).toEqual(Buffer.from(files.find((file) => file.id === `${side}-mid`).bytes));
    await page.getByRole('radio', { name: 'Render view', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Render view', exact: true })).toHaveAttribute('data-state', 'on');
    await expect(page.locator('#viewerError')).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath(`${side}-mid-3d.png`) });
    await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
    await row.getByRole('checkbox').uncheck();
  }
  await page.locator('#estimateNormals').check();
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Surface analysis ready');
  await expect(page.getByRole('checkbox', { name: 'Show Left mid-surface', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Show Right mid-surface', exact: true })).toBeVisible();
});

test('computed patches, local normals and QC can be viewed and downloaded', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1024, height: 1100 });
  const white = [];
  const faces = [];
  for (let y = 0; y < 14; y += 1) {
    for (let x = 0; x < 14; x += 1) {
      white.push(x + 1, y + 1, 6);
      const i = x + y * 14;
      if (x < 13 && y < 13) faces.push(i, i + 1, i + 14, i + 1, i + 15, i + 14);
    }
  }
  const pial = Float64Array.from(white, (v, i) => i % 3 === 2 ? v + 2 : v);
  const vertices = {};
  for (const h of ['lh', 'rh']) {
    vertices[`${h}.white`] = Float64Array.from(white);
    vertices[`${h}.pial`] = pial;
    vertices[`${h}.registration`] = Float64Array.from(white, (_, i) => i % 3 === 0 ? 1 : 0);
  }
  const atlas = new ArrayBuffer(18);
  new DataView(atlas).setUint32(0, 1, true);
  new DataView(atlas).setFloat32(4, 1, true);
  new Uint8Array(atlas).set([1, 1], 16);
  const input = scan().buffer;
  const result = await analyzeSurfaces({
    source: readVolume(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)),
    vertices,
    faces: { lh: Int32Array.from(faces), rh: Int32Array.from(faces) },
    estimateNormals: true,
    patches: { hemisphere: 'lh', count: 1 },
    loadAtlas: async () => atlas,
  });
  expect(result.analysis.flat_patch_status).toBe('PATCHES_FOUND');
  const geometry = JSON.parse(new TextDecoder().decode(result.files.find((file) => file.id === 'patch-geometry').bytes));
  await page.addInitScript((indexCount) => {
    window.patchRenderingEnabled = true;
    const draw = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (mode, count, ...args) {
      if (!window.patchRenderingEnabled && mode === this.TRIANGLES && count === indexCount) return;
      return draw.call(this, mode, count, ...args);
    };
  }, geometry.patches.LH01.faces.length * 3);
  await deliverSurfaces(page, result);
  expect(await page.locator('#controls').evaluate((controls) => {
    const right = controls.getBoundingClientRect().right;
    return [...controls.querySelectorAll('.nd-download-btn')].every((button) => button.getBoundingClientRect().right <= right);
  })).toBe(true);
  const patch = page.locator('.nd-volume-toggle').filter({ hasText: 'Left flat patch 1' });
  await patch.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('Left flat patch 1');
  const selected = result.analysis.flat_patches.LH01;
  const format = (values, decimals) => values.map((value, axis) => `${'RAS'[axis]} ${value.toFixed(decimals)}`).join(' · ');
  await expect(page.locator('#patchCenter')).toHaveValue(format(selected.center_ras_mm, 3));
  await expect(page.locator('#patchNormal')).toHaveValue(format(selected.normal_ras, 6));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy patch RAS measurements' }).click();
  await expect(page.locator('#patchCopyStatus')).toContainText('Copied full-precision');
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied.center_ras_mm).toEqual(selected.center_ras_mm);
  expect(copied.normal_ras).toEqual(selected.normal_ras);
  const coordinatesDownload = page.waitForEvent('download');
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Patch coordinates and normals (RAS)' }).getByRole('button', { name: 'Download', exact: true }).click();
  const coordinates = await coordinatesDownload;
  expect(coordinates.suggestedFilename()).toBe('topofit_patch_coordinates_ras.csv');
  const csv = (await readFile(await coordinates.path(), 'utf8')).trim().split('\n');
  expect(csv[1].split(',').slice(3, 9).map(Number)).toEqual([...selected.center_ras_mm, ...selected.normal_ras]);

  await expect(page.locator('#location')).toContainText(selected.center_ras_mm.map(Math.round).join('×'));
  await expect(page.locator('#viewerError')).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Multi+Render', exact: true })).toHaveAttribute('data-state', 'on');
  const canvas = await page.locator('#gl1').boundingBox();
  const axial = { x: canvas.x, y: canvas.y + canvas.height / 2, width: Math.floor(canvas.width / 2), height: Math.floor(canvas.height / 2) };
  const sliceImage = async (visible) => {
    await page.evaluate((enabled) => { window.patchRenderingEnabled = enabled; }, visible);
    await page.getByRole('radio', { name: 'Render view', exact: true }).click();
    await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
    return page.screenshot({ clip: axial });
  };
  await page.screenshot({ path: testInfo.outputPath('patch-before-scroll.png') });
  expect(await patchPixels(page, axial), 'Selected patch must be visibly highlighted on the slice').toBeGreaterThan(4);
  expect((await sliceImage(true)).equals(await sliceImage(false))).toBe(false);
  await page.mouse.move(axial.x + axial.width / 2, axial.y + axial.height / 2);
  for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, 120);
  await expect(page.locator('#location')).not.toContainText(selected.center_ras_mm.map(Math.round).join('×'));
  await expect(page.locator('#patchCenter')).toHaveValue(format(selected.center_ras_mm, 3));
  const scrolledPatch = await sliceImage(true);
  const scrolledWithoutPatch = await sliceImage(false);
  expect(scrolledPatch.equals(scrolledWithoutPatch), 'A patch outside the current slice must not be projected onto it').toBe(true);
  expect(await patchPixels(page, axial)).toBe(0);
  await sliceImage(true);
  await page.screenshot({ path: testInfo.outputPath('patch-scrolled-away.png') });
  const normals = page.locator('.nd-volume-toggle').filter({ hasText: 'Left mid-surface normals' });
  await normals.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('nx_ras,ny_ras,nz_ras');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close', exact: true }).click();
  const downloading = page.waitForEvent('download');
  await normals.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe('lh.mid.normals.csv');
  await page.screenshot({ path: testInfo.outputPath('computed-patch.png') });
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await page.getByRole('tab', { name: 'Surfaces', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await expect(page.locator('#patchMeasurements')).toBeHidden();
  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Cortical patches and normals' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#patchMeasurements')).toBeVisible();
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
  const qcVolume = page.locator('.freebrowse-root p').filter({ hasText: /^topofit_patch_qc\.nii$/ }).locator('../..');
  await qcVolume.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await expect(page.locator('#patchMeasurements')).toBeHidden();
  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await expectCorticalOverlay(page);
  await expect(page.locator('#patchMeasurements')).toBeHidden();
  await patch.getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#patchMeasurements')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('patch-ras-phone.png'), fullPage: true });
  await page.locator('.nd-app-bar [data-neurodesk-theme-toggle]').click();
  await page.screenshot({ path: testInfo.outputPath('patch-ras-phone-light.png'), fullPage: true });
  await page.locator('#imageInput').setInputFiles(scan());
  await expect(page.locator('#patchMeasurements')).toBeHidden();
  await expect(page.locator('#patchCenter')).toHaveValue('');
});

test('settings stay visible and pass edited values to the worker', async ({ page }, testInfo) => {
  await deliverSurfaces(page);
  for (const id of ['advancedSettings', 'surfaceAnalysisSettings']) {
    await expect(page.locator(`#${id}`)).toHaveJSProperty('tagName', 'SECTION');
    await expect(page.locator(`#${id} > summary`)).toHaveCount(0);
    await page.locator(`#${id}Title`).click();
  }
  await expect(page.locator('#conform')).toBeVisible();
  await expect(page.locator('#thickness')).toBeVisible();
  await page.locator('#estimateNormals').check();
  await page.locator('#findPatches').check();
  await page.locator('#patchCount').fill('2');
  await page.locator('#patchRadius').fill('8');
  await page.locator('#patchHemisphere').selectOption('lh');
  await expect(page.locator('#patchRadius')).toHaveValue('8');
  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.lastTopofitJob.patches)).toEqual({ count: 2, radius: 8, hemisphere: 'lh', maxRms: 0.5, minAreaFraction: 0.25 });
  expect(await page.evaluate(() => window.lastTopofitJob.estimateNormals)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('analysis-phone.png'), fullPage: true });
  await page.locator('.nd-app-bar [data-neurodesk-theme-toggle]').click();
  await page.screenshot({ path: testInfo.outputPath('analysis-phone-light.png'), fullPage: true, animations: 'disabled' });
});

test('invalid patch settings and a missing ROI are revealed before reconstruction', async ({ page }) => {
  await deliverSurfaces(page);
  await page.locator('#findPatches').check();
  await page.locator('#patchCount').fill('0');
  await page.locator('#runButton').click();
  await expect(page.locator('#estimateNormals')).toBeVisible();
  await expect(page.locator('#patchCount')).toBeFocused();
  await page.locator('#patchCount').fill('3');
  await page.locator('#patchQuality > summary').click();
  await page.locator('#patchRegion').selectOption('roi');
  await page.locator('#runButton').click();
  await expect(page.locator('#patchRoi')).toBeAttached();
  await expect(page.locator('#estimateNormals')).toBeVisible();
  await expect(page.locator('#patchQuality')).toHaveAttribute('open', '');
  await expect(page.locator('#runButton')).toBeEnabled();
  expect(await page.evaluate(() => window.lastTopofitJob.patches)).toBeNull();
});

test('real reconstructed cortex displays patch QC and clearly named patches', async ({ page }, testInfo) => {
  const root = process.env.TOPOFIT_SURFACE_REPLAY;
  test.skip(!root, 'Requires external OpenRecon validation surfaces and surface-analysis replay outputs.');
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1024, height: 1100 });
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const outputs = JSON.parse(await readFile(join(root, 'outputs/files.json'), 'utf8'));
  const analysis = JSON.parse(await readFile(join(root, 'outputs/topofit_surface_analysis.json'), 'utf8'));
  const files = [
    ...['lh', 'rh'].flatMap((h) => ['white', 'pial', 'registration'].map((s) => ({ id: `${h}-${s}`, name: `${h}.${s}`, mediaType: 'application/vnd.freesurfer.surface' }))),
    ...outputs,
  ];
  const replayVertices = {};
  const replayFaces = {};
  for (const file of files.filter(({ id }) => /^(lh|rh)-(white|pial|registration)$/.test(id))) {
    const bytes = await readFile(join(root, 'surfaces', file.name));
    let offset = 3;
    for (let lines = 0; lines < 2;) if (bytes[offset++] === 10) lines += 1;
    const count = bytes.readInt32BE(offset);
    const faceCount = bytes.readInt32BE(offset + 4);
    offset += 8;
    replayVertices[file.name] = Float64Array.from({ length: count * 3 }, (_, i) => bytes.readFloatBE(offset + i * 4));
    offset += count * 12;
    replayFaces[file.id.slice(0, 2)] = Int32Array.from({ length: faceCount * 3 }, (_, i) => bytes.readInt32BE(offset + i * 4));
  }
  const mids = writeSurfaceFiles(replayVertices, replayFaces).filter(({ id }) => id.endsWith('-mid'));
  files.push(...mids.map(({ id, name, mediaType }) => ({ id, name, mediaType })));
  const atlasPath = join(root, 'atlas/fsaverage-cortex.bin');
  await page.route('**/fsaverage-cortex.bin', (route) => route.fulfill({ path: atlasPath, contentType: 'application/octet-stream' }));
  const paths = new Map(files.map((file) => [file.name, join(root, outputs.includes(file) ? 'outputs' : 'surfaces', file.name)]));
  await page.route('**/__topofit_fixture__/*', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const mid = mids.find((file) => file.name === name);
    if (mid) return route.fulfill({ body: Buffer.from(mid.bytes), contentType: 'application/octet-stream' });
    const path = paths.get(name);
    return path ? route.fulfill({ path, contentType: 'application/octet-stream' }) : route.abort();
  });
  await page.addInitScript(({ files, analysis }) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      async postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        const loaded = await Promise.all(files.map(async (file) => ({ ...file, bytes: await (await fetch(`/__topofit_fixture__/${file.name}`)).arrayBuffer() })));
        const vertices = {};
        const faces = {};
        for (const file of loaded.filter((file) => /^(lh|rh)-(white|pial|registration)$/.test(file.id))) {
          const bytes = new Uint8Array(file.bytes);
          let offset = 3;
          for (let lines = 0; lines < 2;) if (bytes[offset++] === 10) lines += 1;
          const view = new DataView(file.bytes);
          const vertexCount = view.getInt32(offset);
          const faceCount = view.getInt32(offset + 4);
          offset += 8;
          vertices[file.name] = Float32Array.from({ length: vertexCount * 3 }, (_, i) => view.getFloat32(offset + i * 4));
          offset += vertexCount * 12;
          if (file.id.endsWith('-white')) faces[file.id.slice(0, 2)] = Int32Array.from({ length: faceCount * 3 }, (_, i) => view.getInt32(offset + i * 4));
        }
        this.onmessage({ data: { type: 'result', files: loaded, surfaces: { vertices, faces }, provenance: { surfaceVertices: 245762, surfaceAnalysis: analysis, runtime: {}, outputSha256: {} }, elapsedSeconds: 0 } });
      }
    };
  }, { files, analysis });
  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(join(root, 'source.nii.gz'));
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#imageLabel')).toContainText('PATCHES', { timeout: 60_000 });
  await expect(page.locator('#viewerError')).toBeHidden();
  await expect(page.locator('#resultList')).not.toContainText(/registration/i);
  for (const side of ['Left', 'Right']) {
    for (let index = 1; index <= 3; index += 1) {
      await expect(page.locator('#resultList').getByText(`${side} flat patch ${index}`, { exact: true })).toHaveCount(1);
    }
  }
  await page.screenshot({ path: testInfo.outputPath('real-patch-qc.png') });
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Left flat patch 1' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('Left flat patch 1', { timeout: 30_000 });
  await expect(page.locator('#viewerError')).toBeHidden();
  await expect(page.getByRole('radio', { name: 'Multi+Render', exact: true })).toHaveAttribute('data-state', 'on');
  await page.screenshot({ path: testInfo.outputPath('real-selected-patch.png') });
  const canvas = await page.locator('#gl1').boundingBox();
  for (const [column, row] of [[0, 0], [1, 0], [0, 1]]) {
    expect(await patchPixels(page, {
      x: canvas.x + column * canvas.width / 2,
      y: canvas.y + row * canvas.height / 2,
      width: Math.floor(canvas.width / 2),
      height: Math.floor(canvas.height / 2),
    }), 'The real cortical patch must be highlighted in each intersecting slice').toBeGreaterThan(4);
  }
  const axial = {
    x: canvas.x,
    y: canvas.y + canvas.height / 2,
    width: Math.floor(canvas.width / 2),
    height: Math.floor(canvas.height / 2),
  };
  await page.mouse.move(axial.x + axial.width / 3, axial.y + axial.height / 2);
  for (let i = 0; i < 30; i += 1) await page.mouse.wheel(0, 120);
  await expect.poll(() => patchPixels(page, axial), { message: 'Scrolling away must hide the real cortical patch on that slice' }).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('real-patch-scrolled-away.png') });
  await page.locator('#findPatches').check();
  await page.locator('#patchCount').fill('1');
  await page.locator('#patchHemisphere').selectOption('rh');
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Surface analysis ready', { timeout: 90_000 });
  await expect(page.locator('#resultList').getByText('Right flat patch 1', { exact: true })).toHaveCount(1);
  await expect(page.locator('#resultList').getByText('Left flat patch 1', { exact: true })).toHaveCount(0);
  await expect(page.locator('#resultList').getByText('Right flat patch 2', { exact: true })).toHaveCount(0);
  await page.locator('#resultList').getByText('Right flat patch 1', { exact: true }).locator('..').getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('Right flat patch 1', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('reanalyzed-right-patch.png') });
  await expectCorticalOverlay(page);
  for (const label of ['Left white surface', 'Right pial surface']) {
    const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
    await row.getByRole('checkbox').check();
    await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('#imageLabel')).toContainText(label.includes('white') ? 'WHITE' : 'PIAL');
    await expect(page.locator('#viewerError')).toBeHidden();
  }
  await page.screenshot({ path: testInfo.outputPath('real-cortical-overlays.png') });
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Right flat patch 1' }).getByRole('button', { name: 'View', exact: true }).click();
  await expectCorticalOverlay(page, 'Left mid-surface');
  await page.getByRole('checkbox', { name: 'Show Right mid-surface', exact: true }).check();
  await expect(page.getByRole('checkbox', { name: 'Show Right mid-surface', exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#imageLabel')).toContainText('RIGHT MID-SURFACE');
  await expect(page.locator('#viewerError')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('real-mid-surfaces.png') });
  await page.getByRole('radio', { name: 'Render view', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('real-mid-surfaces-3d.png') });
  for (const label of ['Left white surface', 'Left pial surface', 'Left mid-surface', 'Right mid-surface']) {
    const row = page.locator('.nd-volume-toggle').filter({ hasText: label });
    await row.getByRole('button', { name: 'View', exact: true }).click();
    await expect(row.getByRole('checkbox')).toBeEnabled({ timeout: 30_000 });
    await expect(page.locator('#resultList input:checked')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath(`${label.replaceAll(' ', '-')}-3d.png`) });
  }
  await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('real-boundaries-and-surface.png') });
});

test('analysis runs in its own worker and can be repeated or cancelled without reconstruction', async ({ page }) => {
  const modelRequests = [];
  page.on('request', (request) => { if (/\.onnx(?:[?]|$)/.test(request.url())) modelRequests.push(request.url()); });
  await deliverSurfaces(page);
  await expect(page.locator('#analyzeButton')).toBeEnabled();
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#estimateNormals')).toBeVisible();
  await page.locator('#estimateNormals').check();
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Surface analysis ready');
  await expect(page.getByText('Left mid-surface normals', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Show Left white surface' })).toBeVisible();
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Processing manifest' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#infoDialog')).toContainText('original-qc');
  await expect(page.locator('#infoDialog')).toContainText('lh.mid.normals.csv');
  await page.locator('#infoDialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.route('**/fsaverage-cortex.bin', () => {});
  await page.locator('#findPatches').check();
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Analyzing reconstructed surfaces');
  for (const button of await page.locator('#resultList button').all()) await expect(button).toBeDisabled();
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('Surface analysis cancelled');
  await expect(page.getByText('Left mid-surface normals', { exact: true })).toBeVisible();
  await expect(page.locator('#analyzeButton')).toBeEnabled();
  await page.unroute('**/fsaverage-cortex.bin');
  await page.route('**/fsaverage-cortex.bin', (route) => route.fulfill({ body: '' }));
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Model size mismatch');
  await expect(page.getByText('Left mid-surface normals', { exact: true })).toBeVisible();
  await page.locator('#findPatches').uncheck();
  await page.locator('#analyzeButton').click();
  await expect(page.locator('#statusText')).toContainText('Surface analysis ready');
  await expect(page.getByText('Left mid-surface normals', { exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => window.reconstructionRuns)).toBe(1);
  expect(modelRequests).toEqual([]);
  await page.locator('#imageInput').setInputFiles(scan());
  await expect(page.locator('#analyzeButton')).toBeDisabled();
  await expect(page.locator('#resultList .nd-volume-toggle')).toHaveCount(0);
});

test('cortical surfaces export as printable STL through niimath', async ({ page }) => {
  await deliverSurfaces(page);
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Left pial surface' }).getByRole('checkbox').check();
  await page.locator('#stlButton').click();
  await expect(page.locator('#infoDialog')).toBeVisible();
  await expect(page.locator('#stlSurfaceList')).toHaveText('left pial surface');
  await expect(page.locator('#stlReduce')).toHaveValue('25');
  await expect(page.locator('#stlSmooth')).toHaveValue('0');
  // An empty field must not become "-r 0", which niimath rejects.
  await page.locator('#stlReduce').fill('');
  await page.locator('#stlSaveButton').click();
  await expect(page.locator('#infoDialog')).toBeVisible();
  // The stub delivers a tetrahedron, so keep every triangle: this checks the format, not niimath's simplifier.
  await page.locator('#stlReduce').fill('100');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#stlSaveButton').click(),
  ]);
  expect(download.suggestedFilename()).toBe('lh.pial.stl');
  const stl = await readFile(await download.path());
  expect(stl.length).toBe(84 + 4 * 50);
  expect(stl.readUInt32LE(80)).toBe(4);
  expect(stl.subarray(0, 80).every((byte) => byte === 0)).toBe(true);
  await expect(page.locator('#statusText')).toContainText('lh.pial.stl · 4 triangles');
});

test('STL export serializes processing and cancellation rejects late results', async ({ page }) => {
  await deliverSurfaces(page);
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(job, ...rest) {
        if (!job.surfaces) return super.postMessage(job, ...rest);
        window.finishStl = () => this.onmessage({ data: {
          type: 'result',
          files: [{ name: 'stale.stl', bytes: new ArrayBuffer(84), triangles: 0 }],
        } });
      }
    };
  });
  const downloads = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.locator('#stlButton').click();
  await page.locator('#stlSaveButton').click();
  await expect(page.locator('#imageInput')).toBeDisabled();
  await expect(page.locator('#runButton')).toBeDisabled();
  await page.locator('#cancelButton').click();
  await expect(page.locator('#stlButton')).toBeEnabled();
  await expect(page.locator('#statusText')).toContainText('STL export cancelled');
  await page.locator('#imageInput').setInputFiles({ ...scan(), name: 'replacement.nii' });
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.evaluate(() => window.finishStl());
  await expect(page.locator('#statusText')).not.toContainText('Saved');
  expect(downloads).toEqual([]);
});

test('STL export defaults to all four cortical surfaces', async ({ page }, testInfo) => {
  await deliverSurfaces(page);
  await page.locator('#stlButton').click();
  await expect(page.locator('#stlSurfaceList')).toContainText('right pial surface');
  await page.locator('#stlReduce').fill('100');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.locator('#stlReduce').evaluate((input) => ({
      height: input.getBoundingClientRect().height,
      font: Number.parseFloat(getComputedStyle(input).fontSize),
    }));
    expect(size.height).toBeGreaterThanOrEqual(width < 780 ? 44 : 30);
    if (width < 780) expect(size.font).toBeGreaterThanOrEqual(16);
    await page.screenshot({ path: testInfo.outputPath(`stl-${width}.png`), fullPage: true });
  }
  const downloads = [];
  page.on('download', (download) => downloads.push(download));
  await page.locator('#stlSaveButton').click();
  await expect(page.locator('#statusText')).toContainText('Saved');
  await expect.poll(() => downloads.length).toBe(4);
  expect(downloads.map((download) => download.suggestedFilename()).sort()).toEqual([
    'lh.pial.stl', 'lh.white.stl', 'rh.pial.stl', 'rh.white.stl',
  ]);
  for (const download of downloads) {
    const stl = await readFile(await download.path());
    expect(stl.readUInt32LE(80)).toBe(4);
  }
});

test('FreeBrowse surface controls stay synchronized with TopoFit results', async ({ page }, testInfo) => {
  await deliverSurfaces(page);
  const left = page.getByRole('checkbox', { name: 'Show Left mid-surface', exact: true });
  const right = page.getByRole('checkbox', { name: 'Show Right mid-surface', exact: true });
  await left.check();
  await expect(left).toBeEnabled();
  await right.check();
  await expect(right).toBeEnabled();
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await page.getByRole('tab', { name: 'Surfaces', exact: true }).click();
  const leftSurface = page.locator('.freebrowse-root p').filter({ hasText: /^lh\.mid\.white$/ }).locator('../..');
  await expect(leftSurface).toBeVisible();
  await leftSurface.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await expect(left).not.toBeChecked();
  await left.check();
  await expect(left).toBeEnabled();
  await leftSurface.getByTitle('Delete surface', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(left).not.toBeChecked();
  await right.uncheck();
  await expect(right).toBeEnabled();
  await right.check();
  await expect(right).toBeEnabled();
  await left.check();
  await expect(left).toBeEnabled();
  await expect(leftSurface).toBeVisible();
  await expect(page.locator('.freebrowse-root p').filter({ hasText: /^rh\.mid\.white$/ })).toBeVisible();
  await page.getByRole('radio', { name: 'Axial view', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Axial view', exact: true })).toHaveAttribute('data-state', 'on');
  await page.getByRole('radio', { name: 'Multi+Render', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('freebrowse-desktop.png') });
  await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
  await page.getByTitle('Delete volume', { exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await left.uncheck();
  await expect(left).toBeEnabled();
  await expect(left).not.toBeChecked();
  await expect(right).toBeChecked();
  await expect(page.locator('#imageLabel')).toHaveText('RIGHT MID-SURFACE');
  await left.check();
  await expect(left).toBeEnabled();
  await right.check();
  await expect(right).toBeEnabled();
  await page.getByRole('tab', { name: 'Surfaces', exact: true }).click();

  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#freebrowseViewer').scrollIntoViewIfNeeded();
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await expect(leftSurface).toBeVisible();
  const outsideViewport = await page.locator('.freebrowse-root').evaluate((root) => [...root.querySelectorAll('button')]
    .filter((button) => button.checkVisibility())
    .filter((button) => button.getBoundingClientRect().right > window.innerWidth + 1)
    .map((button) => button.title || button.textContent));
  expect(outsideViewport).toEqual([]);
  const targets = await page.locator('.freebrowse-root > header button').evaluateAll((buttons) => buttons.filter((button) => button.checkVisibility()).map((button) => {
    const { width, height } = button.getBoundingClientRect();
    return { name: button.title, width, height, minWidth: getComputedStyle(button).minWidth, minHeight: getComputedStyle(button).minHeight };
  }));
  expect(targets.filter(({ width, height }) => width < 44 || height < 44)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('freebrowse-phone.png') });
  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await page.locator('[data-neurodesk-theme-toggle]').click();
  await expect(page.locator('.freebrowse-root')).not.toHaveClass(/\bdark\b/);
  await page.locator('#freebrowseViewer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('freebrowse-phone-light.png') });
  await expect(page.locator('.freebrowse-root h1')).toBeHidden();
  await expect(page.getByTitle('Switch to light mode', { exact: true })).toBeHidden();
});
