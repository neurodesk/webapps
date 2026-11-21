import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { prepareWorkflow, verifyWorkflow } from './workflows.mjs';
import { diagnosticLines, failureSnapshot } from './smoke-diagnostics.mjs';
import { observePageDiagnostics } from './page-diagnostics.mjs';
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
const appTimeoutMs = Number(process.env.NEURODESK_APP_TIMEOUT_MS) || (process.env.NEURODESK_WORKFLOWS ? 12 * 60 * 1000 : 3 * 60 * 1000);
const maxAppAttempts = process.env.CI ? 2 : 1;

function isTransientDesktopFailure(error) {
  const message = String(error?.message || error || '');
  return /timed out|Target page, context or browser has been closed|electron\.launch|browser has been closed|EPIPE|ECONNRESET|net::ERR_/i.test(message);
}

async function runSingleApp(app) {
  const userData = await mkdtemp(join(tmpdir(), `neurodesk-${app.id}-`));
  const errors = [];
  const missing = [];
  let desktop;
  let progress;
  let deadlineTimer;
  let prepared = null;
  let diagnostics = { requestFailures: [], consoleErrors: [] };
  let timedOut = false;
  try {
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        try { desktop?.process()?.kill('SIGKILL'); } catch { /* ignore */ }
        reject(new Error(`${app.id} timed out after ${Math.round(appTimeoutMs / 1000)}s`));
      }, appTimeoutMs);
    });
    const run = (async () => {
      prepared = process.env.NEURODESK_WORKFLOWS ? await prepareWorkflow(app.id) : null;
      desktop = await electron.launch({
        executablePath,
        args: [...(process.env.NEURODESK_CONTAINER === '1' ? ['--no-sandbox'] : []), ...(process.env.NEURODESK_EXECUTABLE ? [] : [join(root, 'packages/desktop')])],
        env: { ...environment, ...(prepared?.env ?? {}), NEURODESK_BUNDLE: resources, NEURODESK_APP: app.id, NEURODESK_USER_DATA: userData, NEURODESK_DOWNLOADS: join(report, app.id, 'downloads') },
        timeout: 60000,
      });
      if (environment.NEURODESK_SMOKE_DIAGNOSTICS === '1') {
        const child = desktop.process();
        for (const channel of ['stdout', 'stderr']) {
          const consume = diagnosticLines(record => console.error(JSON.stringify(record)));
          child[channel]?.on('data', chunk => {
            consume(chunk);
            console.error(JSON.stringify({ time: new Date().toISOString(), event: `electron-${channel}`, bytes: chunk.length }));
          });
        }
        child.on('exit', (code, signal) => console.error(JSON.stringify({ time: new Date().toISOString(), event: 'electron-exit', code, signal })));
      }
      const page = await desktop.firstWindow();
      let reporting = false;
      let previousStatus = '';
      progress = setInterval(async () => {
        if (reporting || !process.env.NEURODESK_WORKFLOWS) return;
        reporting = true;
        try {
          const status = await page.locator('#statusText, #status, #consoleOutput, #technicalConsoleOutput, #technicalLog, #log').allTextContents();
          const text = status.join(' ').slice(-1600);
          if (text !== previousStatus) { console.log(`${app.id} progress: ${text}`); previousStatus = text; }
        } catch { /* The window can close during diagnostic polling; workflow errors are recorded separately. */ } finally { reporting = false; }
      }, 10000);
      diagnostics = observePageDiagnostics(page, { label: app.id });
      page.on('pageerror', error => { console.error(`${app.id} pageerror: ${error.stack || error.message}`); errors.push(error.stack || error.message); });
      // nd-compute-connection probes the page's own origin for a compute server that serves the app; the desktop never is one.
      const computeProbe = (response, url) => response.status() === 404 && url.origin === new URL(page.url()).origin && url.pathname === '/api/v1/info';
      page.on('response', response => {
        const url = new URL(response.url());
        if (response.status() >= 400 && !url.pathname.startsWith('/_local/') && !computeProbe(response, url)) missing.push(`${response.status()} ${response.url()}`);
      });
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
      return { app: app.id, passed: !errors.length && !missing.length && !blocked.length, errors, missing, blocked, downloaded, workflow, diagnostics };
    })();
    return await Promise.race([run, deadline]);
  } catch (error) {
    if (desktop && !timedOut && environment.NEURODESK_SMOKE_DIAGNOSTICS === '1') {
      const server = await failureSnapshot(() => desktop.evaluate(() => globalThis.neurodeskOffline?.serverSnapshot?.()));
      console.error(JSON.stringify({ time: new Date().toISOString(), event: server ? 'failure-snapshot' : 'failure-snapshot-unavailable', ...(server ? { server } : {}) }));
    }
    errors.push(error.message);
    return { app: app.id, passed: false, errors, missing, diagnostics, transient: isTransientDesktopFailure(error) };
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(progress);
    if (desktop && !timedOut && errors.length) {
      try { await (await desktop.firstWindow()).screenshot({ path: join(report, `${app.id}-failure.png`) }); } catch { /* A closed or crashed window cannot provide a screenshot; retain the recorded workflow error. */ }
    }
    if (desktop) {
      await Promise.race([desktop.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 15000))]);
      try { desktop.process()?.kill('SIGKILL'); } catch { /* ignore */ }
    }
    await prepared?.close?.();
  }
}

for (const app of bundle.apps.filter(app => !process.env.NEURODESK_TEST_APP || process.env.NEURODESK_TEST_APP.split(',').includes(app.id))) {
  let result;
  for (let attempt = 1; attempt <= maxAppAttempts; attempt++) {
    result = await runSingleApp(app);
    if (result.passed || !result.transient || attempt === maxAppAttempts) break;
    console.warn(`::warning title=Desktop smoke retry::${app.id} hit transient error on attempt ${attempt}/${maxAppAttempts}; retrying: ${result.errors.join('; ')}`);
  }
  const { transient: _transient, ...recorded } = result;
  results.push(recorded);
  console.log(JSON.stringify(recorded));
}
await writeFile(join(report, 'startup.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Desktop test report: ${report}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
