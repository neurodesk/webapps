// BISON's Node drivers for antsRegistration, DenoiseImage and Greedy with each instance in its own
// worker thread, as @neurodesk/node-drivers/mindgrab runs MindGrab. WebAssembly memories grow and
// never shrink, so an instance that stays in the main thread holds its largest heap until the
// process ends; dispose() ends the thread and frees it at once.
//
//   createRegistration() -> { run(argv, inputs), memoryBytes(), dispose() }   (run is async here)
//   createDenoiser()     -> { denoise({ image, mask, ... }), memoryBytes(), dispose() }
//   createGreedy()       -> { affine({ fixed, moving }), rigid({ fixed, moving }), svf({ fixed, moving, matrix, mask }), memoryBytes(), dispose() }
//
// Errors keep their name, message, `log` and `aborted`. After an abort the worker is ended and the
// instance refuses further work with the package's own message. Inputs are copied (callers reuse
// them); outputs come back without a copy.

import { Worker } from 'node:worker_threads';

const ENTRY = new URL('./node-worker.js', import.meta.url);

const LABELS = { registration: 'registration kernel', denoiser: 'denoise module', greedy: 'Greedy module' };

function rebuild(plain) {
  const Type = { TypeError, RangeError }[plain.name] ?? Error;
  const error = plain.cause ? new Type(plain.message, { cause: Object.assign(new Error(plain.cause.message), { name: plain.cause.name }) }) : new Type(plain.message);
  if (plain.name !== error.name) error.name = plain.name;
  if (Object.hasOwn(plain, 'log')) error.log = plain.log;
  if (Object.hasOwn(plain, 'aborted')) error.aborted = plain.aborted;
  if (plain.stack) error.stack = `${plain.stack}\n    at (worker thread)`;
  return error;
}

// The refusal each package gives after an abort (hmc-registration index.js, ants-denoise index.js).
function refusal(kind, reason) {
  if (kind === 'greedy') return new Error(`The Greedy module stopped (${reason}); create a new one.`);
  if (kind === 'registration') return Object.assign(new Error(`The registration kernel stopped (${reason}); load a new one.`), { log: [], aborted: true });
  return new Error(`The denoise module aborted earlier (${reason}). Create a new denoiser.`);
}

// Copies of the input bytes, each with its own buffer, so they can be transferred.
function copied(bytes, transfer) {
  if (!(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) return bytes;
  // new Uint8Array(arrayBuffer) is a view, so an ArrayBuffer is sliced to copy it.
  const copy = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : new Uint8Array(bytes);
  transfer.push(copy.buffer);
  return copy;
}

async function start(kind, { onLog, module, wasm } = {}) {
  const worker = new Worker(ENTRY, {
    workerData: { kind, module: module?.toString(), wasm: wasm?.toString(), forwardLog: typeof onLog === 'function' },
  });
  const pending = new Map();
  let next = 0;
  let heapBytes = null;
  let runs = 0;
  let stopped = null;
  let disposed = null;

  const fail = (reason) => {
    for (const { reject } of pending.values()) reject(reason);
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      if (message.type === 'log') {
        onLog?.(message.line);
        return;
      }
      if (message.heapBytes !== undefined && message.heapBytes !== null) heapBytes = message.heapBytes;
      if (message.type === 'ready') resolve();
      else if (message.type === 'failed') reject(rebuild(message.error));
      else {
        const call = pending.get(message.id);
        pending.delete(message.id);
        if (!pending.size) worker.unref();
        if (message.type === 'result') call?.resolve(message.result);
        else {
          if (message.stopped !== null) {
            stopped = message.stopped;
            worker.terminate();
          }
          call?.reject(rebuild(message.error));
        }
      }
    });
    worker.on('error', (error) => {
      stopped ??= error?.message ?? String(error);
      const lost = Object.assign(new Error(`The ${LABELS[kind]} worker failed (${stopped}).`, { cause: error }), { log: [], aborted: true });
      reject(lost);
      fail(lost);
    });
    worker.on('exit', (code) => {
      if (disposed) return;
      stopped ??= `worker exited with code ${code}`;
      const lost = Object.assign(new Error(`The ${LABELS[kind]} worker exited (code ${code}).`), { log: [], aborted: true });
      reject(lost);
      fail(lost);
    });
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  worker.unref();

  function call(method, args, transfer) {
    if (disposed) return Promise.reject(Object.assign(new Error(`The ${LABELS[kind]} worker was disposed.`), { log: [], aborted: true }));
    if (stopped) return Promise.reject(refusal(kind, stopped));
    const id = next++;
    runs++;
    worker.ref();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args }, transfer);
    });
  }

  return {
    call,
    /** The wasm heap after the last call (bytes); it never shrinks, so this is the instance's peak. */
    memoryBytes: () => heapBytes,
    /** Ends the worker and frees its heap; returns the heap it reached and the number of calls. */
    async dispose() {
      if (!disposed) {
        disposed = { heapBytes, runs };
        fail(Object.assign(new Error(`The ${LABELS[kind]} worker was disposed.`), { log: [], aborted: true }));
        await worker.terminate();
      }
      return disposed;
    },
  };
}

/**
 * antsRegistration (@neurodesk/hmc-registration) in a worker thread. run(argv, inputs) resolves
 * to { outputs, log } and rejects with the kernel's error (log, aborted).
 * @param {{ onLog?: (line: string) => void, module?: string|URL, wasm?: string|URL }} [options]
 */
export async function createRegistration(options) {
  const worker = await start('registration', options);
  return {
    run(argv, inputs = {}) {
      const transfer = [];
      const copies = {};
      for (const [name, bytes] of Object.entries(inputs ?? {})) copies[name] = copied(bytes, transfer);
      return worker.call('run', [argv, copies], transfer);
    },
    memoryBytes: worker.memoryBytes,
    dispose: worker.dispose,
  };
}

/**
 * ANTs DenoiseImage (@neurodesk/ants-denoise) in a worker thread; denoise() takes the package's
 * options and resolves to float32 NIfTI bytes.
 * @param {{ onLog?: (line: string) => void, module?: string|URL, wasm?: string|URL }} [options]
 */
export async function createDenoiser(options) {
  const worker = await start('denoiser', options);
  return {
    denoise(settings = {}) {
      const transfer = [];
      const message = { ...settings, image: copied(settings.image, transfer) };
      if (settings.mask) message.mask = copied(settings.mask, transfer);
      return worker.call('denoise', [message], transfer);
    },
    memoryBytes: worker.memoryBytes,
    dispose: worker.dispose,
  };
}

/**
 * Greedy's single-threaded WebAssembly (@neurodesk/greedy/single) in a worker thread: affine() and
 * rigid() take raw .nii bytes and resolve to Greedy's RAS matrix text; svf() takes
 * registerSvfGreedy's arguments and resolves to the raw .nii warp.
 */
export async function createGreedy() {
  const worker = await start('greedy');
  const register = (method) => (args) => {
    const transfer = [];
    const copies = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, copied(value, transfer)]));
    return worker.call(method, [copies], transfer);
  };
  return { affine: register('affine'), rigid: register('rigid'), svf: register('svf'), memoryBytes: worker.memoryBytes, dispose: worker.dispose };
}
