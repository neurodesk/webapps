// The browser's niimath runner for tensor.js: one cached module of the dtifit-enabled
// @niivue/niimath build this package pins. The DWI2TRX and NODDI tensor workers
// use it. It also runs under Node, but the command line uses runNiimath from
// @neurodesk/node-drivers/niimath, which makes a new module for each call.
//
// `--dtifit` is a CLI mode (more than one input and output), not a chainable operator, so the
// module is driven directly: stage files into the Emscripten FS, callMain, read outputs, unlink.

let modulePromise = null;

function getModule() {
  // Reset the cache on failure so a later fit can retry: a one-off load error (network or WASM)
  // must not stay in the cache for the remainder of the session.
  modulePromise ??= import('@niivue/niimath/niimath.js')
    .then((m) => m.default())
    .catch((error) => {
      modulePromise = null;
      throw error;
    });
  return modulePromise;
}

let inFlight = false;

/**
 * Runs one niimath argv over in-memory files. Serialized: the module has one shared FS, so
 * concurrent calls would collide. Callers also disable the trigger UI while a fit runs.
 * @param {string[]} args niimath argv without the program name
 * @param {{ inputs?: Record<string, Uint8Array>, outputs?: string[] }} files
 * @returns {Promise<{ outputs: Record<string, Uint8Array> }>}
 */
export async function runNiimath(args, { inputs = {}, outputs = [] } = {}) {
  if (inFlight) throw new Error('niimath is busy.');
  inFlight = true;
  try {
    const mod = await getModule();
    try {
      for (const [name, data] of Object.entries(inputs)) mod.FS_createDataFile('.', name, data, true, true);
      let code;
      try {
        code = mod.callMain(args);
      } catch (error) {
        // A throw from callMain (not a non-zero return) means the WASM aborted, for example
        // "memory access out of bounds" on an oversized volume. The module is dead: drop it so
        // the next call makes a new one instead of failing with a confusing second error.
        modulePromise = null;
        throw error;
      }
      if (code !== 0) throw new Error(`niimath ${args[0]} failed (exit ${code}).`);
      return { outputs: Object.fromEntries(outputs.map((name) => [name, mod.FS_readFile(name)])) };
    } finally {
      for (const name of [...Object.keys(inputs), ...outputs]) {
        try {
          mod.FS_unlink(name);
        } catch {
          // an output that a failed run did not write
        }
      }
    }
  } finally {
    inFlight = false;
  }
}
