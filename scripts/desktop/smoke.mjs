import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { prepareWorkflow, verifyWorkflow } from './workflows.mjs';
import { verifyBundle } from '../../packages/desktop/src/bundle.js';

const root = resolve(import.meta.dirname, '../..');
const resources = process.env.NEURODESK_BUNDLE || join(root, 'packages/desktop/resources');
const report = resolve(process.env.NEURODESK_TEST_REPORT || await mkdtemp(join(tmpdir(), 'neurodesk-desktop-report-')));
await mkdir(report, { recursive: true });
await verifyBundle(resources);
const require = createRequire(join(root, 'packages/desktop/package.json'));
const executablePath = process.env.NEURODESK_EXECUTABLE || require('electron');
const bundle = JSON.parse(await readFile(join(resources, 'manifest.json')));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const remoteModels = new Set(Object.values(bundle.assets).filter(asset => asset.remote && asset.kind === 'model').map(asset => asset.sha256));
const results = [];
let modelDownloadTested = false;
for (const app of bundle.apps.filter(app => !process.env.NEURODESK_TEST_APP || process.env.NEURODESK_TEST_APP.split(',').includes(app.id))) {
  const userData = await mkdtemp(join(tmpdir(), `neurodesk-${app.id}-`));
  const errors = [];
  const missing = [];
  let desktop;
  let progress;
  let prepared = null;
  try {
    prepared = process.env.NEURODESK_WORKFLOWS ? await prepareWorkflow(app.id) : null;
    desktop = await electron.launch({
      executablePath,
      args: [...(process.env.NEURODESK_CONTAINER === '1' ? ['--no-sandbox'] : []), ...(process.env.NEURODESK_EXECUTABLE ? [] : [join(root, 'packages/desktop')])],
      env: { ...environment, ...(prepared?.env ?? {}), NEURODESK_BUNDLE: resources, NEURODESK_APP: app.id, NEURODESK_USER_DATA: userData, NEURODESK_DOWNLOADS: join(report, app.id, 'downloads') },
      timeout: 60000,
    });
    const page = await desktop.firstWindow();
    let reporting = false;
    let previousStatus = '';
    progress = setInterval(async () => {
      if (reporting || !process.env.NEURODESK_WORKFLOWS) return;
      reporting = true;
      try {
        const status = await page.locator('#statusText, #status, #consoleOutput, #log').allTextContents();
        const text = status.join(' ').slice(-1600);
        if (text !== previousStatus) { console.log(`${app.id} progress: ${text}`); previousStatus = text; }
      } catch {} finally { reporting = false; }
    }, 10000);
    page.on('console', message => console.log(`${app.id} ${message.type()}: ${message.text()}`));
    page.on('pageerror', error => { console.error(`${app.id} pageerror: ${error.stack || error.message}`); errors.push(error.stack || error.message); });
    page.on('response', response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/_local/')) missing.push(`${response.status()} ${response.url()}`); });
    await page.waitForLoadState('domcontentloaded');
    if (bundle.modelsIncluded === false && !modelDownloadTested && process.env.NEURODESK_CONTAINER !== '1') {
      const [url, model] = Object.entries(bundle.assets).filter(([url, asset]) => asset.remote && url.endsWith('.onnx')).sort((a, b) => a[1].bytes - b[1].bytes)[0];
      const bytes = await page.evaluate(async url => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
        return (await response.arrayBuffer()).byteLength;
      }, url);
      if (bytes !== model.bytes) throw new Error('Downloaded model has the wrong size');
      modelDownloadTested = true;
      console.log(`Verified first-use model download: ${url}`);
    }
    const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible');
    if (await enter.count()) await enter.first().click();
    if (await page.locator('#welcomeLater:visible').count()) await page.locator('#welcomeLater').click();
    await page.locator('[data-neurodesk-shell-control=standalone]:visible').first().click({ timeout: 60000 });
    await page.locator('#neurodeskStandaloneDialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(report, `${app.id}.png`) });
    await page.locator('#neurodeskStandaloneDialog').getByRole('button', { name: 'Close', exact: true }).click();
    const workflow = process.env.NEURODESK_WORKFLOWS ? await verifyWorkflow(app.id, page, { root, resources, desktop, ...(prepared?.context ?? {}) }) : null;
    const blocked = await desktop.evaluate(() => globalThis.neurodeskOffline.blockedRequests);
    // An installed pack serves each model asset in place, so an asset hash in
    // this profile's cache was fetched over the network instead. Slices derived
    // from a packed asset are cached by their own hash and are not downloads.
    const cached = await readdir(join(userData, 'models')).catch(() => []);
    const downloaded = cached.filter(name => remoteModels.has(name)).length;
    if (process.env.NEURODESK_MODELS_DIR && downloaded) errors.push(`Downloaded ${downloaded} models although a model pack is installed`);
    results.push({ app: app.id, passed: !errors.length && !missing.length && !blocked.length, errors, missing, blocked, downloaded, workflow });
  } catch (error) {
    errors.push(error.message);
    results.push({ app: app.id, passed: false, errors, missing });
  } finally {
    clearInterval(progress);
    if (desktop && errors.length) {
      try { await (await desktop.firstWindow()).screenshot({ path: join(report, `${app.id}-failure.png`) }); } catch {}
    }
    await desktop?.close();
    await prepared?.close?.();
  }
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(join(report, 'startup.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Desktop test report: ${report}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
