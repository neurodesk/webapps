// fastprep in the browser: the Rust core (WASM) decides every step; this host owns the files and runs each step on
// its tool driver, one at a time, which keeps peak memory to one tool's working set.

import initCore, { runFastprep as runCore } from '../wasm/fastprep/fastprep_wasm.js';
import initGlm, * as glmWasm from '../wasm/glm/glm_wasm.js';
import { drivers as makeDrivers } from './drivers.js';
import { Files } from './files.js';

/** float32 BOLD ceiling for in-browser runs (all echoes of a run), checked from headers before processing. */
const MAX_BOLD_BYTES = 1e9;

/** The JS side of the core's Host trait. */
function createHost(files, tools, { onLog = () => {}, onStep = () => {} } = {}) {
  return {
    async run(argv, fslOut) {
      const tool = tools[argv[0]];
      if (!tool) return { code: 127, stdout: '', stderr: `${argv[0]} is not available in the browser` };
      onStep(argv);
      try {
        return await tool(argv, { files, fslOut });
      } catch (e) {
        return { code: 1, stdout: '', stderr: e?.message ?? String(e) };
      }
    },
    readRange: (path, offset, len) => files.range(path, offset, len),
    async readText(path, limit) {
      if (files.size(path) > limit) throw new Error(`${path}: larger than ${limit} bytes`);
      return files.text(path);
    },
    async write(path, bytes) {
      files.put(path, bytes.slice());
    },
    async append(path, bytes) {
      const old = files.has(path) ? await files.bytes(path) : new Uint8Array();
      const next = new Uint8Array(old.length + bytes.length);
      next.set(old);
      next.set(bytes, old.length);
      files.put(path, next);
    },
    exists: (path) => files.has(path),
    stat: (path) => files.stat(path),
    list: (dir) => files.list(dir),
    mkdirs() {},
    remove: (path) => files.remove(path),
    rename: (from, to) => files.rename(from, to),
    copy: (from, to) => files.copy(from, to),
    now: () => Date.now() / 1000,
    localTime() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },
    log: onLog,
  };
}

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
