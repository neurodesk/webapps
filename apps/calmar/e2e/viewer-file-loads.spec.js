import { expect, test } from '@playwright/test';

async function openViewer(page) {
  await page.goto('/');
  await page.waitForFunction(() => globalThis.app?.nv?.canvas, null, { timeout: 60000 });
  await page.evaluate(async () => {
    const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
    const affine = [2, 0, 0, -8, 0, 2, 0, -8, 0, 0, 2, -8, 0, 0, 0, 1];
    const volume = new Uint8Array(writeNifti1(new Float32Array(512), { dims: [8, 8, 8], affine }));
    const header = volume.slice(0, volume.length - 512 * 4);
    const frame = value => new Float32Array(512).fill(value);
    globalThis.scan = name => new File([volume], name);
    globalThis.series = (name) => {
      const dims = new DataView(header.buffer);
      dims.setInt16(40, 4, true);
      dims.setInt16(48, 3, true);
      return new File([header, frame(1), frame(2), frame(3)], name);
    };
  });
}

test('a partly loaded 4D image put back into the viewer loads its remaining frames', async ({ page }) => {
  await openViewer(page);
  const result = await page.evaluate(async () => {
    const viewer = app.viewerController;
    app.nv.opts.limitFrames4D = 1;
    await viewer.loadBaseVolume(globalThis.series('bold.nii'), { assertCurrent: () => {} });
    const image = app.nv.volumes[0];
    const partial = [image.nFrame4D, image.nTotalFrame4D];
    viewer.clearVolumes();
    app.nv.addVolume(image);
    const deferred = await app.nv.loadDeferred4DVolumes(image.id).then(() => 'loaded', error => error.message);
    return { partial, deferred, frames: image.nFrame4D, lastFrame: image.img[512 * 2] ?? null };
  });
  expect(result).toEqual({ partial: [1, 3], deferred: 'loaded', frames: 3, lastFrame: 3 });
});

test('a superseded load and its replacement read their files without an object URL or a fetch', async ({ page }) => {
  await openViewer(page);
  const result = await page.evaluate(async () => {
    const viewer = app.viewerController;
    let objectUrls = 0;
    let fetches = 0;
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = (...args) => {
      objectUrls += 1;
      return createObjectURL.apply(URL, args);
    };
    const fetchResource = globalThis.fetch;
    globalThis.fetch = (...args) => {
      fetches += 1;
      return fetchResource(...args);
    };
    let current = true;
    const superseded = viewer.loadBaseVolume(globalThis.scan('old.nii'), {
      assertCurrent: () => {
        if (!current) throw new DOMException('superseded', 'AbortError');
      },
    }).then(() => 'committed', error => error.name);
    current = false;
    viewer.releaseSupersededLoads();
    const shown = await viewer.loadVolumeStack([
      { file: globalThis.scan('new.nii'), stage: 'structural' },
      { file: globalThis.scan('mask.nii'), stage: 'lesion' },
    ], { assertCurrent: () => {} });
    return { superseded: await superseded, shown, viewer: app.nv.volumes.map(volume => volume.name), objectUrls, fetches };
  });
  expect(result).toEqual({ superseded: 'AbortError', shown: true, viewer: ['new.nii', 'mask.nii'], objectUrls: 0, fetches: 0 });
});

test('a file that is no NIfTI image is reported with the reason', async ({ page }) => {
  await openViewer(page);
  const messages = await page.evaluate(async () => {
    const viewer = app.viewerController;
    const lines = [];
    viewer.updateOutput = message => lines.push(message);
    const loaded = await viewer.loadBaseVolume(new File(['not an image'], 'broken.nii'), { assertCurrent: () => {} });
    return { loaded, last: lines.at(-1) };
  });
  expect(messages).toEqual({ loaded: false, last: 'Error loading broken.nii: Failed to parse NIfTI file broken.nii.' });
});
