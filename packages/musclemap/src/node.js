import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { createMuscleMapPipeline } from './pipeline.js';
import { MODELS } from './model-catalog.generated.js';
import { metricsCsv, outputNames } from './results.js';
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');
export const MODEL_KEYS = MODELS.map(model => `${model.id}-v${model.modelVersion}`);
export const MODEL_ASSETS = MODELS.map(model => ({
  ...model.asset,
  filename: basename(new URL(model.asset.url).pathname)
}));
const MODEL_SET = createHash('sha256').update(JSON.stringify(MODEL_ASSETS.map(asset => asset.sha256))).digest('hex').slice(0, 16);
export function selectModel(key = 'wholebody-v1.4') {
  const index = MODELS.findIndex((model, index) => MODEL_KEYS[index] === key || (model.id === key && model.status === 'active') || (model.id === key && !MODELS.some(other => other.id === key && other.status === 'active')));
  if (index < 0) throw new Error(`Unknown model "${key}". Choose ${MODEL_KEYS.join(', ')}.`);
  return { model: MODELS[index], asset: MODEL_ASSETS[index] };
}
// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function defaultCacheDir() {
  if (process.env.NEURODESK_MUSCLEMAP_MODEL_DIR) return process.env.NEURODESK_MUSCLEMAP_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'musclemap', MODEL_SET);
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
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "musclemap download-models" while online, or reinstall the complete release.`);
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
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  const models = process.env.NEURODESK_MUSCLEMAP_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    ...(models ? { models } : {}),
  };
}

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || Math.min(4, availableParallelism())) {
  const threads = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
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


function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
  return number;
}
export function validateSettings({ model: key, overlap, sourceChunkSize = 17, batchSize = 1,
  imfMethod = 'none', imfComponents = 2 } = {}) {
  const { model, asset } = selectModel(key);
  const selectedOverlap = overlap === undefined ? model.preprocessing.overlapDefault : Number(overlap);
  if (!Number.isFinite(selectedOverlap) || selectedOverlap < 0 || selectedOverlap >= 1) throw new Error('Overlap must be in [0, 1)');
  const sourceChunk = sourceChunkSize === 'full' ? 'full' : positiveInteger(sourceChunkSize, 'Source chunk size');
  const batch = positiveInteger(batchSize, 'Batch size');
  if (![1, 2, 4, 8].includes(batch)) throw new Error('Batch size must be 1, 2, 4 or 8');
  if (!['none', 'kmeans', 'gmm', 'dixon', 'both-kmeans', 'both-gmm'].includes(imfMethod)) throw new Error('Unknown IMF method');
  const components = Number(imfComponents);
  if (![2, 3].includes(components)) throw new Error('IMF components must be 2 or 3');
  return { model, asset, settings: {
    model, overlap: selectedOverlap, sourceChunkSize: sourceChunk, chunkSize: batch,
    calculateMetrics: true,
    imfMetrics: { enabled: imfMethod !== 'none', method: imfMethod.endsWith('gmm') ? 'gmm' : 'kmeans',
      components, mode: imfMethod === 'dixon' ? 'dixon' : imfMethod.startsWith('both-') ? 'both' : 'threshold' }
  } };
}
export async function segment({ input, output, model, threads, cacheDir = defaultCacheDir(),
  offline = offlineByDefault(), onProgress = () => {}, fat, water, ...options } = {}) {
  if (!input || !output) throw new Error('An input image and output directory are required');
  const selected = validateSettings({ model, ...options });
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const imf = selected.settings.imfMetrics;
  if (imf.enabled && imf.mode !== 'threshold' && (!fat || !water)) throw new Error('Dixon IMF requires --fat and --water images');
  if ((fat || water) && (!imf.enabled || imf.mode === 'threshold')) throw new Error('Fat/water inputs require a Dixon IMF method');
  const bytes = arrayBuffer(await readFile(input));
  const parsed = parseNiftiVolume(bytes, { decompress: gunzipSync });
  if (parsed.header.dims.slice(4).some(size => size > 1)) throw new Error('Input must be one 3D NIfTI volume');
  const modelBytes = await loadAsset(selected.asset, { cacheDir, offline, onProgress: message => onProgress(undefined, message) });
  const pipeline = createMuscleMapPipeline({
    Tensor: ort.Tensor,
    createSession: data => ort.InferenceSession.create(new Uint8Array(data), {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads, interOpNumThreads: 1
    }),
    loadModel: async () => arrayBuffer(modelBytes),
    decompress: gunzipSync,
    events: { progress: onProgress, log: message => onProgress(undefined, message) }
  });
  const started = performance.now();
  const inferenceSettings = imf.enabled && imf.mode !== 'threshold'
    ? { ...selected.settings, imfMetrics: { enabled: false } }
    : selected.settings;
  let result = await pipeline.run({ inputData: bytes, settings: inferenceSettings });
  if (imf.enabled && imf.mode !== 'threshold') {
    result = await pipeline.metrics({
      segmentationInputs: [{ data: result.stages.segmentation.niftiData, labelSpaceId: selected.model.labelSpaceId,
        labelSpace: selected.model.labelSpace, encoding: 'sparse' }],
      metricSourceData: imf.mode === 'both' ? bytes : null,
      dixonFatData: arrayBuffer(await readFile(fat)), dixonWaterData: arrayBuffer(await readFile(water)),
      settings: { imfMetrics: imf }
    });
  }
  const names = outputNames(basename(input));
  const labels = result.detectedLabels.map(index => selected.model.labelSpace.labels[index]);
  const files = [
    [names.segmentation, new Uint8Array(result.stages.segmentation.niftiData)],
    [names.display, new Uint8Array(result.stages.segmentation_display.niftiData)],
    [names.metrics, metricsCsv(result.metrics, labels)]
  ];
  await mkdir(destination, { recursive: true });
  for (const [name, data] of files) await writeAtomically(join(destination, name), data);
  return { output: destination, files: files.map(([name]) => name),
    model: `${selected.model.id}-v${selected.model.modelVersion}`, labelSpaceId: selected.model.labelSpaceId,
    modelSha256: selected.asset.sha256, executionProvider: 'cpu', onnxRuntime: ort.env.versions.node, threads: intraOpNumThreads, seconds: (performance.now() - started) / 1000 };
}
