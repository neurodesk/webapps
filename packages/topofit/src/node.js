import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import manifest from '../model.manifest.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import { MODELS, runTopofit } from './pipeline.js';

// Only assets a supported model can load are installed: a graph for a model the pipeline refuses is dead weight.
export const MODEL_ASSETS = manifest.assets.filter(({ filename }) => (
  !filename.startsWith('topofit-') || MODELS.some((model) => filename.startsWith(`topofit-${model}-`))
));

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function defaultCacheDir() {
  if (process.env.NEURODESK_TOPOFIT_MODEL_DIR) return process.env.NEURODESK_TOPOFIT_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'topofit', manifest.release);
}

function assetSetSha256(assets) {
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
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "topofit download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const response = await fetch(new URL(asset.filename, manifest.base_url));
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const asset of MODEL_ASSETS) await loadAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length, assetSetSha256: assetSetSha256(MODEL_ASSETS) };
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  const models = process.env.NEURODESK_TOPOFIT_MODEL_DIR ? await downloadModels({ offline: true }) : null;
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

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
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

export async function reconstruct({
  input,
  output,
  model = 't1w-1mm',
  conform = true,
  threads,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const source = await readFile(input);
  const assets = new Map(MODEL_ASSETS.map((asset) => [asset.filename, asset]));
  const sessionOptions = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads,
    interOpNumThreads: 1,
  };
  const result = await runTopofit({
    buffer: arrayBuffer(source),
    model,
    conform,
    async loadAsset(name) {
      const asset = assets.get(name);
      if (!asset) throw new Error(`TopoFit release ${manifest.release} does not install ${name}.`);
      return arrayBuffer(await loadAsset(asset, { cacheDir, offline, onProgress: (message) => onProgress(undefined, message) }));
    },
    createSession: (bytes) => ort.InferenceSession.create(new Uint8Array(bytes), sessionOptions),
    Tensor: ort.Tensor,
    onProgress,
    runtime: {
      app: `TopoFit command line ${packageJson.version}`,
      release: manifest.release,
      assets: Object.fromEntries(manifest.assets.map(({ filename, sha256: digest }) => [filename, digest])),
      inference: 'ONNX Runtime Node',
      onnxruntime: ort.env.versions.node,
      executionProvider: 'cpu',
      threads: intraOpNumThreads,
      graphOptimizationLevel: 'all',
    },
  });
  await mkdir(destination, { recursive: true });
  for (const file of result.files) await writeAtomically(join(destination, file.name), new Uint8Array(file.bytes));
  return { output: destination, files: result.files.map((file) => file.name), elapsedSeconds: result.elapsedSeconds };
}
