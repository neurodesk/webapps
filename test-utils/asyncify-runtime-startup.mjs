import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveSite } from './serve-site.mjs';

const modelBase64 = 'CAcSDGJhY2tlbmQtdGVzdDpBCgsKAXgSAXkiA05lZxIQdGVzdF9uZWdfZXhhbXBsZVoPCgF4EgoKCAgBEgQKAggCYg8KAXkSCgoICAESBAoCCAJCBAoAEA0=';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// This handler replaces only the scientific job in a copy of the real bundled worker.
// Its original initialization and URL remain in place; its own path expression
// is also evaluated for pipelines that configure ORT only when a job starts.
async function runAsyncifyModel({ data }) {
  const threadUrls = [];
  const NativeWorker = Worker;
  self.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      threadUrls.push(String(url));
    }
  };
  try {
    const ort = await import(data.apiUrl);
    ort.env.wasm.numThreads = 2;
    ort.env.wasm.wasmPaths = self.__runtimeStartupPaths;
    const model = Uint8Array.from(atob(data.modelBase64), c => c.charCodeAt(0));
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
    const output = await session.run({ x: new ort.Tensor('float32', new Float32Array([1, -2]), [2]) });
    const values = Array.from(output.y.data);
    await session.release();
    postMessage({ values, threads: ort.env.wasm.numThreads, isolated: self.crossOriginIsolated, threadUrls, paths: self.__runtimeStartupPaths });
  } catch (error) {
    postMessage({ error: String(error), paths: self.__runtimeStartupPaths });
  }
}

export async function verifyAsyncifyRuntime({ browser, apps, repoRoot }) {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const moduleFamily = manifest.families.find(family => family.id === 'ort-web-asyncify');
  const binaryFamily = manifest.families.find(family => family.id === 'ort-web-asyncify-wasm');
  const module = moduleFamily.files[0];
  const binary = binaryFamily.files[0];
  const apiPath = join(repoRoot, 'apps/synthsr/node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs');
  const consumers = apps.filter(app => app.app_scoped_runtime_families.includes(moduleFamily.id));
  assert.ok(consumers.length > 0, 'No asyncify consumers were tested');
  const scratch = await mkdtemp(join(tmpdir(), 'asyncify-startup-'));
  const files = new Map();
  const workers = [];
  let site;
  try {
    for (const app of consumers) {
      const assets = join(repoRoot, 'dist', app.path, 'assets');
      const candidates = [];
      for (const name of await readdir(assets)) {
        if (!name.endsWith('.js')) continue;
        const source = await readFile(join(assets, name), 'utf8');
        if (source.includes(module.name) && source.includes(binary.name) && source.includes('wasmPaths')) candidates.push({ name, source });
      }
      assert.ok(candidates.length > 0, `${app.id}: no bundled asyncify workers`);
      for (const { name, source } of candidates) {
        const assignment = /[\w$]+(?:\.[\w$]+)*\.wasmPaths\s*=\s*\{[^{}]*\bmjs\s*:[^{}]*\}/;
        const paths = source.match(assignment)?.[0];
        assert.ok(paths, `${app.id}/${name}: missing bundled wasmPaths assignment`);
        const path = join(scratch, `${app.id}-${name}`);
        await writeFile(path, `${source}\nself.__runtimeStartupPaths=${paths};\nself.onmessage=${runAsyncifyModel.toString()};\n`);
        const workerPath = `${app.path}/assets/${name}`;
        files.set(`/${workerPath}`, path);
        workers.push({ app, workerPath });
      }
      files.set(`/${app.path}/__runtime_startup_api.mjs`, apiPath);
    }
    site = await serveSite(join(repoRoot, 'dist'), { isolationHeaders: false, files });
    const base = `${site.origin}/`;
    for (const { app, workerPath } of workers) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const workerUrl = new URL(workerPath, base).href;
        const moduleUrl = new URL(`${app.path}/assets/${module.name}`, base).href;
        const binaryUrl = new URL(`_runtime/${binaryFamily.target}/${binary.name}`, base).href;
        for (const [url, expected] of [[moduleUrl, module.sha256], [binaryUrl, binary.sha256]]) {
          const response = await context.request.get(url);
          assert.equal(response.status(), 200, url);
          assert.equal(hash(await response.body()), expected, url);
        }
        const appUrl = new URL(`${app.path}/`, base).href;
        const response = await context.request.get(appUrl);
        assert.equal(response.headers()['cross-origin-embedder-policy'], undefined);
        assert.equal(response.headers()['cross-origin-opener-policy'], undefined);
        await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
        const result = await page.evaluate(async settings => {
          const worker = new Worker(settings.workerUrl, { type: 'module' });
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('Threaded asyncify inference timed out')), 30_000);
              worker.onmessage = ({ data }) => {
                clearTimeout(timer);
                data.error ? reject(new Error(`${data.error}; paths=${JSON.stringify(data.paths)}`)) : resolve(data);
              };
              worker.onerror = event => {
                clearTimeout(timer);
                reject(new Error(event.message));
              };
              worker.postMessage(settings);
            });
          } finally {
            worker.terminate();
          }
        }, { apiUrl: new URL(`${app.path}/__runtime_startup_api.mjs`, base).href, modelBase64, workerUrl });
        assert.deepEqual(result.values, [-1, 2], app.id);
        assert.equal(result.threads, 2, app.id);
        assert.equal(result.isolated, true, app.id);
        assert.equal(new URL(result.paths.wasm, workerUrl).href, binaryUrl, app.id);
        assert.equal(new URL(result.paths.mjs, workerUrl).href, moduleUrl, app.id);
        assert.ok(result.threadUrls.length > 0, `${app.id}: no pthread was created`);
        assert.ok(result.threadUrls.every(url => url === moduleUrl), `${app.id}: pthread escaped app scope: ${JSON.stringify(result.threadUrls)}`);
        console.log(`PASS ${workerPath}: shared verified asyncify WASM, app-local pthread module, two-thread inference`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await site?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
