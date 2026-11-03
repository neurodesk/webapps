import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Network fixtures must reach Playwright rather than the app's offline service worker.
test.use({ serviceWorkers: 'block' });

const kbBytes = await readFile(new URL('../web/models/annotations/aphasia-kb.json', import.meta.url));

async function openFixture(page) {
  await page.goto('/');
  await page.waitForFunction(() => globalThis.app?.nv?.canvas);
  await page.evaluate(async () => {
    const { writeNifti1 } = await import('/js/modules/nifti-writer.js');
    const dims = [8, 8, 8];
    const affine = [[1, 0, 0, -4], [0, 1, 0, -4], [0, 0, 1, -4], [0, 0, 0, 1]];
    const data = new Uint8Array(512);
    data[219] = 1;
    const bytes = writeNifti1(data, { dims, spacing: [1, 1, 1], affine: affine.flat() });
    app.mniLesionFile = app.tagFileSpace(new File([bytes], 'synthetic-lesion.nii'), { space: 'mni160' });
    app.overlapResult = { summary: { networks: [] } };
    app.manifest = structuredClone(await app.ensureManifest());
    // Keep the real KB evaluator, with no label atlases and a tiny tract grid.
    app.manifest.kbReport.reportAtlases = {};
    app.manifest.kbReport.disconnectomeGrid = { dims, affine };
    globalThis.startKbPipeline = () => {
      globalThis.kbCompletion = app._runPipelineWithStatus({ stages: [{ id: 'kb-report', module: 'kb-report' }] }, 0, 'Reporting');
      app.progress.setCancellable(true);
    };
  });
}

for (const mode of ['mni', 'checkerboard', 'displacement']) {
  test(`report export omits misleading images from ${mode} QC`, async ({ page }) => {
    await openFixture(page);
    const result = await page.evaluate(async mode => {
      app.hasRegistrationDisplacement = true;
      app.registrationTemplateFile = app.mniLesionFile;
      app.registeredT1MniFile = app.mniLesionFile;
      app.registrationCheckerboardFile = app.mniLesionFile;
      app.displacementMagnitudeFile = app.mniLesionFile;
      await app.showRegistrationQc(mode);
      const volumes = app.nv.volumes.map(volume => volume.id);
      const crosshair = [...app.nv.scene.crosshairPos];
      for (const box of document.querySelectorAll('#reportParts [data-report-part]')) box.checked = ['method', 'image'].includes(box.dataset.reportPart);
      document.querySelector('#reportImageOptions input[value="both"]').checked = true;
      app.triggerBrowserDownload = async () => {};
      const html = await app.exportReport('html');
      return { html, status: document.getElementById('reportModalStatus').textContent, volumes, afterVolumes: app.nv.volumes.map(volume => volume.id), crosshair, afterCrosshair: [...app.nv.scene.crosshairPos] };
    }, mode);
    expect(result.html).toContain('Lesion images omitted');
    expect(result.html).not.toContain('<img');
    expect(result.status).toContain('Lesion images omitted');
    expect(result.afterVolumes).toEqual(result.volumes);
    expect(result.afterCrosshair).toEqual(result.crosshair);
  });
}

test('footer Cancel aborts the KB download and prevents later publication', async ({ page }) => {
  await openFixture(page);
  const url = await page.evaluate(() => {
    // Use a unique URL so cached KB bytes cannot bypass the pending download.
    const entry = app.manifest.annotationAssets.find(asset => asset.id === app.manifest.kbReport.annotationAssetId);
    entry.sourceUrl = new URL('/review-kb.json', location.href).href;
    return entry.sourceUrl;
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested;
  const request = new Promise(resolve => { requested = resolve; });
  await page.route(url, async route => {
    requested();
    await held;
    await route.fulfill({ body: kbBytes, contentType: 'application/json' }).catch(() => {});
  });
  await page.evaluate(() => globalThis.startKbPipeline());
  await request;
  await page.locator('#cancelButton').click();
  expect(await page.evaluate(() => globalThis.kbCompletion)).toBe('stopped');
  release();
  await expect(page.locator('#statusText')).toHaveText('Cancelled');
  expect(await page.evaluate(() => ({ report: app.kbReport, kb: app.knowledgeBase }))).toEqual({ report: null, kb: null });
});

test('footer Cancel stops tract scoring; rerunning can publish a new report', async ({ page }) => {
  await openFixture(page);
  await page.evaluate(async () => {
    const { DisconnectomeClient } = await import('/js/modules/kb-report.js');
    globalThis.tractWorkers = [];
    class ControlledWorker {
      constructor() { globalThis.tractWorkers.push(this); }
      postMessage(message) { this.message = message; }
      terminate() { this.terminated = true; }
    }
    app.disconnectomeClient = new DisconnectomeClient('synthetic-worker', { WorkerClass: ControlledWorker });
    // Avoid downloading a real tract atlas: this regression concerns the pending worker lifecycle.
    app.disconnectomeClient.sentAtlasKeys.add(app.manifest.atlasAssets.find(asset => asset.id === app.manifest.kbReport.disconnectomeAssetId).cacheKey);
    globalThis.startKbPipeline();
  });
  await page.waitForFunction(() => globalThis.tractWorkers[0]?.message);
  await page.locator('#cancelButton').click();
  expect(await page.evaluate(() => globalThis.kbCompletion)).toBe('stopped');
  expect(await page.evaluate(() => ({ report: app.kbReport, terminated: globalThis.tractWorkers[0].terminated, pending: app.disconnectomeClient.pending.size }))).toEqual({ report: null, terminated: true, pending: 0 });
  await expect(page.locator('#statusText')).toHaveText('Cancelled');
  await page.evaluate(() => {
    const old = globalThis.tractWorkers[0];
    old.onmessage({ data: { id: old.message.id, tracts: [], fractions: [] } });
    app.disconnectomeClient.sentAtlasKeys.add(app.manifest.atlasAssets.find(asset => asset.id === app.manifest.kbReport.disconnectomeAssetId).cacheKey);
    globalThis.startKbPipeline();
  });
  await page.waitForFunction(() => globalThis.tractWorkers[1]?.message);
  await page.evaluate(() => {
    const worker = globalThis.tractWorkers[1];
    worker.onmessage({ data: { id: worker.message.id, tracts: [], fractions: [] } });
  });
  expect(await page.evaluate(() => globalThis.kbCompletion)).toBe('complete');
  expect(await page.evaluate(() => app.kbReport)).not.toBeNull();
  await expect(page.locator('#statusText')).toHaveText('Complete');
});
