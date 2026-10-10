import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { createVesselBoostPipeline } from './pipeline.js';
import { MODEL_ASSETS, MODELS, modelAsset } from './assets.js';
import { runSteps, validateParameters } from './options.js';

// Native ORT must see this before loading, including direct Node API imports.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const ort = await import('onnxruntime-node');
export { MODEL_ASSETS };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const toBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const offlineDefault = () => process.env.NEURODESK_OFFLINE === '1';
export function defaultCacheDir() {
  return (
    process.env.NEURODESK_VESSELBOOST_MODEL_DIR ||
    join(
      process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
      'neurodesk',
      'vesselboost',
      digest(JSON.stringify(MODEL_ASSETS)).slice(0, 16)
    )
  );
}
async function verifiedFile(path, asset) {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const bytes of createReadStream(path)) {
      size += bytes.length;
      hash.update(bytes);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (size !== asset.bytes || hash.digest('hex') !== asset.sha256)
    throw new Error(`${asset.filename} failed checksum verification: ${path}`);
  return true;
}
async function ensureAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  if (await verifiedFile(path, asset)) return path;
  if (offline)
    throw new Error(
      `${asset.filename} is missing from offline model directory ${cacheDir}. Run "vesselboost download-models" while online.`
    );
  onProgress(`Downloading ${asset.filename}`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Download ${asset.filename}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
    throw new Error(`${asset.filename} download failed checksum verification`);
  await mkdir(cacheDir, { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return path;
}
export async function downloadModels({
  cacheDir = defaultCacheDir(),
  offline = offlineDefault(),
  onProgress = () => {},
} = {}) {
  for (const asset of MODEL_ASSETS) await ensureAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length };
}
async function loadPreprocessing() {
  const manifest = JSON.parse(
    await readFile(new URL('../preprocessing/artifact.json', import.meta.url), 'utf8')
  );
  for (const asset of manifest.files) {
    if (
      !(await verifiedFile(new URL(`../preprocessing/${asset.filename}`, import.meta.url), asset))
    )
      throw new Error(`Required preprocessing artifact is missing: ${asset.filename}`);
  }
  const preprocessing = await import('../preprocessing/preprocessing.js');
  const bytes = await readFile(new URL('../preprocessing/preprocessing_bg.wasm', import.meta.url));
  await preprocessing.default({ module_or_path: bytes });
  return preprocessing;
}
export async function checkInstallation() {
  const preprocessing = await loadPreprocessing();
  const output = preprocessing.bilateral_denoise(Float32Array.of(1), 1, 1, 1, 2, 1.5, 0);
  if (output.length !== 1 || !Number.isFinite(output[0]))
    throw new Error('Preprocessing CPU self-check failed');
  const graph = Buffer.from(
    'CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN',
    'base64'
  );
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
  });
  const input = new ort.Tensor('float32', Float32Array.of(42), [1]);
  let result;
  try {
    result = await session.run({ x: input });
    if (result.y.data[0] !== 42) throw new Error('ONNX Runtime CPU self-check failed');
  } finally {
    input.dispose();
    result?.y.dispose();
    await session.release();
  }
  return {
    executable: process.execPath,
    node: process.version,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    preprocessing: 'required Rust WebAssembly',
  };
}
export async function segment({
  input,
  output,
  parameters = {},
  threads = Math.min(4, availableParallelism()),
  cacheDir = defaultCacheDir(),
  offline = offlineDefault(),
  signal,
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  const p = validateParameters(parameters);
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 64)
    throw new Error('threads must be an integer between 1 and 64');
  if (!input || !output) throw new Error('Provide an input image and output directory');
  const existing = await readdir(output).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length) throw new Error(`Output directory is not empty: ${output}`);
  signal?.throwIfAborted();
  const bytes = toBuffer(await readFile(input));
  // Refuse invalid input before models, preprocessing or native inference.
  parseNiftiVolume(bytes, { decompress: gunzipSync });
  const selected = [modelAsset(MODELS[p.model])];
  if (p.brainExtraction.startsWith('synthstrip')) selected.push(modelAsset('synthstrip.onnx'));
  for (const asset of selected) await ensureAsset(asset, { cacheDir, offline, onProgress });
  const preprocessing = await loadPreprocessing();
  const outputs = new Map();
  const events = {
    log: onLog,
    progress: (fraction, text) => onProgress(text, fraction),
    complete() {},
    stepComplete() {},
    volumeInfo() {},
    stageData(stage, bytes) {
      outputs.set(`${stage}.nii`, new Uint8Array(bytes));
    },
    emit(type, data) {
      if (type === 'brain-mask-overlay')
        outputs.set('brain-mask.nii', new Uint8Array(data.niftiData));
    },
  };
  const pipeline = createVesselBoostPipeline({
    ort,
    preprocessingWasm: preprocessing,
    events,
    signal,
    parseVolume: (bytes) => parseNiftiVolume(bytes, { decompress: gunzipSync }),
    sessionOptions: {
      executionProviders: ['cpu'],
      intraOpNumThreads: threads,
      interOpNumThreads: 1,
    },
    fetchModel: async (_url, name) => {
      signal?.throwIfAborted();
      const asset = modelAsset(name);
      const path = await ensureAsset(asset, { cacheDir, offline, onProgress });
      const bytes = await readFile(path);
      if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256)
        throw new Error(`${name} failed checksum verification`);
      return bytes;
    },
  });
  const execute = async (type, data) => {
    signal?.throwIfAborted();
    if (type === 'run-inference')
      data = {
        overlap: p.overlap,
        threshold: p.threshold,
        minComponentSize: p.minimumComponentSize,
        modelName: MODELS[p.model],
      };
    await pipeline.dispatch(type, data);
    signal?.throwIfAborted();
  };
  await execute('load', { inputData: bytes });
  await runSteps(execute, p);
  await mkdir(output, { recursive: true });
  for (const [name, bytes] of outputs) await writeFile(join(output, name), bytes, { flag: 'wx' });
  let vesselVoxels = 0;
  const mask = parseNiftiVolume(outputs.get('segmentation.nii'));
  for (const voxel of mask.imageData) vesselVoxels += voxel !== 0;
  return {
    input: basename(input),
    output: resolve(output),
    files: [...outputs.keys()],
    vesselVoxels,
    provenance: {
      appVersion: packageJson.version,
      parameters: p,
      models: selected.map(({ filename, sha256 }) => ({ filename, sha256 })),
      executionProvider: 'cpu',
      onnxRuntime: ort.env.versions.node,
      threads,
    },
  };
}
