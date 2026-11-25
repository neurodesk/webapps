// Node.js execution driver for @neurodesk/brainchop.
// Runs @brainchop/core's threaded CPU WebAssembly modules via @neurodesk/node-drivers/mindgrab,
// sharing the exact model registry and output conventions with apps/brainchop.
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { MODELS, TISSUE_STAGES, findModel, outputNames, stemFor, validateOptions } from './models.js';

export { MODELS, TISSUE_STAGES, findModel, outputNames, stemFor, validateOptions };

const CORE_PACKAGE_URL = import.meta.resolve('@brainchop/core/package.json');
const CORE_WASM_MODELS = Object.freeze(['mindmap', 'mindmap-fast', 'mindsnap']);

let driverPromise = null;
function getDriver() {
  driverPromise ??= loadMindgrabCpu(CORE_PACKAGE_URL);
  return driverPromise;
}

async function writeFileAtomic(path, data) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, data, { flag: 'wx' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

function probeCoreWasmHelp(moduleUrl) {
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 1 });
    const lines = [];
    const log = (line) => lines.push(String(line));
    const { default: createModule } = await import(workerData.moduleUrl);
    let settle;
    const done = new Promise((r) => { settle = r; });
    const mod = await createModule({ noInitialRun: true, thisProgram: 'brainchop', print: log, printErr: log, onExit: settle });
    try { mod.callMain(['--help']); } catch (e) { if (typeof e?.status === 'number') settle(e.status); else { log(String(e)); settle(-1); } }
    const code = await done;
    parentPort.postMessage({ code, lines });
  `;
  const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl } });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error('Brainchop WASM self-check timed out')), 30_000);
    worker.on('message', (msg) => {
      if (msg.code !== 0) finish(new Error(`Brainchop WASM self-check exited with status ${msg.code}`));
      else finish(null, msg);
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => finish(new Error(`Brainchop self-check worker exited early (${code})`)));
  });
}

export async function downloadModels({ cacheDir = '.' } = {}) {
  return {
    directory: resolve(cacheDir),
    count: 0,
    modelsEmbedded: true,
    note: 'Brainchop model weights are embedded in @brainchop/core WebAssembly modules; nothing to download.',
  };
}

export async function checkInstallation() {
  const driver = await getDriver();
  for (const name of CORE_WASM_MODELS) {
    await access(new URL(`dist/brainchop-${name}.js`, CORE_PACKAGE_URL));
    await access(new URL(`dist/brainchop-${name}.wasm`, CORE_PACKAGE_URL));
  }
  await probeCoreWasmHelp(new URL('dist/brainchop-mindmap.js', CORE_PACKAGE_URL).href);
  return {
    ok: true,
    executable: process.execPath,
    node: process.version,
    version: packageJson.version,
    backend: 'cpu',
    corePackage: driver.packageName,
    coreVersion: driver.version,
    models: MODELS.map((m) => m.id),
    modelsEmbedded: true,
  };
}

function summarizeLabelVolume(buffer) {
  const volume = parseNiftiVolume(buffer, { decompress: gunzipSync });
  const labels = new Set();
  let nonZeroVoxels = 0;
  for (let i = 0; i < volume.imageData.length; i += 1) {
    const value = Math.round(volume.imageData[i]);
    if (value !== 0) {
      nonZeroVoxels += 1;
      labels.add(value);
    }
  }
  return {
    dims: volume.dims,
    nonZeroVoxels,
    uniqueLabels: labels.size,
  };
}

function summarizeFractionVolume(buffer) {
  const volume = parseNiftiVolume(buffer, { decompress: gunzipSync, OutputCtor: Float32Array });
  let nonZeroVoxels = 0;
  let sum = 0;
  let max = -Infinity;
  for (let i = 0; i < volume.imageData.length; i += 1) {
    const value = volume.imageData[i];
    if (value > 0) {
      nonZeroVoxels += 1;
      sum += value;
    }
    if (value > max) max = value;
  }
  return {
    dims: volume.dims,
    nonZeroVoxels,
    meanNonZero: nonZeroVoxels ? Number((sum / nonZeroVoxels).toFixed(4)) : 0,
    max: Number((Number.isFinite(max) ? max : 0).toFixed(4)),
  };
}

export async function segment({
  input,
  output,
  model = 'mindmap',
  saveConform = false,
  noTurbo = false,
  legacyCleanup = false,
  threads = Math.min(4, availableParallelism()),
  overwrite = false,
  timeoutMs,
  signal,
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  const opts = validateOptions({ model, saveConform, noTurbo, legacyCleanup });
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 64) {
    throw new Error('threads must be an integer between 1 and 64');
  }
  if (!input || !output) {
    throw new Error('Provide an input T1-weighted MRI NIfTI image and an output directory');
  }
  if (!overwrite) {
    const existing = await readdir(output).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (existing.length) {
      throw new Error(`Output directory is not empty: ${output} (pass --overwrite to allow)`);
    }
  }

  signal?.throwIfAborted();
  onProgress('Reading input T1-weighted MRI volume');
  const rawBytes = await readFile(input);
  // Validate input NIfTI before allocating the CPU WebAssembly heap.
  const inputVol = parseNiftiVolume(rawBytes, { decompress: gunzipSync });
  if (inputVol.header.dims.slice(4, inputVol.header.dims[0] + 1).some((d) => d > 1)) {
    throw new Error('Brainchop requires a single 3D NIfTI volume (got 4D or higher).');
  }

  const driver = await getDriver();
  const driverOptions = {
    model: opts.model.coreModel,
    backend: 'cpu',
    saveConform: opts.saveConform,
    noTurbo: opts.noTurbo,
    legacyCleanup: opts.legacyCleanup,
    gzipOutput: false,
    threads,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    signal,
    onLog,
  };

  const names = outputNames(basename(input), opts.model.id);
  await mkdir(output, { recursive: true });

  if (opts.model.kind === 'tissues') {
    onProgress(`Computing GM/WM/CSF tissue fractions with ${opts.model.label} (CPU, ${threads} threads)`);
    const result = await driver.segmentTissues(rawBytes, driverOptions);
    const files = [];
    const maps = {};
    let dims = null;
    for (const stage of TISSUE_STAGES) {
      const buf = result.tissues[stage.id];
      const fileName = names[stage.id];
      await writeFileAtomic(join(output, fileName), Buffer.from(buf));
      files.push(fileName);
      const summary = summarizeFractionVolume(buf);
      dims ??= summary.dims;
      maps[stage.id] = {
        file: fileName,
        nonZeroVoxels: summary.nonZeroVoxels,
        meanNonZero: summary.meanNonZero,
        max: summary.max,
      };
    }
    return {
      input: basename(input),
      output: resolve(output),
      model: opts.model.id,
      kind: 'tissues',
      files,
      dims,
      maps,
      elapsedMs: Math.round(result.elapsedMs),
      provenance: {
        appVersion: packageJson.version,
        corePackage: driver.packageName,
        coreVersion: driver.version,
        coreModel: opts.model.coreModel,
        backend: result.backend,
        threads,
        saveConform: opts.saveConform,
        noTurbo: opts.noTurbo,
        modelsEmbedded: true,
      },
    };
  }

  onProgress(`Running ${opts.model.label} (CPU, ${threads} threads)`);
  const result = await driver.segment(rawBytes, driverOptions);
  const fileName = names.segmentation;
  await writeFileAtomic(join(output, fileName), Buffer.from(result.image));
  const summary = summarizeLabelVolume(result.image);

  return {
    input: basename(input),
    output: resolve(output),
    model: opts.model.id,
    kind: 'labels',
    files: [fileName],
    dims: summary.dims,
    nonZeroVoxels: summary.nonZeroVoxels,
    uniqueLabels: summary.uniqueLabels,
    elapsedMs: Math.round(result.elapsedMs),
    provenance: {
      appVersion: packageJson.version,
      corePackage: driver.packageName,
      coreVersion: driver.version,
      coreModel: opts.model.coreModel,
      backend: result.backend,
      threads,
      saveConform: opts.saveConform,
      noTurbo: opts.noTurbo,
      legacyCleanup: opts.legacyCleanup,
      modelsEmbedded: true,
    },
  };
}
