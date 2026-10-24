// One registration kernel (@neurodesk/hmc-registration) or one denoiser (@neurodesk/ants-denoise),
// isolated in its own worker thread (node-workers.js). Emscripten memories grow and never shrink;
// ending the thread frees the instance's heap at once.

import { parentPort, workerData } from 'node:worker_threads';

const { kind, module, wasm, forwardLog } = workerData;
const onLog = forwardLog ? (line) => parentPort.postMessage({ type: 'log', line: String(line) }) : undefined;
const locations = {
  ...(module ? { module: new URL(module) } : {}),
  ...(wasm ? { wasm: new URL(wasm) } : {}),
};

// Error properties that callers read: name, message, the run's log and the abort flag.
function serialise(error) {
  const plain = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack };
  if (error && Object.hasOwn(error, 'log')) plain.log = error.log;
  if (error && Object.hasOwn(error, 'aborted')) plain.aborted = error.aborted;
  if (error?.cause !== undefined) plain.cause = { name: error.cause?.name ?? 'Error', message: error.cause?.message ?? String(error.cause) };
  return plain;
}

// The reason the instance stopped, or null when it still accepts work. Each package words its
// later refusal with this reason: hmc-registration flags the error, ants-denoise names the abort.
function stoppedBy(error) {
  const aborted = kind === 'registration' ? error?.aborted === true : error?.cause !== undefined && /DenoiseImage aborted/.test(error?.message ?? '');
  if (!aborted) return null;
  return error.cause instanceof Error ? error.cause.message : String(error.cause);
}

// Typed arrays the worker made (FS.readFile copies) go back without a copy.
function transferable(bytes, list) {
  if (!(bytes instanceof Uint8Array)) return bytes;
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  list.push(own.buffer);
  return own;
}

let instance;
try {
  if (kind === 'registration') {
    const { loadHmcRegistration } = await import('@neurodesk/hmc-registration/node');
    instance = await loadHmcRegistration({ ...locations, onLog });
  } else if (kind === 'denoiser') {
    const { loadDenoise } = await import('@neurodesk/ants-denoise/node');
    instance = await loadDenoise({ ...locations, onLog });
  } else {
    throw new Error(`Unknown worker kind ${kind}.`);
  }
  parentPort.postMessage({ type: 'ready', heapBytes: instance.memoryBytes() });
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: serialise(error) });
}

if (instance) {
  parentPort.on('message', async ({ id, method, args }) => {
    try {
      let result;
      const transfer = [];
      if (kind === 'registration' && method === 'run') {
        const { outputs, log } = instance.run(...args);
        const moved = {};
        for (const [name, bytes] of Object.entries(outputs)) moved[name] = transferable(bytes, transfer);
        result = { outputs: moved, log };
      } else if (kind === 'denoiser' && method === 'denoise') {
        result = transferable(await instance.denoise(...args), transfer);
      } else {
        throw new Error(`Unknown method ${method}.`);
      }
      parentPort.postMessage({ type: 'result', id, result, heapBytes: instance.memoryBytes() }, transfer);
    } catch (error) {
      parentPort.postMessage({ type: 'error', id, error: serialise(error), stopped: stoppedBy(error), heapBytes: instance.memoryBytes() });
    }
  });
}
