// Module worker entry: runs LayNii (LN2_LAYERS + optional LN2_PROFILE) off the main thread.
// Each message creates a fresh WASM module instance so C state and memory are completely isolated.
import { createLayniiRunner } from './index.js';
import { LAYNII_WASM_SHA256 } from './pin.js';

const DEFAULT_KERNEL = {
  module: new URL('../wasm/laynii.mjs', import.meta.url).href,
  wasm: new URL('../wasm/laynii.wasm', import.meta.url).href,
};

const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

let cachedWasm = null;
let cachedCreateModule = null;

async function ensureAssets({ module, wasm }) {
  if (!cachedWasm) {
    const response = await fetch(wasm);
    if (!response.ok) {
      throw new Error(`LayNii WebAssembly did not load (HTTP ${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== LAYNII_WASM_SHA256) {
      throw new Error('LayNii WebAssembly checksum mismatch.');
    }
    cachedWasm = bytes;
  }
  if (!cachedCreateModule) {
    const imported = await import(/* @vite-ignore */ module);
    if (typeof imported.default !== 'function') {
      throw new Error('LayNii module did not load.');
    }
    cachedCreateModule = imported.default;
  }
  return { createModule: cachedCreateModule, wasmBinary: cachedWasm };
}

function ownedCopy(bytes) {
  if (!bytes) return null;
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

async function handle(data) {
  const { id, rim, signal = null, mask = null, kernel: urls, ...settings } = data ?? {};
  const log = [];
  let runner = null;
  try {
    const { createModule, wasmBinary } = await ensureAssets({ ...DEFAULT_KERNEL, ...urls });
    runner = await createLayniiRunner({
      createModule,
      wasmBinary,
      onLog: (line) => {
        const clean = String(line).replace(/\r/g, '').trim();
        if (clean) log.push(clean);
      },
    });
    const result = await runner.runLayersAndProfile({ rim, signal, mask, ...settings });
    const outputs = {};
    const transfer = [];
    for (const key of [
      'layersEquidist',
      'metricEquidist',
      'midGmEquidist',
      'layersEquivol',
      'metricEquivol',
      'midGmEquivol',
      'layersEquicount',
      'thickness',
      'curvature',
    ]) {
      const copy = ownedCopy(result[key]);
      if (copy) {
        outputs[key] = copy;
        transfer.push(copy.buffer);
      }
    }
    self.postMessage(
      { id, outputs, profile: result.profile, log, heapBytes: runner.memoryBytes() },
      transfer,
    );
  } catch (error) {
    self.postMessage({
      id,
      error: error?.message ?? String(error),
      log,
      heapBytes: runner?.memoryBytes() ?? null,
    });
  }
}

self.onmessage = ({ data }) => {
  void handle(data);
};
