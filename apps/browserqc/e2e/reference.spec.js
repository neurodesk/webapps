import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { ARTIFACTS, CASES, compare, pinnedExample, readReference, summarize, writeReference } from '../../../packages/browserqc/validation/reference.mjs';

// Runs quality control of the pinned example through the app itself (automation, segmentation
// worker, niimath worker, served assets) on the CPU backend the command line also runs, and
// compares its downloads with packages/browserqc/validation/reference.json, which the command
// line's release check also uses. Runs only when BROWSERQC_BROWSER_REFERENCE is "check" or
// "write" ("write" records the result).
const mode = process.env.BROWSERQC_BROWSER_REFERENCE;
const minutes = 60_000;
const dispatch = (page, command, request = {}) => page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

for (const model of CASES) {
  test(`web app ${model} quality control of the pinned example matches the browser reference`, async ({ page, browser }) => {
    test.skip(mode !== 'check' && mode !== 'write', 'set BROWSERQC_BROWSER_REFERENCE=check or write');
    test.setTimeout(30 * minutes);
    const example = await pinnedExample();
    await page.goto('./');
    await expect(page.locator('#neurodesk-input-transfer')).toHaveCount(1);
    for (const [role, file, mimeType] of [['image', example.image, 'application/gzip'], ['sidecar', example.sidecar, 'application/json']]) {
      await page.locator('#neurodesk-input-transfer').setInputFiles({ name: file.name, mimeType, buffer: await readFile(file.path) });
      await dispatch(page, 'adopt', { role });
    }
    const started = performance.now();
    await dispatch(page, 'start', { operation: 'quality-control', parameters: { backend: 'cpu', model } });
    await expect.poll(async () => {
      const snapshot = await dispatch(page, 'snapshot');
      if (snapshot.state === 'failed') throw new Error(JSON.stringify(snapshot.error));
      return snapshot.state;
    }, { timeout: 25 * minutes, intervals: [5_000] }).toBe('succeeded');
    const seconds = Math.round((performance.now() - started) / 1000);
    const { report } = await dispatch(page, 'snapshot');
    expect(report.provenance.segmentation).toMatchObject({ model, backend: 'cpu' });
    const files = {};
    for (const artifactId of Object.keys(report.artifacts)) {
      const downloaded = page.waitForEvent('download');
      await dispatch(page, 'download', { artifactId });
      const download = await downloaded;
      files[download.suggestedFilename()] = await readFile(await download.path());
    }
    expect(Object.keys(files).sort()).toEqual([...ARTIFACTS[model]].sort());
    const actual = summarize(files, await readFile(example.image.path));
    const sidecar = JSON.parse(await readFile(example.sidecar.path, 'utf8'));
    const reference = await readReference();
    if (mode === 'write') {
      reference.browser ??= { cases: {} };
      reference.browser.path = 'apps/browserqc/e2e/reference.spec.js: the app\'s quality-control automation on the CPU backend, built assets';
      reference.browser.app = `browserqc ${report.appVersion}`;
      reference.browser.browser = `Chromium ${browser.version()}`;
      reference.browser.cases[model] = { seconds, artifacts: actual };
      await writeReference(reference);
      return;
    }
    const failures = compare('web app', actual, reference.browser.cases[model].artifacts, 'browser', sidecar)
      .filter(([passed]) => !passed)
      .map(([, line]) => line);
    expect(failures).toEqual([]);
  });
}
