import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSite } from './serve-site.mjs';

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

async function runProbe({ page, workerUrl }) {
  return page.evaluate(async ({ workerUrl, tag }) => {
    const worker = new Worker(workerUrl, { type: 'module' });
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('The module did not start within 60s')), 60_000);
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
  }, { workerUrl, tag: PROBE });
}

/**
 * For every app of every shared WASM family that lists `consumers` in `runtime-assets/manifest.json`,
 * start the module the app's build uses and require that it fetched the binary from the family's
 * `_runtime/` path with HTTP 200, once with isolation response headers and once with only the
 * service worker, as GitHub Pages serves it.
 */
export async function verifySharedBinaries({ browser, registry, repoRoot }) {
  const dist = join(repoRoot, 'dist');
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const shared = manifest.families.filter(family => family.deduplicate && family.files.some(file => file.name.endsWith('.wasm')));
  const uncovered = shared.filter(family => !family.consumers && !COVERED_ELSEWHERE.has(family.id)).map(family => family.id);
  assert.deepEqual(uncovered, [], 'Shared WASM families without a startup check: list their consumers in runtime-assets/manifest.json');
  const scratch = await mkdtemp(join(tmpdir(), 'shared-binary-startup-'));
  const files = new Map();
  const probes = [];
  try {
    for (const family of shared.filter(family => family.consumers)) {
      for (const file of family.files.filter(file => file.name.endsWith('.wasm'))) {
        const binaryPath = `_runtime/${family.target}/${file.name}`;
        assert.equal(hash(await readFile(join(dist, binaryPath))), file.sha256, binaryPath);
        for (const id of family.consumers) {
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
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            const problems = [];
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
            });
            const serviceWorker = await exists(join(dist, app.path, 'coi-serviceworker.js'));
            await page.goto(`${site.origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
            if (isolationHeaders) await page.waitForFunction(() => crossOriginIsolated);
            else if (serviceWorker) await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
            reloading = false;
            const report = await runProbe({ page, workerUrl: `${site.origin}/${probePath}` });
            const binaryUrl = `${site.origin}/${binaryPath}`;
            const binaries = report.fetches.filter(({ url }) => url.endsWith('.wasm'));
            assert.equal(report.error, undefined, `${label}: fetched ${JSON.stringify(binaries)}, then ${report.error}`);
            assert.equal(report.instantiated, true, `${label}: the module did not instantiate`);
            assert.deepEqual(binaries, [{ url: binaryUrl, status: 200 }], `${label}: the module must fetch only the shared binary`);
            if (isolationHeaders || serviceWorker) assert.equal(report.isolated, true, `${label}: the worker is not cross-origin isolated`);
            const escaped = report.threadUrls.filter(url => !url.startsWith(`${site.origin}/${app.path}/`));
            assert.deepEqual(escaped, [], `${label}: pthread workers must start inside the app`);
            assert.deepEqual(problems, [], `${label}: the page reported problems`);
            console.log(`PASS ${label}: instantiated from /${binaryPath}${report.threadUrls.length ? ` with ${report.threadUrls.length} app-local pthread workers` : ''}`);
          } finally {
            await context.close();
          }
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
