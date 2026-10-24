// BISON in Node: the pinned WebAssembly builds the web app runs (antsRegistration, DenoiseImage,
// niimath) and onnxruntime-node for the forest.
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { runNiimath } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import { createFloat32Nifti, createNiftiHeaderFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { MODES } from './features.js';
import { assetDirectory, defaultCacheDir, loadNodeAssets } from './node-assets.js';
import { createDenoiser, createRegistration } from './node-workers.js';
import { modeFor, runBison } from './pipeline.js';

// Set before loading the native library, including direct users of the Node API.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

export function nodeDrivers({ onLog, threads } = {}) {
  return {
    // Each instance runs in its own worker thread and ends with its stage, which frees its heap.
    // The registration log reaches onLog through run()'s result, so the worker does not forward it.
    createRegistration: () => createRegistration(),
    createDenoiser: () => createDenoiser({ onLog }),
    niimath: (args, files) => runNiimath(createNiimath, args, files),
    ort,
    sessionOptions: { executionProviders: ['cpu'], intraOpNumThreads: resolveThreads(threads), interOpNumThreads: 1 },
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

/**
 * Segments a T1 (and optional FLAIR) file into `output`.
 * @returns {Promise<{ output: string, mode: string, files: string[], volumes: object[], volumePol: object, timings: object }>}
 */
export async function segment({ t1, flair = null, output, assetDir, cacheDir, offline, threads, onProgress = () => {}, onLog, checkpoint, signal } = {}) {
  if (!output) throw new Error('An output directory is required.');
  const mode = modeFor({ t1, flair });
  const destination = resolve(output);
  await assertNewOutput(destination);
  const assets = await loadNodeAssets({ modes: [mode], assetDir, cacheDir, offline, onProgress });
  const inputs = { t1: await readFile(t1), flair: flair ? await readFile(flair) : null, t1Name: basename(t1) };
  const result = await runBison(inputs, nodeDrivers({ onLog, threads }), assets, { onProgress, onLog, checkpoint, signal });
  await mkdir(destination, { recursive: true });
  for (const file of result.files) await writeAtomically(join(destination, file.name), file.bytes);
  return { ...result, output: destination, files: result.files.map((file) => file.name) };
}

/**
 * Verifies every asset of both modes: from the asset directory, else from the cache, downloading
 * what is missing unless offline.
 */
export async function downloadModels({ assetDir, cacheDir = defaultCacheDir(), offline = false, onProgress } = {}) {
  const dir = assetDirectory(assetDir);
  const assets = await loadNodeAssets({ modes: Object.keys(MODES), assetDir: dir, cacheDir, offline, onProgress });
  return { directory: resolve(dir ?? cacheDir), count: assets.size };
}

/** Starts each runtime once: the registration kernel, the denoise module, niimath and ONNX Runtime. */
export async function checkInstallation() {
  for (const create of [createRegistration, createDenoiser]) {
    const instance = await create();
    await instance.dispose();
  }
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, 2, 2, 2, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] } });
  const image = new Uint8Array(createFloat32Nifti(Float32Array.from({ length: 8 }, (_, k) => k), header));
  const { outputs } = await runNiimath(createNiimath, ['in.nii', '-add', '1', 'out.nii.gz', '-odt', 'float'], { inputs: { 'in.nii': image }, outputs: ['out.nii.gz'] });
  if (!outputs['out.nii.gz']?.length) throw new Error('niimath check failed.');
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
  };
}
