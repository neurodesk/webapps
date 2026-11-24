import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { chromium, expect as baseExpect } from '@playwright/test';
import { serveSite } from '../test-utils/serve-site.mjs';
import { siteUnderTest } from '../test-utils/site-catalog.mjs';
import { findApp } from '../scripts/lib/apps-registry.mjs';
import { dicomSeries } from '../test-utils/dicom-fixture.mjs';
import { requireChecked, smokeApps } from '../scripts/lib/smoke-apps.mjs';

function syntheticPng(name = 'lesion.png', width = 64, height = 64) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([typeBuf, data])) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      const lesion = dx * dx + dy * dy < 16 * 16;
      const p = row + 1 + x * 3;
      raw[p] = lesion ? 96 : 216;
      raw[p + 1] = lesion ? 54 : 178;
      raw[p + 2] = lesion ? 34 : 154;
    }
  }
  return {
    name,
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

const { registry, apps, siteDir } = await siteUnderTest();
const selection = smokeApps(registry.apps);
let checked = 0;
const expect = baseExpect.configure({ timeout: 60000 });
const site = await serveSite(siteDir, { isolationHeaders: false });
const baseURL = (process.env.BASE_URL || site.origin).replace(/\/+$/, '');
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
const failures = [];
if (process.env.UPLOAD_ARTIFACTS) await mkdir(process.env.UPLOAD_ARTIFACTS, { recursive: true });
const checks = [
  ['lcmodel', '#t1Input', async page => {
    await expect(page.locator('#t1Info')).toContainText('16 × 16 × 4');
    await expect(page.locator('#t1Canvas')).toBeVisible();
    await expect(page.locator('#viewerNotice')).toBeHidden();
    await page.locator('#t1Input').setInputFiles([...dicomSeries(), ...dicomSeries({ series: 2 })]);
    await expect(page.locator('#statusText')).toContainText('choose the one T1 series');
    await expect(page.locator('#t1Info')).toContainText('16 × 16 × 4');
    await expect(page.locator('#t1Canvas')).toBeVisible();
  }],
  ['elastix', '#movingInput', async page => {
    await expect(page.locator('#movingInfo')).toContainText('.nii');
    await expect(page.locator('#runButton')).toBeDisabled();
    await page.locator('#fixedInput').setInputFiles([
      ...dicomSeries({ extension: '' }), ...dicomSeries({ series: 2, extension: '' }),
    ]);
    await expect(page.locator('#fixedSeries option')).toHaveCount(2);
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#fixedSeries').selectOption('1');
    await expect(page.locator('#fixedSeries')).toHaveValue('1');
    await expect(page.locator('#fixedInfo')).toContainText('.nii');
  }],
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
  ['syncro', '#movingInput', async page => {
    await expect(page.locator('#movingInfo')).toContainText('16×16×4');
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.locator('#lesion').setInputFiles(dicomSeries({ extension: '' }));
    await expect(page.locator('#lesionInfo')).toContainText('16 × 16 × 4');
    await page.locator('#pathological').setInputFiles(dicomSeries({ extension: '' }));
    await expect(page.locator('#pathologicalInfo')).toContainText('16 × 16 × 4');
    await page.locator('#movingInput').setInputFiles([...dicomSeries(), ...dicomSeries({series:2})]);
    await expect(page.locator('#statusText')).toContainText('one complete DICOM series for the moving image');
    await expect(page.locator('#movingInfo')).toContainText('16×16×4');
    await expect(page.locator('#runButton')).toBeEnabled();
  }],
  ['nesvor', '#imageInput', async page => {
    await expect(page.locator('#fileInfo')).toContainText('1 stack loaded');
    await expect(page.locator('#stackRows [data-stack]')).toHaveCount(1);
    await expect(page.locator('#imageInput')).toBeEnabled();
    await page.locator('#imageInput').setInputFiles([...dicomSeries({ extension: '' }), ...dicomSeries({ series: 2, extension: '' })]);
    await expect(page.locator('#stackRows [data-stack]')).toHaveCount(3);
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
  ['mri2vid', '#pickFiles', async page => expect(page.locator('#optionsPanel')).toBeVisible()],
  ['dermoscope', '#imageInput', async page => {
    await expect(page.locator('#fileInfo')).toContainText('lesion.png');
    await expect(page.locator('#runButton')).toBeEnabled();
  }, { files: () => syntheticPng(), label: 'imports a PNG dermoscopy photograph' }],
];
try {
  for (const [id, selector, verify, options = {}] of checks) {
    if (!selection.apps.some(app => app.id === id)) continue;
    // A host serves only its catalogue's apps.
    if (!apps.some(app => app.id === id)) continue;
    checked += 1;
    const app = findApp(registry, id);
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
      await page.locator(selector).setInputFiles(options.files ? options.files() : dicomSeries({ extension: '.IMA' }));
      await verify(page);
      if (process.env.UPLOAD_ARTIFACTS) {
        const welcome = page.locator('#welcomeLater');
        if (await welcome.isVisible()) await welcome.click();
        await page.screenshot({ path: join(process.env.UPLOAD_ARTIFACTS, `${id}-loaded.png`), fullPage: true });
        await page.locator('[data-neurodesk-theme-toggle]:visible').first().click();
        await page.screenshot({ path: join(process.env.UPLOAD_ARTIFACTS, `${id}-loaded-alternate-theme.png`), fullPage: true });
      }
      console.log(`PASS ${id}: ${options.label ?? 'same scan picker imports a real four-slice DICOM series'}`);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
      console.error(`FAIL ${id}: ${error.message}`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); await site.close(); }
if (failures.length) process.exitCode = 1;
requireChecked(checked, selection, 'Image uploads');
