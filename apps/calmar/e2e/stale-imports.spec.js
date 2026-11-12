import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));

// A file named `held-*` waits in the read step (where a DICOM series is converted), one named
// `slow-*` in each read of its bytes and one named `late-*` before NiiVue loads it as a volume;
// with `holdDrawing` set, a seed waits before NiiVue loads it as the drawing (`drawing`).
// A volume named `decoded-*`, or listed in `holdDecoded`, waits after NiiVue decoded it and
// before NiiVue inserts it; with `holdDecodedDrawing` set a drawing does (`decoded-drawing`).
// `resume(name)` lets the import go on, `ended(name)` is how it ended and `release(name)` is both.
async function holdImports(page) {
  await page.goto('/');
  await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
  const scan = voxels => page.evaluate(async (count) => {
    const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
    const affine = [2, 0, 0, -8, 0, 2, 0, -8, 0, 0, 2, -8, 0, 0, 0, 1];
    const data = new Float32Array(512);
    data.fill(1, 0, count);
    return [...new Uint8Array(writeNifti1(data, { dims: [8, 8, 8], affine }))];
  }, voxels);
  const image = Buffer.from(await scan(512));
  const smallMask = Buffer.from(await scan(3));
  await page.evaluate(() => {
    globalThis.releaseImport = {};
    globalThis.settled = {};
    const held = name => new Promise((resolve) => {
      globalThis.releaseImport[name] = resolve;
    });
    const readScan = app.readScanInput.bind(app);
    app.readScanInput = async (files) => {
      if (files[0].name.startsWith('held-')) await held(files[0].name);
      return readScan(files);
    };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function arrayBuffer() {
      if (this.name.startsWith('slow-')) await held(this.name);
      return read.call(this);
    };
    for (const method of ['loadVolumes', 'addVolumeFromUrl']) {
      const load = app.nv[method].bind(app.nv);
      app.nv[method] = async (volumes) => {
        const { name } = [volumes].flat()[0];
        if (name.startsWith('late-')) await held(name);
        return load(volumes);
      };
    }
    const loadSeed = app.maskDrawingController.loadSeedFile.bind(app.maskDrawingController);
    app.maskDrawingController.loadSeedFile = async (...args) => {
      if (globalThis.holdDrawing) await held('drawing');
      return loadSeed(...args);
    };
    globalThis.holdDecoded = [];
    const decode = globalThis.niivue.NVImage.loadFromUrl;
    globalThis.niivue.NVImage.loadFromUrl = async function loadFromUrl(options) {
      const image = await decode.call(this, options);
      const name = options.name || (globalThis.holdDecodedDrawing ? 'decoded-drawing' : '');
      if (name.startsWith('decoded-') || globalThis.holdDecoded.includes(name)) await held(name);
      return image;
    };
    const importInput = app.importInput.bind(app);
    app.importInput = (kind, files, keep) => {
      const name = files[0].name;
      const result = importInput(kind, files, keep);
      globalThis.settled[name] = result.then(() => 'kept', error => error.name);
      return result;
    };
  });
  const choose = (input, name, buffer = image) => page.locator(`#${input}FileInput`).setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  const waiting = name => page.waitForFunction(held => globalThis.releaseImport[held], name);
  const hold = async (input, name, buffer) => {
    await choose(input, name, buffer);
    await waiting(name);
  };
  const resume = name => page.evaluate((held) => {
    const go = globalThis.releaseImport[held];
    delete globalThis.releaseImport[held];
    go();
  }, name);
  const ended = name => page.evaluate(held => globalThis.settled[held], name);
  const release = async (name) => {
    await resume(name);
    return ended(name);
  };
  const loaded = () => page.evaluate(() => ({
    structural: app.nativeStructuralFile?.name ?? null,
    shown: app.structuralFile?.name ?? null,
    geometry: app.nativeStructuralInfo !== null,
    standIn: app.structuralFromDiffusion !== null,
    dwi: app.deepIslesDwiFile?.name ?? null,
    seed: app.nativeLesionSeedFile !== null,
    base: app.viewerBaseFile?.name ?? null,
    controllerBase: app.viewerController.currentBaseFile?.name ?? null,
    brainmask: app.brainmaskFile !== null || app.nativeBrainmaskFile !== null,
    autoSeed: app.autoLesionSeedFile !== null,
    overlay: app.viewerController.currentOverlayFile?.name ?? null,
    lesion: app.lesionFile?.name ?? null,
    review: app.maskReviewActive,
    maskOrigin: app.maskOrigin,
    drawn: app.nv.drawBitmap ? app.nv.drawBitmap.reduce((count, value) => count + (value ? 1 : 0), 0) : 0,
    viewer: app.nv.volumes.map(volume => volume.name),
  }));
  const log = () => page.evaluate(() => document.getElementById('technicalConsoleOutput').textContent);
  const logLines = () => page.evaluate(() => [...document.querySelectorAll('#technicalConsoleOutput .nd-console-line')].map(line => line.textContent));
  const viewerIdle = () => page.evaluate(() => app._viewerLoad);
  return { choose, hold, waiting, resume, ended, release, loaded, log, logLines, viewerIdle, image, smallMask };
}

test.describe('an import that finishes late', () => {
  test.beforeEach(() => {
    test.setTimeout(120000);
  });

  test('a structural image is dropped for a newer one and kept beside a lesion mask', async ({ page }) => {
    const { choose, hold, release, loaded, log } = await holdImports(page);
    await hold('structural', 'held-old-T1.nii');
    await choose('structural', 'new-T1.nii');
    await expect.poll(async () => (await loaded()).structural).toBe('new-T1.nii');
    expect(await release('held-old-T1.nii')).toBe('AbortError');
    const state = await loaded();
    expect(state.structural).toBe('new-T1.nii');
    expect(state.viewer).toEqual(['new-T1.nii']);

    // An import in another input leaves the pending one current.
    await hold('structural', 'held-next-T1.nii');
    await choose('lesion', 'lesion.nii');
    await expect.poll(async () => (await loaded()).lesion).toBe('lesion.nii');
    expect(await release('held-next-T1.nii')).toBe('kept');
    expect((await loaded()).structural).toBe('held-next-T1.nii');
    expect(await log()).not.toContain('input failed');
  });

  test('a lesion mask is dropped for a newer one', async ({ page }) => {
    const { choose, hold, release, loaded, log } = await holdImports(page);
    await hold('lesion', 'held-old-lesion.nii');
    await choose('lesion', 'new-lesion.nii');
    await expect.poll(async () => (await loaded()).lesion).toBe('new-lesion.nii');
    expect(await release('held-old-lesion.nii')).toBe('AbortError');
    const state = await loaded();
    expect(state.lesion).toBe('new-lesion.nii');
    expect(state.viewer).toEqual(['new-lesion.nii']);
    expect(await log()).not.toContain('input failed');
  });

  test('structural and lesion imports are dropped once everything was cleared', async ({ page }) => {
    const { hold, release, loaded } = await holdImports(page);
    await hold('structural', 'held-T1.nii');
    await hold('lesion', 'held-lesion.nii');
    await page.evaluate(() => app.clearResults({ full: true }));
    expect(await release('held-T1.nii')).toBe('AbortError');
    expect(await release('held-lesion.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({ structural: null, lesion: null, viewer: [] });
  });

  test('structural and lesion imports are dropped once an example replaced the subject', async ({ page }) => {
    test.setTimeout(240000);
    const { hold, release, loaded, log } = await holdImports(page);
    const selector = page.locator('[data-neurodesk-examples]');
    const example = examples.find(item => item.id === 'stroke-lesion-m2001');
    await hold('structural', 'held-T1.nii');
    await hold('lesion', 'held-lesion.nii');
    // The held imports fired `change`, which is how the selector learns of a replacement; this one must not.
    await page.locator('select[data-neurodesk-example]').selectOption(example.id);
    await expect(selector).toHaveAttribute('data-example-state', 'ready', { timeout: 120000 });
    expect(await release('held-T1.nii')).toBe('AbortError');
    expect(await release('held-lesion.nii')).toBe('AbortError');
    await expect(selector).toHaveAttribute('data-example-id', example.id);
    expect(await loaded()).toMatchObject({ structural: example.files[0].name, lesion: null, viewer: [example.files[0].name] });
    expect(await log()).not.toContain('input failed');
  });

  for (const stage of ['held', 'slow']) {
    test(`an uploaded mask (${stage}) is dropped for a newer one`, async ({ page }) => {
      const { choose, hold, release, loaded, log, smallMask } = await holdImports(page);
      await choose('structural', 'T1.nii');
      await expect.poll(async () => (await loaded()).structural).toBe('T1.nii');
      await hold('manualMask', `${stage}-old-mask.nii`);
      await choose('manualMask', 'new-mask.nii', smallMask);
      await expect.poll(log).toContain('Manual lesion mask ready for editing: new-mask.nii');
      expect(await release(`${stage}-old-mask.nii`)).toBe('AbortError');
      expect(await loaded()).toMatchObject({ review: true, maskOrigin: 'uploaded', drawn: 3 });
      expect(await log()).not.toContain(`ready for editing: ${stage}-old-mask.nii`);
      expect(await log()).not.toContain('input failed');
    });
  }

  test('an uploaded mask is dropped once a blank mask, a new structural image or Clear replaced it', async ({ page }) => {
    const { choose, hold, release, loaded, log } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).structural).toBe('T1.nii');

    await hold('manualMask', 'held-before-blank-mask.nii');
    await page.evaluate(() => app.startLesionMaskReview({ blank: true }));
    expect(await release('held-before-blank-mask.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({ review: true, maskOrigin: 'blank', drawn: 0 });

    await hold('manualMask', 'slow-before-clear-mask.nii');
    await page.evaluate(() => app.clearResults({ full: false }));
    expect(await release('slow-before-clear-mask.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({ review: false, maskOrigin: null, drawn: 0 });

    await hold('manualMask', 'held-before-T1-mask.nii');
    await choose('structural', 'next-T1.nii');
    await expect.poll(async () => (await loaded()).structural).toBe('next-T1.nii');
    expect(await release('held-before-T1-mask.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({ structural: 'next-T1.nii', review: false, maskOrigin: null, drawn: 0 });
    expect(await log()).not.toContain('input failed');
    expect(await log()).not.toContain('ready for editing');
  });

  test('a review reading the old structural image leaves the new one its geometry', async ({ page }) => {
    const { choose, waiting, resume, ended, loaded, smallMask } = await holdImports(page);
    await choose('structural', 'slow-old-T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('slow-old-T1.nii');
    await choose('manualMask', 'mask.nii', smallMask);
    await waiting('slow-old-T1.nii');
    await choose('structural', 'new-T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('new-T1.nii');
    await resume('slow-old-T1.nii');
    expect(await ended('mask.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({
      structural: 'new-T1.nii',
      shown: 'new-T1.nii',
      geometry: false,
      review: false,
      drawn: 0,
      viewer: ['new-T1.nii'],
    });
  });

  test('a seed that lands after Clear is closed again', async ({ page }) => {
    const { choose, waiting, resume, ended, loaded, smallMask } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await page.evaluate(() => {
      globalThis.holdDrawing = true;
    });
    await choose('manualMask', 'mask.nii', smallMask);
    await waiting('drawing');
    await page.evaluate(() => app.clearResults({ full: false }));
    await resume('drawing');
    expect(await ended('mask.nii')).toBe('AbortError');
    await page.evaluate(() => app._viewerLoad);
    expect(await loaded()).toMatchObject({
      structural: 'T1.nii',
      review: false,
      maskOrigin: null,
      drawn: 0,
      viewer: ['T1.nii'],
    });
  });

  test('an older lesion overlay that lands late does not stay above the newer one', async ({ page }) => {
    const { choose, hold, release, loaded, log } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await hold('lesion', 'late-old-lesion.nii');
    await choose('lesion', 'new-lesion.nii');
    await expect.poll(async () => (await loaded()).lesion).toBe('new-lesion.nii');
    expect(await release('late-old-lesion.nii')).toBe('AbortError');
    await expect.poll(log).toContain('Lesion mask ready: new-lesion.nii');
    expect(await loaded()).toMatchObject({
      lesion: 'new-lesion.nii',
      overlay: 'new-lesion.nii',
      viewer: ['T1.nii', 'new-lesion.nii'],
    });

    await choose('lesion', 'next-lesion.nii');
    await expect.poll(log).toContain('Lesion mask ready: next-lesion.nii');
    expect(await loaded()).toMatchObject({ overlay: 'next-lesion.nii', viewer: ['T1.nii', 'next-lesion.nii'] });
    expect(await log()).not.toContain('input failed');
  });

  test('a structural image that lands after everything was cleared is taken out again', async ({ page }) => {
    const { choose, hold, release, loaded } = await holdImports(page);
    await hold('structural', 'late-T1.nii');
    await page.evaluate(() => app.clearResults({ full: true }));
    expect(await release('late-T1.nii')).toBe('AbortError');
    expect(await loaded()).toMatchObject({ structural: null, shown: null, base: null, viewer: [] });

    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await page.evaluate(() => app.clearResults({ full: true }));
    expect(await loaded()).toMatchObject({ structural: null, base: null, viewer: [] });
  });

  test('a seed still being resampled is not kept once Clear replaced its review', async ({ page }) => {
    const { choose, hold, waiting, resume, release, loaded, smallMask } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await hold('manualMask', 'slow-mask.nii', smallMask);
    await resume('slow-mask.nii');
    await waiting('slow-mask.nii');
    expect(await loaded()).toMatchObject({ review: true, seed: false });
    await page.evaluate(() => app.clearResults({ full: false }));
    expect(await release('slow-mask.nii')).toBe('AbortError');
    await page.evaluate(() => app._viewerLoad);
    expect(await loaded()).toMatchObject({ review: false, maskOrigin: null, seed: false, drawn: 0, viewer: ['T1.nii'] });
  });

  test('a diffusion stand-in leaves a structural image still being read current', async ({ page }) => {
    const { choose, hold, release, loaded, log } = await holdImports(page);
    await choose('deepIslesDwi', 'dwi.nii');
    await choose('deepIslesAdc', 'adc.nii');
    await expect.poll(log).toContain('DeepISLES ADC input ready: adc.nii');
    await hold('structural', 'held-T1.nii');
    await page.evaluate(() => app.ensureStructuralForDiffusion());
    expect(await loaded()).toMatchObject({ structural: 'dwi.nii', standIn: true, base: 'dwi.nii' });
    expect(await release('held-T1.nii')).toBe('kept');
    expect(await loaded()).toMatchObject({
      structural: 'held-T1.nii',
      shown: 'held-T1.nii',
      standIn: false,
      dwi: 'dwi.nii',
      base: 'held-T1.nii',
      viewer: ['held-T1.nii'],
    });
    expect(await log()).not.toContain('input failed');
  });

  test('a failed DICOM conversion is reported once', async ({ page }) => {
    const { choose, log, logLines } = await holdImports(page);
    await choose('structural', 'scan.dcm', Buffer.from('not a DICOM file'));
    await expect.poll(log, { timeout: 60000 }).toContain('Structural input failed');
    await page.waitForTimeout(500);
    const errors = (await logLines()).filter(line => /fail|error/i.test(line));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Structural input failed');
  });

  test('a worker result for a replaced structural image is not published', async ({ page }) => {
    const { choose, loaded, log, image } = await holdImports(page);
    await choose('deepIslesDwi', 'dwi.nii');
    await choose('deepIslesAdc', 'adc.nii');
    await expect.poll(log).toContain('DeepISLES ADC input ready: adc.nii');
    // The worker is replaced by a recorder; its responses are delivered by hand, late.
    await page.evaluate(() => {
      globalThis.sent = [];
      globalThis.terminated = 0;
      const { executor } = app;
      const send = step => async () => {
        executor.running = true;
        executor.currentRunningStep = step;
        globalThis.sent.push(step);
        return true;
      };
      executor.loadVolume = send('load');
      executor.runSynthStrip = send('brainmask');
      executor.runDeepIslesInference = send('deepisles');
      const terminate = executor.terminateWorker.bind(executor);
      executor.terminateWorker = () => {
        globalThis.terminated += 1;
        terminate();
      };
      globalThis.preparation = app.runLesionPreparation().then(() => 'ended', error => error.name);
    });
    await page.waitForFunction(() => globalThis.sent.includes('brainmask'));
    expect(await loaded()).toMatchObject({ structural: 'dwi.nii', standIn: true });
    await page.evaluate(() => app.executor.handleMessage({ type: 'progress', value: 0.3, text: 'Brain extraction' }));
    await expect(page.locator('#cancelButton')).toBeVisible();

    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    expect(await page.evaluate(() => globalThis.terminated)).toBeGreaterThan(0);
    expect(await page.evaluate(() => globalThis.preparation)).toBe('ended');
    const late = (stage, extra = {}) => page.evaluate(async ({ stage, extra, bytes }) => {
      app.executor.handleMessage({ type: 'progress', value: 0.9, text: 'Late progress' });
      app.executor.handleMessage({ type: 'stageData', stage, niftiData: new Uint8Array(bytes).buffer, ...extra });
      app.executor.handleMessage({ type: 'step-complete', step: stage === 'brainmask' ? 'brainmask' : 'inference' });
      await new Promise(resolve => setTimeout(resolve, 200));
      await app._viewerLoad;
    }, { stage, extra, bytes: [...image] });
    await late('brainmask');
    expect(await loaded()).toMatchObject({ structural: 'T1.nii', brainmask: false, viewer: ['T1.nii'] });
    await expect(page.locator('#downloadBrainMaskButton')).toBeDisabled();
    await expect(page.locator('#statusText')).toHaveText('Cancelled');
    await expect(page.locator('#cancelButton')).toBeHidden();
    await expect(page.locator('#progress')).toHaveJSProperty('value', 0);
    expect(await page.evaluate(() => Boolean(app.progress.timer))).toBe(false);
    expect(await log()).toContain('Analysis stopped: the structural image changed.');
    expect(await log()).not.toContain('Brain mask ready');

    // A DeepISLES seed that arrives for the replaced image does not enter review.
    expect(await loaded()).toMatchObject({ dwi: 'dwi.nii' });
    await page.evaluate(() => document.getElementById('runDeepIslesSegmentationButton').click());
    await page.waitForFunction(() => globalThis.sent.includes('deepisles'));
    await choose('structural', 'next-T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('next-T1.nii');
    await late('segmentation', { taskId: 'lnm-deepisles-seed' });
    expect(await loaded()).toMatchObject({
      structural: 'next-T1.nii',
      autoSeed: false,
      review: false,
      maskOrigin: null,
      viewer: ['next-T1.nii'],
    });
    await expect(page.locator('#downloadLesionMaskButton')).toBeDisabled();
    const text = await log();
    expect(text).not.toContain('DeepISLES lesion seed ready');
    expect(text).not.toMatch(/failed/i);
  });

  test('a cancelled structural example that NiiVue was loading is not kept', async ({ page }) => {
    test.setTimeout(240000);
    const { resume, loaded, viewerIdle } = await holdImports(page);
    const selector = page.locator('[data-neurodesk-examples]');
    const example = examples.find(item => item.id === 'stroke-lesion-m2001');
    const { name } = example.files[0];
    await page.evaluate((held) => {
      globalThis.holdDecoded.push(held);
    }, name);
    await page.locator('select[data-neurodesk-example]').selectOption(example.id);
    await page.waitForFunction(held => globalThis.releaseImport[held], name, { timeout: 180000 });
    await selector.getByRole('button', { name: 'Cancel example download' }).click();
    await expect(selector).toHaveAttribute('data-example-state', 'cancelled');
    await resume(name);
    await viewerIdle();
    await expect(selector).toHaveAttribute('data-example-state', 'cancelled');
    expect(await loaded()).toMatchObject({
      structural: null,
      shown: null,
      base: null,
      controllerBase: null,
      viewer: [],
    });
  });

  test('a structural image replaced by a failed import while NiiVue loaded it is taken out', async ({ page }) => {
    const { choose, hold, release, loaded, log, viewerIdle } = await holdImports(page);
    await hold('structural', 'decoded-T1.nii');
    await choose('structural', 'scan.dcm', Buffer.from('not a DICOM file'));
    await expect.poll(log, { timeout: 60000 }).toContain('Structural input failed');
    expect(await release('decoded-T1.nii')).toBe('AbortError');
    await viewerIdle();
    expect(await loaded()).toMatchObject({
      structural: null,
      shown: null,
      base: null,
      controllerBase: null,
      viewer: [],
    });
  });

  test('a replaced review is not logged as a failure', async ({ page }) => {
    const { choose, waiting, resume, loaded, log, viewerIdle } = await holdImports(page);
    await choose('structural', 'slow-T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('slow-T1.nii');
    const replaceReview = async (start) => {
      await page.evaluate(() => {
        app.nativeStructuralInfo = null;
      });
      await start();
      await waiting('slow-T1.nii');
      await page.evaluate(() => app.clearResults({ full: false }));
      await resume('slow-T1.nii');
      await viewerIdle();
      await page.waitForTimeout(200);
    };
    await replaceReview(() => page.locator('#startManualMaskButton').dispatchEvent('click'));
    await page.evaluate(() => {
      app.runLesionSegmentation = async () => {};
      app.runDeepIslesSegmentation = async () => {};
    });
    await replaceReview(() => page.locator('#runLesionSegmentationButton').dispatchEvent('click'));
    await replaceReview(() => page.locator('#runDeepIslesSegmentationButton').dispatchEvent('click'));
    expect(await loaded()).toMatchObject({ structural: 'slow-T1.nii', review: false, viewer: ['slow-T1.nii'] });
    expect(await log()).not.toMatch(/failed/i);

    // A real error is still reported.
    await page.evaluate(() => {
      app.startLesionMaskReview = async () => {
        throw new Error('no drawing surface');
      };
    });
    await page.locator('#startManualMaskButton').dispatchEvent('click');
    await expect.poll(log).toContain('Manual mask failed: no drawing surface');
  });

  test('a viewer load that never settles does not block the loads after a clear', async ({ page }) => {
    const { choose, hold, release, loaded, log, viewerIdle } = await holdImports(page);
    await hold('structural', 'decoded-stuck-T1.nii');
    await page.evaluate(() => app.clearResults({ full: true }));
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base, { timeout: 15000 }).toBe('T1.nii');
    await choose('lesion', 'lesion.nii');
    await expect.poll(log, { timeout: 15000 }).toContain('Lesion mask ready: lesion.nii');
    expect(await loaded()).toMatchObject({ viewer: ['T1.nii', 'lesion.nii'] });

    // The abandoned load lands beside the newer image and is taken out again.
    expect(await release('decoded-stuck-T1.nii')).toBe('AbortError');
    await viewerIdle();
    await viewerIdle();
    const state = await loaded();
    expect(state).toMatchObject({ structural: 'T1.nii', shown: 'T1.nii', base: 'T1.nii', controllerBase: 'T1.nii', lesion: 'lesion.nii' });
    expect(state.viewer[0]).toBe('T1.nii');
    expect(state.viewer).not.toContain('decoded-stuck-T1.nii');

    // So does a load a new structural image replaced.
    await hold('structural', 'decoded-stuck-next-T1.nii');
    await choose('structural', 'last-T1.nii');
    await expect.poll(async () => (await loaded()).base, { timeout: 15000 }).toBe('last-T1.nii');
    expect(await release('decoded-stuck-next-T1.nii')).toBe('AbortError');
    await viewerIdle();
    await viewerIdle();
    expect(await loaded()).toMatchObject({ structural: 'last-T1.nii', base: 'last-T1.nii', controllerBase: 'last-T1.nii', viewer: ['last-T1.nii'] });
    expect(await log()).not.toContain('input failed');
  });
  const drawTwoVoxels = page => page.evaluate(() => {
    app.nv.drawBitmap[100] = 1;
    app.nv.drawBitmap[101] = 1;
    app.nv.drawAddUndoBitmap();
    app.nv.refreshDrawing(true);
  });

  test('an abandoned structural image that lands during a review keeps the edits drawn since', async ({ page }) => {
    const { choose, hold, release, loaded, log, viewerIdle, smallMask } = await holdImports(page);
    await hold('structural', 'decoded-old-T1.nii');
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await choose('manualMask', 'mask.nii', smallMask);
    await expect.poll(log).toContain('Manual lesion mask ready for editing: mask.nii');
    expect(await loaded()).toMatchObject({ review: true, drawn: 3 });
    await drawTwoVoxels(page);

    expect(await release('decoded-old-T1.nii')).toBe('AbortError');
    await viewerIdle();
    await viewerIdle();
    await page.waitForTimeout(200);
    await viewerIdle();
    expect(await loaded()).toMatchObject({
      structural: 'T1.nii',
      base: 'T1.nii',
      controllerBase: 'T1.nii',
      review: true,
      seed: true,
      drawn: 5,
      viewer: ['T1.nii'],
    });
    await page.locator('#maskUndoButton').dispatchEvent('click');
    expect(await loaded()).toMatchObject({ review: true, drawn: 3 });
    expect(await log()).not.toMatch(/failed|started again/i);
  });

  test('an abandoned seed that lands during a newer review keeps the edits drawn since', async ({ page }) => {
    const { choose, waiting, resume, ended, loaded, log, viewerIdle, image, smallMask } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await page.evaluate(() => {
      globalThis.holdDecodedDrawing = true;
    });
    await choose('manualMask', 'old-mask.nii', image);
    await waiting('decoded-drawing');
    await page.evaluate(() => {
      globalThis.holdDecodedDrawing = false;
    });
    await choose('structural', 'next-T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('next-T1.nii');
    await choose('manualMask', 'mask.nii', smallMask);
    await expect.poll(log).toContain('Manual lesion mask ready for editing: mask.nii');
    await drawTwoVoxels(page);
    expect(await loaded()).toMatchObject({ review: true, drawn: 5 });

    await resume('decoded-drawing');
    expect(await ended('old-mask.nii')).toBe('AbortError');
    await viewerIdle();
    await page.waitForTimeout(200);
    await viewerIdle();
    expect(await loaded()).toMatchObject({
      structural: 'next-T1.nii',
      base: 'next-T1.nii',
      review: true,
      drawn: 5,
      viewer: ['next-T1.nii'],
    });
    await page.locator('#maskUndoButton').dispatchEvent('click');
    expect(await loaded()).toMatchObject({ review: true, drawn: 3 });
    expect(await log()).not.toMatch(/failed|started again/i);
  });

  test('a brain mask overlay that lands after Clear results is taken out again', async ({ page }) => {
    const { choose, waiting, resume, loaded, log, viewerIdle, image } = await holdImports(page);
    await choose('structural', 'T1.nii');
    await expect.poll(async () => (await loaded()).base).toBe('T1.nii');
    await page.evaluate(() => {
      globalThis.sent = [];
      const { executor } = app;
      const send = step => async () => {
        executor.running = true;
        executor.currentRunningStep = step;
        globalThis.sent.push(step);
        return true;
      };
      executor.loadVolume = send('load');
      executor.runSynthStrip = send('brainmask');
      globalThis.holdDecoded.push('brainmask.nii');
      globalThis.extraction = app.runBrainExtraction().then(() => 'ended', error => error.name);
    });
    await page.waitForFunction(() => globalThis.sent.includes('brainmask'));
    await page.evaluate((bytes) => {
      app.executor.handleMessage({ type: 'stageData', stage: 'brainmask', niftiData: new Uint8Array(bytes).buffer });
      app.executor.handleMessage({ type: 'step-complete', step: 'brainmask' });
    }, [...image]);
    await waiting('brainmask.nii');
    expect(await loaded()).toMatchObject({ brainmask: true });

    await page.evaluate(() => app.clearResults({ full: false }));
    await resume('brainmask.nii');
    await page.waitForTimeout(200);
    await viewerIdle();
    await viewerIdle();
    expect(await loaded()).toMatchObject({
      structural: 'T1.nii',
      base: 'T1.nii',
      controllerBase: 'T1.nii',
      brainmask: false,
      viewer: ['T1.nii'],
    });
    await expect(page.locator('#layerToggleBrainMask')).not.toBeChecked();
    expect(await log()).not.toMatch(/failed|error/i);
  });
});
