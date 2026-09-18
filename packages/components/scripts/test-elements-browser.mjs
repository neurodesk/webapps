import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const fixture = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Custom element browser verification</title>
  <link rel="stylesheet" href="/src/styles/imaging-workspace.css">
</head>
<body>
  <main>
    <section data-example-scope id="firstWorkflow">
      <nd-file-field id="firstFile" label="First scan"></nd-file-field>
      <nd-example-selector id="example"></nd-example-selector>
      <div id="moveTarget"></div>
    </section>
    <section data-example-scope>
      <nd-file-field id="secondFile" label="Second scan"></nd-file-field>
    </section>
    <nd-viewer-toolbar id="firstToolbar"></nd-viewer-toolbar>
    <nd-viewer-toolbar id="secondToolbar"></nd-viewer-toolbar>
    <nd-result-list id="results"></nd-result-list>
    <nd-console id="firstConsole" label="First log" collapsed></nd-console>
    <nd-console id="secondConsole" label="Second log" collapsed></nd-console>
  </main>
  <script type="module">
    import {
      defineConsole, defineFileField, defineResultList,
      defineViewerToolbar, defineExampleSelector,
    } from '/src/elements/index.js';
    import { WindowControls } from '/src/ui/WindowControls.js';

    const byId = id => document.getElementById(id);
    const state = window.fixture = { files: {}, downloads: [], jobs: [], updates: [] };
    for (const id of ['firstToolbar', 'secondToolbar']) {
      byId(id).options = { overlay: false, colormap: false, screenshot: false };
    }
    const example = byId('example');
    example.examples = [{
      id: 'small', label: 'Small fixture', description: 'Browser test input.',
      expectedResult: 'Import completes.',
      files: [{ role: 'image', name: 'example.nii', url: '/example.nii' }],
    }];
    example.onLoad = async (_example, { signal, fetchFiles, assertCurrent }) => {
      const job = { signal };
      state.jobs.push(job);
      await fetchFiles();
      await new Promise(resolve => { job.release = resolve; });
      assertCurrent();
    };
    state.example = example;
    for (const define of [defineConsole, defineFileField, defineResultList, defineViewerToolbar, defineExampleSelector]) define();
    for (const id of ['firstFile', 'secondFile']) {
      byId(id).addEventListener('nd-files', async event => {
        state.files[id] = (await event.detail.files).map(file => file.name);
      });
    }
    const volumes = state.volumes = [
      { global_min: 0, global_max: 200, cal_min: 0, cal_max: 200 },
      { global_min: 0, global_max: 100, cal_min: 10, cal_max: 90 },
    ];
    ['firstToolbar', 'secondToolbar'].forEach((id, index) => {
      const controls = new WindowControls({
        root: byId(id), getVolume: () => volumes[index],
        updateVolume: () => state.updates.push(index),
      });
      controls.bind();
      controls.sync();
    });
    byId('results').render({ scan: { description: 'Processed scan' } });
    byId('results').addEventListener('nd-download', event => state.downloads.push(event.detail.stage));
    byId('firstConsole').log('First console entry');
    byId('secondConsole').log('Second console entry');
    state.ready = true;
  </script>
</body>
</html>`;

const artifacts = process.env.ELEMENT_ARTIFACTS || join(tmpdir(), 'webapp-elements');
await mkdir(artifacts, { recursive: true });
const site = await serveSite(fileURLToPath(new URL('..', import.meta.url)));
let browser;
try {
  browser = await chromium.launch();
  for (const [name, viewport, mobile] of [
    ['desktop', { width: 1280, height: 900 }, false],
    ['phone', { width: 390, height: 844 }, true],
  ]) {
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: site.origin });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`${site.origin}/`, route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.route(`${site.origin}/example.nii`, route => route.fulfill({ body: 'browser-test-input' }));
    try {
      await page.goto(site.origin);
      await page.waitForFunction(() => window.fixture?.ready);
      assert.equal(await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
        return new Set(ids).size === ids.length;
      }), true, 'all generated control IDs must be unique');

      const firstLog = page.locator('#firstConsole');
      const secondLog = page.locator('#secondConsole');
      const toggle = firstLog.getByRole('button', { name: /First log/i });
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(firstLog.locator('.nd-console-output')).toBeVisible();
      await expect(secondLog.locator('.nd-console-output')).toBeHidden();
      await toggle.press('Space');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await firstLog.getByRole('button', { name: 'Copy', exact: true }).click();
      await expect(firstLog.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /First console entry/);
      await firstLog.getByRole('button', { name: 'Clear', exact: true }).click();
      await expect(firstLog.locator('.nd-console-line')).toHaveCount(0);
      await expect(secondLog.locator('.nd-console-line')).toHaveCount(1);

      await page.locator('#firstToolbar [data-nd-control="windowMin"]').fill('25');
      await page.locator('#firstToolbar [data-nd-control="windowMin"]').press('Tab');
      await expect.poll(() => page.evaluate(() => window.fixture.volumes.map(volume => volume.cal_min))).toEqual([25, 10]);
      assert.deepEqual(await page.evaluate(() => window.fixture.updates), [0]);
      await page.locator('#firstToolbar').getByRole('button', { name: 'Axial', exact: true }).click();
      await expect(page.locator('#firstToolbar [data-view="axial"]')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#secondToolbar [data-view="multiplanar"]')).toHaveAttribute('aria-pressed', 'true');

      await page.locator('#firstFile input').setInputFiles({ name: 'first.nii', mimeType: 'application/octet-stream', buffer: Buffer.from('first') });
      await page.locator('#secondFile input').setInputFiles({ name: 'second.nii', mimeType: 'application/octet-stream', buffer: Buffer.from('second') });
      await expect.poll(() => page.evaluate(() => window.fixture.files)).toEqual({ firstFile: ['first.nii'], secondFile: ['second.nii'] });
      await page.evaluate(() => { document.getElementById('firstFile').disabled = true; });
      await expect(page.locator('#firstFile input')).toBeDisabled();
      await expect(page.locator('#secondFile input')).toBeEnabled();
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['ignored'], 'ignored.nii'));
        document.querySelector('#firstFile label').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      });
      assert.deepEqual(await page.evaluate(() => window.fixture.files.firstFile), ['first.nii']);
      await page.locator('#results').getByRole('button', { name: 'Download', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fixture.downloads), ['scan']);

      await page.locator('#example select').selectOption('small');
      await page.waitForFunction(() => typeof window.fixture.jobs[0]?.release === 'function');
      await page.evaluate(() => document.getElementById('moveTarget').append(window.fixture.example));
      await expect(page.locator('#example')).toHaveAttribute('data-example-state', 'loading');
      assert.equal(await page.evaluate(() => window.fixture.jobs[0].signal.aborted), false);
      await page.evaluate(() => window.fixture.jobs[0].release());
      await expect(page.locator('#example')).toHaveAttribute('data-example-state', 'ready');
      await expect(page.locator('#example select')).toHaveCount(1);
      await page.locator('#example select').selectOption('small');
      await page.waitForFunction(() => typeof window.fixture.jobs[1]?.release === 'function');
      await page.evaluate(() => window.fixture.example.remove());
      await expect.poll(() => page.evaluate(() => window.fixture.jobs[1].signal.aborted)).toBe(true);
      await page.evaluate(() => {
        document.getElementById('firstWorkflow').append(window.fixture.example);
        window.fixture.jobs[1].release();
      });
      await expect(page.locator('#example')).toHaveAttribute('data-example-state', 'cancelled');
      await expect(page.locator('#example select')).toBeEnabled();
      await expect(page.locator('#example select')).toHaveCount(1);

      assert.deepEqual(errors, [], 'browser must not report uncaught errors');
      await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
      console.log(`PASS ${name}: custom element keyboard, clipboard, independent controls, file selection, events and lifecycle`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${name}-failure.png`), fullPage: true });
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`Element browser screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  await site.close();
}
