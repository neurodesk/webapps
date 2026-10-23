// The browser and Node wrapper of the shoreline WebAssembly modules (scripts/build-wasm.mjs):
// load the threaded module on cross-origin isolated pages and the single-threaded one
// elsewhere, then run the `shoreline` command line on files held in memory.

/** The most threads the app uses: the gain flattens beyond 8 (ds006676: 224 s on 1, 42 s on 8). */
export const MAX_THREADS = 8;

/** Bytes of WebAssembly memory the module can use. */
export const MEMORY_LIMIT = 4 * 1024 ** 3;

/**
 * The threads a run can use here: up to MAX_THREADS of the computer's, or 1 when the page is
 * not cross-origin isolated (threaded WebAssembly needs SharedArrayBuffer).
 */
export function threadCount({ isolated = globalThis.crossOriginIsolated === true, hardware = globalThis.navigator?.hardwareConcurrency } = {}) {
  if (!isolated || typeof SharedArrayBuffer === "undefined") return 1;
  return Math.max(1, Math.min(MAX_THREADS, Number.isInteger(hardware) ? hardware : 1));
}

/**
 * Peak bytes of a run on `voxels` voxels per volume and `volumes` volumes: about 13 bytes per
 * voxel and volume (1.56 GB natively for 112 × 112 × 72 × 141), plus the compressed input and
 * output that the session holds.
 */
export function estimateMemory({ voxels, volumes, inputBytes = 0 }) {
  return 13 * voxels * volumes + 2 * inputBytes + 64 * 1024 ** 2;
}

/** Whether a run of this size fits in the module's memory. */
export function fitsInMemory(size) {
  return estimateMemory(size) <= MEMORY_LIMIT;
}

/**
 * Loads a module: `threadsUrl` and `singleUrl` are the URLs of the two builds'
 * `shoreline_wasm.js`. Resolves to the module and the threads it runs on.
 */
export async function loadShoreline({ threadsUrl, singleUrl, threads = threadCount() }) {
  const threaded = threads > 1;
  const api = await import(/* @vite-ignore */ threaded ? threadsUrl : singleUrl);
  await api.default();
  if (threaded) await api.initThreadPool(threads);
  return { api, threads: threaded ? threads : 1 };
}

/**
 * Runs the command line with `args` (eddy-style options, the file names as given in
 * `files`). `files` maps names to bytes; the series named by `--imain` is consumed. Returns
 * the output files (names starting with the `--out` base), by name.
 */
export function runShoreline({ api, files, args, onLog = () => {} }) {
  const out = args.find((a) => a.startsWith("--out="))?.slice("--out=".length);
  if (!out) throw new Error("runShoreline needs an --out= argument.");
  const session = new api.Session();
  try {
    for (const [name, bytes] of Object.entries(files)) session.addFile(name, bytes);
    session.run(args, onLog);
    const outputs = {};
    for (const name of session.fileNames()) {
      if (name.startsWith(`${out}.`)) outputs[name] = session.takeFile(name);
    }
    return outputs;
  } finally {
    session.free();
  }
}
