// Node.js API for the TotalSegmentator standalone CLI (ONNX Runtime Node on CPU).
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readVolume } from '@neurodesk/synthsr';
import { fetchBytesWithRetry } from '@neurodesk/webapp-components/fetch';
import packageJson from '../package.json' with { type: 'json' };
import { MODELS, resolveTaskPlan } from './models.js';
import { MAX_INPUT_VOXELS, segmentVolume, validatePlanMemory } from './pipeline.js';
import { segmentationResults } from './results.js';

// Set before loading the native library, including direct users of the Node API.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');

export const MODEL_ASSETS = Object.freeze([...MODELS]);

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

// Named after the installed model set so a re-pinned model never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR) return process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'totalsegmentator', installedSha256(MODEL_ASSETS).slice(0, 16));
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

async function verifyCachedAsset(asset, path) {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      hash.update(chunk);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (size !== asset.bytes || hash.digest('hex') !== asset.sha256) {
    throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
  }
  return true;
}

async function ensureAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  if (await verifyCachedAsset(asset, path)) return path;
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "totalsegmentator download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const bytes = Buffer.from(await fetchBytesWithRetry(asset.url, {}, { retryTransient: true, retries: 3 }));
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return path;
}

export async function downloadModels({
  task = null,
  resolution = 'fast',
  subset = 'all',
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  let selected = MODEL_ASSETS;
  if (task) {
    const plan = resolveTaskPlan({ task, resolution, subset });
    selected = plan.cropModel ? [plan.cropModel, ...plan.models] : [...plan.models];
  }
  for (const asset of selected) await ensureAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: selected.length, installedSha256: installedSha256(selected) };
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  const models = process.env.NEURODESK_TOTALSEGMENTATOR_MODEL_DIR ? await downloadModels({ offline: true }) : null;
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

const positiveInteger = (value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = positiveInteger(value);
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

async function assertNewOutput(directory) {
  let info;
  try {
    info = await stat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Output path ${directory} exists and is not a directory.`);
  const entries = await readdir(directory);
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

export async function segment({
  input,
  output,
  task = 'total',
  resolution = 'fast',
  subset = 'all',
  threads,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const plan = resolveTaskPlan({ task, resolution, subset });
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);

  let volume;
  try {
    volume = readVolume(arrayBuffer(await readFile(input)), { maxVoxels: MAX_INPUT_VOXELS });
  } catch (error) {
    throw new Error((error?.message || String(error)).replace(/before synthesis\b/i, 'before segmentation'));
  }
  validatePlanMemory({ dims: volume.dims, affine: volume.affine, models: plan.models, cropModel: plan.cropModel });

  const options = { cacheDir, offline, onProgress: (message) => onProgress(undefined, message) };
  const requiredModels = plan.cropModel ? [plan.cropModel, ...plan.models] : [...plan.models];
  // Verify or download every required model before computation so missing/corrupt files fail immediately.
  const modelPaths = new Map();
  for (const model of requiredModels) {
    modelPaths.set(model.id, await ensureAsset(model, options));
  }

  const sessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads,
    interOpNumThreads: 1,
  };

  const started = performance.now();
  const result = await segmentVolume({
    volume,
    task: plan.task.id,
    models: plan.models,
    cropModel: plan.cropModel,
    runModel: async (model, fn) => {
      const path = modelPaths.get(model.id) ?? await ensureAsset(model, options);
      const bytes = await readFile(path);
      if (bytes.length !== model.bytes || sha256(bytes) !== model.sha256) {
        throw new Error(`Cached ${model.filename} failed checksum verification.`);
      }
      const session = await ort.InferenceSession.create(bytes, sessionOptions);
      try {
        return await fn(async (tile) => {
          const tensor = new ort.Tensor('float32', tile, [1, 1, ...model.patch]);
          const outputs = await session.run({ [session.inputNames[0]]: tensor });
          return outputs[session.outputNames[0]].data;
        });
      } finally {
        await session.release();
      }
    },
    onProgress: ({ stage, part, totalParts, patch, totalPatches }) => {
      const base = Math.max(0, part - 1) / totalParts;
      const span = 1 / totalParts;
      const frac = totalPatches > 0 ? patch / totalPatches : 0;
      const verb = stage === 'crop' ? 'Locating trunk' : 'Segmenting';
      const suffix = totalParts > 1 ? ` · model ${part}/${totalParts} · patch ${patch}/${totalPatches}` : ` · patch ${patch}/${totalPatches}`;
      onProgress(base + span * frac, `${verb}${suffix}`);
    },
  });

  const built = segmentationResults({
    labels: result.labels,
    imageData: volume.data,
    dims: result.dims,
    affine: result.affine,
    task: plan.task.id,
    modality: plan.task.modality,
  }, basename(input));

  const segFilename = `${built.segmentation.name}.gz`;
  const tableFilename = built.table.name;
  const segGzipped = gzipSync(built.segmentation.bytes);

  await mkdir(destination, { recursive: true });
  await writeAtomically(join(destination, segFilename), segGzipped);
  await writeAtomically(join(destination, tableFilename), built.table.text);

  const totalMl = Math.round(built.rows.reduce((sum, row) => sum + row.ml, 0) * 100) / 100;
  return {
    output: destination,
    files: [segFilename, tableFilename],
    task: plan.task.id,
    resolution: plan.resolution,
    subset: plan.subset,
    structures: built.rows.length,
    totalMl,
    provenance: {
      app: `TotalSegmentator command line ${packageJson.version}`,
      models: requiredModels.map((m) => ({ id: m.id, file: m.filename, sha256: m.sha256 })),
      inference: 'ONNX Runtime Node',
      onnxruntime: ort.env.versions.node,
      executionProvider: 'cpu',
      threads: intraOpNumThreads,
      resampledShape: result.resampledShape,
      windows: result.windows,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}
