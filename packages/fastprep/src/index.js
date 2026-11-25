// fastprep in the browser: the Rust core (WASM) decides every step; this host owns the files and runs each step on
// its tool driver, one at a time, which keeps peak memory to one tool's working set.

import initCore, { runFastprep as runCore } from '../wasm/fastprep/fastprep_wasm.js';
import initGlm, * as glmWasm from '../wasm/glm/glm_wasm.js';
import { Files } from '@neurodesk/pipeline-drivers/files';
import { createHost } from '@neurodesk/pipeline-drivers/host';
import { drivers as makeDrivers } from './drivers.js';

/** float32 BOLD ceiling for in-browser runs (all echoes of a run), checked from headers before processing. */
const MAX_BOLD_BYTES = 1e9;

let ready;

/**
 * Run fastprep on one BIDS dataset held in memory.
 *
 * @param {object} args
 * @param {Iterable<[string, Blob|Uint8Array]>} args.dataset relative path -> file, rooted at the BIDS directory
 * @param {Iterable<[string, Blob|Uint8Array]>} args.templates relative path -> file, rooted at the templates directory
 * @param {object} args.runtimes `{niimath, mindgrab, mindgrabOptions, greedy, synthsr, meica, sdc}` (see drivers.js; `meica`:
 *   the module `loadMeica` returns, needed for ME-ICA; `sdc`: the module `loadSdc` returns or a lazy loader, needed for PEPOLAR) and
 *   optional `wasm: {core, glm}` init inputs (URLs or bytes) for the fastprep and glm modules
 * @param {object} [args.options] core options: labels, synthsr, frisgo, robustfov, t1w, omp, nprocs
 * @returns {Promise<Files>} all files; derivatives under /out, commands.sh under /work
 */
export async function runFastprep({ dataset, templates, runtimes, options = {}, onLog, onStep }) {
  ready ??= Promise.all([initCore(runtimes.wasm?.core), initGlm(runtimes.wasm?.glm)]);
  await ready;
  const files = new Files();
  for (const [rel, data] of dataset) files.put(`/bids/${rel}`, data);
  for (const [rel, data] of templates) files.put(`/templates/${rel}`, data);
  const host = createHost(files, makeDrivers({ ...runtimes, glm: glmWasm }), { onLog, onStep });
  await runCore(host, {
    bids: '/bids', out: '/out', work: '/work', templates: '/templates', surfaces: false,
    maxBoldBytes: MAX_BOLD_BYTES, omp: 1, ...options,
  });
  return files;
}
