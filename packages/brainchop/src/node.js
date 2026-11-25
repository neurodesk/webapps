// Node.js execution driver for @neurodesk/brainchop.
// Runs @brainchop/core's threaded CPU WebAssembly modules via @neurodesk/node-drivers/mindgrab,
// sharing the exact model registry and output conventions with apps/brainchop.
import { access, readFile, stat } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { claimOutputDir } from '@neurodesk/node-drivers/output-dir';
import { readNiftiVolume, writeNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti-volume';
import packageJson from '../package.json' with { type: 'json' };
import { MODELS, TISSUE_STAGES, findModel, outputNames, stemFor, validateOptions } from './models.js';

export { MODELS, TISSUE_STAGES, findModel, outputNames, stemFor, validateOptions };

const CORE_PACKAGE_URL = import.meta.resolve('@brainchop/core/package.json');
const CORE_WASM_MODELS = Object.freeze(['mindmap', 'mindmap-fast', 'mindsnap']);
const MAX_DECOMPRESSED_NIFTI_BYTES = 512 * 1024 * 1024;

let driverPromise = null;
function getDriver() {
  driverPromise ??= loadMindgrabCpu(CORE_PACKAGE_URL);
  return driverPromise;
}

const boundedGunzip = (bytes, { maxOutputLength = MAX_DECOMPRESSED_NIFTI_BYTES } = {}) =>
  gunzipSync(bytes, { maxOutputLength });

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function probeCoreWasmHelp(moduleUrl) {
  const workerSource = `
    import { parentPort, workerData } from 'node:worker_threads';
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 1 });
    const lines = [];
    const log = (line) => lines.push(String(line));
    const { default: createModule } = await import(workerData.moduleUrl);
    let settle;
    const done = new Promise((r) => { settle = r; });
    const mod = await createModule({ noInitialRun: true, thisProgram: 'brainchop', print: log, printErr: log, onExit: settle });
    try { mod.callMain(['--help']); } catch (e) { if (typeof e?.status === 'number') settle(e.status); else { log(String(e)); settle(-1); } }
    const code = await done;
    parentPort.postMessage({ code, lines });
  `;
  const worker = new Worker(workerSource, { eval: true, workerData: { moduleUrl } });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(new Error('Brainchop WASM self-check timed out')), 30_000);
    worker.on('message', (msg) => {
      if (msg.code !== 0) finish(new Error(`Brainchop WASM self-check exited with status ${msg.code}`));
      else finish(null, msg);
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => finish(new Error(`Brainchop self-check worker exited early (${code})`)));
  });
}

export async function downloadModels({ cacheDir = '.', offline = false } = {}) {
  requireNonEmptyString(cacheDir, 'cacheDir');
  if (typeof offline !== 'boolean') {
    throw new Error('offline must be a boolean');
  }
  return {
    directory: resolve(cacheDir),
    count: 0,
    modelsEmbedded: true,
    note: 'Brainchop model weights are embedded in @brainchop/core WebAssembly modules; nothing to download.',
  };
}

export async function checkInstallation({ cacheDir } = {}) {
  if (cacheDir !== undefined) {
    const dir = requireNonEmptyString(cacheDir, 'cacheDir');
    const info = await stat(dir).catch(() => null);
    if (!info || !info.isDirectory()) {
      throw new Error(`Model directory does not exist or is not a directory: ${dir}`);
    }
  }
  const driver = await getDriver();
  for (const name of CORE_WASM_MODELS) {
    await access(new URL(`dist/brainchop-${name}.js`, CORE_PACKAGE_URL));
    await access(new URL(`dist/brainchop-${name}.wasm`, CORE_PACKAGE_URL));
  }
  await probeCoreWasmHelp(new URL('dist/brainchop-mindmap.js', CORE_PACKAGE_URL).href);
  return {
    ok: true,
    executable: process.execPath,
    node: process.version,
    version: packageJson.version,
    backend: 'cpu',
    corePackage: driver.packageName,
    coreVersion: driver.version,
    models: MODELS.map((m) => m.id),
    modelsEmbedded: true,
    ...(cacheDir !== undefined ? { cacheDir: resolve(cacheDir) } : {}),
  };
}

function summarizeLabelVolume(volume) {
  const labels = new Set();
  let nonZeroVoxels = 0;
  for (let i = 0; i < volume.data.length; i += 1) {
    const value = Math.round(volume.data[i]);
    if (value !== 0) {
      nonZeroVoxels += 1;
      labels.add(value);
    }
  }
  return {
    dims: volume.dims,
    nonZeroVoxels,
    uniqueLabels: labels.size,
  };
}

function summarizeFractionVolume(volume) {
  let nonZeroVoxels = 0;
  let sum = 0;
  let max = -Infinity;
  for (let i = 0; i < volume.data.length; i += 1) {
    const value = volume.data[i];
    if (value > 0) {
      nonZeroVoxels += 1;
      sum += value;
    }
    if (value > max) max = value;
  }
  return {
    dims: volume.dims,
    nonZeroVoxels,
    meanNonZero: nonZeroVoxels ? Number((sum / nonZeroVoxels).toFixed(4)) : 0,
    max: Number((Number.isFinite(max) ? max : 0).toFixed(4)),
  };
}

/**
 * Re-serialize a native-grid Brainchop output preserving both qform and sform
 * transforms (and NIfTI-2 when the input was NIfTI-2) verbatim.
 */
function preserveNativeGeometry(outputBuffer, inputVol, { labels = false, description = '' }) {
  const outVol = readNiftiVolume(outputBuffer, {
    decompress: boundedGunzip,
    maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
  });
  const sameShape = outVol.dims[0] === inputVol.dims[0]
    && outVol.dims[1] === inputVol.dims[1]
    && outVol.dims[2] === inputVol.dims[2];
  if (!sameShape) {
    return { buffer: outputBuffer, volume: outVol };
  }
  let voxelData = outVol.data;
  if (labels) {
    let maxVal = 0;
    for (let i = 0; i < outVol.data.length; i += 1) {
      const v = Math.round(outVol.data[i]);
      if (v > maxVal) maxVal = v;
    }
    if (maxVal <= 255) {
      const u8 = new Uint8Array(outVol.data.length);
      for (let i = 0; i < outVol.data.length; i += 1) {
        u8[i] = Math.max(0, Math.min(255, Math.round(outVol.data[i])));
      }
      voxelData = u8;
    } else {
      const i16 = new Int16Array(outVol.data.length);
      for (let i = 0; i < outVol.data.length; i += 1) {
        i16[i] = Math.round(outVol.data[i]);
      }
      voxelData = i16;
    }
  }
  const rewritten = writeNiftiVolume(
    {
      data: voxelData,
      dims: inputVol.dims,
      affine: inputVol.affine,
      transforms: inputVol.transforms,
      version: inputVol.version,
    },
    description,
  );
  return { buffer: rewritten, volume: outVol };
}

export async function segment({
  input,
  output,
  model = 'mindmap',
  saveConform = false,
  noTurbo = false,
  legacyCleanup = false,
  threads = Math.min(4, availableParallelism()),
  overwrite = false,
  timeoutMs,
  signal,
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  // Validate all inputs and options BEFORE touching the output directory or WASM runtime.
  requireNonEmptyString(input, 'input');
  requireNonEmptyString(output, 'output');
  requireNonEmptyString(model, 'model');
  const opts = validateOptions({ model, saveConform, noTurbo, legacyCleanup });
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 64) {
    throw new Error('threads must be an integer between 1 and 64');
  }
  if (typeof overwrite !== 'boolean') {
    throw new Error('overwrite must be a boolean');
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive number');
  }

  signal?.throwIfAborted();
  const claim = await claimOutputDir(output, { overwrite, tool: 'brainchop' });
  try {
    signal?.throwIfAborted();
    onProgress('Reading input T1-weighted MRI volume');
    const rawBytes = await readFile(input);
    // Validate gzip CRC, NIfTI-1/2 header, NiBabel affine, and float32 voxel finiteness.
    const inputVol = readNiftiVolume(rawBytes, {
      decompress: boundedGunzip,
      maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
    });
    // Hand @brainchop/core a clean NIfTI-1 with the exact NiBabel-selected affine
    // so NIfTI-2, qform-only, conflicting qform/sform, and LAS-fallback inputs are
    // interpreted consistently.
    const normalizedInput = new Uint8Array(
      writeNiftiVolume(
        { data: inputVol.data, dims: inputVol.dims, affine: inputVol.affine, version: 1 },
        'Brainchop input',
      ),
    );

    const driver = await getDriver();
    const driverOptions = {
      model: opts.model.coreModel,
      backend: 'cpu',
      saveConform: opts.saveConform,
      noTurbo: opts.noTurbo,
      legacyCleanup: opts.legacyCleanup,
      gzipOutput: false,
      threads,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      signal,
      onLog,
    };

    const names = outputNames(basename(input), opts.model.id);

    if (opts.model.kind === 'tissues') {
      onProgress(`Computing GM/WM/CSF tissue fractions with ${opts.model.label} (CPU, ${threads} threads)`);
      const result = await driver.segmentTissues(normalizedInput, driverOptions);
      const artifacts = [];
      const maps = {};
      let dims = null;
      for (const stage of TISSUE_STAGES) {
        const rawOut = result.tissues[stage.id];
        const fileName = names[stage.id];
        const prepared = opts.saveConform
          ? {
              buffer: rawOut,
              volume: readNiftiVolume(rawOut, {
                decompress: boundedGunzip,
                maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
              }),
            }
          : preserveNativeGeometry(rawOut, inputVol, {
              labels: false,
              description: `Brainchop ${stage.id} fraction`,
            });
        artifacts.push({ name: fileName, data: Buffer.from(prepared.buffer) });
        const summary = summarizeFractionVolume(prepared.volume);
        dims ??= summary.dims;
        maps[stage.id] = {
          file: fileName,
          nonZeroVoxels: summary.nonZeroVoxels,
          meanNonZero: summary.meanNonZero,
          max: summary.max,
        };
      }
      const writtenFiles = await claim.publish(artifacts);
      return {
        input: basename(input),
        output: claim.dir,
        model: opts.model.id,
        kind: 'tissues',
        files: writtenFiles,
        dims,
        maps,
        elapsedMs: Math.round(result.elapsedMs),
        provenance: {
          appVersion: packageJson.version,
          corePackage: driver.packageName,
          coreVersion: driver.version,
          coreModel: opts.model.coreModel,
          backend: result.backend,
          threads,
          saveConform: opts.saveConform,
          noTurbo: opts.noTurbo,
          modelsEmbedded: true,
        },
      };
    }

    onProgress(`Running ${opts.model.label} (CPU, ${threads} threads)`);
    const result = await driver.segment(normalizedInput, driverOptions);
    const fileName = names.segmentation;
    const prepared = opts.saveConform
      ? {
          buffer: result.image,
          volume: readNiftiVolume(result.image, {
            decompress: boundedGunzip,
            maxDecompressedBytes: MAX_DECOMPRESSED_NIFTI_BYTES,
          }),
        }
      : preserveNativeGeometry(result.image, inputVol, {
          labels: true,
          description: `Brainchop ${opts.model.id} segmentation`,
        });

    const writtenFiles = await claim.publish([
      { name: fileName, data: Buffer.from(prepared.buffer) },
    ]);
    const summary = summarizeLabelVolume(prepared.volume);

    return {
      input: basename(input),
      output: claim.dir,
      model: opts.model.id,
      kind: 'labels',
      files: writtenFiles,
      dims: summary.dims,
      nonZeroVoxels: summary.nonZeroVoxels,
      uniqueLabels: summary.uniqueLabels,
      elapsedMs: Math.round(result.elapsedMs),
      provenance: {
        appVersion: packageJson.version,
        corePackage: driver.packageName,
        coreVersion: driver.version,
        coreModel: opts.model.coreModel,
        backend: result.backend,
        threads,
        saveConform: opts.saveConform,
        noTurbo: opts.noTurbo,
        legacyCleanup: opts.legacyCleanup,
        modelsEmbedded: true,
      },
    };
  } finally {
    await claim.release();
  }
}
