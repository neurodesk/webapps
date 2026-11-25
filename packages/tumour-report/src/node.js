// Node.js execution and model cache driver for @neurodesk/tumour-report.
// Shares the exact preprocessing, tiling, morphometry, MNI RADS and report
// serialization code with the Brain Tumour Report web application.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadGreedySingleThread } from '@neurodesk/greedy/single';
import { claimOutputDir } from '@neurodesk/node-drivers/output-dir';
import { readNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import packageJson from '../package.json' with { type: 'json' };
import { ASSETS, TUMOUR_TYPES, assetById, manifest } from './models.js';
import { computeNativeMorphometry } from './morphometry.js';
import { extractBrainMask, segmentTumour } from './pipeline.js';
import { gridsMatch, validateVolume } from './preprocess.js';
import { computeMniRads, normalizeToMniWithGreedy, parseBcbTractsPack } from './rads.js';
import { buildReport, caseName } from './results.js';

// Native ONNX Runtime must always see telemetry disabled before loading so
// an inherited ORT_DISABLE_TELEMETRY=0 cannot write files under ~/.cache.
process.env.ORT_DISABLE_TELEMETRY = '1';
const ort = await import('onnxruntime-node');

export { ASSETS, TUMOUR_TYPES, manifest };

const VALID_TUMOUR_TYPES = new Set(TUMOUR_TYPES.map((entry) => entry.id));
const MAX_DECOMPRESSED_NIFTI_BYTES = 512 * 1024 * 1024;

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const offlineDefault = () => process.env.NEURODESK_OFFLINE === '1';

const boundedGunzip = (bytes, { maxOutputLength = MAX_DECOMPRESSED_NIFTI_BYTES } = {}) =>
  gunzipSync(bytes, { maxOutputLength });

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

const VALID_PARAMETER_KEYS = new Set(['tumourType', 'computeMniReport', 'deformableMni', 'skullStripped']);
const VALID_DOWNLOAD_KEYS = new Set(['cacheDir', 'offline', 'onProgress', 'signal']);
const VALID_CHECK_KEYS = new Set(['cacheDir']);
const VALID_ANALYZE_KEYS = new Set([
  'input',
  'output',
  'mask',
  'parameters',
  'threads',
  'cacheDir',
  'offline',
  'overwrite',
  'signal',
  'onProgress',
  'onLog',
]);

function assertAllowedKeys(options, allowed, label) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${label} must be an object`);
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown option in ${label}: ${key}`);
    }
  }
}

export function defaultCacheDir() {
  const envDir = process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  if (envDir !== undefined) {
    return requireNonEmptyString(envDir, 'NEURODESK_TUMOUR_REPORT_MODEL_DIR');
  }
  return join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'neurodesk',
    'tumour-report',
    digest(JSON.stringify(ASSETS)).slice(0, 16),
  );
}

async function verifiedFile(path, asset) {
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
    throw new Error(`${asset.filename} failed checksum verification: ${path}`);
  }
  return true;
}

async function ensureAsset(asset, { cacheDir, offline, onProgress, signal }) {
  signal?.throwIfAborted();
  const path = join(cacheDir, asset.filename);
  if (await verifiedFile(path, asset)) return path;
  if (offline) {
    throw new Error(
      `${asset.filename} is missing from offline model directory ${cacheDir}. Run "tumour-report download-models" while online.`,
    );
  }
  if (!asset.url) {
    throw new Error(`${asset.filename} has no download URL configured.`);
  }
  onProgress(`Downloading ${asset.filename}`);
  const response = await fetch(asset.url, { signal });
  if (!response.ok) {
    throw new Error(`Download ${asset.filename}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || digest(bytes) !== asset.sha256) {
    throw new Error(`${asset.filename} download failed checksum verification`);
  }
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

export async function downloadModels(options = {}) {
  assertAllowedKeys(options, VALID_DOWNLOAD_KEYS, 'downloadModels options');
  const {
    cacheDir,
    offline = offlineDefault(),
    onProgress = () => {},
    signal,
  } = options;
  const resolvedCache = cacheDir === undefined
    ? defaultCacheDir()
    : requireNonEmptyString(cacheDir, 'cacheDir');
  if (typeof offline !== 'boolean') {
    throw new Error('offline must be a boolean');
  }
  for (const asset of ASSETS) {
    await ensureAsset(asset, { cacheDir: resolvedCache, offline, onProgress, signal });
  }
  return {
    directory: resolve(resolvedCache),
    count: ASSETS.length,
    models: ASSETS.filter((a) => a.kind === 'model').length,
    atlases: ASSETS.filter((a) => a.kind === 'atlas').length,
  };
}

export function validateParameters(parameters = {}) {
  assertAllowedKeys(parameters, VALID_PARAMETER_KEYS, 'parameters');
  const tumourType = parameters.tumourType === undefined ? 'glioblastoma' : parameters.tumourType;
  if (typeof tumourType !== 'string' || !VALID_TUMOUR_TYPES.has(tumourType)) {
    throw new Error(`tumourType must be one of: ${[...VALID_TUMOUR_TYPES].join(', ')}`);
  }
  const computeMniReport = parameters.computeMniReport === undefined ? true : parameters.computeMniReport;
  if (typeof computeMniReport !== 'boolean') {
    throw new Error('computeMniReport must be a boolean');
  }
  const deformableMni = parameters.deformableMni === undefined ? false : parameters.deformableMni;
  if (typeof deformableMni !== 'boolean') {
    throw new Error('deformableMni must be a boolean');
  }
  const skullStripped = parameters.skullStripped === undefined ? false : parameters.skullStripped;
  if (typeof skullStripped !== 'boolean') {
    throw new Error('skullStripped must be a boolean');
  }
  return {
    tumourType,
    computeMniReport,
    deformableMni,
    skullStripped,
  };
}

function nonZeroMask(data) {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] > 0) mask[i] = 1;
  }
  return mask;
}

async function runSingleOnnxSession(modelPath, threads, fn) {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  try {
    const runTensor = async (tile, shape) => {
      const input = new ort.Tensor('float32', tile, shape);
      let outputs;
      try {
        outputs = await session.run({ [session.inputNames[0]]: input });
        return Float32Array.from(outputs[session.outputNames[0]].data);
      } finally {
        input.dispose();
        for (const output of Object.values(outputs || {})) output.dispose();
      }
    };
    return await fn(runTensor);
  } finally {
    await session.release();
  }
}

export async function checkInstallation(options = {}) {
  assertAllowedKeys(options, VALID_CHECK_KEYS, 'checkInstallation options');
  const { cacheDir } = options;
  if (cacheDir !== undefined) {
    requireNonEmptyString(cacheDir, 'cacheDir');
  }

  const graph = Buffer.from(
    'CAc6NwoQCgF4EgF5IghJZGVudGl0eRIBZ1oPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCAhAN',
    'base64',
  );
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
  });
  const input = new ort.Tensor('float32', Float32Array.of(42), [1]);
  let result;
  try {
    result = await session.run({ x: input });
    if (result.y.data[0] !== 42) {
      throw new Error('ONNX Runtime CPU self-check failed');
    }
  } finally {
    input.dispose();
    result?.y.dispose();
    await session.release();
  }

  const greedy = await loadGreedySingleThread();
  if (!greedy || typeof greedy !== 'object') {
    throw new Error('Greedy single-thread WASM self-check failed');
  }

  // Verify every pinned asset when a cache directory is explicitly specified or
  // supplied by the portable launcher (NEURODESK_TUMOUR_REPORT_MODEL_DIR).
  const dirToVerify = cacheDir ?? process.env.NEURODESK_TUMOUR_REPORT_MODEL_DIR;
  let modelsVerified = false;
  if (dirToVerify !== undefined) {
    const checkedDir = requireNonEmptyString(dirToVerify, 'cacheDir');
    for (const asset of ASSETS) {
      const present = await verifiedFile(join(checkedDir, asset.filename), asset);
      if (!present) {
        throw new Error(`${asset.filename} is missing from model directory ${checkedDir}`);
      }
    }
    modelsVerified = true;
  }

  return {
    ok: true,
    executable: process.execPath,
    node: process.version,
    version: packageJson.version,
    onnxRuntime: ort.env.versions.node,
    executionProvider: 'cpu',
    greedy: 'wasm-single',
    assets: ASSETS.length,
    modelsVerified,
  };
}

export async function analyze(options = {}) {
  const started = performance.now();
  // Validate all inputs and options BEFORE touching the output directory or models.
  assertAllowedKeys(options, VALID_ANALYZE_KEYS, 'analyze options');
  const {
    input,
    output,
    mask,
    parameters = {},
    threads = Math.min(4, availableParallelism()),
    cacheDir,
    offline = offlineDefault(),
    overwrite = false,
    signal,
    onProgress = () => {},
    onLog = () => {},
  } = options;
  requireNonEmptyString(input, 'input');
  requireNonEmptyString(output, 'output');
  if (mask !== undefined && mask !== null) {
    requireNonEmptyString(mask, 'mask');
  }
  const resolvedCacheDir = cacheDir === undefined
    ? defaultCacheDir()
    : requireNonEmptyString(cacheDir, 'cacheDir');
  if (typeof offline !== 'boolean') {
    throw new Error('offline must be a boolean');
  }
  if (typeof overwrite !== 'boolean') {
    throw new Error('overwrite must be a boolean');
  }
  const params = validateParameters(parameters);
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 64) {
    throw new Error('threads must be an integer between 1 and 64');
  }

  signal?.throwIfAborted();
  const claim = await claimOutputDir(output, { overwrite, tool: 'tumour-report' });
  try {
    signal?.throwIfAborted();
    onProgress('Reading T1c volume');
    const volume = readNiftiVolume(await readFile(input), {
      decompress: boundedGunzip,
      maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
    });
    validateVolume(volume, 'T1c');
    onLog(`Loaded T1c ${basename(input)} (${volume.dims.join(' × ')})`);

    let brainMask = null;
    let tumourMask = null;
    const warnings = [];
    const usedModels = [];
    let patches = 0;

    if (mask) {
      signal?.throwIfAborted();
      onProgress('Reading supplied tumour mask');
      const maskVol = readNiftiVolume(await readFile(mask), {
        decompress: boundedGunzip,
        maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
      });
      validateVolume(maskVol, 'Tumour mask');
      if (!gridsMatch(volume, maskVol)) {
        throw new Error(
          `Supplied tumour mask (${maskVol.dims.join(' × ')}) is not aligned to the T1c voxel-to-RAS grid (${volume.dims.join(' × ')}).`,
        );
      }
      tumourMask = nonZeroMask(maskVol.data);
      onLog(`Using supplied tumour mask ${basename(mask)}`);
      if (params.skullStripped) {
        brainMask = nonZeroMask(volume.data);
      } else if (params.computeMniReport) {
        const brainAsset = assetById('mri-brain');
        const brainPath = await ensureAsset(brainAsset, {
          cacheDir: resolvedCacheDir,
          offline,
          onProgress,
          signal,
        });
        usedModels.push({ id: brainAsset.id, filename: brainAsset.filename, sha256: brainAsset.sha256 });
        const brainOut = await extractBrainMask({
          volume,
          runBrain: (tile, shape) =>
            runSingleOnnxSession(brainPath, threads, (runTensor) => runTensor(tile, shape)),
          onProgress: (ev) => onProgress(ev.message),
          signal,
        });
        brainMask = brainOut.brainMask;
        warnings.push(...brainOut.warnings);
      }
    } else {
      let brainPath = null;
      if (!params.skullStripped) {
        const brainAsset = assetById('mri-brain');
        brainPath = await ensureAsset(brainAsset, {
          cacheDir: resolvedCacheDir,
          offline,
          onProgress,
          signal,
        });
        usedModels.push({ id: brainAsset.id, filename: brainAsset.filename, sha256: brainAsset.sha256 });
      }
      const tumourAsset = assetById('mri-tumorcore-t1c');
      const tumourPath = await ensureAsset(tumourAsset, {
        cacheDir: resolvedCacheDir,
        offline,
        onProgress,
        signal,
      });
      usedModels.push({ id: tumourAsset.id, filename: tumourAsset.filename, sha256: tumourAsset.sha256 });

      let tumourSession = null;
      try {
        const seg = await segmentTumour({
          volume,
          skullStripped: params.skullStripped,
          runBrain: params.skullStripped
            ? undefined
            : (tile, shape) =>
              runSingleOnnxSession(brainPath, threads, (runTensor) => runTensor(tile, shape)),
          runTumorCore: async (tile, shape) => {
            if (!tumourSession) {
              tumourSession = await ort.InferenceSession.create(tumourPath, {
                executionProviders: ['cpu'],
                intraOpNumThreads: threads,
                interOpNumThreads: 1,
                graphOptimizationLevel: 'all',
              });
            }
            const tensor = new ort.Tensor('float32', tile, shape);
            let outputs;
            try {
              outputs = await tumourSession.run({ [tumourSession.inputNames[0]]: tensor });
              return Float32Array.from(outputs[tumourSession.outputNames[0]].data);
            } finally {
              tensor.dispose();
              for (const outTensor of Object.values(outputs || {})) outTensor.dispose();
            }
          },
          onProgress: (ev) => onProgress(ev.message),
          signal,
        });
        brainMask = seg.brainMask;
        tumourMask = seg.tumourMask;
        patches = seg.patches;
        warnings.push(...seg.warnings);
      } finally {
        if (tumourSession) await tumourSession.release();
      }
    }

    signal?.throwIfAborted();
    onProgress('Computing native-space morphometry');
    const morphometry = computeNativeMorphometry({
      tumourMask,
      brainMask,
      dims: volume.dims,
      affine: volume.affine,
    });
    onLog(`Native morphometry: ${morphometry.lesionCount} lesions, ${morphometry.totalVolumeMl.toFixed(2)} mL`);

    let rads = null;
    let mniMask = null;
    let mniDims = null;
    let mniAffine = null;
    let registrationMode = null;
    const usedAtlases = [];

    if (params.computeMniReport && morphometry.lesionCount > 0) {
      const atlasIds = [
        'mni-icbm152-t1-brain',
        'mni-lateralisation',
        'mni-lobes',
        'schaefer7',
        'schaefer17',
        'bcb-tracts',
      ];
      if (params.tumourType === 'glioblastoma') {
        atlasIds.push('resect-left', 'resect-right');
      }
      const atlasPaths = {};
      for (const id of atlasIds) {
        const asset = assetById(id);
        atlasPaths[id] = await ensureAsset(asset, {
          cacheDir: resolvedCacheDir,
          offline,
          onProgress,
          signal,
        });
        usedAtlases.push({ id: asset.id, filename: asset.filename, sha256: asset.sha256 });
      }

      signal?.throwIfAborted();
      onProgress('Registering to MNI ICBM152 2009a with Greedy');
      const greedyApi = await loadGreedySingleThread();
      const mniTemplateBytes = await readFile(atlasPaths['mni-icbm152-t1-brain']);
      const mniNorm = await normalizeToMniWithGreedy({
        volume,
        brainMask: brainMask ?? nonZeroMask(volume.data),
        tumourMask,
        mniTemplateBytes,
        greedyApi,
        deformable: params.deformableMni,
        onProgress: (ev) => onProgress(ev.message),
        signal,
      });
      registrationMode = mniNorm.mode;
      if (mniNorm.mniVoxels === 0) {
        warnings.push('Warped tumour mask is empty in MNI space; MNI anatomical characterization unavailable.');
      } else {
        mniMask = mniNorm.mniMask;
        mniDims = mniNorm.dims;
        mniAffine = mniNorm.affine;
        onProgress('Computing MNI RADS anatomical report');
        const loadMask = async (id) =>
          Uint8Array.from(
            readNiftiVolume(await readFile(atlasPaths[id]), {
              decompress: boundedGunzip,
              maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
            }).data,
          );
        const loadFloat = async (id) =>
          readNiftiVolume(await readFile(atlasPaths[id]), {
            decompress: boundedGunzip,
            maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
          }).data;
        const atlases = {
          lateralisation: await loadMask('mni-lateralisation'),
          lobes: await loadMask('mni-lobes'),
          schaefer7: await loadMask('schaefer7'),
          schaefer17: await loadMask('schaefer17'),
          bcbTracts: parseBcbTractsPack(
            boundedGunzip(await readFile(atlasPaths['bcb-tracts'])),
          ),
          resectLeft: atlasPaths['resect-left'] ? await loadFloat('resect-left') : null,
          resectRight: atlasPaths['resect-right'] ? await loadFloat('resect-right') : null,
        };
        rads = computeMniRads({
          mniMask,
          dims: mniDims,
          tumourType: params.tumourType,
          atlases,
        });
      }
    }

    const label = caseName(basename(input));
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const built = buildReport({
      caseLabel: label,
      tumourType: params.tumourType,
      dims: volume.dims,
      affine: volume.affine,
      transforms: volume.transforms,
      niftiVersion: volume.version,
      brainMask,
      tumourMask,
      mniMask,
      mniDims,
      mniAffine,
      morphometry,
      rads,
      warnings,
      provenance: {
        appVersion: packageJson.version,
        mode: mask ? 'supplied-mask' : 'raidionics-v1.3',
        skullStripped: params.skullStripped,
        executionProvider: 'cpu',
        onnxRuntime: ort.env.versions.node,
        threads,
        models: usedModels,
        atlases: usedAtlases,
        registrationMode,
        patches,
        seconds,
      },
    });

    const artifacts = [
      { name: built.tumourMask.name, data: Buffer.from(built.tumourMask.bytes) },
    ];
    if (built.brainMask) {
      artifacts.push({ name: built.brainMask.name, data: Buffer.from(built.brainMask.bytes) });
    }
    if (built.tumourMaskMni) {
      artifacts.push({ name: built.tumourMaskMni.name, data: Buffer.from(built.tumourMaskMni.bytes) });
    }
    artifacts.push(
      { name: built.reportJson.name, data: built.reportJson.text },
      { name: built.lesionsTsv.name, data: built.lesionsTsv.text },
      { name: built.summaryTsv.name, data: built.summaryTsv.text },
    );

    const writtenFiles = await claim.publish(artifacts);

    return {
      input: basename(input),
      output: claim.dir,
      caseLabel: label,
      files: writtenFiles,
      dims: volume.dims,
      lesionCount: morphometry.lesionCount,
      totalVolumeMl: morphometry.totalVolumeMl,
      brainVolumeMl: morphometry.brainVolumeMl,
      mniVolumeMl: rads?.mniVolumeMl ?? null,
      laterality: rads?.laterality ?? null,
      resectability: rads?.resectability ?? null,
      warnings,
      provenance: built.report.provenance,
    };
  } finally {
    await claim.release();
  }
}
