/**
 * The browser's niimath runner for the shared tensor fit in @neurodesk/dwi2trx: the
 * locally-built dtifit-enabled niimath WASM (vendor/niimath), one cached module.
 *
 * `--dtifit` is a CLI mode (multi-input, multi-output), not a chainable operator, so the module
 * is driven directly: stage files into the Emscripten FS, callMain, read outputs, unlink.
 */

import type { NiimathModule } from '@niivue/niimath/niimath.js'

let modulePromise: Promise<NiimathModule> | null = null

async function getModule(): Promise<NiimathModule> {
  // Reset the cache on failure so a later fit can retry — otherwise a one-off
  // load error (network/WASM hiccup) would be cached and poison the session.
  modulePromise ??= import('@niivue/niimath/niimath.js')
    .then((m) => m.default())
    .catch((err) => {
      modulePromise = null
      throw err
    })
  return modulePromise
}

let inFlight = false

/**
 * Runs one niimath argv over in-memory files. Serialized: the module is a single shared FS, so
 * concurrent calls would collide; callers should also disable the trigger UI while a fit runs.
 */
export async function runNiimath(
  args: string[],
  { inputs = {}, outputs = [] }: { inputs?: Record<string, Uint8Array>; outputs?: string[] },
): Promise<{ outputs: Record<string, Uint8Array> }> {
  if (inFlight) throw new Error('niimath is busy.')
  inFlight = true
  try {
    const mod = await getModule()
    try {
      for (const [name, data] of Object.entries(inputs)) mod.FS_createDataFile('.', name, data, true, true)
      let code: number
      try {
        code = mod.callMain(args)
      } catch (err) {
        // A THROW from callMain (as opposed to a non-zero return) means the WASM aborted, e.g.
        // a "memory access out of bounds" on an oversized volume. The module is dead: drop it so
        // the next call reinstantiates instead of failing with a confusing second error.
        modulePromise = null
        throw err
      }
      if (code !== 0) throw new Error(`niimath ${args[0]} failed (exit ${code}).`)
      return { outputs: Object.fromEntries(outputs.map((name) => [name, mod.FS_readFile(name)])) }
    } finally {
      for (const name of [...Object.keys(inputs), ...outputs]) {
        try {
          mod.FS_unlink(name)
        } catch {
          // an output a failed run never wrote
        }
      }
    }
  } finally {
    inFlight = false
  }
}
