import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSite } from './serve-site.mjs';
import { syntheticHeadNifti } from './synthetic-head.mjs';

const PROBE = '__sharedBinaryProbe';
// Each shared WASM family is covered here through its `consumers`, or by the check named beside it.
const COVERED_ELSEWHERE = new Map([
  ['ort-web-asyncify-wasm', 'verifyAsyncifyRuntime runs two-thread inference on it in every consumer'],
  ['dcm2niix-jpeg', 'name-matched, so assembly fails on other bytes; test:image-uploads converts DICOM in the composite site'],
  ['hmc-registration-wasm', 'name-matched, so assembly fails on other bytes; shared before this check'],
  ['ants-denoise-wasm', 'name-matched, so assembly fails on other bytes; shared before this check'],
  ['n4-wasm', 'name-matched, so assembly fails on other bytes; shared before this check'],
]);

// Runs inside the worker. It starts the Emscripten factory of the app's own built file, so the binary
// is requested through the URL that file holds, and reports every fetch and pthread the start makes.
async function startFactory(tag, loadFactory) {
  const fetches = [];
  const threadUrls = [];
  const nativeFetch = self.fetch;
  self.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), self.location.href).href;
    try {
      const response = await nativeFetch(...args);
      fetches.push({ url, status: response.status });
      return response;
    } catch (error) {
      fetches.push({ url, error: String(error) });
      throw error;
    }
  };
  const NativeWorker = self.Worker;
  self.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      threadUrls.push(String(url));
    }
  };
  const report = { fetches, threadUrls, isolated: self.crossOriginIsolated };
  try {
    const factory = await loadFactory();
    const module = await factory({ noInitialRun: true });
    report.instantiated = typeof module === 'object' && module !== null;
  } catch (error) {
    report.error = String(error?.stack ?? error);
  }
  self.postMessage({ [tag]: report });
}

// Runs inside the worker. It segments a volume with MindGrab's published API on the threaded CPU
// backend, loading the model module from the app's own staged copy, and reports every fetch and pthread.
async function segmentOnCpu(tag, { apiUrl, assetPath, model, input }) {
  const fetches = [];
  const threadUrls = [];
  const nativeFetch = self.fetch;
  self.fetch = async (...args) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]), self.location.href).href;
    const response = await nativeFetch(...args);
    fetches.push({ url, status: response.status });
    return response;
  };
  const NativeWorker = self.Worker;
  self.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      threadUrls.push(String(url));
    }
  };
  const report = { fetches, threadUrls, isolated: self.crossOriginIsolated };
  try {
    const { segment } = await import(apiUrl);
    const bytes = Uint8Array.from(atob(input), char => char.charCodeAt(0));
    const result = await segment(bytes, { model, backend: 'cpu', worker: false, gzipOutput: false, assetPath });
    const image = new Uint8Array(result.image);
    const view = new DataView(result.image);
    const offset = view.getFloat32(108, true);
    report.backend = result.backend;
    report.dimensions = [view.getInt16(42, true), view.getInt16(44, true), view.getInt16(46, true)];
    report.labelled = image.subarray(offset).reduce((count, value) => count + (value !== 0), 0);
    report.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', image))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    report.error = `${error?.stack ?? error}${error?.log ? `\n${error.log.join('\n')}` : ''}`;
  }
  self.postMessage({ [tag]: report });
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

function hasDefaultExport(source) {
  return /export\s+default\s+[\w$]+\s*;/.test(source) || /export\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(source);
}

// Every built module of the app holding a string that resolves to the shared binary, with the string's offset.
async function findLoaders({ dist, app, binaryPath }) {
  const loaders = [];
  const appDist = join(dist, app.path);
  for (const file of await readdir(appDist, { recursive: true })) {
    if (!/\.m?js$/.test(file)) continue;
    const source = await readFile(join(appDist, file), 'utf8');
    const path = `${app.path}/${file.split('\\').join('/')}`;
    for (const match of source.matchAll(/(['"])([^'"\n]*\.wasm)\1/g)) {
      if (new URL(match[2], `https://site.invalid/${path}`).pathname !== `/${binaryPath}`) continue;
      loaders.push({ path, source, offset: match.index });
      break;
    }
  }
  return loaders;
}

// A module exporting the factory is imported as the app imports it. A worker bundle starts the factory
// only inside a scientific job, so a copy served at the bundle's own URL also starts the factory itself.
function probeFor({ loader, index, app }) {
  const start = `(${startFactory.toString()})`;
  if (hasDefaultExport(loader.source)) {
    return {
      path: `${app.path}/__shared_binary_probe_${index}.mjs`,
      source: `${start}(${JSON.stringify(PROBE)}, async () => (await import(${JSON.stringify(`/${loader.path}`)})).default);\n`,
    };
  }
  const factories = [...loader.source.slice(0, loader.offset).matchAll(/async function ([\w$]+)\([\w$]+=\{\}\)\{/g)];
  const factory = factories.at(-1)?.[1];
  assert.ok(factory, `${loader.path}: no probe knows how to start the module that loads the shared binary; add one to test-utils/shared-binary-startup.mjs`);
  return {
    path: loader.path,
    source: `${loader.source}\n${start}(${JSON.stringify(PROBE)}, async () => ${factory});\n`,
  };
}

async function runProbe({ page, workerUrl, timeoutMs = 60_000, message }) {
  return page.evaluate(async ({ workerUrl, tag, timeoutMs, message }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    if (message) worker.postMessage(message);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`The module did not finish within ${timeoutMs / 1000}s`)), timeoutMs);
        worker.addEventListener('message', ({ data }) => {
          if (!data?.[tag]) return;
          clearTimeout(timer);
          resolve(data[tag]);
        });
        worker.addEventListener('error', event => {
          clearTimeout(timer);
          reject(new Error(event.message || 'The worker failed to load'));
        });
      });
    } finally {
      worker.terminate();
    }
  }, { workerUrl, tag: PROBE, timeoutMs, message });
}

// A MindGrab threaded CPU binary (`brainchop-<model>.wasm`); the WebGPU and WebGL2 builds end in -gpu and -gl.
const MINDGRAB_CPU_BINARY = /^brainchop-([a-z0-9]+)\.wasm$/;
// Hosted runners finish one CPU segmentation in a few minutes; MindGrab's own CPU limit is 15 minutes.
const SEGMENTATION_TIMEOUT_MS = 16 * 60_000;

// A segmentation takes minutes, so by default one runs per app and at least one per binary: every app proves
// its staged modules run a shared binary to the end, and the start of every other pair is checked above.
// SHARED_BINARY_EVERY_SEGMENTATION=1 runs every pair.
function coveringSegmentations(segmentations) {
  const binariesOf = app => segmentations.filter(job => job.app === app).length;
  const selected = [];
  const covered = new Set();
  for (const sha256 of new Set(segmentations.map(job => job.file.sha256))) {
    const jobs = segmentations.filter(job => job.file.sha256 === sha256).sort((a, b) => binariesOf(a.app) - binariesOf(b.app));
    const job = jobs.find(candidate => !covered.has(candidate.app)) ?? jobs[0];
    selected.push(job);
    covered.add(job.app);
  }
  for (const job of segmentations) {
    if (covered.has(job.app)) continue;
    selected.push(job);
    covered.add(job.app);
  }
  return selected;
}

// The page of `app` in a new context, cross-origin isolated as `site` serves it, with every
// page error, failed request, HTTP error and `.wasm` response recorded.
async function withAppPage({ browser, site, dist, app, isolationHeaders }, run) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const problems = [];
    const wasmResponses = [];
    page.on('pageerror', error => problems.push(`page error: ${error.message}`));
    let reloading = !isolationHeaders;
    context.on('requestfailed', request => {
      const reason = request.failure()?.errorText;
      // The isolation service worker reloads the page once it controls it, which aborts requests in flight.
      if (reloading && reason === 'net::ERR_ABORTED') return;
      problems.push(`request failed: ${request.url()} ${reason}`);
    });
    context.on('response', response => {
      if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
      if (!reloading && new URL(response.url()).pathname.endsWith('.wasm')) wasmResponses.push({ url: response.url(), status: response.status() });
    });
    const serviceWorker = await exists(join(dist, app.path, 'coi-serviceworker.js'));
    await page.goto(`${site.origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (isolationHeaders) await page.waitForFunction(() => crossOriginIsolated);
    else if (serviceWorker) await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
    reloading = false;
    return await run({ page, problems, wasmResponses, isolated: isolationHeaders || serviceWorker });
  } finally {
    await context.close();
  }
}

// The worker's fetch log must hold the shared binary, HTTP 200, and no other WebAssembly. The browser's network
// log must agree: it saw the shared URL, and no copy of the file (its name, with or without a Vite hash) anywhere else.
function assertOnlySharedBinary({ label, site, binaryPath, report, wasmResponses }) {
  const expected = { url: `${site.origin}/${binaryPath}`, status: 200 };
  const binaries = report.fetches.filter(({ url }) => new URL(url).pathname.endsWith('.wasm'));
  assert.equal(report.error, undefined, `${label}: fetched ${JSON.stringify(binaries)}, then ${report.error}`);
  assert.deepEqual(binaries, [expected], `${label}: the module must fetch only the shared binary`);
  const stem = binaryPath.split('/').at(-1).replace(/\.wasm$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const copies = wasmResponses.filter(({ url }) => new RegExp(`/${stem}(?:-[\\w-]{8})?\\.wasm$`).test(new URL(url).pathname));
  assert.ok(copies.length > 0, `${label}: the browser's network log has no request for the shared binary`);
  for (const copy of copies) assert.deepEqual(copy, expected, `${label}: the browser loaded a copy of the binary from another URL`);
}

/**
 * For every app that must share a WASM file of `runtime-assets/manifest.json` (the `consumers` of
 * the file or of its family), start the module the app's build uses and require that it fetched the
 * binary from the family's `_runtime/` path with HTTP 200, once with isolation response headers and
 * once with only the service worker, as GitHub Pages serves it. It then segments a head phantom on
 * MindGrab's threaded CPU backend in each app that shares a MindGrab CPU binary, through the app's
 * staged model module, with only the service worker.
 */
export async function verifySharedBinaries({ browser, registry, repoRoot }) {
  const dist = join(repoRoot, 'dist');
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const shared = manifest.families.filter(family => family.deduplicate && family.files.some(file => file.name.endsWith('.wasm')));
  const consumersOf = (family, file) => file.consumers ?? family.consumers;
  const uncovered = shared
    .filter(family => !COVERED_ELSEWHERE.has(family.id) && family.files.some(file => file.name.endsWith('.wasm') && !consumersOf(family, file)))
    .map(family => family.id);
  assert.deepEqual(uncovered, [], 'Shared WASM families without a startup check: list their consumers in runtime-assets/manifest.json');
  const scratch = await mkdtemp(join(tmpdir(), 'shared-binary-startup-'));
  const files = new Map();
  const probes = [];
  const segmentations = [];
  try {
    for (const family of shared) {
      for (const file of family.files.filter(file => file.name.endsWith('.wasm') && consumersOf(family, file))) {
        const binaryPath = `_runtime/${family.target}/${file.name}`;
        assert.equal(hash(await readFile(join(dist, binaryPath))), file.sha256, binaryPath);
        for (const id of consumersOf(family, file)) {
          const app = registry.apps.find(candidate => candidate.id === id);
          assert.ok(app, `${family.id}: unknown consumer ${id}`);
          const loaders = await findLoaders({ dist, app, binaryPath });
          assert.ok(loaders.length > 0, `${id}: no built module loads ${binaryPath}`);
          for (const loader of loaders) {
            const probe = probeFor({ loader, index: probes.length, app });
            const path = join(scratch, `${probes.length}.mjs`);
            await writeFile(path, probe.source);
            files.set(`/${probe.path}`, path);
            probes.push({ family, app, binaryPath, loader, probePath: probe.path });
          }
          const model = file.name.match(MINDGRAB_CPU_BINARY)?.[1];
          if (!model) continue;
          // MindGrab imports `<assetPath>/brainchop-<model>.js`, so the module beside which the app staged the binary is the one it runs.
          const module = loaders.filter(loader => loader.path.endsWith(`/${file.name.replace(/\.wasm$/, '.js')}`));
          assert.equal(module.length, 1, `${id}: expected one staged ${file.name.replace(/\.wasm$/, '.js')} that loads ${binaryPath}`);
          const api = join(repoRoot, 'node_modules/.pnpm', `@brainchop+mindgrab@${family.version}`, 'node_modules/@brainchop/mindgrab/dist/index.js');
          assert.ok(await exists(api), `${family.id}: its version must be the @brainchop/mindgrab release of its binaries; ${api} is missing`);
          const apiPath = `${app.path}/__mindgrab_api_${family.version}.js`;
          const probePath = `${app.path}/__mindgrab_segmentation_${segmentations.length}.mjs`;
          const path = join(scratch, `segmentation-${segmentations.length}.mjs`);
          await writeFile(path, `self.onmessage = ({ data }) => (${segmentOnCpu.toString()})(${JSON.stringify(PROBE)}, data);\n`);
          files.set(`/${apiPath}`, api);
          files.set(`/${probePath}`, path);
          segmentations.push({ family, file, app, binaryPath, model, probePath, apiPath, assetPath: module[0].path.replace(/[^/]+$/, '') });
        }
      }
    }
    assert.ok(probes.length > 0, 'No shared WASM family lists consumers');
    for (const isolationHeaders of [false, true]) {
      const site = await serveSite(dist, { isolationHeaders, files });
      const mode = isolationHeaders ? 'response-header isolation' : 'service-worker isolation';
      try {
        for (const { family, app, binaryPath, loader, probePath } of probes) {
          const label = `${app.id} ${loader.path} (${family.id}, ${mode})`;
          await withAppPage({ browser, site, dist, app, isolationHeaders }, async ({ page, problems, wasmResponses, isolated }) => {
            const report = await runProbe({ page, workerUrl: `${site.origin}/${probePath}` });
            assertOnlySharedBinary({ label, site, binaryPath, report, wasmResponses });
            assert.equal(report.instantiated, true, `${label}: the module did not instantiate`);
            if (isolated) assert.equal(report.isolated, true, `${label}: the worker is not cross-origin isolated`);
            const escaped = report.threadUrls.filter(url => !url.startsWith(`${site.origin}/${app.path}/`));
            assert.deepEqual(escaped, [], `${label}: pthread workers must start inside the app`);
            assert.deepEqual(problems, [], `${label}: the page reported problems`);
            console.log(`PASS ${label}: instantiated from /${binaryPath}${report.threadUrls.length ? ` with ${report.threadUrls.length} app-local pthread workers` : ''}`);
          });
        }
        if (isolationHeaders) continue;
        const input = Buffer.from(syntheticHeadNifti()).toString('base64');
        const outputs = new Map();
        const selected = process.env.SHARED_BINARY_EVERY_SEGMENTATION === '1' ? segmentations : coveringSegmentations(segmentations);
        for (const { family, file, app, binaryPath, model, probePath, apiPath, assetPath } of selected) {
          const label = `${app.id} MindGrab ${model} on the threaded CPU backend (${family.id}, ${mode})`;
          await withAppPage({ browser, site, dist, app, isolationHeaders }, async ({ page, problems, wasmResponses }) => {
            const started = Date.now();
            const report = await runProbe({
              page,
              workerUrl: `${site.origin}/${probePath}`,
              timeoutMs: SEGMENTATION_TIMEOUT_MS,
              message: { apiUrl: `${site.origin}/${apiPath}`, assetPath: `${site.origin}/${assetPath}`, model, input },
            });
            assertOnlySharedBinary({ label, site, binaryPath, report, wasmResponses });
            assert.equal(report.isolated, true, `${label}: the worker is not cross-origin isolated`);
            assert.equal(report.backend, 'cpu', `${label}: ran on another backend`);
            assert.deepEqual(report.dimensions, [64, 64, 64], `${label}: the output is not on the input grid`);
            assert.ok(report.labelled > 0, `${label}: the segmentation is empty`);
            assert.ok(report.threadUrls.length > 0, `${label}: the threaded module started no pthread worker`);
            const escaped = report.threadUrls.filter(url => !url.startsWith(`${site.origin}/${app.path}/`));
            assert.deepEqual(escaped, [], `${label}: pthread workers must start inside the app`);
            const modules = report.fetches.filter(({ url }) => !new URL(url).pathname.endsWith('.wasm'));
            assert.deepEqual(modules, [], `${label}: the run fetched more than the shared binary`);
            assert.deepEqual(problems, [], `${label}: the page reported problems`);
            // The CPU build is deterministic, so every app running the same shared bytes must give the same file.
            const first = outputs.get(file.sha256) ?? outputs.set(file.sha256, { sha256: report.sha256, label }).get(file.sha256);
            assert.equal(report.sha256, first.sha256, `${label}: the output differs from ${first.label}`);
            console.log(`PASS ${label}: segmented a 64x64x64 head phantom from /${binaryPath} in ${Math.round((Date.now() - started) / 1000)}s `
              + `(${report.threadUrls.length} app-local pthread workers, ${report.labelled} nonzero output bytes, sha256 ${report.sha256.slice(0, 12)})`);
          });
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
