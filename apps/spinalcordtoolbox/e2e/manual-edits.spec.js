import { expect as baseExpect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Manual mask editing on FreeBrowse's drawing layer: the SCT Edit masks
// section puts a result stage on the layer, the test draws, erases and fills
// on the real canvas with FreeBrowse's own Drawing tab, and the downloaded
// mask must hold exactly what was painted, in the original image geometry.
// Every image here is anisotropic and stored in a permuted, flipped
// orientation (i -> posterior, j -> inferior, k -> right), where NiiVue's own
// loadDrawing does not round-trip.

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

function maskVolume(value = index => index) {
  const voxels = new Uint8Array(D[0] * D[1] * D[2]);
  for (let k = 0; k < D[2]; k += 1) for (let j = 0; j < D[1]; j += 1) for (let i = 0; i < D[0]; i += 1) {
    if (inCord(i, k)) voxels[nativeIndex(i, j, k)] = value(1);
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

async function openEditSection(page) {
  const section = page.locator('#editSection');
  await expect(section).not.toHaveClass(/step-disabled/);
  if (/collapsed/.test(await section.getAttribute('class'))) await section.locator('.section-toggle').click();
}

async function startEditing(page, choice) {
  await openEditSection(page);
  if (choice) await page.locator('#editStageSelect').selectOption(choice);
  await page.locator('#editStart').click();
  await poll(() => page.evaluate(() => app.manualEdits.isEditing())).toBe(true);
  await expect(page.locator('#editApply')).toBeVisible();
}

const drawingField = (page, label) => page.locator('#freebrowseViewer div.space-y-2', { has: page.getByText(label, { exact: true }) }).first();

async function choosePen(page) {
  await drawingField(page, 'Draw Mode').locator('select').selectOption('pen');
  await poll(() => page.evaluate(() => app.nv.drawIsEnabled)).toBe(true);
}

async function setCheckbox(page, id, checked) {
  const box = page.locator(`#freebrowseViewer #${id}`);
  if ((await box.getAttribute('aria-checked')) !== String(checked)) await box.click();
  await expect(box).toHaveAttribute('aria-checked', String(checked));
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
  const row = page.locator('#stageButtons .volume-toggle', { hasText: label });
  const [download] = await Promise.all([page.waitForEvent('download'), row.locator('.download-btn').click()]);
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

// RAS z of the axial slice NiiVue shows.
const shownSlice = page => page.evaluate(() => Math.round(app.nv.view.screenSlices[0].planePoint[2] ?? 0));

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

test('a stage round-trips voxel-exactly through the drawing layer, from SCT and from FreeBrowse', async ({ page }) => {
  // 20 x 14 x 7 voxels of 0.5 x 0.8 x 3 mm, the case scripts/test_manual_edits.mjs replays.
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
    start: [...app.nv.volumes[0].img2RASstart],
    step: [...app.nv.volumes[0].img2RASstep],
  }));
  expect(geometry).toEqual({ permRAS: [3, -1, -2], dimsRAS: [3, 7, 20, 14], start: [0, 19, 260], step: [280, -1, -20] });

  const checkLayer = () => page.evaluate(() => {
    const overlay = app.nv.volumes.find(volume => /spine_step1/.test(volume.name));
    const bitmap = app.nv.drawingVolume.img;
    const [, X, Y, Z] = app.nv.volumes[0].dimsRAS;
    let misplaced = 0;
    let index = 0;
    // The drawing must sit exactly where NiiVue shows the overlay.
    for (let z = 0; z < Z; z += 1) for (let y = 0; y < Y; y += 1) for (let x = 0; x < X; x += 1, index += 1) {
      const s = overlay.img2RASstart;
      const t = overlay.img2RASstep;
      if (bitmap[index] !== overlay.img[s[0] + x * t[0] + s[1] + y * t[1] + s[2] + z * t[2]]) misplaced += 1;
    }
    return { misplaced, exported: [...app.manualEdits.editor.currentNative()] };
  });

  // SCT's Edit mask, no edits: the layer matches the overlay and exports the input mask.
  await startEditing(page, 'spine_step1');
  const sct = await checkLayer();
  expect(sct.misplaced).toBe(0);
  expect(sct.exported).toEqual([...labels]);
  await page.locator('#editApply').click();
  await poll(() => page.evaluate(() => app.manualEdits.isEditing())).toBe(false);
  await expect(page.locator('#stageButtons')).not.toContainText('(edited)');

  // FreeBrowse's own Edit as drawing on the overlay is taken over and refilled.
  await page.locator('#freebrowseViewer [role="tab"][id$="-trigger-sceneDetails"]').dispatchEvent('mousedown', { button: 0 });
  await page.locator('#freebrowseViewer button[title="Edit as drawing"]').last().click();
  await poll(() => page.evaluate(() => app.manualEdits.editingStage)).toBe('spine_step1');
  await poll(() => page.evaluate(() => app.nv.drawingVolume && app.manualEdits.editor.changedVoxels() === 0 && app.manualEdits.editor.currentNative().some(Boolean))).toBe(true);
  const adopted = await page.evaluate(() => [...app.manualEdits.editor.currentNative()]);
  expect(adopted).toEqual([...labels]);

  // One painted voxel, then FreeBrowse's Save Drawing applies it to the stage.
  await page.evaluate(() => {
    app.nv.drawingVolume.img[0] = 70;
    app.nv.refreshDrawing();
  });
  await page.locator('#freebrowseViewer button', { hasText: 'Save Drawing' }).click();
  await poll(() => page.evaluate(() => app.inferenceExecutor.getResult('spine_step1').manualEdit?.changedVoxels)).toBe(1);
  await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name))).toEqual(['permuted.nii', 'spine_spine_step1_edited.nii']);
  const { name, bytes } = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  expect(name).toBe('spine_spine_step1_edited.nii');
  // RAS voxel 0 is native (19, 13, 0); nothing else changed.
  const expected = Uint8Array.from(labels);
  expected[19 + 20 * 13] = 70;
  expect([...voxelsOf(bytes)]).toEqual([...expected]);
  // Same header as the model output apart from cal_max (the largest label is now 70).
  const header = Buffer.from(bytes.subarray(0, 352));
  expect(header.readFloatLE(124)).toBe(70);
  header.writeFloatLE(model.readFloatLE(124), 124);
  expect(header.equals(model.subarray(0, 352))).toBe(true);
});

test('draw, erase and fill on the canvas, with undo, restore and lesion metrics', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  const model = maskVolume(() => 1);
  await deliverStage(page, 'segmentation', 'lesion_sci_t2', stageFile(model));
  await page.evaluate(() => { app.selectedTask = { id: 'lesion_sci_t2' }; });

  // Draw: one stroke on background, outside the cord (RAS x = k, y = 39 - i).
  await startEditing(page, 'segmentation');
  await choosePen(page);
  await setCheckbox(page, 'pen-erases', false);
  const at = await axialView(page);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);

  // Undo takes the stroke back; draw it again.
  await page.locator('#freebrowseViewer button', { hasText: 'Undo' }).click();
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBe(0);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
  const slice = await page.evaluate(() => {
    const [, X, Y] = app.nv.volumes[0].dimsRAS;
    const bitmap = app.nv.drawingVolume.img;
    const zs = new Set();
    for (let index = 0; index < bitmap.length; index += 1) if (bitmap[index] && !app.manualEdits.editor.session.original[index]) zs.add(Math.floor(index / (X * Y)));
    return [...zs];
  });
  expect(slice).toHaveLength(1);
  await page.locator('#editApply').click();
  await expect(page.locator('#stageButtons')).toContainText('SCT Segmentation (edited)');
  let download = await downloadStage(page, 'SCT Segmentation (edited)');
  expect(download.name).toBe('lesion_sci_t2_segmentation_edited.nii');
  const drawn = changes(model, voxelsOf(download.bytes));
  expect(drawn.length).toBeGreaterThan(3);
  for (const voxel of drawn) {
    expect(voxel).toMatchObject({ from: 0, to: 1, k: 1, j: 31 - slice[0] });
    expect(voxel.i).toBeGreaterThanOrEqual(39 - 13);
    expect(voxel.i).toBeLessThanOrEqual(39 - 3);
  }
  await expect(page.locator('#spinalcordtoolbox-log')).toContainText(/Manual edit applied to SCT Segmentation: \d+ voxels changed/);
  let current = voxelsOf(download.bytes).slice();

  // Erase: a stroke across the cord at x = 6 (native k = 6).
  await startEditing(page, 'segmentation');
  await choosePen(page);
  await setCheckbox(page, 'pen-erases', true);
  await stroke(page, [at(6, 10), at(6, 30)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
  await page.locator('#editApply').click();
  download = await downloadStage(page, 'SCT Segmentation (edited)');
  const erased = changes(current, voxelsOf(download.bytes));
  expect(erased.length).toBeGreaterThan(3);
  for (const voxel of erased) expect(voxel).toMatchObject({ from: 1, to: 0, k: 6 });
  current = voxelsOf(download.bytes).slice();

  // Fill: a closed outline on background (x 9..11, y 2..10) with Pen Fill fills its inside.
  await startEditing(page, 'segmentation');
  await choosePen(page);
  await setCheckbox(page, 'pen-erases', false);
  await setCheckbox(page, 'pen-fill', true);
  await stroke(page, [at(9, 2), at(11, 2), at(11, 10), at(9, 10), at(9, 2)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
  await page.locator('#editApply').click();
  download = await downloadStage(page, 'SCT Segmentation (edited)');
  const filled = changes(current, voxelsOf(download.bytes));
  for (const voxel of filled) expect(voxel).toMatchObject({ from: 0, to: 1 });
  // The centre of the outline, x 10 y 6 (native i 33, k 10), is filled, not just the rim.
  const fillSlice = filled[0].j;
  expect(voxelsOf(download.bytes)[nativeIndex(33, fillSlice, 10)]).toBe(1);
  expect(filled.length).toBeGreaterThanOrEqual(3 * 9);

  // Restore the model's mask.
  await page.locator('#editStageSelect').selectOption('segmentation');
  await page.locator('#editRevert').click();
  await expect(page.locator('#stageButtons')).not.toContainText('(edited)');
  download = await downloadStage(page, 'SCT Segmentation');
  expect(download.name).toBe('lesion_sci_t2_segmentation.nii');
  expect([...voxelsOf(download.bytes)]).toEqual([...model]);

  // A lesion mask drawn from nothing: a new stage, measured against the cord.
  await startEditing(page, 'new:lesion');
  await expect(page.locator('#editLabelSelect')).toHaveValue('1');
  await choosePen(page);
  await setCheckbox(page, 'pen-erases', false);
  await stroke(page, [at(6, 18), at(6, 21)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
  await page.locator('#editApply').click();
  await expect(page.locator('#stageButtons')).toContainText('Lesion (drawn)');
  await poll(() => page.evaluate(() => app.inferenceExecutor.getResult('lesion_metrics')?.summary?.lesion_count ?? null), { timeout: 120000 }).toBe(1);
  await expect(page.locator('#metricsResults')).toBeVisible();
});

test('the pen paints the label chosen by name in a multi-label stage', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  const model = maskVolume(() => 1);
  await deliverStage(page, 'spine_step1', 'spine', stageFile(model));
  await startEditing(page, 'spine_step1');
  await page.locator('#editLabelSelect').selectOption({ label: 'C2-C3 disc' });
  await choosePen(page);
  await setCheckbox(page, 'pen-erases', false);
  // FreeBrowse's own Pen Value field follows the label chosen in SCT.
  await expect(drawingField(page, 'Pen Value').locator('input[type="number"]')).toHaveValue('63');
  const at = await axialView(page);
  await stroke(page, [at(1, 4), at(1, 12)]);
  await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
  await page.locator('#editApply').click();
  const { bytes } = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  const painted = changes(model, voxelsOf(bytes));
  expect(painted.length).toBeGreaterThan(0);
  for (const voxel of painted) expect(voxel.to).toBe(63);
  expect(bytes.readFloatLE(124)).toBe(63);

  // Discard closes the layer and keeps the stage as it was; its overlay returns.
  await startEditing(page, 'spine_step1');
  await poll(() => page.evaluate(() => app.nv.volumes[1].opacity)).toBe(0);
  await page.evaluate(() => {
    app.nv.drawingVolume.img.fill(0);
  });
  await page.locator('#editDiscard').click();
  await poll(() => page.evaluate(() => app.manualEdits.isEditing())).toBe(false);
  expect(await page.evaluate(() => app.nv.drawingVolume)).toBeNull();
  await poll(() => page.evaluate(() => app.nv.volumes[1].opacity)).toBeGreaterThan(0);
  const kept = await downloadStage(page, 'TotalSpineSeg Labels (edited)');
  expect(kept.bytes.equals(bytes)).toBe(true);
});

test('unsaved edits are not dropped by a new run or a new file without asking', async ({ page }) => {
  await openApp(page);
  await loadInput(page);
  await deliverStage(page, 'segmentation', 'spinalcord', stageFile(maskVolume(() => 1)));
  await startEditing(page, 'segmentation');
  await page.evaluate(() => {
    app.nv.drawingVolume.img[0] = 1;
  });

  // Dismissed: nothing runs, the drawing stays.
  const messages = [];
  page.once('dialog', dialog => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator('#runSegmentation').click();
  await poll(() => messages.length).toBe(1);
  expect(messages[0]).toMatch(/A new segmentation run discards your manual edits to SCT Segmentation/);
  expect(await page.evaluate(() => app.manualEdits.isEditing())).toBe(true);
  expect(await page.evaluate(() => app.inferenceExecutor.isRunning())).toBe(false);

  // Applied but not downloaded still counts; downloading saves it.
  await page.locator('#editApply').click();
  await expect(page.locator('#stageButtons')).toContainText('(edited)');
  page.once('dialog', dialog => {
    messages.push(dialog.message());
    void dialog.dismiss();
  });
  await page.locator('#fileInput').setInputFiles({ name: 'other.nii', mimeType: 'application/octet-stream', buffer: inputVolume() });
  await poll(() => messages.length).toBe(2);
  expect(await page.evaluate(() => app.inputFile.name)).toBe('sub-01_T2w.nii');
  await downloadStage(page, 'SCT Segmentation (edited)');

  // Saved: a new file loads without a question.
  await loadInput(page, inputVolume(), 'other.nii');
  expect(messages).toHaveLength(2);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a pinch in draw mode zooms without leaving a pen dot', async ({ page }) => {
    await openApp(page);
    await loadInput(page);
    await deliverStage(page, 'segmentation', 'spinalcord', stageFile(maskVolume(() => 1)));
    await startEditing(page, 'segmentation');
    await choosePen(page);
    const at = await axialView(page);
    const client = await page.context().newCDPSession(page);
    const touch = (type, points) => client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
    });

    // One finger paints.
    await touch('touchStart', [at(1, 8)]);
    await touch('touchEnd', []);
    await poll(() => page.evaluate(() => app.manualEdits.editor.changedVoxels())).toBeGreaterThan(0);
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
