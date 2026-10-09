import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { readVolume } from '@neurodesk/synthsr';
import { runSynthstrip } from '@neurodesk/synthstrip';
import { SYNTHSTRIP_MODEL } from '@neurodesk/synthstrip/model';
import { loadMindgrabCpu } from '@neurodesk/runtime-support/node/mindgrab';
import packageJson from '../package.json' with { type: 'json' };
import { runBet } from './bet.js';
import { betRuntime } from './bet-runtime.js';
import { runMindgrab } from './mindgrab.js';
import { outputNames, writeOutputs } from './outputs.js';

export const MODEL_ASSETS = Object.freeze([SYNTHSTRIP_MODEL]);
export const DEFAULT_METHOD = 'synthstrip';
const DEFAULT_FRACTIONAL_INTENSITY = 0.5;

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

// The MindGrab package this package pins, which the web app also serves.
const loadMindgrab = () => loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));

async function loadBetRuntime() {
  return betRuntime(await WebAssembly.compile(await readFile(new URL('../wasm/bet.wasm', import.meta.url))));
}

// What each --method runs. A method's models are verified before any computation.
const METHODS = {
  synthstrip: {
    models: [SYNTHSTRIP_MODEL],
    threaded: true,
    async extract({ volume, models: [model], threads, onProgress }) {
      // Without the arena the T1 example peaks at 2.6 GB instead of 4.4 GB, at the same speed and mask.
      const sessionOptions = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: 1, enableCpuMemArena: false };
      const result = await runSynthstrip({
        volume,
        loadModel: async () => ({ bytes: model, hash: SYNTHSTRIP_MODEL.sha256 }),
        createSession: (bytes) => ort.InferenceSession.create(bytes, sessionOptions),
        Tensor: ort.Tensor,
        onProgress,
      });
      return { ...result, provenance: { ...result.provenance, inference: 'ONNX Runtime Node', onnxruntime: ort.env.versions.node, executionProvider: 'cpu', threads } };
    },
  },
  bet: {
    models: [],
    async extract({ volume, fractionalIntensity, onProgress }) {
      const result = runBet({ volume, runtime: await loadBetRuntime(), fractionalIntensity, onProgress });
      return { ...result, provenance: { ...result.provenance, runtime: 'WebAssembly, single-threaded' } };
    },
  },
  // The web app's CPU backend: the same modules, with the weights compiled in, and the same options.
  mindgrab: {
    models: [],
    async extract({ volume, onProgress }) {
      const { segment } = await loadMindgrab();
      const result = await runMindgrab({ volume, backend: 'cpu', segmenter: segment, onProgress });
      return { ...result, provenance: { ...result.provenance, runtime: 'WebAssembly with Node worker threads' } };
    },
  },
};

export function resolveMethod(value = DEFAULT_METHOD) {
  if (!Object.hasOwn(METHODS, value)) {
    const names = Object.keys(METHODS);
    throw new Error(`Method must be ${names.slice(0, -1).join(', ')} or ${names.at(-1)}, not "${value}".`);
  }
  return METHODS[value];
}

export function resolveFractionalIntensity(value, method) {
  if (value === undefined) return method === 'bet' ? DEFAULT_FRACTIONAL_INTENSITY : undefined;
  if (method !== 'bet') throw new Error('--fractional-intensity applies to --method bet only.');
  const fraction = typeof value === 'string' && /^(\d+\.?\d*|\.\d+)$/.test(value) ? Number(value) : value;
  if (typeof fraction !== 'number' || !(fraction >= 0 && fraction <= 1)) throw new Error(`Fractional intensity must be a number from 0 to 1, not "${value}".`);
  return fraction;
}

const positiveInteger = (value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = positiveInteger(value);
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

// Named after the installed set, so a re-pinned model never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR) return process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'brain-extraction', installedSha256(MODEL_ASSETS).slice(0, 16));
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
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "brain-extraction download-models" while online, or reinstall the complete release.`);
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

// Proves the BET module runs: its mask of a bright sphere must cover the sphere. BET is not
// meant for such a phantom, so the mask's extent beyond the sphere is not checked.
function betSmokeTest(runtime) {
  const size = 32;
  const data = Float32Array.from({ length: size ** 3 }, (_, i) => {
    const [x, y, z] = [i % size, Math.floor(i / size) % size, Math.floor(i / size ** 2)].map((c) => c - size / 2);
    return Math.hypot(x, y, z) < 10 ? 100 : 0;
  });
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const { mask } = runBet({ volume: { dims: [size, size, size], affine, data }, runtime });
  if (data.some((value, index) => value && !mask.data[index])) throw new Error('BET WebAssembly check failed.');
  return mask.data.reduce((sum, value) => sum + value, 0);
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  const betVoxels = betSmokeTest(await loadBetRuntime());
  const mindgrab = await loadMindgrab();
  const models = process.env.NEURODESK_BRAIN_EXTRACTION_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    betSmokeTestVoxels: betVoxels,
    mindgrab: mindgrab.version,
    ...(models ? { models } : {}),
  };
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

// Publishes the brain and mask together into a directory this run alone owns: an exclusively
// created lock in an otherwise empty directory keeps two runs from interleaving their files,
// and both files are staged before either is renamed into place.
async function publish(directory, files) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.brain-extraction.lock');
  try {
    await writeFile(lock, '', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another brain-extraction run is writing to ${directory}. Choose a new or empty directory.`);
    throw error;
  }
  const staged = Object.entries(files).map(([name, bytes]) => ({ path: join(directory, name), partial: join(directory, `${name}.${randomUUID()}.partial`), bytes }));
  try {
    const entries = await readdir(directory);
    if (entries.length !== 1) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    for (const { partial, bytes } of staged) await writeFile(partial, bytes, { flag: 'wx' });
    for (const { partial, path } of staged) await rename(partial, path);
  } finally {
    for (const { partial } of staged) await rm(partial, { force: true });
    await rm(lock, { force: true });
  }
}

export async function extract({
  input,
  output,
  method: methodName = DEFAULT_METHOD,
  fractionalIntensity,
  threads,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const method = resolveMethod(methodName);
  const fraction = resolveFractionalIntensity(fractionalIntensity, methodName);
  if (!method.threaded && threads !== undefined) throw new Error('--threads applies to --method synthstrip only.');
  const intraOpNumThreads = method.threaded ? resolveThreads(threads) : undefined;
  const destination = resolve(output);
  await assertNewOutput(destination);
  const volume = readVolume(arrayBuffer(await readFile(input)));
  const models = [];
  for (const asset of method.models) models.push(await loadAsset(asset, { cacheDir, offline, onProgress: (message) => onProgress(undefined, message) }));
  const started = performance.now();
  const result = await method.extract({ volume, models, threads: intraOpNumThreads, fractionalIntensity: fraction, onProgress });
  const names = outputNames(basename(input), methodName);
  const files = writeOutputs(result);
  await publish(destination, { [names.brain]: new Uint8Array(files.brain), [names.mask]: new Uint8Array(files.mask) });
  return {
    output: destination,
    files: [names.brain, names.mask],
    maskVoxels: result.mask.data.reduce((sum, value) => sum + value, 0),
    provenance: {
      app: `brain-extraction command line ${packageJson.version}`,
      ...result.provenance,
      method: methodName,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}
