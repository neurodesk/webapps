import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadAppExamples } from '../scripts/lib/app-examples.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const id = process.argv[process.argv.indexOf('--app') + 1];
const app = (await loadAppsRegistry()).apps.find(entry => entry.id === id);
if (!app) throw new Error('Specify a registered app with --app <id>');
const examples = await loadAppExamples(app);
if (!process.argv.includes('--skip-build')) {
  execFileSync('pnpm', ['--filter', app.id, 'build'], { cwd: repoRoot, stdio: 'inherit' });
}
const scratch = await mkdtemp(join(tmpdir(), 'example-browser-'));
await mkdir(join(scratch, 'site'));
await symlink(join(repoRoot, 'apps', app.id, 'dist'), join(scratch, 'site', app.path));
const server = await serveSite(join(scratch, 'site'));
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
try {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/${app.path}/`, { waitUntil: 'domcontentloaded' });
  const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible').first();
  if (await enter.count()) await enter.click();
  const workspace = page.getByRole('link', { name: 'Open Workspace', exact: true });
  if (await workspace.isVisible()) await workspace.click();
  const welcome = page.locator('#welcomeLater');
  if (await welcome.isVisible()) await welcome.click();
  const selector = page.getByRole('combobox', { name: 'Example', exact: true });
  if (examples.length === 0) {
    await expect(selector).toHaveCount(0);
    await expect(page.locator('input[data-neurodesk-input="image"]').first()).toBeEnabled();
    console.log(`PASS ${app.id}: local scan input available without examples`);
  } else {
    await expect(selector).toHaveCount(1);
    await expect(selector).toBeVisible();
    await expect(selector).toBeEnabled({ timeout: 120000 });
    const state = page.locator('[data-neurodesk-examples]');
    await expect(state).toHaveAttribute('data-example-state', 'idle');
    for (const example of examples) {
      await selector.selectOption(example.id);
      await expect(state).toHaveAttribute('data-example-state', 'ready', { timeout: 180000 });
      await expect(state).toHaveAttribute('data-example-id', example.id);
      await expect(selector).toBeEnabled();
      console.log(`PASS ${app.id}: imported ${example.id}`);
    }
  }
  if (app.id === 'qsmbly') {
    const { readFile } = await import('node:fs/promises');
    const { readVolume } = await import('../packages/synthsr/src/volume.js');
    await expect(page.locator('#magField')).toHaveValue('3');
    expect(await page.evaluate(() => window.app.getEchoTimesFromInputs())).toEqual([20]);
    await page.locator('#prepareMaskInput').click();
    await expect(page.locator('#previewMask')).toBeEnabled({ timeout: 120000 });
    await page.locator('#previewMask').click();
    await page.locator('#thresholdRobust').click();
    await expect(page.locator('#runPipelineSidebar')).toBeEnabled({ timeout: 120000 });
    console.log('PASS qsmbly: prepared the phase-quality input and generated a robust mask');
    if (!await page.locator('#runPipelineSidebar').isVisible()) {
      await page.locator('#pipelineSection [data-disclosure-toggle]').click();
    }
    await page.locator('#runPipelineSidebar').click();
    await page.waitForFunction(() => window.app.pipelineExecutor.pipelineHasRun, null, { timeout: 300000 });
    const result = page.locator('#stage-item-final .stage-download');
    await expect(result).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await result.click();
    const download = await downloadPromise;
    const bytes = await readFile(await download.path());
    const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(volume.dims).toEqual([224, 224, 160]);
    expect(volume.data.every(Number.isFinite)).toBe(true);
    expect(volume.data.some(value => value !== 0)).toBe(true);
    console.log('PASS qsmbly: real brain example produced a finite, nonempty susceptibility map and download');
  }
  if (app.id === 'niimath') {
    const { readFile } = await import('node:fs/promises');
    const { readVolume } = await import('../packages/synthsr/src/volume.js');
    const sourceResponse = await page.request.get(examples.at(-1).files[0].url);
    expect(sourceResponse.ok()).toBe(true);
    const bytesOf = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const original = readVolume(bytesOf(await sourceResponse.body()));
    await page.locator('#command').fill('-mul 0 -add 7');
    await page.locator('#processButton').click();
    await expect(page.locator('#outputSection')).toHaveAttribute('open', '', { timeout: 120000 });
    await expect(page.locator('#saveButton')).toBeEnabled();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#saveButton').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('niimath.nii.gz');
    const processed = readVolume(bytesOf(await readFile(await download.path())));
    expect(processed.dims).toEqual(original.dims);
    expect(processed.data.length).toBeGreaterThan(0);
    expect(processed.data.every(value => value === 7)).toBe(true);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        expect(processed.affine[row][column]).toBeCloseTo(original.affine[row][column], 4);
      }
    }
    console.log('PASS niimath: real example arithmetic produced a downloaded image of sevens with preserved geometry');
  }
} finally {
  await browser.close();
  await server.close();
  await rm(scratch, { recursive: true, force: true });
}
