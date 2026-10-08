import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TENSOR_MAPS, mapFileName } from '@neurodesk/dwi2trx';
import { fit } from '@neurodesk/dwi2trx/node';
import { EXAMPLE_SHA256, compare, pinnedExample, readReference, summarize, writeReference } from '../../../packages/dwi2trx/validation/reference.mjs';
import { gpuBrowser } from '../../../test-utils/hardware-gpu.mjs';

// Fits the pinned example's tensor through the app itself (automation, tensor worker, vendored
// niimath, served assets) and compares every map with
// packages/dwi2trx/validation/dwi-gradients-reference.json, which the command line's release
// check also uses. The app's MindGrab runs on WebGPU, so the brain mask comes from the command
// line's CPU MindGrab and is handed to the app through its mask role: this isolates the fit.
// Runs only when DWI2TRX_BROWSER_REFERENCE is "check" or "write" ("write" records the result).
const mode = process.env.DWI2TRX_BROWSER_REFERENCE;
// Chromium stops a tab's scripted downloads after ten, so the eleven maps take two runs.
const DOWNLOADS_PER_PAGE = 10;

test.use(gpuBrowser);

async function fitInApp(page, roles) {
  await page.goto('/');
  for (const [role, path] of roles) {
    await page.locator('#neurodesk-input-transfer').setInputFiles(path);
    await page.evaluate((role) => globalThis.neurodeskAutomation.dispatch('adopt', { role }), role);
  }
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'fit' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 5 * 60_000, intervals: [2_000] }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  expect(snapshot.report.provenance.tensor).toMatchObject({ algorithm: 'niimath dtifit', masked: true, mask: { source: 'provided' } });
  return snapshot.report;
}

test('web app tensor fit of the pinned example matches the browser reference', async ({ page, browser }) => {
  test.skip(mode !== 'check' && mode !== 'write', 'set DWI2TRX_BROWSER_REFERENCE=check or write');
  test.setTimeout(15 * 60_000);
  const example = await pinnedExample();
  const work = await mkdtemp(join(tmpdir(), 'dwi2trx-reference-'));
  try {
    const cli = await fit({ dwi: example.image.path, bval: example.bval.path, bvec: example.bvec.path, output: join(work, 'cli') });
    expect(cli.provenance.masked).toBe(true);
    const maskPath = join(work, 'cli', mapFileName(example.image.name, 'mask'));
    const mask = summarize(await readFile(maskPath));
    const roles = [['image', example.image.path], ['bval', example.bval.path], ['bvec', example.bvec.path], ['mask', maskPath]];
    const maps = {};
    let report;
    let seconds;
    let tab = page;
    while (Object.keys(maps).length < TENSOR_MAPS.length) {
      const started = performance.now();
      report = await fitInApp(tab, roles);
      seconds ??= Math.round((performance.now() - started) / 1000);
      const pending = Object.entries(report.artifacts).filter(([, artifact]) => !maps[TENSOR_MAPS.find((name) => name.toLowerCase() === artifact.role)]);
      for (const [artifactId, artifact] of pending.slice(0, DOWNLOADS_PER_PAGE)) {
        const map = TENSOR_MAPS.find((name) => name.toLowerCase() === artifact.role);
        const downloading = tab.waitForEvent('download');
        await tab.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(mapFileName(example.image.name, map));
        maps[map] = summarize(await readFile(await download.path()));
      }
      tab = await page.context().newPage();
    }
    expect(Object.keys(maps).sort()).toEqual([...TENSOR_MAPS].sort());
    if (mode === 'write') {
      await writeReference({
        example: example.id,
        inputs: EXAMPLE_SHA256,
        mask: { path: 'dwi2trx command line: MindGrab CPU modules on the first b0 volume', provenance: cli.provenance.mask, ...mask },
        browser: {
          path: "apps/dwi2trx/e2e/reference.spec.js: the app's fit automation with the mask role, tensor worker, built assets",
          app: `dwi2trx ${report.appVersion}`,
          niimath: report.provenance.tensor.version,
          browser: `Chromium ${browser.version()}`,
          seconds,
          maps,
        },
      });
      return;
    }
    const reference = await readReference();
    expect(mask.voxelSha256, 'the command line\'s MindGrab mask is the recorded one').toBe(reference.mask.voxelSha256);
    const failures = compare('web app', maps, reference.browser.maps, 'browser reference')
      .filter(([passed]) => !passed)
      .map(([, line]) => line);
    expect(failures).toEqual([]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
