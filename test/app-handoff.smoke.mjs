#!/usr/bin/env node
// DICOM View hands its converted image to White matter lesions, and through the shell's
// receiver to Carotid Flow, on the built composite site,
// in every engine: once with isolation headers, as the hosted site sends them, and once
// without, so each app's isolation service worker installs and reloads the page on its first
// visit, the receiving page included. Pass engine names to limit the run.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect as baseExpect, firefox, webkit } from '@playwright/test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { dicomSeries } from '../test-utils/dicom-fixture.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
const siteDir = process.env.HANDOFF_SITE_DIR ?? join(repoRoot, 'dist');
const launchArgs = { chromium: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] };
const LOADED = 'Loaded series7_test_scan_7.nii from DICOM View';
// As patient as the page's own 60 s timeout: conversion and the isolation reloads take time.
const expect = baseExpect.configure({ timeout: 60000 });

async function handoff(engine, isolationHeaders) {
  const site = await serveSite(siteDir, { isolationHeaders });
  const profile = await mkdtemp(join(tmpdir(), `handoff-${engine}-`));
  // A profile on disk: WebKit's ephemeral sessions refuse Blobs in IndexedDB.
  const context = await { chromium, firefox, webkit }[engine].launchPersistentContext(profile, { args: launchArgs[engine] ?? [] });
  try {
    await context.addInitScript(() => {
      if (!location.pathname.includes('/white-matter-lesions/')) return;
      sessionStorage.setItem('receiverLoads', String(Number(sessionStorage.getItem('receiverLoads') ?? 0) + 1));
      const Native = window.Worker;
      window.startedWorkers = [];
      window.Worker = class extends Native {
        constructor(url, options) {
          super(url, options);
          window.startedWorkers.push(String(url));
        }
      };
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${site.origin}/dicomview/`);
    // The first visit may reload once for isolation; work in the page that stays.
    await page.waitForFunction(() => window.crossOriginIsolated && document.getElementById('dicomInput'));
    await page.locator('#dicomInput').setInputFiles(dicomSeries({ series: 7, slices: 12 }).map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    const menu = page.getByRole('combobox', { name: 'Open in another webapp', exact: true });
    await expect(menu.locator('option[value="white-matter-lesions"]')).toBeEnabled();
    await menu.selectOption('white-matter-lesions');
    await page.waitForURL(/\/white-matter-lesions\//);
    await expect(page.locator('#statusText')).toHaveText(LOADED);
    await expect(page.locator('#fileInfo')).toHaveText('series7_test_scan_7.nii · 16 × 16 × 12 voxels');
    await expect(page.locator('#runButton')).toBeEnabled();
    await page.waitForTimeout(1500);
    await expect(page.locator('#statusText'), 'nothing started after the load').toHaveText(LOADED);
    await expect(page.locator('#cancelButton')).toBeHidden();
    const after = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('neurodesk-handoff');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const keys = await new Promise((resolve) => {
        database.transaction('entries').objectStore('entries').getAllKeys().onsuccess = ({ target }) => resolve(target.result);
      });
      database.close();
      return {
        hash: location.hash,
        keys,
        secrets: Object.keys(sessionStorage).filter((key) => key.startsWith('neurodesk-handoff:')),
        loads: Number(sessionStorage.getItem('receiverLoads')),
        segmentation: window.startedWorkers.filter((url) => /\/worker-[^/]*\.js/.test(url)),
        isolated: window.crossOriginIsolated,
      };
    });
    assert.equal(after.hash, '');
    assert.deepEqual(after.keys, [], 'the entry is deleted');
    assert.deepEqual(after.secrets, [], 'the secret is used up');
    assert.deepEqual(after.segmentation, [], 'no segmentation worker started');
    assert.equal(after.isolated, true);
    if (!isolationHeaders) assert.ok(after.loads >= 2, `the receiving page reloaded for isolation (${after.loads} load)`);
    return after.loads;
  } finally {
    await context.close();
    await site.close();
    await rm(profile, { recursive: true, force: true });
  }
}

// Carotid Flow binds its input in its first module, which the build places before the shell's:
// the shell must deliver the handoff to that input as soon as the page is up, not after its 60 s
// fallback. Timed at delivery: headless Firefox in CI has no WebGL2, and an app that needs a
// viewer to load keeps its input disabled there; Carotid Flow takes the series without one.
async function shellHandoff(engine) {
  const site = await serveSite(siteDir, { isolationHeaders: true });
  const profile = await mkdtemp(join(tmpdir(), `handoff-shell-${engine}-`));
  const context = await { chromium, firefox, webkit }[engine].launchPersistentContext(profile, { args: launchArgs[engine] ?? [] });
  try {
    await context.addInitScript(() => {
      if (!location.pathname.includes('/carotid-flow/')) return;
      window.addEventListener('change', (event) => {
        const input = event.target;
        if (input.id === 'imageInput' && input.files?.length) window.delivered ??= { at: performance.now(), names: [...input.files].map((file) => file.name) };
      }, true);
    });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${site.origin}/dicomview/`);
    await page.waitForFunction(() => window.crossOriginIsolated && document.getElementById('dicomInput'));
    const series = dicomSeries({ series: 7, slices: 12 });
    await page.locator('#dicomInput').setInputFiles(series.map(({ name, mimeType, buffer }) => ({ name, mimeType, buffer })));
    const menu = page.getByRole('combobox', { name: 'Open in another webapp', exact: true });
    await expect(menu.locator('option[value="carotid-flow"]')).toBeEnabled();
    await menu.selectOption('carotid-flow');
    await page.waitForURL(/\/carotid-flow\//);
    const delivered = await (await page.waitForFunction(() => window.delivered, null, { timeout: 60000 })).jsonValue();
    assert.deepEqual(delivered.names.sort(), series.map(({ name }) => name).sort(), 'the series\' DICOM files');
    assert.ok(delivered.at < 20000, `delivered ${(delivered.at / 1000).toFixed(1)} s after the page started`);
    return delivered.at / 1000;
  } finally {
    await context.close();
    await site.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const failures = [];
for (const engine of engines) {
  for (const isolationHeaders of [true, false]) {
    const label = `${engine}, ${isolationHeaders ? 'isolation headers' : 'isolation service worker'}`;
    try {
      const loads = await handoff(engine, isolationHeaders);
      console.log(`PASS ${label}: image loaded from DICOM View (${loads} receiving page load${loads === 1 ? '' : 's'})`);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      console.error(`FAIL ${label}: ${error.message}`);
    }
  }
  try {
    const seconds = await shellHandoff(engine);
    console.log(`PASS ${engine}, shell receiver: Carotid Flow received the series ${seconds.toFixed(1)} s after its page started`);
  } catch (error) {
    failures.push(`${engine}, shell receiver: ${error.message}`);
    console.error(`FAIL ${engine}, shell receiver: ${error.message}`);
  }
}
if (failures.length) {
  console.error(`\n${failures.length} handoff check(s) failed`);
  process.exit(1);
}
