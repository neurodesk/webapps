import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium, expect as baseExpect } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';
import { dicomSeries } from '../test-utils/dicom-fixture.mjs';

const { apps } = await loadAppsRegistry();
const expect = baseExpect.configure({ timeout: 60000 });
const site = await serveSite(join(repoRoot, 'dist'), { isolationHeaders: false });
const baseURL = (process.env.BASE_URL || site.origin).replace(/\/+$/, '');
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const failures = [];
if (process.env.UPLOAD_ARTIFACTS) await mkdir(process.env.UPLOAD_ARTIFACTS, { recursive: true });
const checks = [
  ['carotid-flow', '#imageInput', async page => {
    // The fixture is a converted four-slice volume, which proves DICOM reaches the reader.
    await expect(page.locator('#statusText')).toContainText('has 4 slices; Carotid Flow reads one gated slice');
    await expect(page.locator('#runButton')).toBeDisabled();
  }],
  ['disconnectome', '#imageInput', async page => {
    await expect(page.locator('#lesionInfo')).toContainText('.nii');
    await expect(page.locator('#runButton')).toBeEnabled();
    await expect(page.locator('#imageLabel')).toContainText('LESION');
    await expect(page.locator('#saveButton')).toBeDisabled();
  }],
  ['brain-extraction', '#imageInput', async page => {
    await expect(page.locator('#fileInfo')).toContainText('16 × 16 × 4');
    await expect(page.locator('#runButton')).toBeEnabled();
  }],
  ['syncro', '#input', async page => {
    await expect(page.locator('#primaryInfo')).toContainText('16 × 16 × 4');
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#lesion').setInputFiles(dicomSeries({ extension: '' }));
    await expect(page.locator('#lesionInfo')).toContainText('16 × 16 × 4');
    await page.locator('#pathological').setInputFiles(dicomSeries({ extension: '' }));
    await expect(page.locator('#pathologicalInfo')).toContainText('16 × 16 × 4');
    await page.locator('#input').setInputFiles([...dicomSeries(), ...dicomSeries({series:2})]);
    await expect(page.locator('#statusText')).toContainText('one complete DICOM series for this slot');
    await expect(page.locator('#runButton')).toBeDisabled();
  }],
  ['synthsr', '#imageInput', async page => expect(page.locator('#fileInfo')).toContainText('16 × 16 × 4')],
  ['niimath', '#niftiInput', async page => {
    await expect(page.locator('#dicomPick option')).toHaveCount(1);
    await expect(page.locator('#loadingCircle')).toBeHidden();
  }],
  ['calmar', '#structuralFileInput', async page => {
    await expect.poll(() => page.evaluate(() => window.app?.structuralFile?.name)).toMatch(/\.nii/);
    for (const kind of ['Dwi', 'Adc']) {
      await page.locator(`#deepIsles${kind}FileInput`).setInputFiles(dicomSeries());
      await expect.poll(() => page.evaluate(kind => window.app?.[`deepIsles${kind}File`]?.name, kind)).toMatch(/\.nii/);
    }
  }],
  ['vesselboost', '#fileInput', async page => expect.poll(() => page.evaluate(() => window.app?.fileIOController?.getActiveFile()?.name)).toMatch(/\.nii/)],
  ['spinalcordtoolbox', '#fileInput', async page => expect.poll(() => page.evaluate(() => window.app?.fileIOController?.getActiveFile()?.name)).toMatch(/\.nii/)],
  ['musclemap', '#fileInput', async page => expect.poll(() => page.evaluate(() => window.app?.fileIOController?.getEntries()?.[0]?.file?.name)).toMatch(/\.nii/)],
  ['seedseg', '#unifiedFiles', async page => expect.poll(() => page.evaluate(() => window.app?._buckets?.t1w?.[0]?.name)).toMatch(/\.nii/)],
  ['qsmbly', '#unifiedFiles', async page => {
    await expect(page.locator('#consoleOutput')).toContainText('Magnitude (Echo 1) loaded', { timeout: 60000 });
    await page.locator('#maskFiles').setInputFiles(dicomSeries());
    await expect.poll(() => page.evaluate(() => window.app?.fileIOController?.maskFile?.[0]?.name)).toMatch(/\.nii/);
  }],
  ['easy-mp2rage', '#file', async page => {
    await expect(page.locator('#filetable')).toContainText('16 × 16 × 4');
    await page.locator('#file').setInputFiles([...dicomSeries(), ...dicomSeries({ series: 2 })]);
    await expect(page.locator('#log')).toContainText('one series at a time');
    await expect(page.locator('#filetable tbody tr')).toHaveCount(1);
  }],
  ['dicom2vid', '#pickFiles', async page => expect(page.locator('#optionsPanel')).toBeVisible()],
];
try {
  for (const [id, selector, verify] of checks) {
    if (process.env.SMOKE_APPS && !process.env.SMOKE_APPS.split(',').includes(id)) continue;
    const app = apps.find(app => app.id === id);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(60000);
    try {
      await page.goto(`${baseURL}/${app.path}/`, { waitUntil: 'domcontentloaded' });
      if (await page.locator('script[src*="coi-serviceworker"]').count()) {
        await page.waitForFunction(() => crossOriginIsolated);
      }
      await page.waitForLoadState('load');
      const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible');
      if (await enter.count()) await enter.first().click();
      await expect(page.locator(selector)).toBeEnabled();
      await page.locator(selector).setInputFiles(dicomSeries({ extension: '.IMA' }));
      await verify(page);
      if (process.env.UPLOAD_ARTIFACTS) {
        const welcome = page.locator('#welcomeLater');
        if (await welcome.isVisible()) await welcome.click();
        await page.screenshot({ path: join(process.env.UPLOAD_ARTIFACTS, `${id}-loaded.png`), fullPage: true });
        await page.locator('[data-neurodesk-theme-toggle]:visible').first().click();
        await page.screenshot({ path: join(process.env.UPLOAD_ARTIFACTS, `${id}-loaded-alternate-theme.png`), fullPage: true });
      }
      console.log(`PASS ${id}: same scan picker imports a real four-slice DICOM series`);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
      console.error(`FAIL ${id}: ${error.message}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await site.close(); }
if (failures.length) process.exitCode = 1;
