import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { readVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import packageJson from '../package.json' with { type: 'json' };
import { ENSEMBLE_SIZES, FLAMES_FOLDS, SYNTHSTRIP } from './assets.js';
import { nonzeroMask, runFolds } from './pipeline.js';
import { lesionResults, outputNames } from './results.js';

export const MODEL_ASSETS = Object.freeze([SYNTHSTRIP, ...FLAMES_FOLDS]);

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

// Named after the installed set, so a re-pinned model never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_FLAMES_MODEL_DIR) return process.env.NEURODESK_FLAMES_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'flames', installedSha256(MODEL_ASSETS).slice(0, 16));
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
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "flames download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return path;
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const asset of MODEL_ASSETS) await ensureAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length, installedSha256: installedSha256(MODEL_ASSETS) };
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  const models = process.env.NEURODESK_FLAMES_MODEL_DIR ? await downloadModels({ offline: true }) : null;
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

export function resolveFolds(value = 1) {
  const folds = positiveInteger(value);
  if (!ENSEMBLE_SIZES.includes(folds)) throw new Error(`Folds must be ${ENSEMBLE_SIZES.join(' or ')}, not "${value}".`);
  return folds;
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

export async function segment({
  input,
  output,
  folds = 1,
  skullStripped = false,
  threads,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const foldCount = resolveFolds(folds);
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const volume = readVolume(arrayBuffer(await readFile(input)));
  const options = { cacheDir, offline, onProgress: (message) => onProgress(undefined, message) };
  const load = async (asset) => {
    const bytes = await readFile(await ensureAsset(asset, options));
    // Verify the bytes handed to the runtime too, in case the file changed after preflight.
    if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
      throw new Error(`Cached ${asset.filename} failed checksum verification.`);
    }
    return bytes;
  };
  const sessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads,
    interOpNumThreads: 1,
  };
  const createSession = (bytes) => ort.InferenceSession.create(bytes, sessionOptions);
  // Every model is verified before any computation, so a missing or corrupt file fails at once.
  const selected = FLAMES_FOLDS.slice(0, foldCount);
  for (const asset of [...(skullStripped ? [] : [SYNTHSTRIP]), ...selected]) {
    await ensureAsset(asset, options);
  }
  const started = performance.now();
  let brainMask;
  if (skullStripped) {
    brainMask = nonzeroMask(volume);
  } else {
    const stripped = await runSynthstrip({
      volume,
      loadModel: async () => ({ bytes: await load(SYNTHSTRIP), hash: SYNTHSTRIP.sha256 }),
      createSession,
      Tensor: ort.Tensor,
      onProgress: (value, message) => onProgress(0.1 * value, message),
    });
    brainMask = stripped.mask.data;
  }
  const { probability, windows, resampledShape } = await runFolds({
    volume,
    brainMask,
    folds: selected.length,
    loadModel: (n) => load(selected[n]),
    createSession,
    Tensor: ort.Tensor,
    onPatch: (n, total) => onProgress(0.1 + 0.9 * n / total, `Segmenting lesions · patch ${n} of ${total}`),
  });
  const results = lesionResults(volume, probability);
  const names = outputNames(basename(input));
  await mkdir(destination, { recursive: true });
  await writeAtomically(join(destination, names.mask), new Uint8Array(results.mask));
  await writeAtomically(join(destination, names.probability), new Uint8Array(results.probability));
  await writeAtomically(join(destination, names.table), results.tsv);
  return {
    output: destination,
    files: [names.mask, names.probability, names.table],
    ...results.summary,
    provenance: {
      app: `FLAMeS command line ${packageJson.version}`,
      models: selected.map((fold) => ({ file: fold.filename, sha256: fold.sha256 })),
      brainMask: skullStripped ? 'nonzero voxels' : 'SynthStrip',
      inference: 'ONNX Runtime Node',
      onnxruntime: ort.env.versions.node,
      executionProvider: 'cpu',
      threads: intraOpNumThreads,
      resampledShape,
      windows,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}
