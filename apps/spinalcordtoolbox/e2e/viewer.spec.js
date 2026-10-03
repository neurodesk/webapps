import { expect as baseExpect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The viewer is FreeBrowse around NiiVue 1.0, mounted in an open shadow root
// on #freebrowseViewer. Playwright locators pierce open shadow roots.
const examples = JSON.parse(readFileSync(new URL('../examples.json', import.meta.url), 'utf8'));
const SIZE = 24;

// Software WebGL on a busy CI runner is slow; every assertion waits up to a minute.
const expect = baseExpect.configure({ timeout: 60000 });
const poll = (read, options = {}) => expect.poll(read, { timeout: 60000, ...options });

// A minimal little-endian NIfTI-1 volume: 1 mm isotropic, identity sform.
function nifti(datatype, bitpix, voxels) {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [3, SIZE, SIZE, SIZE, 1, 1, 1, 1].forEach((value, index) => header.writeInt16LE(value, 40 + index * 2));
  header.writeInt16LE(datatype, 70);
  header.writeInt16LE(bitpix, 72);
  [1, 1, 1, 1, 1, 1, 1, 1].forEach((value, index) => header.writeFloatLE(value, 76 + index * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeInt16LE(1, 254);
  [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]].forEach((row, r) => row.forEach((value, c) => header.writeFloatLE(value, 280 + (r * 4 + c) * 4)));
  header.write('n+1\0', 344, 'binary');
  return Buffer.concat([header, Buffer.from(voxels.buffer)]);
}

const index = (x, y, z) => x + SIZE * (y + SIZE * z);
const inCord = (x, y, z) => Math.abs(x - 12) < 3 && Math.abs(y - 12) < 3 && z > 2 && z < 21;

function inputVolume() {
  const voxels = new Int16Array(SIZE ** 3);
  for (let z = 0; z < SIZE; z += 1) for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) {
    voxels[index(x, y, z)] = 100 + 10 * x + 5 * y + (inCord(x, y, z) ? 600 : 0);
  }
  return nifti(4, 16, voxels);
}

function cordMask() {
  const voxels = new Uint8Array(SIZE ** 3);
  for (let z = 0; z < SIZE; z += 1) for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) {
    if (inCord(x, y, z)) voxels[index(x, y, z)] = 1;
  }
  return nifti(2, 8, voxels);
}

async function openApp(page) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(globalThis.app?.automation), null, { timeout: 120000 });
  await poll(() => page.evaluate(() => app.isViewerAvailable())).toBe(true);
}

async function loadInput(page, name = 'cord.nii') {
  await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: inputVolume() });
  await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name)), { timeout: 120000 }).toEqual([name]);
  await expect(page.locator('#stepInferenceSection')).not.toHaveClass(/step-disabled/, { timeout: 120000 });
}

// Hands the app a segmentation exactly as the inference worker does.
async function deliverSegmentation(page) {
  await page.evaluate(async (bytes) => {
    const niftiData = Uint8Array.from(bytes).buffer;
    app.inferenceExecutor.handleStageData({ stage: 'segmentation', taskId: 'spinalcord', niftiData });
  }, [...cordMask()]);
  await poll(() => page.evaluate(() => app.nv.volumes.length), { timeout: 120000 }).toBe(2);
}

const viewState = (page) => page.evaluate(() => ({
  zoom: app.nv.pan2Dxyzmm[3],
  pan: Array.from(app.nv.pan2Dxyzmm).slice(0, 3),
  scale: app.nv.scaleMultiplier,
}));

async function canvasBox(page) {
  const box = await page.locator('#freebrowseViewer canvas').boundingBox();
  expect(box.width).toBeGreaterThan(100);
  expect(box.height).toBeGreaterThan(100);
  return box;
}

test.describe('FreeBrowse viewer', () => {
  test.setTimeout(300000);

  test('the example loads into FreeBrowse; wheel zoom, drag pan and reset work in 2D and 3D', async ({ page }) => {
    await openApp(page);
    const viewer = page.locator('#freebrowseViewer');
    await expect(viewer.locator('.freebrowse-root')).toBeVisible();
    await expect(page.locator('#viewerInfoPrimary')).toContainText('zoom');

    const example = examples[0];
    await page.locator('select[data-neurodesk-example]').selectOption(example.id);
    await poll(() => page.evaluate(() => app.nv.volumes.map(volume => volume.name)), { timeout: 240000 }).toEqual([example.files[0].name]);
    expect(await page.evaluate(() => app.nv.backend)).toBe('webgl2');

    // Controls FreeBrowse provides are not duplicated in SCT's toolbar.
    for (const id of ['windowMin', 'rangeMin', 'overlayOpacity', 'colormapSelect', 'crosshairToggle', 'downloadCurrentVolume']) {
      await expect(page.locator(`#${id}`)).toHaveCount(0);
    }
    await expect(page.locator('.view-tab[data-view]')).toHaveCount(0);
    await expect(viewer.getByRole('radio', { name: 'Multi view' })).toBeVisible();

    // 2D: in pan/zoom mode the wheel zooms and a right-drag pans.
    const box = await canvasBox(page);
    const x = box.x + box.width * 0.7;
    const y = box.y + box.height * 0.5;
    expect((await viewState(page)).zoom).toBe(1);
    await viewer.getByRole('radio', { name: 'Pan/Zoom' }).click();
    await page.mouse.move(x, y);
    for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, -120);
    await poll(async () => (await viewState(page)).zoom).toBeGreaterThan(1);
    const zoomed = await viewState(page);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x + 60, y + 40, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await poll(async () => (await viewState(page)).pan).not.toEqual(zoomed.pan);
    expect((await viewState(page)).zoom).toBe(zoomed.zoom);

    // One visible control restores the view.
    const reset = viewer.locator('button[title^="Reset view"]');
    await expect(reset).toBeVisible();
    await reset.click();
    await poll(() => viewState(page)).toMatchObject({ zoom: 1, pan: [0, 0, 0] });

    // 3D: the wheel zooms the render, and reset restores it.
    await viewer.getByRole('radio', { name: 'Render view' }).click();
    await page.mouse.move(x, y);
    for (let step = 0; step < 3; step += 1) await page.mouse.wheel(0, 120);
    await poll(async () => (await viewState(page)).scale).not.toBe(1);
    await reset.click();
    await poll(async () => (await viewState(page)).scale).toBe(1);
    await viewer.getByRole('radio', { name: 'Multi view' }).click();

    // FreeBrowse downloads the current image; SCT keeps only the screenshot.
    const screenshot = page.waitForEvent('download');
    await page.locator('#screenshotViewer').click();
    expect((await screenshot).suggestedFilename()).toBe('sct_T2_spinalcord_screenshot.png');
    await viewer.locator('button[title="Show sidebar"]').click();
    await viewer.getByRole('button', { name: 'Download' }).click();
    const image = page.waitForEvent('download');
    await viewer.getByRole('button', { name: 'OK' }).click();
    expect((await image).suggestedFilename()).toBe(example.files[0].name);
  });

  test('a result is a labelled overlay that the Results eye and FreeBrowse both control', async ({ page }) => {
    await openApp(page);
    await loadInput(page);
    const before = await page.evaluate(() => { app.nv.pan2Dxyzmm = [0, 0, 0, 2]; return app.nv.volumes[0].id; });
    await deliverSegmentation(page);

    const state = () => page.evaluate(() => app.nv.volumes.map(volume => ({
      name: volume.name,
      opacity: volume.opacity,
      labels: volume.colormapLabel?.labels ?? null,
      colour: volume.colormapLabel ? Array.from(volume.colormapLabel.lut.slice(4, 8)) : null,
    })));
    expect(await state()).toEqual([
      { name: 'cord.nii', opacity: 1, labels: null, colour: null },
      { name: 'spinalcord_segmentation.nii', opacity: 0.7, labels: ['Background', 'Spinal cord'], colour: [68, 128, 255, 255] },
    ]);
    // Adding the overlay kept the loaded input, and with it the user's zoom.
    expect(await page.evaluate(() => [app.nv.volumes[0].id, app.nv.pan2Dxyzmm[3]])).toEqual([before, 2]);

    // The label under the crosshair is named below the viewer.
    await page.evaluate(() => app.nv.setCrosshairPos([12, 12, 12]));
    await expect(page.locator('#viewerInfoLabel')).toHaveText('Spinal cord');
    await page.evaluate(() => app.nv.setCrosshairPos([2, 2, 2]));
    await expect(page.locator('#viewerInfoLabel')).toHaveText('');

    // Results eye buttons toggle opacity without reloading volumes.
    const eye = stage => page.locator(`#stageButtons .view-btn[data-stage="${stage}"]`);
    await expect(eye('segmentation')).toHaveClass(/active/);
    await eye('segmentation').click();
    await poll(async () => (await state())[1].opacity).toBe(0);
    await expect(eye('segmentation')).not.toHaveClass(/active/);
    await eye('segmentation').click();
    await poll(async () => (await state())[1].opacity).toBe(0.7);

    // Hiding the input keeps it loaded underneath the mask.
    await eye('input').click();
    await poll(async () => (await state()).map(volume => volume.opacity)).toEqual([0, 0.7]);
    await expect(eye('input')).not.toHaveClass(/active/);
    await eye('input').click();
    await poll(async () => (await state()).map(volume => volume.opacity)).toEqual([1, 0.7]);
    expect(await page.evaluate(() => app.nv.volumes[0].id)).toBe(before);

    // FreeBrowse's own opacity and visibility controls drive the same state.
    const viewer = page.locator('#freebrowseViewer');
    await viewer.locator('button[title="Show sidebar"]').click();
    await expect(viewer.getByRole('tab', { name: 'Volumes' })).toBeVisible();
    // The Drawing tab stays available; FreeBrowse enables it once a drawing layer exists.
    await expect(viewer.getByRole('tab', { name: 'Drawing' })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Create empty drawing layer' })).toBeEnabled();
    await expect(viewer.locator('button[title="Edit as drawing"]')).toBeEnabled();
    await page.evaluate(() => app.nv.setVolume(1, { opacity: 0.4 }));
    await page.evaluate(() => app.nv.setVolume(1, { opacity: 0 }));
    await expect(eye('segmentation')).not.toHaveClass(/active/);
    await eye('segmentation').click();
    await poll(async () => (await state())[1].opacity).toBe(0.4);
    await expect(eye('segmentation')).toHaveClass(/active/);

    // The stage file is still downloadable from Results.
    const download = page.waitForEvent('download');
    await page.locator('#stageButtons .download-btn').click();
    expect((await download).suggestedFilename()).toBe('spinalcord_segmentation.nii');

    // Clearing results removes the overlay but not the input.
    await page.locator('#clearResults').click();
    await poll(async () => (await state()).map(volume => volume.name)).toEqual(['cord.nii']);
    expect(await page.evaluate(() => app.nv.volumes[0].id)).toBe(before);

    // The mount handle and NiiVue instance are reachable for later integrations.
    expect(await page.evaluate(() => app.viewerMount.nv === app.nv && app.viewer.nv === app.nv && typeof app.viewerMount.destroy === 'function')).toBe(true);
  });

  test('Compare shows each loaded session on its own canvas and returns to the single view', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#compareViewButton')).toBeDisabled();
    await loadInput(page, 'first.nii');
    await loadInput(page, 'second.nii');
    await expect(page.locator('#compareViewButton')).toBeEnabled();
    await page.locator('#compareViewButton').click();
    await expect(page.locator('#comparisonGrid .comparison-panel')).toHaveCount(2);
    await expect(page.locator('#comparisonGrid .comparison-panel.active .comparison-label')).toHaveText('second.nii');
    await poll(() => page.evaluate(() => [...app.viewer.compareViewers.values()].map(entry => entry.nv.volumes[0]?.name))).toEqual(['first.nii', 'second.nii']);
    await expect(page.locator('#freebrowseViewer')).toBeHidden();
    await expect(page.locator('#viewerInfoPrimary')).toHaveText('Comparison: 2 images');

    await page.locator('#singleViewButton').click();
    await expect(page.locator('#comparisonGrid .comparison-panel')).toHaveCount(0);
    await expect(page.locator('#freebrowseViewer')).toBeVisible();
    expect(await page.evaluate(() => app.nv.volumes.map(volume => volume.name))).toEqual(['second.nii']);
  });
});

test.describe('FreeBrowse viewer on a touch screen', () => {
  test.use({ hasTouch: true });
  test.setTimeout(300000);

  test('pinch zooms and a two-finger drag pans in 2D; pinch zooms in 3D', async ({ page }) => {
    await openApp(page);
    await loadInput(page);
    const viewer = page.locator('#freebrowseViewer');
    const box = await canvasBox(page);
    const x = box.x + box.width * 0.7;
    const y = box.y + box.height * 0.5;
    const client = await page.context().newCDPSession(page);
    const touch = (type, points) => client.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([px, py], id) => ({ x: px, y: py, id })),
    });
    const pinch = async (from, to, shift = 0) => {
      await touch('touchStart', [[x - from, y]]);
      await touch('touchStart', [[x - from, y], [x + from, y]]);
      for (let step = 1; step <= 5; step += 1) {
        const half = from + ((to - from) * step) / 5;
        const dy = (shift * step) / 5;
        await touch('touchMove', [[x - half, y + dy], [x + half, y + dy]]);
      }
      await touch('touchEnd', []);
    };

    // No drag mode needs choosing on a phone: two fingers always zoom and pan.
    expect(await viewState(page)).toMatchObject({ zoom: 1, pan: [0, 0, 0] });
    const mode = await page.evaluate(() => app.nv.primaryDragMode);
    await pinch(20, 60);
    await poll(async () => (await viewState(page)).zoom).toBeCloseTo(3, 1);
    const zoomed = await viewState(page);
    await pinch(40, 40, 50);
    await poll(async () => (await viewState(page)).pan).not.toEqual(zoomed.pan);
    expect((await viewState(page)).zoom).toBeCloseTo(zoomed.zoom, 5);
    expect(await page.evaluate(() => app.nv.primaryDragMode)).toBe(mode);

    await viewer.locator('button[title^="Reset view"]').tap();
    await poll(() => viewState(page)).toMatchObject({ zoom: 1, pan: [0, 0, 0] });

    await viewer.getByRole('radio', { name: 'Render view' }).tap();
    await poll(() => page.evaluate(() => app.nv.sliceType)).toBe(4);
    await pinch(20, 30);
    await poll(async () => (await viewState(page)).scale).toBeCloseTo(1.5, 1);
  });
});

test.describe('without WebGL2', () => {
  test.setTimeout(300000);

  test('the app falls back to the 2D preview and stays usable', async ({ page }) => {
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return type === 'webgl2' || type === 'webgpu' ? null : getContext.call(this, type, ...rest);
      };
    });
    await page.goto('/');
    await page.waitForFunction(() => Boolean(globalThis.app?.automation), null, { timeout: 120000 });
    expect(await page.evaluate(() => [app.isViewerAvailable(), app.nv, app.viewerMount])).toEqual([false, null, null]);
    const message = page.locator('#viewerUnavailableMessage');
    await expect(message).toBeVisible();
    await expect(message).toContainText('WebGL2');
    expect((await message.textContent()).trim().length).toBeLessThanOrEqual(90);
    await expect(page.locator('#freebrowseViewer')).toBeHidden();
    await expect(page.locator('#screenshotViewer')).toBeDisabled();

    await page.locator('#fileInput').setInputFiles({ name: 'cord.nii', mimeType: 'application/octet-stream', buffer: inputVolume() });
    await expect(page.locator('#stepInferenceSection')).not.toHaveClass(/step-disabled/, { timeout: 120000 });
    await expect(page.locator('#runSegmentation')).toBeEnabled();
    await expect(page.locator('#viewerInfoPrimary')).toHaveText('Input: 2D preview');
    await expect(page.locator('#fallbackCanvas2d')).toBeVisible();

    // Results and their downloads work without a viewer.
    await page.evaluate((bytes) => app.inferenceExecutor.handleStageData({ stage: 'segmentation', taskId: 'spinalcord', niftiData: Uint8Array.from(bytes).buffer }), [...cordMask()]);
    await expect(page.locator('#stageButtons .view-btn[data-stage="segmentation"]')).toBeEnabled();
    const download = page.waitForEvent('download');
    await page.locator('#stageButtons .download-btn').click();
    expect((await download).suggestedFilename()).toBe('spinalcord_segmentation.nii');
  });
});
