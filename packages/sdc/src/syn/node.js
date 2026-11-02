// SPDX-License-Identifier: Apache-2.0
// The Node runtimes of the SyN-SDC pipeline (pipeline.js): hmc-registration kernels and the
// DenoiseImage and N4 kernels in worker threads, MindGrab's CPU modules through the shared
// driver, the committed field-fit module and zlib. An abort terminates every thread it started.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { readDenoiseWasm } from '@neurodesk/ants-denoise/node';
import { spawnRegistrationThread } from '@neurodesk/hmc/node';
import { readHmcRegistrationWasm } from '@neurodesk/hmc-registration/node';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { loadFieldFit } from '../field-fit.js';
import { correctSusceptibility, PRIOR_FILES } from './pipeline.js';
import { PRIOR_BASE_URL, PRIOR_NOTICES_SHA256, PRIOR_SHA256 } from './prior.js';

/** Runs one DenoiseImage or N4 call in a new worker thread; an abort terminates it. */
export function runTool(tool, image, { signal } = {}) {
  signal?.throwIfAborted();
  const thread = new Worker(new URL('./node-tool-worker.js', import.meta.url), { workerData: { tool, image } });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      thread.terminate().then(() => (error ? reject(error) : resolvePromise(value)));
    };
    const onAbort = () => settle(signal.reason ?? new DOMException(`${tool} cancelled.`, 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    thread.once('message', (bytes) => settle(null, new Uint8Array(bytes)));
    thread.once('error', (error) => settle(error));
    thread.once('exit', (code) => settle(new Error(`The ${tool} thread stopped (exit ${code}) before it finished.`)));
  });
}

/**
 * The runtime correctSusceptibility takes, in Node.
 * @param {{ workers?: number, spawn?: () => object }} [options] kernel threads (default 2)
 */
export async function nodeRuntime({ workers = 2, spawn = spawnRegistrationThread } = {}) {
  const fieldFit = await loadFieldFit(await readFile(new URL('../sdc-field-fit.wasm', import.meta.url)));
  let mindgrab = null;
  return {
    spawn,
    workers,
    fieldFit,
    gzip: (bytes) => gzipSync(bytes, { level: 6 }),
    denoise: (image, options) => runTool('denoise', image, options),
    n4: (image, options) => runTool('n4', image, options),
    async mindgrab(image, { signal } = {}) {
      mindgrab ??= await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
      const result = await mindgrab.segment(image, { model: 'mindgrab', mask: true, gzipOutput: true, signal });
      if (!result?.mask) throw new Error('MindGrab returned no brain mask.');
      return new Uint8Array(result.mask);
    },
  };
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The prior's directory: NEURODESK_SDC_MODEL_DIR (the portable release's bundled copy), else a cache
 * named after the pinned dataset commit, so a re-pinned prior never meets a stale copy.
 */
export function defaultPriorDirectory() {
  if (process.env.NEURODESK_SDC_MODEL_DIR) return resolve(process.env.NEURODESK_SDC_MODEL_DIR);
  const revision = PRIOR_BASE_URL.match(/resolve\/([0-9a-f]{40})\//)[1];
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'neurodesk', 'sdc', `prior-${revision.slice(0, 12)}`);
}

/**
 * Makes sure `directory` holds the pinned prior files and their notices, downloading each missing or
 * changed one unless `offline`. Returns the number of files verified.
 */
export async function downloadPrior({ directory = defaultPriorDirectory(), offline = process.env.NEURODESK_OFFLINE === '1', onProgress } = {}) {
  const pins = { ...PRIOR_SHA256, ...PRIOR_NOTICES_SHA256 };
  for (const [name, expected] of Object.entries(pins)) {
    const path = join(directory, name);
    const cached = await readFile(path).catch(() => null);
    if (cached && sha256(cached) === expected) continue;
    if (offline) throw new Error(`${name} is missing from the prior directory ${directory}, and downloads are off (NEURODESK_OFFLINE=1).`);
    onProgress?.(`Downloading ${name}`);
    const response = await fetch(new URL(name, PRIOR_BASE_URL));
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error(`${name}: the download does not match its pinned SHA-256.`);
    await mkdir(directory, { recursive: true });
    await writeFile(`${path}.partial`, bytes);
    await rename(`${path}.partial`, path);
  }
  return Object.keys(pins).length;
}

/**
 * Checks the installation without running a correction: the registration and DenoiseImage kernels
 * are the pinned builds, the field-fit and N4 modules and MindGrab's CPU modules load, and a
 * bundled prior (NEURODESK_SDC_MODEL_DIR) holds the pinned files.
 */
export async function checkInstallation() {
  await readHmcRegistrationWasm();
  await readDenoiseWasm();
  await loadFieldFit(await readFile(new URL('../sdc-field-fit.wasm', import.meta.url)));
  const { default: createN4Module } = await import('@neurodesk/n4/module');
  if (typeof createN4Module !== 'function') throw new Error('The N4 module did not load.');
  const mindgrab = await loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));
  if (!mindgrab.MODELS?.mindgrab) throw new Error('The MindGrab package does not list the mindgrab model.');
  const bundled = process.env.NEURODESK_SDC_MODEL_DIR;
  if (bundled) await readPrior(bundled);
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    sdc: version,
    mindgrab: mindgrab.version,
    prior: bundled ? resolve(bundled) : null,
  };
}

/** Reads the prior files from a directory and checks each against its pinned SHA-256. */
export async function readPrior(directory) {
  const prior = {};
  for (const name of Object.values(PRIOR_FILES)) {
    const bytes = new Uint8Array(await readFile(join(directory, name)));
    if (sha256(bytes) !== PRIOR_SHA256[name]) throw new Error(`${name} in ${directory} is not the pinned prior file.`);
    prior[name] = bytes;
  }
  return prior;
}

/**
 * Corrects one DWI series from files and writes the BIDS derivatives into a new or empty
 * directory. `prior` is a directory holding PRIOR_FILES, or null for "no prior".
 */
export async function correctFiles({ dwi, bval, bvec, json = null, t1w, epiMask = null, t1wMask = null, prior, output, phaseEncodingDirection, totalReadoutTime, seed, workers, signal, onProgress, runtime } = {}) {
  if (!dwi || !bval || !bvec || !t1w || !output) throw new Error('A DWI series with its bval and bvec, a T1w and an output directory are required.');
  if (prior === undefined) throw new Error('Give a prior directory, or prior: null for "no prior".');
  const destination = resolve(output);
  try {
    if ((await readdir(destination)).length) throw new Error(`Output directory ${destination} is not empty.`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const read = async (path) => (path ? new Uint8Array(await readFile(path)) : null);
  const result = await correctSusceptibility({
    dwi: await read(dwi),
    bval: await readFile(bval, 'utf8'),
    bvec: await readFile(bvec, 'utf8'),
    sidecar: json ? JSON.parse(await readFile(json, 'utf8')) : null,
    fileName: basename(dwi),
    t1w: await read(t1w),
    epiMask: await read(epiMask),
    t1wMask: await read(t1wMask),
    prior: prior ? await readPrior(prior) : null,
    phaseEncodingDirection,
    totalReadoutTime,
    seed,
    runtime: runtime ?? (await nodeRuntime({ workers })),
    signal,
    onProgress,
  });
  await mkdir(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(result.files)) await writeFile(join(destination, name), bytes, { flag: 'wx' });
  return { ...result, output: destination };
}
