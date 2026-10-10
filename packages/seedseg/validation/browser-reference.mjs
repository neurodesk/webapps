import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { MODEL_ASSETS } from '../src/assets.js';
import { outputNames } from '../src/results.js';
import { createProstateFixture } from '../../../apps/seedseg/test/prostate-fixture.mjs';
import { resolveSiteFile } from './site-path.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.wasm': 'application/wasm' };

// Stream models through HTTP rather than base64-encoding them into CDP frames.
export async function browserReference({ modelsDirectory, ensemble, threshold, topN, composite = false }) {
  const root = join(repository, composite ? 'dist' : 'apps/seedseg/dist');
  const prefix = composite ? '/seedseg/' : '/';
  const server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const file = path.startsWith('/validation-models/')
        ? join(modelsDirectory, path.slice('/validation-models/'.length))
        : resolveSiteFile(root, path);
      const info = await stat(file);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
        'Content-Length': info.size, 'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Access-Control-Allow-Origin': '*' });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  let browser;
  const browserHome = await mkdtemp(join(tmpdir(), 'seedseg-browser-home-'));
  try {
    const browserEnv = { ...process.env };
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) browserEnv[key] = browserHome;
    browser = await chromium.launch({ headless: true, env: browserEnv });
    const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await context.route(/cloudflareinsights\.com|googletagmanager\.com|google-analytics\.com/, route => route.fulfill({ body: '' }));
    await context.route('**/seedseg-model-*.onnx', route => {
      const asset = MODEL_ASSETS.find(candidate => route.request().url().endsWith(`/${candidate.filename}`));
      assert.ok(asset, 'Only published checkpoint requests are allowed');
      return route.fulfill({ status: 302, headers: { Location: `${origin}/validation-models/${asset.filename}`, 'Access-Control-Allow-Origin': '*' } });
    });
    const page = await context.newPage();
    let runtimeVersion;
    page.on('worker', worker => {
      if (!worker.url().includes('/js/inference-worker.js')) return;
      runtimeVersion = worker.evaluate(async () => {
        const runtime = await import(new URL('../wasm/ort.webgpu.bundle.min.mjs', self.location.href).href);
        return runtime.env.versions.web;
      });
    });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => console.error(`Browser request failed: ${request.url()} ${request.failure()?.errorText}`));
    await page.goto(`${origin}${prefix}`);
    await page.waitForFunction(() => Boolean(globalThis.neurodeskAutomation));
    await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'synthetic-prostate-t1.nii', mimeType: 'application/x-nifti', buffer: createProstateFixture() });
    await page.evaluate(() => neurodeskAutomation.dispatch('adopt', { role: 'image' }));
    await page.evaluate(parameters => neurodeskAutomation.dispatch('start', { operation: 'segment', parameters }), {
      models: MODEL_ASSETS.slice(0, ensemble).map(asset => asset.seed), threshold, markers: topN,
    });
    let snapshot;
    const deadline = performance.now() + 600_000;
    do {
      snapshot = await page.evaluate(() => neurodeskAutomation.dispatch('snapshot'));
      if (/succeeded|failed/.test(snapshot.state)) break;
      if (performance.now() >= deadline) throw new Error('SeedSeg browser inference exceeded 10 minutes');
      await new Promise(accept => setTimeout(accept, 250));
    } while (true);
    assert.equal(snapshot.state, 'succeeded', JSON.stringify({ snapshot, errors }));
    assert.deepEqual(snapshot.report.provenance.models.map(model => model.sha256), MODEL_ASSETS.slice(0, ensemble).map(asset => asset.sha256));
    const files = {};
    const names = outputNames(ensemble);
    for (const id of Object.keys(snapshot.report.artifacts)) {
      const waiting = page.waitForEvent('download');
      await page.evaluate(artifactId => neurodeskAutomation.dispatch('download', { artifactId }), id);
      const download = await waiting;
      assert.equal(download.suggestedFilename(), names[id]);
      files[id] = await readFile(await download.path());
      assert.equal(createHash('sha256').update(files[id]).digest('hex'), snapshot.report.artifacts[id].sha256);
    }
    if (process.env.SEEDSEG_VALIDATION_ARTIFACTS && ensemble === 4 && topN === 3 && threshold === 0.1) {
      await mkdir(process.env.SEEDSEG_VALIDATION_ARTIFACTS, { recursive: true });
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.screenshot({ path: join(process.env.SEEDSEG_VALIDATION_ARTIFACTS, `seedseg-result-${width}.png`), fullPage: true });
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    const ortWeb = await runtimeVersion;
    assert.equal(ortWeb, '1.21.0', 'Actual worker runtime agrees with the pinned ORT Web release');
    return { files, provenance: snapshot.report.provenance, chromium: browser.version(), ortWeb, composite };
  } finally {
    await browser?.close();
    await new Promise(accept => server.close(accept));
    await rm(browserHome, { recursive: true, force: true });
  }
}
