import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runInference } from './pipeline.js';
import { MODEL_ASSETS, MODEL_SEEDS, resolveModels, validateSelection } from './assets.js';
import { outputNames } from './results.js';
import runtimeManifest from '../runtime.manifest.json' with { type: 'json' };
import { fileURLToPath, pathToFileURL } from 'node:url';
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');
export { MODEL_ASSETS, MODEL_SEEDS };
// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function defaultCacheDir() {
  if (process.env.NEURODESK_SEEDSEG_MODEL_DIR) return process.env.NEURODESK_SEEDSEG_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'seedseg', installedSha256(MODEL_ASSETS).slice(0, 16));
}

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

async function loadAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (bytes) {
    if (!verified(bytes)) throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
    return bytes;
  }
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "seedseg download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const asset of MODEL_ASSETS) await loadAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length, installedSha256: installedSha256(MODEL_ASSETS) };
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'], intraOpNumThreads: 4, interOpNumThreads: 1 });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  await loadQsm();
  const models = process.env.NEURODESK_SEEDSEG_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    qsmVersion: runtimeManifest.version,
    ...(models ? { models } : {}),
  };
}

export function withStderrLogging(callback) {
  const previous = console.log;
  console.log = (...messages) => console.error(...messages);
  try {
    return callback();
  } finally {
    console.log = previous;
  }
}

export async function loadQsm() {
  const root = fileURLToPath(new URL('../runtime/', import.meta.url));
  const files = new Map();
  for (const file of runtimeManifest.files) {
    const bytes = await readFile(join(root, file.name));
    if (sha256(bytes) !== file.sha256) throw new Error(`QSM runtime ${file.name} failed checksum verification.`);
    files.set(file.name, bytes);
  }
  const qsm = await import(pathToFileURL(join(root, 'qsm_wasm.js')).href);
  qsm.initSync({ module: files.get('qsm_wasm_bg.wasm') });
  return {
    makehomogeneous_wasm(...args) {
      // The pinned QSM host binding logs synchronously with console.log.
      // Keep CLI stdout machine-readable without changing the verified runtime.
      return withStderrLogging(() => qsm.makehomogeneous_wasm(...args));
    },
  };
}

function integer(value, name, maximum = Infinity) {
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${name} must be a positive integer${Number.isFinite(maximum) ? ` up to ${maximum}` : ''}.`);
  }
  return number;
}

export function resolveSettings({ models, ensemble, threshold = 0.1, nMarkers = 3, threads } = {}) {
  if (models !== undefined && ensemble !== undefined) throw new Error('Choose --models or --ensemble, not both.');
  const selected = ensemble === undefined ? resolveModels(models) : MODEL_ASSETS.slice(0, integer(ensemble, 'Ensemble', 4));
  const probability = typeof threshold === 'string' && threshold.trim() ? Number(threshold) : threshold;
  const markers = integer(nMarkers, 'Top-N markers', 10);
  validateSelection({ threshold: probability, nMarkers: markers });
  return { models: selected, threshold: probability, nMarkers: markers,
    threads: integer(threads ?? process.env.SLURM_CPUS_PER_TASK ?? Math.min(4, availableParallelism()), 'Threads') };
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

export async function segment({ input, output, models, ensemble, threshold, nMarkers, threads,
  cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const settings = resolveSettings({ models, ensemble, threshold, nMarkers, threads });
  const destination = resolve(output);
  await assertNewOutput(destination);
  const inputData = arrayBuffer(await readFile(input));
  const verified = new Map();
  for (const asset of settings.models) {
    verified.set(asset.id, await loadAsset(asset, { cacheDir, offline, onProgress: message => onProgress(undefined, message) }));
  }
  const qsm = await loadQsm();
  const started = performance.now();
  const result = await runInference(inputData, {
    selectedModels: settings.models.map(asset => asset.id), threshold: settings.threshold,
    nMarkers: settings.nMarkers, qsm, Tensor: ort.Tensor, decompress: gunzipSync,
    createSession: bytes => ort.InferenceSession.create(bytes, { executionProviders: ['cpu'],
      graphOptimizationLevel: 'all', intraOpNumThreads: settings.threads, interOpNumThreads: 1 }),
    loadModel: async asset => verified.get(asset.id),
    events: { progress: onProgress, log: message => onProgress(undefined, message) },
  });
  const names = outputNames(settings.models.length);
  await mkdir(destination, { recursive: true });
  for (const [stage, { niftiData }] of Object.entries(result.stages)) {
    await writeAtomically(join(destination, names[stage]), new Uint8Array(niftiData));
  }
  return { output: destination, files: Object.values(names), markerVoxels: result.markerVoxels,
    models: result.models, threshold: settings.threshold, nMarkers: settings.nMarkers,
    threads: settings.threads, onnxRuntime: ort.env.versions.node, executionProvider: 'cpu',
    qsmVersion: runtimeManifest.version, seconds: (performance.now() - started) / 1000 };
}
