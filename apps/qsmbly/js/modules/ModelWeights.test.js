import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { fetchModelWeights } from './ModelWeights.js';

test('verified weights remain usable when the shared cache rejects a quota-exceeding write', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const saved = Object.getOwnPropertyDescriptors(globalThis);
  const requests = [];
  const warnings = [];
  const progress = [];
  const warn = console.warn;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  globalThis.location = { origin: 'https://example.org' };
  globalThis.caches = { open: async () => ({
    match: async () => null,
    put: async () => { throw new Error('QuotaExceededError'); },
  }) };
  globalThis.fetch = async url => {
    requests.push(url);
    return new Response(bytes);
  };
  console.warn = message => warnings.push(message);
  try {
    const weights = await fetchModelWeights({ files: [{ name: 'model.onnx', bytes: 4, sha256 }] }, (...args) => progress.push(args),
      'https://huggingface.co/qsmxt/qsm-onnx-weights/resolve/0123456789012345678901234567890123456789/');
    expect(weights).toEqual([bytes]);
    expect(requests).toEqual(['https://huggingface.co/qsmxt/qsm-onnx-weights/resolve/0123456789012345678901234567890123456789/model.onnx']);
    expect(warnings).toEqual(['Could not cache model.onnx: QuotaExceededError']);
    expect(progress.at(-1)).toEqual([0, 'model.onnx', 4, 4, false]);
  } finally {
    console.warn = warn;
    for (const key of ['crypto', 'location', 'caches', 'fetch']) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]);
      else delete globalThis[key];
    }
  }
});

async function loadModelWeightsModule(importedUrls, initialized, fetch) {
  const context = createContext({ fetch, Response, Blob, DecompressionStream });
  const dlModule = new SyntheticModule(['default'], function () {
    this.setExport('default', async options => initialized.push(options));
  }, { context });
  await dlModule.link(() => {});
  await dlModule.evaluate();
  const source = await readFile(new URL('./ModelWeights.js', import.meta.url), 'utf8');
  const module = new SourceTextModule(source, {
    context,
    importModuleDynamically: async url => {
      importedUrls.push(url);
      return dlModule;
    },
  });
  await module.link(() => new SyntheticModule(['fetchModel'], function () {
    this.setExport('fetchModel', () => {
      throw new Error('Loading the DL runtime must not fetch model weights');
    });
  }, { context }));
  await module.evaluate();
  return module.namespace;
}

// A wasm header; the DL module is served gzipped, or inflated by a host that sets Content-Encoding.
const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

for (const [served, body] of [['gzipped', gzipSync(wasmBytes)], ['already inflated', wasmBytes]]) {
  test(`DL initialization inflates the ${served} runtime manifest WASM once`, async () => {
    const importedUrls = [];
    const initialized = [];
    const requests = [];
    const fetch = async url => {
      requests.push(url);
      return new Response(body);
    };
    const { loadDlWasm } = await loadModelWeightsModule(importedUrls, initialized, fetch);
    const first = loadDlWasm('https://example.org/qsmbly', '0.31.20261016');
    const second = loadDlWasm('https://example.org/qsmbly', '0.31.20261016');
    expect(await first).toBe(await second);
    expect(importedUrls).toEqual([
      'https://example.org/qsmbly/wasm/qsm_wasm_dl.js?v=0.31.20261016',
    ]);
    expect(requests).toEqual([
      'https://example.org/qsmbly/wasm/qsm_wasm_dl_bg.wasm.gz.bin',
    ]);
    expect(initialized).toHaveLength(1);
    expect(Array.from(initialized[0].module_or_path)).toEqual(Array.from(wasmBytes));
  });
}
