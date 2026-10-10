#!/usr/bin/env node
// Measure a completed production-app five-fold CPU run in Chrome or native macOS Safari.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir, release, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { readVolume } from '@neurodesk/synthsr';
import { downloadModels, MODEL_ASSETS } from '../../../packages/white-matter-lesions/src/node.js';
import { compareWithBrowser, measure } from './browser-reference.mjs';

const { values } = parseArgs({ options: {
  browser: { type: 'string', default: 'chrome' },
  output: { type: 'string', default: join(tmpdir(), 'flames-memory.json') },
  'model-dir': { type: 'string', default: join(tmpdir(), 'neurodesk-flames-validation', 'models') },
} });
assert.ok(['chrome', 'safari'].includes(values.browser));
if (values.browser === 'safari') assert.equal(process.platform, 'darwin', 'Safari requires native macOS');
const app = resolve(new URL('..', import.meta.url).pathname);
const example = JSON.parse(await readFile(join(app, 'examples.json')))[0].files[0];
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url)));
const pin = lock.assets[example.url];
const { directory } = await downloadModels({ cacheDir: values['model-dir'], onProgress: console.log });
const examplePath = join(tmpdir(), 'neurodesk-flames-validation', pin.sha256, example.name);
let input = await readFile(examplePath).catch(() => null);
if (!input) {
  const response = await fetch(example.url);
  assert.ok(response.ok, `Example download HTTP ${response.status}`);
  input = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(examplePath), { recursive: true });
  await writeFile(examplePath, input);
}
assert.equal(createHash('sha256').update(input).digest('hex'), pin.sha256);
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css' };
const server = createServer(async (request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    let file;
    if (path === '/white-matter-lesions/assets/memory-worker.js') {
      const worker = new URL(request.url, 'http://localhost').searchParams.get('worker');
      assert.match(worker, /^worker-[A-Za-z0-9_-]+\.js$/);
      const mapped = Object.fromEntries(MODEL_ASSETS.map((asset) => [asset.url, origin + '/models/' + asset.filename]));
      const prefix = `
Object.defineProperty(navigator, 'hardwareConcurrency', { value: 4 });
const originalFetch = fetch;
const mapped = ${JSON.stringify(mapped)};
self.fetch = (url, options) => originalFetch(mapped[String(url)] || url, options);
`;
      response.setHeader('Content-Type', 'text/javascript');
      response.end(prefix + await readFile(join(app, 'dist', 'assets', worker), 'utf8'));
      return;
    }
    if (path === '/input') file = examplePath;
    else if (path.startsWith('/models/')) {
      const asset = MODEL_ASSETS.find((entry) => `/models/${entry.filename}` === path);
      assert.ok(asset);
      file = join(directory, asset.filename);
    } else {
      assert.ok(path.startsWith('/white-matter-lesions/'));
      const relative = path.slice('/white-matter-lesions/'.length) || 'index.html';
      file = resolve(app, 'dist', relative);
      assert.ok(file.startsWith(join(app, 'dist') + '/'));
    }
    const suffix = file.slice(file.lastIndexOf('.'));
    response.setHeader('Content-Type', types[suffix] || 'application/octet-stream');
    const stream = createReadStream(file);
    stream.on('error', () => { response.statusCode = 404; response.end(); });
    stream.pipe(response);
  } catch {
    response.statusCode = 404;
    response.end();
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browserServer;
let browser;
let safari;
let session;
let execute;
let sampleTimer;
const samples = [];
const receipt = {
  browser: values.browser, os: `${process.platform} ${release()}`, cpu: cpus()[0]?.model, runtime: 'ONNX Runtime Web 1.29.0',
  backend: 'wasm', threads: 4, folds: 5, example: { url: example.url, sha256: pin.sha256 },
  modelPins: MODEL_ASSETS, cache: 'fresh browser profile; verified local assets served over loopback',
  metric: 'Sum of resident process RSS in bytes sampled every second, including browser helpers; shared pages may be counted more than once. Not virtual/reserved WASM memory.',
  baseline: 'App ready after adopting the input file, before starting the operation and displaying the input',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  runs: 1, interpretation: 'Single-run ballpark, not an improvement estimate or a guaranteed memory requirement.',
  errors: [],
};
function sample() {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match && { pid: Number(match[1]), parent: Number(match[2]), bytes: Number(match[3]) * 1024, command: match[4] };
  }).filter(Boolean);
  let selected;
  if (browserServer) {
    const ids = new Set([browserServer.process().pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
    }
    selected = rows.filter((row) => ids.has(row.pid));
  } else {
    selected = rows.filter((row) => /\/Safari\.app\/|com\.apple\.WebKit\.(WebContent|GPU|Networking)/.test(row.command));
  }
  const entry = { time: Date.now(), bytes: selected.reduce((sum, row) => sum + row.bytes, 0), processes: selected.map(({ pid, bytes, command }) => ({ pid, bytes, command })) };
  assert.ok(entry.bytes > 0, 'RSS sampler must observe the browser');
  samples.push(entry);
  return entry.bytes;
}
async function webdriver(path, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:4445${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}
try {
  if (values.browser === 'chrome') {
    browserServer = await chromium.launchServer({ executablePath: process.env.CHROME_EXECUTABLE || undefined, headless: true, args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    receipt.version = browser.version();
    const page = await browser.newPage();
    page.on('pageerror', (error) => receipt.errors.push(error.message));
    await page.goto(`${origin}/white-matter-lesions/`);
    execute = (script, args = []) => page.evaluate(({ script, args }) => new Function(script)(...args), { script, args });
  } else {
    safari = spawn('/usr/bin/safaridriver', ['--port', '4445'], { stdio: 'inherit' });
    for (let attempt = 0; ; attempt++) {
      try { await webdriver('/status', null, 'GET'); break; }
      catch (error) { if (attempt === 30) throw error; await new Promise((done) => setTimeout(done, 1000)); }
    }
    session = await webdriver('/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } });
    receipt.version = session.capabilities.browserVersion;
    await webdriver(`/session/${session.sessionId}/url`, { url: `${origin}/white-matter-lesions/` });
    execute = (script, args = []) => webdriver(`/session/${session.sessionId}/execute/sync`, { script, args });
  }
  for (let attempt = 0; ; attempt++) {
    if (await execute('return !!window.neurodeskAutomation && self.crossOriginIsolated;')) break;
    if (attempt === 60) throw new Error('Production app did not become ready and isolated');
    await new Promise((done) => setTimeout(done, 1000));
  }
  // Serve the shipped worker with an instrumentation prefix that caps hardwareConcurrency,
  // maps immutable asset URLs to verified local files; observe progress/result metadata.
  await execute(`
    const origin = arguments[0];
    window.__memoryRun = { files: [], patches: [] };
    const OriginalFile = File;
    window.File = class extends OriginalFile {
      constructor(...args) { super(...args); window.__memoryRun.files.push(this); }
    };
    const OriginalWorker = Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url, options) {
        if (!String(url).includes('/assets/worker-')) return new OriginalWorker(url, options);
        const filename = new URL(url).pathname.split('/').pop();
        super(origin + '/white-matter-lesions/assets/memory-worker.js?worker=' + encodeURIComponent(filename), options);
        this.addEventListener('error', (event) => { window.__memoryRun.error = event.message || 'Processing worker failed'; });
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'progress') window.__memoryRun.patches.push(data.message);
          if (data.type === 'error') window.__memoryRun.error = data.message;
          if (data.type === 'result') window.__memoryRun.provenance = data.provenance;
        });
      }
    };
    fetch(origin + '/input').then((response) => response.blob()).then((blob) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], arguments[2], { type: 'application/gzip' }));
      document.querySelector('#neurodesk-input-transfer').files = transfer.files;
      return window.neurodeskAutomation.dispatch('adopt', { role: 'image' });
    }).then(() => { window.__memoryRun.ready = true; }).catch((error) => { window.__memoryRun.error = error.message; });
  `, [origin, MODEL_ASSETS, example.name]);
  for (let attempt = 0; ; attempt++) {
    const state = await execute('return { ready: window.__memoryRun.ready, error: window.__memoryRun.error };');
    if (state.error) throw new Error(state.error);
    if (state.ready) break;
    if (attempt === 120) throw new Error('Input adoption timed out');
    await new Promise((done) => setTimeout(done, 1000));
  }
  receipt.baselineRssBytes = sample();
  sampleTimer = setInterval(() => { try { sample(); } catch (error) { receipt.errors.push(error.message); } }, 1000);
  const started = Date.now();
  await execute(`window.neurodeskAutomation.dispatch('start', { operation: 'segment', parameters: { folds: 5, backend: 'wasm', skullStripped: false } }).catch((error) => { window.__memoryRun.error = error.message; }); return true;`);
  for (;;) {
    const state = await execute('return { text: document.querySelector("#statusText").textContent, error: window.__memoryRun.error, provenance: window.__memoryRun.provenance };');
    if (state.error) throw new Error(state.error);
    if (state.provenance) { receipt.provenance = state.provenance; break; }
    if (Date.now() - started > 100 * 60 * 1000) throw new Error('Fivefold completion timed out');
    console.log(state.text);
    await new Promise((done) => setTimeout(done, 10000));
  }
  clearInterval(sampleTimer);
  sampleTimer = null;
  sample();
  receipt.elapsedSeconds = (Date.now() - started) / 1000;
  receipt.peakRssBytes = Math.max(...samples.map(({ bytes }) => bytes));
  receipt.samples = samples;
  receipt.progress = await execute('return window.__memoryRun.patches;');
  receipt.technicalLog = await execute('return document.querySelector("#technicalLog").textContent;');
  assert.ok(receipt.technicalLog.includes('FLAMeS, 5 folds, on WebAssembly, 4 threads'));
  receipt.pageMemoryApiAvailable = await execute('return typeof performance.measureUserAgentSpecificMemory === "function";');
  receipt.pageMemoryNote = 'RSS observes resident native/WASM allocation during inference. UA-specific memory counts different objects and may trigger GC. Its separate post-completion observation is outside RSS sampling and is not a peak measurement.';
  if (receipt.pageMemoryApiAvailable) {
    await execute(`performance.measureUserAgentSpecificMemory().then((memory) => { window.__memoryRun.pageMemory = { bytes: memory.bytes }; }).catch((error) => { window.__memoryRun.pageMemory = { error: error.message }; }); return true;`);
    for (let attempt = 0; attempt < 30; attempt++) {
      receipt.pageMemoryObservation = await execute('return window.__memoryRun.pageMemory;');
      if (receipt.pageMemoryObservation) break;
      await new Promise((done) => setTimeout(done, 1000));
    }
    receipt.pageMemoryObservation ||= { error: 'No response within 30 seconds after completion' };
  }
  assert.equal(receipt.provenance.backend, 'wasm');
  assert.equal(receipt.provenance.models.length, 5);
  assert.ok(receipt.progress.includes(`Segmenting lesions · patch ${5 * receipt.provenance.windows} of ${5 * receipt.provenance.windows}`));
  // Sample before reading output bytes: FileReader/base64 validation allocations are excluded.
  const names = await execute('return window.__memoryRun.files.map((file) => file.name);');
  const files = {};
  for (const name of ['MSLesSeg_P57_T1_FLAIR_lesions.nii', 'MSLesSeg_P57_T1_FLAIR_lesion_probability.nii']) {
    assert.ok(names.includes(name), `App output ${name}`);
    await execute(`window.__memoryRun.output = null; const file = window.__memoryRun.files.findLast((file) => file.name === arguments[0]); const reader = new FileReader(); reader.onload = () => { window.__memoryRun.output = reader.result.split(',')[1]; }; reader.readAsDataURL(file); return true;`, [name]);
    let base64;
    while (!(base64 = await execute('return window.__memoryRun.output;'))) await new Promise((done) => setTimeout(done, 100));
    const bytes = Buffer.from(base64, 'base64');
    files[name] = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(join(dirname(values.output), name), bytes);
  }
  // Safari sync scripts do not await promises: publish snapshot through an explicit completion slot.
  await execute('window.neurodeskAutomation.dispatch("snapshot").then((snapshot) => { window.__memoryRun.report = snapshot.report; }); return true;');
  let measurements;
  while (!(measurements = await execute('return window.__memoryRun.report?.measurements;'))) await new Promise((done) => setTimeout(done, 100));
  receipt.results = measure({ mask: files['MSLesSeg_P57_T1_FLAIR_lesions.nii'], probability: files['MSLesSeg_P57_T1_FLAIR_lesion_probability.nii'], lesions: measurements.count, totalMl: measurements.totalMl });
  receipt.parity = compareWithBrowser(receipt.results, 5);
  for (const [passed, line] of receipt.parity) assert.ok(passed, line);
  assert.deepEqual(receipt.errors, []);
} catch (error) {
  receipt.errors.push(error.stack || String(error));
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  await mkdir(dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(receipt, null, 2) + '\n');
  if (session) await webdriver(`/session/${session.sessionId}`, null, 'DELETE').catch(console.error);
  safari?.kill();
  if (safari && safari.exitCode === null) await new Promise((done) => safari.once('exit', done));
  await browser?.close();
  await browserServer?.close();
  await new Promise((done) => server.close(done));
}
console.log(`Memory receipt ${values.output}; errors ${receipt.errors.length}`);
