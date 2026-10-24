// BISON's browser drivers for runBison, for a module worker of the web app (apps/bison/src/worker.js).
// antsRegistration and DenoiseImage run in module workers of their own packages, one Worker for each
// create call: Emscripten memories grow and never shrink, so dispose() terminates the Worker and frees
// its heap at once, as node-workers.js ends a worker thread. niimath and ONNX Runtime Web run in the
// calling worker.
//
//   createRegistration() -> { run(argv, inputs), memoryBytes(), dispose() }   @neurodesk/hmc-registration/worker
//   createDenoiser()     -> { denoise({ image, mask, ... }), memoryBytes(), dispose() }   @neurodesk/ants-denoise/worker
//   niimath(args, { inputs, outputs }) -> { outputs, log }
//
// Both ANTs kernels are linked with -pthread, so the page must be cross-origin isolated (COOP
// same-origin, COEP require-corp). The worker scripts are served as their packages lay them out
// (src/*.js beside ../wasm/), so each finds its pinned kernel; runtime can name moved kernel files.
//
// runtime: {
//   registration: { worker, module?, wasm? }   URLs of hmc-registration src/worker.js and its kernel
//   denoise:      { worker, module?, wasm? }   URLs of ants-denoise src/worker.js and its kernel
//   niimath?:     { module?, wasm? }           niimath.js and niimath.wasm (default: the bundled build)
//   ort?:         { wasm?, mjs?, numThreads? } ort-wasm-simd-threaded.{wasm,mjs} for ort.env.wasm.wasmPaths
// }
import createBundledNiimath from '@niivue/niimath/niimath.js';
import * as ort from 'onnxruntime-web/wasm';
import { getOptimalWasmThreads } from '@neurodesk/webapp-components/worker';

export { assetUrl, heldAssetError, loadBrowserAssets } from './browser-assets.js';

// ONNX Runtime Web gains little from more threads on the forest; it uses at most 4.
export const MAX_ORT_THREADS = 4;

const LABELS = { registration: 'registration kernel', denoiser: 'denoise module' };

const lost = (message, cause) => Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { log: [], aborted: true });

function workerUrl(runtime, key) {
  const url = runtime?.[key]?.worker;
  if (!url) throw new Error(`The BISON runtime needs the URL of the ${key} worker (runtime.${key}.worker).`);
  return url;
}

// The kernel URLs a worker message carries, when the runtime moved them.
function kernelOf(entry) {
  const kernel = {};
  if (entry?.module) kernel.module = String(entry.module);
  if (entry?.wasm) kernel.wasm = String(entry.wasm);
  return Object.keys(kernel).length ? kernel : undefined;
}

/**
 * One module Worker with the { id, ... } request and reply protocol of the two kernel workers.
 * reply(data) maps a reply to a value or throws its error; a Worker error or dispose() rejects
 * every pending call with `aborted: true`, so registrationSession loads a new instance.
 */
function start(kind, url, { WorkerClass = globalThis.Worker } = {}) {
  if (typeof WorkerClass !== 'function') throw new Error('This browser has no module workers.');
  const worker = new WorkerClass(url, { type: 'module' });
  const pending = new Map();
  let next = 0;
  let heapBytes = null;
  let stopped = null;
  let disposed = false;

  const failAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    if (Number.isSafeInteger(data?.heapBytes)) heapBytes = data.heapBytes;
    const call = pending.get(data?.id);
    if (!call) return;
    pending.delete(data.id);
    call.resolve(data);
  };
  worker.onerror = (event) => {
    event?.preventDefault?.();
    stopped ??= event?.message || 'the worker script failed';
    failAll(lost(`The ${LABELS[kind]} worker failed (${stopped}).`, event?.error));
  };
  worker.onmessageerror = () => {
    stopped ??= 'a reply could not be read';
    failAll(lost(`The ${LABELS[kind]} worker failed (${stopped}).`));
  };

  return {
    /** Sends one request; resolves to the raw reply. Inputs are copied (structured clone), as callers reuse them. */
    request(message) {
      if (disposed) return Promise.reject(lost(`The ${LABELS[kind]} worker was disposed.`));
      if (stopped) return Promise.reject(lost(`The ${LABELS[kind]} worker stopped (${stopped}); start a new one.`));
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          worker.postMessage({ ...message, id });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    memoryBytes: () => heapBytes,
    /** Terminates the Worker, which frees its heap; pending calls reject. */
    async dispose() {
      if (disposed) return;
      disposed = true;
      failAll(lost(`The ${LABELS[kind]} worker was disposed.`));
      worker.terminate();
    },
  };
}

// hmc-registration's worker replies { id, error, log } with no abort flag. Its kernel words an abort
// "<program> aborted (...)" and its later refusal "The registration kernel stopped (...)".
export function registrationError({ error, log = [] }) {
  const aborted = /\baborted \(|kernel stopped \(/.test(error);
  return Object.assign(new Error(error), { log, aborted });
}

// ants-denoise's worker words an abort "ANTs DenoiseImage aborted (...)".
export function denoiseError({ error, log = [] }) {
  return Object.assign(new Error(error), { log, aborted: /DenoiseImage aborted \(/.test(error) });
}

/**
 * antsRegistration, AverageImages, AverageAffineTransform and --apply in a new module Worker.
 * run(argv, inputs) resolves to { outputs, log } and rejects with the kernel's error (log, aborted).
 * The worker does not report its heap, so memoryBytes() is null.
 */
export async function createRegistration({ runtime, WorkerClass } = {}) {
  const url = workerUrl(runtime, 'registration');
  const kernel = kernelOf(runtime.registration);
  const worker = start('registration', url, { WorkerClass });
  return {
    async run(argv, inputs = {}) {
      const reply = await worker.request(kernel ? { argv, inputs, kernel } : { argv, inputs });
      if (reply.error !== undefined) throw registrationError(reply);
      return { outputs: reply.outputs, log: reply.log ?? [] };
    },
    memoryBytes: () => null,
    dispose: worker.dispose,
  };
}

/**
 * ANTs DenoiseImage in a new module Worker. denoise() takes the options of ants-denoise's denoise()
 * and resolves to float32 NIfTI bytes; memoryBytes() is the heap the worker last reported.
 */
export async function createDenoiser({ runtime, onLog, WorkerClass } = {}) {
  const url = workerUrl(runtime, 'denoise');
  const kernel = kernelOf(runtime.denoise);
  const worker = start('denoiser', url, { WorkerClass });
  return {
    async denoise(settings = {}) {
      const reply = await worker.request(kernel ? { ...settings, kernel } : { ...settings });
      if (onLog) for (const line of reply.log ?? []) onLog(line);
      if (reply.error !== undefined) throw denoiseError(reply);
      return reply.output;
    },
    memoryBytes: worker.memoryBytes,
    dispose: worker.dispose,
  };
}

export class NiimathError extends Error {
  constructor(message, { code, log }) {
    super(message);
    this.name = 'NiimathError';
    this.code = code;
    this.log = log;
  }
}

function exists(module, name) {
  try {
    module.FS_readFile(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs one niimath command line over in-memory files, with the file contract of
 * @neurodesk/node-drivers/niimath: a new module for each call, so no file or heap state stays from
 * one command to the next. argv is passed as given (callMain adds the program name).
 * @param {(config: object) => Promise<object>} createModule default export of niimath.js
 * @param {string[]} args niimath argv without the program name; file names are relative to `/`
 * @param {{ inputs?: Record<string, Uint8Array>, outputs?: string[] }} files
 * @param {{ wasm?: string }} [options] the URL of niimath.wasm, when it was moved
 * @returns {Promise<{ outputs: Record<string, Uint8Array>, log: string[] }>}
 */
export async function runNiimath(createModule, args, { inputs = {}, outputs = [] } = {}, { wasm } = {}) {
  const log = [];
  const module = await createModule({
    noInitialRun: true,
    thisProgram: 'niimath',
    print: (line) => log.push(line),
    printErr: (line) => log.push(line),
    ...(wasm ? { locateFile: (path, directory) => (path.endsWith('.wasm') ? String(wasm) : directory + path) } : {}),
  });
  for (const [name, bytes] of Object.entries(inputs)) {
    module.FS_createDataFile('/', name, bytes, true, true);
  }
  // Under Node (the tests), Emscripten records exit() in process.exitCode; keep the host's.
  const host = globalThis.process;
  const hostExitCode = host?.exitCode;
  let code;
  try {
    code = module.callMain([...args]);
  } catch (error) {
    if (typeof error?.status !== 'number') throw error;
    code = error.status;
  } finally {
    if (host) host.exitCode = hostExitCode;
  }
  if (code !== 0) {
    throw new NiimathError(`niimath ${args.join(' ')} exited with ${code}. ${log.join(' ')}`.trim(), { code, log });
  }
  const read = {};
  for (const name of outputs) {
    try {
      read[name] = module.FS_readFile(name);
    } catch {
      // niimath gzips NIfTI output unless told otherwise, so out.nii arrives as out.nii.gz.
      const hint = exists(module, `${name}.gz`) ? ` It wrote ${name}.gz; ask for that name.` : '';
      throw new NiimathError(`niimath ${args.join(' ')} wrote no ${name}.${hint} ${log.join(' ')}`.trim(), { code, log });
    }
  }
  return { outputs: read, log };
}

async function niimathFactory(entry) {
  if (!entry?.module) return createBundledNiimath;
  const { default: createModule } = await import(/* @vite-ignore */ String(entry.module));
  if (typeof createModule !== 'function') throw new Error('niimath did not load.');
  return createModule;
}

/** ONNX Runtime Web's wasm backend, set up from runtime.ort before the first session. */
export function configureOrt(entry = {}, ortModule = ort) {
  const paths = {};
  if (entry.wasm) paths.wasm = String(entry.wasm);
  if (entry.mjs) paths.mjs = String(entry.mjs);
  if (Object.keys(paths).length) ortModule.env.wasm.wasmPaths = paths;
  // Threads need a cross-origin isolated page; without it ONNX Runtime runs on one.
  ortModule.env.wasm.numThreads = entry.numThreads ?? Math.min(MAX_ORT_THREADS, getOptimalWasmThreads());
  return ortModule;
}

/**
 * The drivers runBison takes, for a module worker.
 * @param {{ runtime: object, onLog?: (line: string) => void, WorkerClass?: Function }} options
 *   runtime: the URLs of the staged runtime files (see the header); WorkerClass replaces Worker in tests
 */
export function createBrowserDrivers({ runtime, onLog, WorkerClass } = {}) {
  workerUrl(runtime, 'registration');
  workerUrl(runtime, 'denoise');
  let factory = null;
  return {
    // The registration log reaches onLog through run()'s result (preprocess.js), so it is not forwarded here.
    createRegistration: () => createRegistration({ runtime, WorkerClass }),
    createDenoiser: () => createDenoiser({ runtime, onLog, WorkerClass }),
    async niimath(args, files) {
      factory ??= niimathFactory(runtime.niimath).catch((error) => {
        factory = null;
        throw error;
      });
      return runNiimath(await factory, args, files, { wasm: runtime.niimath?.wasm });
    },
    ort: configureOrt(runtime.ort),
    sessionOptions: { executionProviders: ['wasm'] },
  };
}
