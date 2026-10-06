import { expect as baseExpect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Compare: several images of one patient (for example before and after
// surgery) side by side, each panel with its own results, linked by world
// position until the user unlinks them.

const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const expect = baseExpect.configure({ timeout: 60000 });
const poll = (read, options = {}) => expect.poll(read, { timeout: 60000, ...options });

// Little-endian NIfTI-1, 1 mm voxels, sform = translation by `origin` mm.
function nifti(datatype, bitpix, dims, origin, voxels) {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [3, ...dims, 1, 1, 1, 1].forEach((value, index) => header.writeInt16LE(value, 40 + index * 2));
  header.writeInt16LE(datatype, 70);
  header.writeInt16LE(bitpix, 72);
  [1, 1, 1, 1, 1, 1, 1, 1].forEach((value, index) => header.writeFloatLE(value, 76 + index * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeInt16LE(1, 254);
  [[1, 0, 0, origin[0]], [0, 1, 0, origin[1]], [0, 0, 1, origin[2]]]
    .forEach((row, r) => row.forEach((value, c) => header.writeFloatLE(value, 280 + (r * 4 + c) * 4)));
  header.write('n+1\0', 344, 'binary');
  return Buffer.concat([header, Buffer.from(voxels.buffer)]);
}

// A cord at world x = y = 12 mm, on two grids of different size and origin.
const GRIDS = {
  pre: { dims: [24, 24, 24], origin: [0, 0, 0] },
  post: { dims: [32, 32, 24], origin: [-4, -4, 0] },
};

function volume({ dims, origin }, mask) {
  const [nx, ny, nz] = dims;
  const voxels = mask ? new Uint8Array(nx * ny * nz) : new Int16Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) {
    const inCord = Math.abs(x + origin[0] - 12) < 3 && Math.abs(y + origin[1] - 12) < 3 && z > 2 && z < 21;
    voxels[x + nx * (y + ny * z)] = mask ? Number(inCord) : 100 + 10 * x + 5 * y + (inCord ? 600 : 0);
  }
  return mask ? nifti(2, 8, dims, origin, voxels) : nifti(4, 16, dims, origin, voxels);
}

async function openApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.app?.automation), null, { timeout: 120000 });
  await poll(() => page.evaluate(() => app.isViewerAvailable())).toBe(true);
}

async function addImage(page, name, grid) {
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: volume(grid) });
  await poll(() => page.evaluate(() => app.getActiveSession()?.name), { timeout: 120000 }).toBe(name);
  await expect(page.locator('#stepInferenceSection')).not.toHaveClass(/step-disabled/, { timeout: 120000 });
}

// Hands the active image a cord mask exactly as the inference worker does.
async function deliverCord(page, grid) {
  await page.evaluate(async (bytes) => {
    app.inferenceExecutor.handleStageData({ stage: 'segmentation', taskId: 'spinalcord', niftiData: Uint8Array.from(bytes).buffer });
  }, [...volume(grid, true)]);
  await expect(page.locator('#stageButtons .view-btn[data-stage="segmentation"]')).toHaveCount(1);
}

const sessionId = (page, name) => page.evaluate(n => app.getInputSessions().find(session => session.name === n).id, name);
const panel = (page, name) => page.locator('#comparisonGrid .nd-compare-panel', { has: page.locator('.nd-compare-title', { hasText: name }) });
const panelVolumes = (page, id) => page.evaluate(i => app.viewer.getComparisonViewer(i)?.volumes.map(v => ({ name: v.name, opacity: v.opacity })) ?? null, id);
const resultNames = page => page.locator('#stageButtons .stage-label').allTextContents();

// Records each panel's crosshair in world mm, as NiiVue reports it.
async function watchCrosshairs(page, ids) {
  await page.evaluate((list) => {
    globalThis.crosshairMm = {};
    for (const id of list) {
      const nv = app.viewer.getComparisonViewer(id);
      globalThis.crosshairMm[id] = null;
      nv.addEventListener('locationChange', event => { globalThis.crosshairMm[id] = event.detail.mm.map(v => Math.round(v * 10) / 10); });
    }
  }, ids);
}

const crosshairs = page => page.evaluate(() => ({ ...globalThis.crosshairMm }));

async function clickPanel(page, name, fx, fy) {
  const box = await panel(page, name).locator('canvas').boundingBox();
  expect(box.width).toBeGreaterThan(60);
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.describe('Compare', () => {
  test.setTimeout(300000);

  test('two sessions side by side: own results, linked by world position, unlinkable, switchable', async ({ page }) => {
    await openApp(page);
    await addImage(page, 'pre_op.nii', GRIDS.pre);
    await addImage(page, 'post_op.nii', GRIDS.post);
    await deliverCord(page, GRIDS.post);
    const pre = await sessionId(page, 'pre_op.nii');
    const post = await sessionId(page, 'post_op.nii');

    // Making the first image active parks the second's result; nothing leaks across.
    await page.locator('#fileList .file-session-select', { hasText: 'pre_op.nii' }).click();
    await poll(() => page.evaluate(() => app.getActiveSession().name)).toBe('pre_op.nii');
    await expect(page.locator('#stageButtons .view-btn[data-stage="segmentation"]')).toHaveCount(0);
    expect(await page.evaluate(id => app.sessionResults.peek(id)?.stageOrder, post)).toEqual(['segmentation']);

    // Compare: one labelled panel per image, the active one marked.
    await page.locator('#compareViewButton').click();
    await expect(page.locator('#comparisonGrid .nd-compare-panel')).toHaveCount(2);
    await expect(page.locator('#comparisonGrid .nd-compare-title')).toHaveText(['pre_op.nii · active', 'post_op.nii']);
    await expect(panel(page, 'pre_op.nii')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#freebrowseViewer')).toBeHidden();
    await expect(page.locator('#compareLayoutSelect')).toBeVisible();
    await expect(page.locator('#compareLinkButton')).toHaveAttribute('aria-pressed', 'true');
    // Each panel shows its own overlays: post has its cord mask, pre has none.
    await poll(() => panelVolumes(page, pre)).toEqual([{ name: 'pre_op.nii', opacity: 1 }]);
    await poll(() => panelVolumes(page, post)).toEqual([{ name: 'post_op.nii', opacity: 1 }, { name: 'spinalcord_segmentation.nii', opacity: 0.7 }]);
    expect(await page.evaluate(id => app.viewer.getComparisonViewer(id).volumes[1].colormapLabel.labels, post)).toEqual(['Background', 'Spinal cord']);

    // Linked: a click in one panel moves the other panel's crosshair to the same
    // world position, although the grids differ in size and origin.
    await page.locator('#compareLayoutSelect').selectOption('0');
    await poll(() => page.evaluate(() => [...app.viewer.compareViewers.values()].map(r => r.nv.sliceType))).toEqual([0, 0]);
    await watchCrosshairs(page, [pre, post]);
    await clickPanel(page, 'pre_op.nii', 0.35, 0.6);
    await poll(async () => {
      const mm = await crosshairs(page);
      return Boolean(mm[pre] && mm[post]) && mm[pre].every((v, i) => Math.abs(v - mm[post][i]) < 0.6);
    }).toBe(true);
    // Zoom and pan follow too.
    await page.evaluate(id => { const nv = app.viewer.getComparisonViewer(id); nv.pan2Dxyzmm = [2, 1, 0, 2]; nv.drawScene(); }, pre);
    await poll(() => page.evaluate(id => Array.from(app.viewer.getComparisonViewer(id).pan2Dxyzmm), post)).toEqual([2, 1, 0, 2]);

    // Unlinked: navigating one panel leaves the other where it was.
    await page.locator('#compareLinkButton').click();
    await expect(page.locator('#compareLinkButton')).toHaveAttribute('aria-pressed', 'false');
    const before = (await crosshairs(page))[post];
    await clickPanel(page, 'pre_op.nii', 0.65, 0.3);
    await poll(async () => JSON.stringify((await crosshairs(page))[pre]) !== JSON.stringify(before)).toBe(true);
    await page.waitForTimeout(500);
    expect((await crosshairs(page))[post]).toEqual(before);
    await page.evaluate(id => { const nv = app.viewer.getComparisonViewer(id); nv.pan2Dxyzmm = [0, 0, 0, 3]; nv.drawScene(); }, pre);
    await page.waitForTimeout(500);
    expect(await page.evaluate(id => app.viewer.getComparisonViewer(id).pan2Dxyzmm[3], post)).toBe(2);
    // Linking again aligns the others to the active panel.
    await page.locator('#compareLinkButton').click();
    await poll(() => page.evaluate(id => app.viewer.getComparisonViewer(id).pan2Dxyzmm[3], post)).toBe(3);

    // The keyboard switches the active image from a panel title; its results come back.
    await panel(page, 'post_op.nii').locator('.nd-compare-title').focus();
    await page.keyboard.press('Enter');
    await expect(panel(page, 'post_op.nii')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#comparisonGrid .nd-compare-title')).toHaveText(['pre_op.nii', 'post_op.nii · active']);
    await poll(() => resultNames(page)).toEqual(['Input', 'SCT Segmentation']);
    expect(await page.evaluate(() => app.inferenceExecutor.getResult('segmentation').file.name)).toBe('spinalcord_segmentation.nii');
    // The switch kept both canvases (and so the user's zoom).
    expect(await page.evaluate(() => app.viewer.getComparisonViewerCount())).toBe(2);
    expect(await page.evaluate(id => app.viewer.getComparisonViewer(id).pan2Dxyzmm[3], pre)).toBe(3);

    // A Results eye applies in Compare without leaving it.
    await page.locator('#stageButtons .view-btn[data-stage="segmentation"]').click();
    await poll(async () => (await panelVolumes(page, post))[1].opacity).toBe(0);
    await expect(page.locator('#compareViewButton')).toHaveClass(/active/);
    await page.locator('#stageButtons .view-btn[data-stage="segmentation"]').click();
    await poll(async () => (await panelVolumes(page, post))[1].opacity).toBe(0.7);

    // Pointer: working in the other panel makes it active.
    await clickPanel(page, 'pre_op.nii', 0.5, 0.5);
    await expect(panel(page, 'pre_op.nii')).toHaveAttribute('aria-current', 'true');
    await poll(() => resultNames(page)).toEqual([]);

    // Removing an image leaves one: Compare closes, the remaining image keeps its result.
    await page.locator('#fileList .file-remove[aria-label="Remove pre_op.nii"]').click();
    await expect(page.locator('#comparisonGrid')).toBeHidden();
    await expect(page.locator('#compareViewButton')).toBeDisabled();
    await expect(page.locator('#compareLayoutSelect')).toBeHidden();
    await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name))).toEqual(['post_op.nii', 'spinalcord_segmentation.nii']);
    expect(await page.evaluate(() => app.viewer.getComparisonViewerCount())).toBe(0);

    // Clearing files forgets every image's results.
    await page.locator('#fileInput').setInputFiles({ name: 'third.nii', mimeType: 'application/octet-stream', buffer: volume(GRIDS.pre) });
    await poll(() => page.evaluate(() => app.getInputSessions().length)).toBe(2);
    expect(await page.evaluate(() => app.sessionResults.size)).toBe(1);
    await page.evaluate(() => app.clearFiles());
    await poll(() => page.evaluate(() => [app.getInputSessions().length, app.sessionResults.size])).toEqual([0, 0]);
  });

  test('a segmentation run on one image leaves the other image\'s results in place', async ({ page }) => {
    test.setTimeout(900000);
    await openApp(page);
    // B: the real T2 example. A: a second image with a result of its own.
    await page.locator('select[data-neurodesk-example]').selectOption(examples[0].id);
    await poll(() => page.evaluate(() => app.getActiveSession()?.name), { timeout: 300000 }).toBe(examples[0].files[0].name);
    await addImage(page, 'earlier.nii', GRIDS.pre);
    await deliverCord(page, GRIDS.pre);
    const earlier = await sessionId(page, 'earlier.nii');
    const earlierFile = await page.evaluate(() => {
      globalThis.earlierMask = app.inferenceExecutor.getResult('segmentation').file;
      return globalThis.earlierMask.size;
    });

    await page.locator('#compareViewButton').click();
    await expect(page.locator('#comparisonGrid .nd-compare-panel')).toHaveCount(2);
    await panel(page, examples[0].files[0].name).locator('.nd-compare-title').click();
    await expect(panel(page, examples[0].files[0].name)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#runSegmentation')).toBeEnabled({ timeout: 120000 });

    await page.locator('#modelSelect').selectOption('spinalcord');
    await page.locator('#runSegmentation').click();
    await expect(page.locator('#stepInferenceBadge')).toHaveText('Done', { timeout: 840000 });
    await poll(() => resultNames(page)).toContain('SCT Segmentation');

    // The run filled B's panel and left A's parked result untouched.
    const exampleId = await sessionId(page, examples[0].files[0].name);
    await poll(async () => (await panelVolumes(page, exampleId)).length).toBe(2);
    expect(await page.evaluate(id => app.sessionResults.peek(id).results.segmentation.file === globalThis.earlierMask, earlier)).toBe(true);
    expect((await panelVolumes(page, earlier)).map(v => v.name)).toEqual(['earlier.nii', 'spinalcord_segmentation.nii']);

    // Back on A: its own mask, and B's is parked in turn.
    await panel(page, 'earlier.nii').locator('.nd-compare-title').click();
    await poll(() => page.evaluate(() => app.inferenceExecutor.getResult('segmentation')?.file === globalThis.earlierMask)).toBe(true);
    expect(await page.evaluate(() => app.inferenceExecutor.getResult('segmentation').file.size)).toBe(earlierFile);
    expect(await page.evaluate(id => app.sessionResults.peek(id)?.stageOrder.includes('segmentation'), exampleId)).toBe(true);
  });
});
