// The synthseg command line: the web app's pipeline (./pipeline.js and the Rust wasm) with ONNX Runtime's
// CPU provider in place of WebGPU. It writes the app's two downloads for one input.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { summarizeLabels } from '@neurodesk/webapp-components/automation';
import freesurferLut from '@neurodesk/webapp-components/automation/freesurfer-lut' with { type: 'json' };
import { operationParametersSchema } from '@neurodesk/webapp-components/automation/parameters';
import { readNifti } from '@neurodesk/webapp-components/file-io';
import manifest from '../model.manifest.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import PARAMETERS from './parameters.json' with { type: 'json' };
import { runSynthseg } from './pipeline.js';
import { LABELS_ARTIFACT, looksLikeCt, outputNames } from './results.js';
import { loadSynthseg } from './wasm.js';

export { PARAMETERS };

export const MODEL_ASSETS = Object.freeze(manifest.assets.map((asset) => Object.freeze({ ...asset, url: `${manifest.base_url}${asset.filename}` })));

const SCHEMA = operationParametersSchema(PARAMETERS);

// A one-node ONNX graph (Identity, float32[1], opset 13) proves the native CPU runtime executes.
const IDENTITY_MODEL = Buffer.from('CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN', 'base64');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

// Named after the model's digest, so a re-pinned model never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_SYNTHSEG_MODEL_DIR) return process.env.NEURODESK_SYNTHSEG_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'synthseg', MODEL_ASSETS[0].sha256.slice(0, 16));
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
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "synthseg download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename} (${Math.round(asset.bytes / 1e6)} MB)…`);
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
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length, sha256: MODEL_ASSETS[0].sha256 };
}

async function loadWasm() {
  return loadSynthseg(await readFile(new URL('./synthseg.wasm', import.meta.url)));
}

export async function checkInstallation() {
  const session = await ort.InferenceSession.create(IDENTITY_MODEL, { executionProviders: ['cpu'] });
  const { y } = await session.run({ x: new ort.Tensor('float32', Float32Array.of(42), [1]) });
  await session.release();
  if (y.data[0] !== 42) throw new Error('ONNX Runtime CPU check failed.');
  await loadWasm();
  const models = process.env.NEURODESK_SYNTHSEG_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    preprocessing: 'synthseg.wasm',
    ...(models ? { models } : {}),
  };
}

const positiveInteger = (value) => (typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value);

export function resolveThreads(value = process.env.SLURM_CPUS_PER_TASK || availableParallelism()) {
  const threads = positiveInteger(value);
  if (!Number.isSafeInteger(threads) || threads < 1) throw new Error(`Threads must be a positive integer, not "${value}".`);
  return threads;
}

/** The app's `segment` parameters, checked against the same schema; `ct` stays undefined to detect it. */
export function parseParameters(values = {}) {
  const parsed = SCHEMA.safeParse(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)));
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const key = String(issue.path[0] ?? '');
  const choices = PARAMETERS[key]?.enum ? ` (${PARAMETERS[key].enum.join(' or ')})` : '';
  throw new Error(`--${key}: ${issue.message}${choices}.`);
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

// onnxruntime-node wrapped in the session contract runSynthseg expects. ORT output is NCDHW.
function cpuSession(intraOpNumThreads) {
  return async (bytes) => {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['cpu'],
      intraOpNumThreads,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      enableMemPattern: false,
    });
    return {
      async run(feeds) {
        const tensor = new ort.Tensor('float32', await feeds.input.getData(), feeds.input.dims);
        const outputs = await session.run({ [session.inputNames[0]]: tensor });
        const output = outputs[session.outputNames[0]];
        return { output: { dims: output.dims, type: 'float32', getData: async () => output.data, dispose: () => output.dispose?.() } };
      },
      release: () => session.release(),
    };
  };
}

const describe = (filename, bytes) => ({ filename, bytes: bytes.length, sha256: sha256(bytes) });

export async function segment({
  input,
  output,
  mode,
  ct,
  threads,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const parameters = parseParameters({ mode, ct });
  const intraOpNumThreads = resolveThreads(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  if (!/\.nii(\.gz)?$/i.test(input)) throw new Error('Choose a .nii or .nii.gz image.');
  const source = await readFile(input);
  // The model is verified before any computation, so a missing or corrupt file fails at once.
  const model = await loadAsset(MODEL_ASSETS[0], { cacheDir, offline, onProgress: (message) => onProgress(undefined, message) });
  parameters.ct ??= looksLikeCt((await readNifti(arrayBuffer(source))).data);
  const { buffer, provenance } = await runSynthseg({
    buffer: arrayBuffer(source),
    options: { fast: parameters.mode === 'fast', ct: parameters.ct },
    wasm: await loadWasm(),
    loadModel: async () => ({ bytes: model, hash: MODEL_ASSETS[0].sha256 }),
    createSession: cpuSession(intraOpNumThreads),
    onProgress,
    runtime: {
      app: `SynthSeg command line ${packageJson.version}`,
      inference: 'ONNX Runtime Node',
      onnxRuntime: ort.env.versions.node,
      executionProvider: 'cpu',
      threads: intraOpNumThreads,
    },
  });
  const labels = new Uint8Array(buffer);
  const names = outputNames(basename(input));
  const report = {
    schemaVersion: 1,
    app: 'synthseg',
    appVersion: packageJson.version,
    runId: randomUUID(),
    status: 'succeeded',
    inputs: { image: describe(basename(input), source) },
    parameters,
    provenance,
    artifacts: { labels: { ...LABELS_ARTIFACT, ...describe(names.labels, labels) } },
    measurements: summarizeLabels(await readNifti(buffer), freesurferLut),
  };
  await mkdir(destination, { recursive: true });
  await writeAtomically(join(destination, names.labels), labels);
  await writeAtomically(join(destination, names.report), `${JSON.stringify(report, null, 2)}\n`);
  const peakMemoryMb = Math.round(process.resourceUsage().maxRSS / 1024);
  return { output: destination, files: [names.labels, names.report], parameters, provenance, peakMemoryMb };
}
