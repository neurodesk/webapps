import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';
import { verifyAsyncifyRuntime } from '../test-utils/asyncify-runtime-startup.mjs';
import { verifyQsmBetRuntime } from '../test-utils/qsm-bet-runtime-startup.mjs';

// A two-element Neg graph: exercise real ORT pthread startup without downloading a scientific model.
const modelBase64 = 'CAcSDGJhY2tlbmQtdGVzdDpBCgsKAXgSAXkiA05lZxIQdGVzdF9uZWdfZXhhbXBsZVoPCgF4EgoKCAgBEgQKAggCYg8KAXkSCgoICAESBAoCCAJCBAoAEA0=';
const registry = await loadAppsRegistry();
// Narrow static-worker diagnostics locally; the normal CI invocation still runs every gate.
const requested = new Set((process.env.SMOKE_APPS ?? '').split(',').filter(Boolean));
const apps = requested.size ? registry.apps.filter(app => requested.has(app.id)) : registry.apps;
assert.equal(requested.size || apps.length, apps.length, 'SMOKE_APPS contains an unknown app');
const site = process.env.BASE_URL ? null : await serveSite(join(repoRoot, 'dist'), { isolationHeaders: false });
const base = `${(process.env.BASE_URL || site.origin).replace(/\/$/, '')}/`;
const browser = await chromium.launch({ headless: true });
const failures = [];
let tested = 0;
try {
  for (const app of apps) {
    const workerUrl = new URL(`${app.path}/js/inference-worker.js`, base).href;
    try {
      await readFile(join(repoRoot, 'apps', app.id, 'web/js/inference-worker.js'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const context = await browser.newContext();
    try {
      const response = await context.request.get(workerUrl);
      assert.ok(response.ok(), `${workerUrl}: HTTP ${response.status()}`);
      const source = await response.text();
      const modulePath = source.match(/import \* as ort from ['"]([^'"]+)['"]/)?.[1];
      assert.ok(modulePath, `${app.id}: missing ORT import`);
      const assignment = source.match(/ort\.env\.wasm\.wasmPaths\s*=\s*[^;]+;/)?.[0];
      assert.ok(assignment, `${app.id}: missing WASM path configuration`);
      const binaryManifestPath = source.match(/import\s+\w+\s+from\s+['"]([^'"]*browser-runtime\.manifest\.json)['"]/)?.[1];
      let runtimeBinary;
      let fetchModelUrl;
      if (binaryManifestPath) {
        const manifest = await context.request.get(new URL(binaryManifestPath, workerUrl).href);
        assert.ok(manifest.ok(), `${app.id}: runtime manifest HTTP ${manifest.status()}`);
        runtimeBinary = await manifest.json();
        assert.match(runtimeBinary.sha256, /^[a-f0-9]{64}$/);
        assert.ok(Number.isSafeInteger(runtimeBinary.bytes) && runtimeBinary.bytes > 0);
        const sharedWorkerPath = source.match(/from\s+['"]([^'"]+\/worker\/index\.js)['"]/)?.[1];
        assert.ok(sharedWorkerPath, `${app.id}: missing shared model downloader`);
        fetchModelUrl = new URL(sharedWorkerPath, workerUrl).href;
      }
      const config = { ort: { env: { wasm: {} } }, self: { location: { href: workerUrl } }, URL };
      vm.runInNewContext(assignment, config);
      const page = await context.newPage();
      await page.goto(new URL(`${app.path}/`, base).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => crossOriginIsolated && navigator.serviceWorker.controller !== null);
      const result = await page.evaluate(async (settings) => {
        const source = `import * as ort from ${JSON.stringify(settings.moduleUrl)};
          onmessage = async ({data}) => {
            try {
              ort.env.wasm.numThreads = 2;
              ort.env.wasm.wasmPaths = data.wasmPaths;
              if (data.runtimeBinary) {
                const {fetchModel} = await import(data.fetchModelUrl);
                const binary = data.runtimeBinary;
                const bytes = await fetchModel({url: binary.url, cacheKey: binary.url,
                  integrity: {bytes: binary.bytes, sha256: binary.sha256}});
                ort.env.wasm.wasmBinary = new Uint8Array(bytes);
                postMessage({type: 'runtime-ready'});
              }
              const model = Uint8Array.from(atob(data.modelBase64), c => c.charCodeAt(0));
              const session = await ort.InferenceSession.create(model, {executionProviders: ['wasm']});
              const output = await session.run({x: new ort.Tensor('float32', new Float32Array([1, -2]), [2])});
              postMessage({values: Array.from(output.y.data), threads: ort.env.wasm.numThreads});
              await session.release();
            } catch (error) { postMessage({error: String(error)}); }
          };`;
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error(settings.runtimeBinary
              ? 'Pinned runtime download timed out after 120s'
              : 'Threaded model loading timed out after 20s')), settings.runtimeBinary ? 120_000 : 20_000);
            worker.onmessage = ({data}) => {
              clearTimeout(timer);
              if (data.type === 'runtime-ready') {
                timer = setTimeout(() => reject(new Error('Threaded model loading timed out after 20s')), 20_000);
                return;
              }
              data.error ? reject(new Error(data.error)) : resolve(data);
            };
            worker.onerror = event => {
              clearTimeout(timer);
              reject(new Error(event.message));
            };
            worker.postMessage(settings);
          });
        } finally {
          worker.terminate();
          URL.revokeObjectURL(url);
        }
      }, { moduleUrl: new URL(modulePath, workerUrl).href, wasmPaths: config.ort.env.wasm.wasmPaths, modelBase64, runtimeBinary, fetchModelUrl });
      assert.deepEqual(result, { values: [-1, 2], threads: 2 });
      tested += 1;
      console.log(`PASS ${app.id}: built runtime loaded a model and ran inference with two threads`);
    } catch (error) {
      failures.push(`${app.id}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.ok(tested >= (requested.size || 5), `Expected ${requested.size || 'at least five'} ONNX worker apps, tested ${tested}`);
  if (!requested.size) {
    await verifyAsyncifyRuntime({ browser, base, apps: registry.apps, repoRoot });
    await verifyQsmBetRuntime({ browser, repoRoot });
  }
} finally {
  await browser.close();
  await site?.close();
}
