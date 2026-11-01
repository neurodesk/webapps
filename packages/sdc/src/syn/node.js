// SPDX-License-Identifier: Apache-2.0
// The Node runtimes of the SyN-SDC pipeline (pipeline.js): hmc-registration kernels and the
// DenoiseImage and N4 kernels in worker threads, MindGrab's CPU modules through the shared
// driver, the committed field-fit module and zlib. An abort terminates every thread it started.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { spawnRegistrationThread } from '@neurodesk/hmc/node';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { loadFieldFit } from '../field-fit.js';
import { correctSusceptibility, PRIOR_FILES } from './pipeline.js';
import { PRIOR_SHA256 } from './prior.js';

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

/** Reads the prior files from a directory and checks each against its pinned SHA-256. */
export async function readPrior(directory) {
  const prior = {};
  for (const name of Object.values(PRIOR_FILES)) {
    const bytes = new Uint8Array(await readFile(join(directory, name)));
    if (createHash('sha256').update(bytes).digest('hex') !== PRIOR_SHA256[name]) throw new Error(`${name} in ${directory} is not the pinned prior file.`);
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
