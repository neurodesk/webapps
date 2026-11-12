import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));

// A file named `held-*` waits in the read step (where a DICOM series is converted) and one named
// `slow-*` in decoding, until `release(name)`, which returns how that import ended.
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
    const importInput = app.importInput.bind(app);
    app.importInput = (kind, files, keep) => {
      const name = files[0].name;
      const result = importInput(kind, files, keep);
      globalThis.settled[name] = result.then(() => 'kept', error => error.name);
      return result;
    };
  });
  const choose = (input, name, buffer = image) => page.locator(`#${input}FileInput`).setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  const hold = async (input, name, buffer) => {
    await choose(input, name, buffer);
    await page.waitForFunction(held => globalThis.releaseImport[held], name);
  };
  const release = name => page.evaluate((held) => {
    globalThis.releaseImport[held]();
    return globalThis.settled[held];
  }, name);
  const loaded = () => page.evaluate(() => ({
    structural: app.nativeStructuralFile?.name ?? null,
    lesion: app.lesionFile?.name ?? null,
    review: app.maskReviewActive,
    maskOrigin: app.maskOrigin,
    drawn: app.nv.drawBitmap ? app.nv.drawBitmap.reduce((count, value) => count + (value ? 1 : 0), 0) : 0,
    viewer: app.nv.volumes.map(volume => volume.name),
  }));
  const log = () => page.evaluate(() => document.getElementById('technicalConsoleOutput').textContent);
  return { choose, hold, release, loaded, log, smallMask };
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
});
