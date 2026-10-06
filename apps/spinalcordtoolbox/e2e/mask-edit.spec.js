import { expect as baseExpect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Manual mask editing with the shared nd-mask-editor on FreeBrowse's NiiVue:
// a result row's Edit opens the editor's toolbar row, the test draws, erases
// and fills on the real canvas with its tools, and the downloaded mask must
// hold exactly what was painted, in the original image geometry. Every image
// here is anisotropic and stored in a permuted, flipped orientation
// (i -> posterior, j -> inferior, k -> right), where NiiVue 1.0's own
// loadDrawing does not round-trip; the shared drawing adapter corrects it.

const expect = baseExpect.configure({ timeout: 60000 });
const poll = (read, options = {}) => expect.poll(read, { timeout: 60000, ...options });
const SROW = [[0, 0, 2, -10], [-0.5, 0, 0, 20], [0, -0.8, 0, 30]];

function nifti(dims, pixdims, srow, datatype, bitpix, voxels) {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [3, ...dims, 1, 1, 1, 1].forEach((value, index) => header.writeInt16LE(value, 40 + index * 2));
  header.writeInt16LE(datatype, 70);
  header.writeInt16LE(bitpix, 72);
  [1, ...pixdims, 1, 1, 1, 1].forEach((value, index) => header.writeFloatLE(value, 76 + index * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeInt16LE(1, 254);
  srow.forEach((row, r) => row.forEach((value, c) => header.writeFloatLE(value, 280 + (r * 4 + c) * 4)));
  header.write('n+1\0', 344, 'binary');
  return Buffer.concat([header, Buffer.from(voxels.buffer)]);
}

// The workflow image: 40 x 32 x 12 voxels of 0.5 x 0.8 x 2 mm. RAS voxel
// (x, y, z) is native voxel (i, j, k) = (39 - y, 31 - z, x).
const D = [40, 32, 12];
const PIX = [0.5, 0.8, 2];
const nativeIndex = (i, j, k) => i + D[0] * (j + D[1] * k);
const inCord = (i, k) => Math.abs(i - 20) < 6 && Math.abs(k - 6) < 3;

function inputVolume() {
  const voxels = new Int16Array(D[0] * D[1] * D[2]);
  for (let k = 0; k < D[2]; k += 1) for (let j = 0; j < D[1]; j += 1) for (let i = 0; i < D[0]; i += 1) {
    voxels[nativeIndex(i, j, k)] = 100 + 5 * i + (inCord(i, k) ? 500 : 0);
  }
  return nifti(D, PIX, SROW, 4, 16, voxels);
}

function maskVolume() {
  const voxels = new Uint8Array(D[0] * D[1] * D[2]);
  for (let k = 0; k < D[2]; k += 1) for (let j = 0; j < D[1]; j += 1) for (let i = 0; i < D[0]; i += 1) {
    if (inCord(i, k)) voxels[nativeIndex(i, j, k)] = 1;
  }
  return voxels;
}

// The worker writes stage files from the input header (createNiftiFromData):
// uint8, scl 1/0, cal_max the largest label.
function stageFile(voxels, dims = D, pixdims = PIX, srow = SROW) {
  const file = nifti(dims, pixdims, srow, 2, 8, voxels);
  file.writeFloatLE(Math.max(1, ...voxels), 124);
  return file;
}

const voxelsOf = bytes => new Uint8Array(bytes.buffer, bytes.byteOffset + Math.round(bytes.readFloatLE(108)), bytes.length - Math.round(bytes.readFloatLE(108)));

async function openApp(page) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.app?.automation), null, { timeout: 120000 });
  await poll(() => page.evaluate(() => app.isViewerAvailable())).toBe(true);
}

async function loadInput(page, buffer = inputVolume(), name = 'sub-01_T2w.nii') {
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name)), { timeout: 120000 }).toEqual([name]);
  await expect(page.locator('#stepInferenceSection')).not.toHaveClass(/step-disabled/, { timeout: 120000 });
}

// Hands the app a stage exactly as the inference worker does.
async function deliverStage(page, stage, taskId, buffer) {
  const count = await page.evaluate(() => app.nv.volumes.length);
  await page.evaluate(([stageId, task, bytes]) => {
    app.inferenceExecutor.handleStageData({ stage: stageId, taskId: task, niftiData: Uint8Array.from(bytes).buffer });
  }, [stage, taskId, [...buffer]]);
  await poll(() => page.evaluate(() => app.nv.volumes.length)).toBe(count + 1);
}

const resultRow = (page, label) => page.locator('#stageButtons .volume-toggle', { has: page.locator('.stage-label', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) });
const editorRow = page => page.locator('nd-mask-editor');
const editorButton = (page, name) => editorRow(page).getByRole('button', { name, exact: true });

async function startEditing(page, label) {
  await resultRow(page, label).locator('.nd-edit-btn').click();
  await poll(() => page.evaluate(() => app.manualEdits.session.state)).toBe('editing');
  await expect(editorRow(page)).toBeVisible();
}

// A one-voxel brush, so every stroke lands on known voxels.
async function thinBrush(page) {
  await editorRow(page).locator('input[type="range"]').fill('1');
  await poll(() => page.evaluate(() => app.nv.drawPenSize)).toBe(1);
}

async function apply(page) {
  await editorButton(page, 'Apply').click();
  await poll(() => page.evaluate(() => app.manualEdits.isEditing())).toBe(false);
}

// Axial view of one slice, and page coordinates of the centre of RAS voxel
// (x, y) on it, from NiiVue's own tile layout.
async function axialView(page) {
  await page.evaluate(() => {
    app.nv.sliceType = 0;
    app.nv.drawScene();
  });
  await poll(() => page.evaluate(() => app.nv.view?.screenSlices?.length === 1 && app.nv.view.screenSlices[0].axCorSag === 0)).toBe(true);
  const box = await page.locator('#freebrowseViewer canvas').first().boundingBox();
  const tile = await page.evaluate(() => {
    const canvas = app.nv.canvas || document.querySelector('#freebrowseViewer').shadowRoot.querySelector('canvas');
    const [slice] = app.nv.view.screenSlices;
    return {
      scale: canvas.width / canvas.clientWidth,
      ltwh: slice.leftTopWidthHeight,
      mn: [slice.screen.mnMM[0], slice.screen.mnMM[1]],
      mx: [slice.screen.mxMM[0], slice.screen.mxMM[1]],
    };
  });
  // RAS voxel centres in mm: X = 2x - 10, Y = 0.5y + 0.5 (from SROW).
  return (x, y) => {
    const [left, top, width, height] = tile.ltwh.map(value => value / tile.scale);
    const mmX = 2 * x - 10;
    const mmY = 0.5 * y + 0.5;
    return [
      box.x + left + ((mmX - tile.mn[0]) / (tile.mx[0] - tile.mn[0])) * width,
      box.y + top + (1 - (mmY - tile.mn[1]) / (tile.mx[1] - tile.mn[1])) * height,
    ];
  };
}

async function stroke(page, points) {
  const [first, ...rest] = points;
  await page.mouse.move(...first);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(...point, { steps: 8 });
  await page.mouse.up();
}

async function downloadStage(page, label) {
  const [download] = await Promise.all([page.waitForEvent('download'), resultRow(page, label).locator('.download-btn').click()]);
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

// Voxels of the drawing layer that differ from the mask the session opened.
const drawnVoxels = page => page.evaluate(() => {
  const bitmap = app.nv.drawingVolume?.img;
  if (!bitmap) return -1;
  let count = 0;
  for (let index = 0; index < bitmap.length; index += 1) if (bitmap[index] !== window.__openedDrawing[index]) count += 1;
  return count;
});
const rememberOpenedDrawing = page => page.evaluate(() => { window.__openedDrawing = app.nv.drawingVolume.img.slice(); });

function changes(before, after) {
  const list = [];
  for (let index = 0; index < before.length; index += 1) {
    if (before[index] !== after[index]) {
      const i = index % D[0];
      const j = Math.floor(index / D[0]) % D[1];
      const k = Math.floor(index / (D[0] * D[1]));
      list.push({ i, j, k, from: before[index], to: after[index] });
    }
  }
  return list;
}

test.setTimeout(300000);

test('a stage round-trips voxel-exactly through the shared editor on a permuted, anisotropic image', async ({ page }) => {
  // 20 x 14 x 7 voxels of 0.5 x 0.8 x 3 mm: NiiVue reports permRAS [3, -1, -2].
  const dims = [20, 14, 7];
  const pixdims = [0.5, 0.8, 3];
  const srow = [[0, 0, 3, -10], [-0.5, 0, 0, 20], [0, -0.8, 0, 30]];
  const input = nifti(dims, pixdims, srow, 4, 16, Int16Array.from({ length: 1960 }, (_, index) => 100 + (index % 37) * 7));
  const labels = Uint8Array.from({ length: 1960 }, (_, index) => {
    const i = index % 20;
    const j = Math.floor(index / 20) % 14;
    const k = Math.floor(index / 280);
    return i > 2 && i < 17 && j > 1 && k > 0 ? 1 + ((i + 2 * j + 3 * k) % 4) : 0;
  });
  const model = stageFile(labels, dims, pixdims, srow);

  await openApp(page);
  await loadInput(page, input, 'permuted.nii');
  await deliverStage(page, 'spine_step1', 'spine', model);

  const geometry = await page.evaluate(() => ({
    permRAS: [...app.nv.volumes[0].permRAS],
    dimsRAS: [...app.nv.volumes[0].dimsRAS],
  }));
  expect(geometry).toEqual({ permRAS: [3, -1, -2], dimsRAS: [3, 7, 20, 14] });

  await startEditing(page, 'TotalSpineSeg Labels');
  // The drawing sits exactly where NiiVue shows the overlay.
  const misplaced = await page.evaluate(() => {
    const overlay = app.nv.volumes.find(volume => /spine_step1/.test(volume.name));
    const bitmap = app.nv.drawingVolume.img;
    const [, X, Y, Z] = app.nv.volumes[0].dimsRAS;
    const s = overlay.img2RASstart;
    const t = overlay.img2RASstep;
    let count = 0;
    let index = 0;
    for (let z = 0; z < Z; z += 1) for (let y = 0; y < Y; y += 1) for (let x = 0; x < X; x += 1, index += 1) {
      if (bitmap[index] !== overlay.img[s[0] + x * t[0] + s[1] + y * t[1] + s[2] + z * t[2]]) count += 1;
    }
    return count;
  });
  expect(misplaced).toBe(0);
  // FreeBrowse's own drawing controls are locked, not hidden, for the session.
  await page.locator('#freebrowseViewer button[title="Show sidebar"]').click().catch(() => {});
  await poll(() => page.evaluate(() => {
    const root = document.querySelector('#freebrowseViewer').shadowRoot;
    const tab = root.querySelector('[role="tab"][id$="-trigger-drawing"]');
    return tab ? { inert: tab.inert, shown: tab.getClientRects().length > 0 } : null;
  })).toEqual({ inert: true, shown: true });

  // Apply without a change: nothing is marked edited.
  await apply(page);
  await expect(page.locator('#stageButtons')).not.toContainText('(edited)');
  expect(await page.evaluate(() => document.querySelector('#freebrowseViewer').shadowRoot.querySelector('[role="tab"][id$="-trigger-drawing"]')?.inert)).toBe(false);

  // One painted voxel: RAS voxel 0 is native (19, 13, 0); nothing else changes.
  await startEditing(page, 'TotalSpineSeg Labels');
  await page.evaluate(() => {
    app.nv.drawingVolume.img[0] = 70;
    app.nv.refreshDrawing();
  });
  await apply(page);
  await poll(() => page.evaluate(() => app.inferenceExecutor.getResult('spine_step1').manualEdit?.changedVoxels)).toBe(1);
  await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name))).toEqual(['permuted.nii', 'spine_spine_step1_edited.nii']);
  const { name, bytes } = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  expect(name).toBe('spine_spine_step1_edited.nii');
  const expected = Uint8Array.from(labels);
  expected[19 + 20 * 13] = 70;
  expect([...voxelsOf(bytes)]).toEqual([...expected]);
  // The model output's header, apart from the display range the editor clears.
  const header = Buffer.from(bytes.subarray(0, 352));
  const reference = Buffer.from(model.subarray(0, 352));
  for (const buffer of [header, reference]) buffer.fill(0, 124, 132);
  expect(header.equals(reference)).toBe(true);
});

test('draw, erase and fill on the canvas with the shared toolbar, with undo, labels and SCT analysis', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  const model = maskVolume();
  await deliverStage(page, 'segmentation', 'lesion_sci_t2', stageFile(model));
  await poll(() => page.evaluate(() => app.analysis.generated.cord?.name)).toBe('lesion_sci_t2_segmentation.nii');

  // Draw: one stroke on background, outside the cord (RAS x = k, y = 39 - i).
  await startEditing(page, 'SCT Segmentation');
  await expect(editorRow(page)).toContainText('Editing SCT Segmentation');
  await expect(editorButton(page, 'Draw')).toHaveAttribute('aria-pressed', 'true');
  await rememberOpenedDrawing(page);
  await thinBrush(page);
  const at = await axialView(page);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => drawnVoxels(page)).toBeGreaterThan(0);

  // Undo takes the stroke back; draw it again.
  await editorButton(page, 'Undo').click();
  await poll(() => drawnVoxels(page)).toBe(0);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => drawnVoxels(page)).toBeGreaterThan(0);
  await apply(page);
  await expect(page.locator('#stageButtons')).toContainText('SCT Segmentation (edited)');
  let download = await downloadStage(page, 'SCT Segmentation (edited)');
  expect(download.name).toBe('lesion_sci_t2_segmentation_edited.nii');
  const drawn = changes(model, voxelsOf(download.bytes));
  expect(drawn.length).toBeGreaterThan(3);
  const drawnSlice = drawn[0].j;
  for (const voxel of drawn) {
    expect(voxel).toMatchObject({ from: 0, to: 1, k: 1, j: drawnSlice });
    expect(voxel.i).toBeGreaterThanOrEqual(39 - 13);
    expect(voxel.i).toBeLessThanOrEqual(39 - 3);
  }
  await expect(page.locator('#spinalcordtoolbox-log')).toContainText(/Manual edit applied to SCT Segmentation: \d+ voxels changed/);
  // SCT analysis offers the edited cord mask.
  expect(await page.evaluate(() => app.analysis.generated.cord?.name)).toBe('lesion_sci_t2_segmentation_edited.nii');
  let current = voxelsOf(download.bytes).slice();

  // Erase: a stroke across the cord at x = 6 (native k = 6), then a second
  // stroke elsewhere must not bring the erased voxels back.
  await startEditing(page, 'SCT Segmentation (edited)');
  await thinBrush(page);
  await editorButton(page, 'Erase').click();
  await stroke(page, [at(6, 10), at(6, 30)]);
  await editorButton(page, 'Draw').click();
  await stroke(page, [at(1, 20), at(1, 22)]);
  await apply(page);
  download = await downloadStage(page, 'SCT Segmentation (edited)');
  const after = changes(current, voxelsOf(download.bytes));
  const erased = after.filter(voxel => voxel.to === 0);
  expect(erased.length).toBeGreaterThan(3);
  for (const voxel of erased) expect(voxel).toMatchObject({ from: 1, k: 6 });
  for (const voxel of after.filter(item => item.to === 1)) expect(voxel).toMatchObject({ from: 0, k: 1 });
  current = voxelsOf(download.bytes).slice();

  // Fill: a closed outline on background (x 9..11, y 2..10) fills its inside.
  await startEditing(page, 'SCT Segmentation (edited)');
  await thinBrush(page);
  await editorButton(page, 'Fill').click();
  await stroke(page, [at(9, 2), at(11, 2), at(11, 10), at(9, 10), at(9, 2)]);
  await apply(page);
  download = await downloadStage(page, 'SCT Segmentation (edited)');
  const filled = changes(current, voxelsOf(download.bytes));
  for (const voxel of filled) expect(voxel).toMatchObject({ from: 0, to: 1 });
  // The centre of the outline, x 10 y 6 (native i 33, k 10), is filled, not just the rim.
  expect(voxelsOf(download.bytes)[nativeIndex(33, filled[0].j, 10)]).toBe(1);
  expect(filled.length).toBeGreaterThanOrEqual(3 * 9);
});

test('the Label select paints a named label in a multi-label stage; Cancel keeps the stage', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  const model = maskVolume();
  await deliverStage(page, 'spine_step1', 'spine', stageFile(model));
  await startEditing(page, 'TotalSpineSeg Labels');
  await editorRow(page).getByRole('combobox').selectOption({ label: '63 — C2-C3 disc' });
  await rememberOpenedDrawing(page);
  await thinBrush(page);
  const at = await axialView(page);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => drawnVoxels(page)).toBeGreaterThan(0);
  await apply(page);
  const { bytes } = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  const painted = changes(model, voxelsOf(bytes));
  expect(painted.length).toBeGreaterThan(0);
  for (const voxel of painted) expect(voxel.to).toBe(63);

  // Cancel closes the layer and keeps the stage as it was; its overlay returns.
  await startEditing(page, 'TotalSpineSeg Labels (edited)');
  await poll(() => page.evaluate(() => app.nv.volumes[1].opacity)).toBe(0);
  await page.evaluate(() => {
    app.nv.drawingVolume.img.fill(0);
  });
  await editorButton(page, 'Cancel').click();
  await poll(() => page.evaluate(() => app.manualEdits.isEditing())).toBe(false);
  expect(await page.evaluate(() => app.nv.drawingVolume)).toBeNull();
  await poll(() => page.evaluate(() => app.nv.volumes[1].opacity)).toBeGreaterThan(0);
  const kept = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  expect(kept.bytes.equals(bytes)).toBe(true);
});

test('an edit belongs to its image: it survives switching images, shows in Compare and is not dropped unasked', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  const model = maskVolume();
  await deliverStage(page, 'segmentation', 'spinalcord', stageFile(model));
  await startEditing(page, 'SCT Segmentation');
  await rememberOpenedDrawing(page);
  await thinBrush(page);
  const at = await axialView(page);
  await stroke(page, [at(1, 4), at(1, 6)]);
  await poll(() => drawnVoxels(page)).toBeGreaterThan(0);
  const strokeVoxels = await drawnVoxels(page);

  // A new run on this image would replace its results: dismissed, nothing runs, the drawing stays.
  const messages = [];
  page.once('dialog', dialog => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator('#runSegmentation').click();
  await poll(() => messages.length).toBe(1);
  expect(messages[0]).toMatch(/A new segmentation run discards your manual edits to SCT Segmentation/);
  expect(await page.evaluate(() => app.manualEdits.session.state)).toBe('editing');
  expect(await page.evaluate(() => app.inferenceExecutor.isRunning())).toBe(false);

  // A second image: the open drawing is applied to the first image, which keeps its results.
  await loadInput(page, inputVolume(), 'other.nii');
  expect(messages).toHaveLength(1);
  expect(await page.evaluate(() => app.manualEdits.isEditing())).toBe(false);
  await expect(page.locator('#stageButtons')).not.toContainText('SCT Segmentation');
  expect(await page.evaluate(() => app.analysis.generated)).toEqual({});
  const firstId = await page.evaluate(() => app.getInputSessions().find(session => session.name === 'sub-01_T2w.nii').id);

  // Compare draws the first image's edited stage in its panel.
  await page.locator('#compareViewButton').click();
  await poll(() => page.evaluate(() => app.getComparisonPanels().map(panel => panel.entries.map(entry => entry.file.name)))).toEqual([
    ['sub-01_T2w.nii', 'spinalcord_segmentation_edited.nii'],
    ['other.nii'],
  ]);
  await page.locator('#singleViewButton').click();

  // Back on the first image the edit, its mark and its analysis mask choice are all there.
  await page.evaluate(id => app.fileIOController.activateSession(id), firstId);
  await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name))).toEqual(['sub-01_T2w.nii', 'spinalcord_segmentation_edited.nii']);
  await expect(page.locator('#stageButtons')).toContainText('SCT Segmentation (edited)');
  await poll(() => page.evaluate(() => app.analysis.generated.cord?.name)).toBe('spinalcord_segmentation_edited.nii');
  const { bytes } = await downloadStage(page, 'SCT Segmentation (edited)');
  expect(changes(model, voxelsOf(bytes))).toHaveLength(strokeVoxels);

  // Not downloaded edits elsewhere: an example replaces every image, so it asks.
  const otherId = await page.evaluate(() => app.getInputSessions().find(session => session.name === 'other.nii').id);
  await page.evaluate(id => app.fileIOController.activateSession(id), otherId);
  await poll(() => page.evaluate(() => app.inputFile?.name)).toBe('other.nii');
  await page.evaluate(() => {
    const parked = [...app.sessionResults.parked.values()][0];
    parked.results.segmentation.manualEdit.downloaded = false;
  });
  page.once('dialog', dialog => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  const example = await page.locator('select[data-neurodesk-example] option').nth(1).getAttribute('value');
  await page.locator('select[data-neurodesk-example]').selectOption(example);
  await poll(() => messages.length).toBe(2);
  expect(messages[1]).toMatch(/Loading the example discards your manual edits to SCT Segmentation of sub-01_T2w.nii/);
  expect(await page.evaluate(() => app.getInputSessions().length)).toBe(2);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a pinch in draw mode zooms without leaving a pen dot', async ({ page }) => {
    await openApp(page);
    await loadInput(page);
    await deliverStage(page, 'segmentation', 'spinalcord', stageFile(maskVolume()));
    await startEditing(page, 'SCT Segmentation');
    await rememberOpenedDrawing(page);
    const at = await axialView(page);
    const client = await page.context().newCDPSession(page);
    const touch = (type, points) => client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
    });

    // One finger paints.
    await touch('touchStart', [at(1, 8)]);
    await touch('touchEnd', []);
    await poll(() => drawnVoxels(page)).toBeGreaterThan(0);
    const painted = await page.evaluate(() => [...app.nv.drawingVolume.img]);

    // Two fingers zoom; the first finger's touch leaves no dot behind.
    const [x, y] = at(10, 30);
    const zoom = await page.evaluate(() => app.nv.pan2Dxyzmm[3]);
    await touch('touchStart', [[x, y]]);
    await touch('touchStart', [[x, y], [x + 40, y]]);
    for (let step = 1; step <= 5; step += 1) await touch('touchMove', [[x - 8 * step, y], [x + 40 + 8 * step, y]]);
    await touch('touchEnd', []);
    await poll(() => page.evaluate(() => app.nv.pan2Dxyzmm[3])).toBeGreaterThan(zoom * 1.5);
    expect(await page.evaluate(() => [...app.nv.drawingVolume.img])).toEqual(painted);
  });
});
