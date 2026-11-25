// Node.js execution driver for @neurodesk/brainchomp.
// Runs the pinned brainchomp-lib CPU WebAssembly module in an isolated worker thread
// and applies the exact same world-remap and masking contract as the Brainchomp web app.
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import packageJson from '../package.json' with { type: 'json' };
import { outputNames } from './orient.js';
import {
  BRAINCHOMP_LIB_REVISION,
  DEFAULT_OPENING_RADIUS,
  UPSTREAM_REVISION,
  applyBrainMask,
  prepareModelInput,
  readNifti3d,
  validateOptions,
  voxelVolumeMm3,
} from './pipeline.js';

const CPU_TIMEOUT_MS = 900_000;
const WASM_JS_URL = new URL('../wasm/brainchomp.js', import.meta.url);
const WASM_BIN_URL = new URL('../wasm/brainchomp.wasm', import.meta.url);
const WORKER_URL = new URL('./brainchomp-worker.js', import.meta.url);

// Serialize CPU WASM runs in-process so peak pthread memory stays bounded.
let previousRun = Promise.resolve();

function runWorker({ mode, args = [], input = null, outputs = [], threads, timeoutMs = CPU_TIMEOUT_MS, onLog, signal }) {
  const log = [];
  const worker = new Worker(WORKER_URL, {
    workerData: {
      moduleUrl: WASM_JS_URL.href,
      mode,
      args,
      input,
      outputs,
      threads,
    },
  });

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      await worker.terminate();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const fail = (message) => finish(new Error(log.length ? `${message}\n${log.join('\n')}` : message));
    const onAbort = () => finish(signal.reason ?? new DOMException('Brainchomp cancelled.', 'AbortError'));
    const timer = setTimeout(
      () => fail(`brainchomp CPU module did not finish within ${timeoutMs} ms`),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (message) => {
      if (message.type === 'log') {
        log.push(message.line);
        onLog?.(message.line);
        return;
      }
      if (message.code !== 0) {
        fail(`brainchomp CPU module exited with status ${message.code}`);
        return;
      }
      finish(null, { files: message.files, elapsedMs: message.elapsedMs, log });
    });
    worker.on('error', (error) => fail(`brainchomp worker failed: ${error.message}`));
    worker.on('exit', (code) => fail(`brainchomp worker stopped with code ${code} before finishing`));
  });
}

async function writeFileAtomic(path, data) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, data, { flag: 'wx' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

export async function downloadModels({ cacheDir = '.' } = {}) {
  return {
    directory: resolve(cacheDir),
    count: 0,
    modelsEmbedded: true,
    note: 'Brainchomp model weights are embedded in its WebAssembly module; nothing to download.',
  };
}

export async function checkInstallation() {
  await access(WASM_JS_URL);
  await access(WASM_BIN_URL);
  const probe = await runWorker({ mode: 'help', threads: 1, timeoutMs: 30_000 });
  if (!probe.log.some((line) => line.includes('Brainchomp'))) {
    throw new Error('Brainchomp CPU WebAssembly self-check produced unexpected output.');
  }
  return {
    ok: true,
    executable: process.execPath,
    node: process.version,
    version: packageJson.version,
    backend: 'cpu',
    library: 'brainchomp-lib',
    libraryRevision: BRAINCHOMP_LIB_REVISION,
    upstreamRevision: UPSTREAM_REVISION,
    modelsEmbedded: true,
  };
}

export async function extract({
  input,
  output,
  opening = DEFAULT_OPENING_RADIUS,
  fillHoles = true,
  threads = Math.min(4, availableParallelism()),
  overwrite = false,
  timeoutMs = CPU_TIMEOUT_MS,
  signal,
  onProgress = () => {},
  onLog = () => {},
} = {}) {
  const opts = validateOptions({ opening, fillHoles });
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 64) {
    throw new Error('threads must be an integer between 1 and 64');
  }
  if (!input || !output) {
    throw new Error('Provide an input rodent MRI NIfTI image and an output directory');
  }
  if (!overwrite) {
    const existing = await readdir(output).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (existing.length) {
      throw new Error(`Output directory is not empty: ${output} (pass --overwrite to allow)`);
    }
  }

  signal?.throwIfAborted();
  onProgress('Reading rodent MRI volume');
  const rawBytes = await readFile(input);
  const volume = readNifti3d(rawBytes, { decompress: gunzipSync });
  const modelInput = new Uint8Array(prepareModelInput(volume));

  const wasmArgs = ['--mask', '/mask.nii', '--opening', String(opts.opening)];
  if (!opts.fillHoles) wasmArgs.push('--no-fill-holes');

  onProgress(`Extracting rodent brain (CPU, ${threads} thread${threads === 1 ? '' : 's'})`);
  const turn = previousRun.then(() =>
    runWorker({
      mode: 'segment',
      args: wasmArgs,
      input: modelInput,
      outputs: ['/out.nii', '/mask.nii'],
      threads,
      timeoutMs,
      onLog,
      signal,
    }),
  );
  previousRun = turn.then(() => {}, () => {});
  const runResult = await turn;

  const maskBytes = runResult.files['/mask.nii'];
  if (!maskBytes) {
    throw new Error('Brainchomp CPU module exited cleanly but wrote no brain mask.');
  }

  onProgress('Writing brain image and mask on input grid');
  const maskVolume = readNifti3d(maskBytes, { decompress: gunzipSync });
  const { brain, mask, maskVoxels } = applyBrainMask(volume, maskVolume);
  const names = outputNames(basename(input));

  await mkdir(output, { recursive: true });
  await writeFileAtomic(join(output, names.brain), Buffer.from(brain));
  await writeFileAtomic(join(output, names.mask), Buffer.from(mask));

  const brainVolumeMm3 = Number((maskVoxels * voxelVolumeMm3(volume.affine)).toFixed(3));
  return {
    input: basename(input),
    output: resolve(output),
    files: [names.brain, names.mask],
    dims: volume.dims,
    maskVoxels,
    brainVolumeMm3,
    elapsedMs: Math.round(runResult.elapsedMs),
    provenance: {
      appVersion: packageJson.version,
      method: 'Brainchomp',
      library: 'brainchomp-lib',
      libraryRevision: BRAINCHOMP_LIB_REVISION,
      backend: 'cpu',
      threads,
      openingRadius: opts.opening,
      fillHoles: opts.fillHoles,
      modelsEmbedded: true,
    },
  };
}
