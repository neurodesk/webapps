// The noddi command line: the web app's fit (same noddi.wasm, chunks and output names) on Node,
// with worker threads in place of Web Workers and MindGrab's CPU modules for the brain mask.
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { parseBvalBvec } from '@neurodesk/dwi2trx/gradients';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { createNiftiFromData, decodeNiftiBuffer, isValidNifti1, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { fitVolume } from './fit-pool.js';
import { bidsStem, maskIndices, meanVolumes, outputEntries } from './pipeline.js';
import { multiShellPhantom, phantomTissue } from './phantom.js';
import { loadNoddi } from './wasm.js';

const MINDGRAB_PACKAGE = import.meta.resolve('@brainchop/mindgrab/package.json');
export const MINDGRAB_VERSION = JSON.parse(await readFile(new URL(MINDGRAB_PACKAGE), 'utf8')).version;
const WASM = new URL('./noddi.wasm', import.meta.url);

/** The web app's MindGrab call on the mean b0 (runtime-support's brainMask), here on the CPU. */
export const MASK_OPTIONS = Object.freeze({ model: 'mindgrab', mask: true, gzipOutput: false });

const binary = (data) => Uint8Array.from(data, (value) => (value > 0 ? 1 : 0));

// Wraps a worker thread in the Web Worker interface the shared pool drives.
function spawnThread() {
  const thread = new Worker(new URL('./node-worker.js', import.meta.url));
  const worker = {
    postMessage: (message, transfer) => thread.postMessage(message, transfer),
    terminate: () => thread.terminate(),
    onmessage: null,
    onerror: null,
  };
  thread.on('message', (data) => worker.onmessage?.({ data }));
  thread.on('error', (error) => worker.onerror?.({ message: error.message }));
  return worker;
}

/** Worker threads to fit with: one per core unless `threads` says otherwise. */
export function threadCount(threads) {
  if (threads === undefined) return availableParallelism();
  if (!Number.isInteger(threads) || threads < 1) throw new Error('--threads must be a positive whole number.');
  return threads;
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

// Each file appears under its name complete, and never replaces one a concurrent run wrote there:
// link() fails when the name exists.
async function publish(path, bytes) {
  const partial = join(dirname(path), `.${randomUUID().slice(0, 8)}.partial`);
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await link(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function readNifti(path, role) {
  const buffer = await decodeNiftiBuffer(new Uint8Array(await readFile(path)));
  if (!isValidNifti1(buffer)) throw new Error(`The ${role} ${path} is not NIfTI-1. Convert DICOM with dcm2niix first.`);
  return buffer;
}

/** Reads a DWI and its gradients as the web app does, and applies the gradient table's rules. */
export async function readDwi({ dwi, bval, bvec, api }) {
  const buffer = await readNifti(dwi, 'diffusion image');
  const { bvals, bvecs } = parseBvalBvec(await readFile(bval, 'utf8'), await readFile(bvec, 'utf8'));
  const frames = readNiftiFrames(buffer);
  const name = basename(dwi);
  if (frames.frames !== bvals.length) throw new Error(`${name} has ${frames.frames} volumes but the gradient files list ${bvals.length}.`);
  const table = api.describe(bvals, bvecs);
  if (table.dtiError) throw new Error(table.dtiError);
  const voxels = frames.dims[0] * frames.dims[1] * frames.dims[2];
  return { name, buffer, dims: frames.dims, data: frames.data, voxels, bvals, bvecs, table, meanB0: meanVolumes(frames.data, voxels, table.b0) };
}

/** A brain mask file on the DWI grid, as the web app's mask input reads it. */
async function readMask(path, input) {
  const buffer = await readNifti(path, 'brain mask');
  if (!sameNiftiGrid(buffer, input.buffer)) throw new Error(`${basename(path)} is not on the DWI grid.`);
  const volume = readNiftiFrames(buffer);
  if (volume.frames !== 1) throw new Error('The brain mask must be a single 3D image.');
  return binary(volume.data);
}

/** MindGrab's brain mask of the mean b0, as the web app computes it, on MindGrab's CPU modules. */
async function mindgrabMask(input) {
  const meanB0 = createNiftiFromData(input.meanB0, input.buffer, { dims: input.dims });
  const mindgrab = await loadMindgrabCpu(MINDGRAB_PACKAGE);
  let result;
  try {
    result = await mindgrab.segment(new Uint8Array(meanB0), MASK_OPTIONS);
  } catch (error) {
    throw new Error(`MindGrab could not mask the mean b0 (${error.message}). Give --mask FILE or --no-mask.`);
  }
  if (!result?.mask) throw new Error('MindGrab did not return a brain mask. Give --mask FILE or --no-mask.');
  return { mask: binary(readNiftiFrames(result.mask).data), backend: result.backend, elapsedMs: Math.round(result.elapsedMs) };
}

/**
 * Fits the diffusion tensor and, with two or more shells, NODDI (AMICO), and writes the web app's
 * downloads to `output`: one BIDS dwimap per map and the brain mask the fit used. The mask is
 * MindGrab's of the mean b0 unless `maskFile` gives one on the DWI grid or `noMask` fits every
 * voxel.
 * @param options.noddi false for the tensor maps only
 * @param options.tensorFit "wls" (default) or "ols"
 * @param options.threads worker threads, default one per core
 */
export async function fit({ dwi, bval, bvec, output, maskFile, noMask = false, noddi = true, tensorFit = 'wls', threads, onProgress = () => {} } = {}) {
  if (!dwi || !bval || !bvec || !output) throw new Error('A diffusion image, its bval and bvec files and an output directory are required.');
  if (maskFile !== undefined && noMask) throw new Error('Give a mask file or no mask, not both.');
  if (!['wls', 'ols'].includes(tensorFit)) throw new Error('--tensor-fit is wls or ols.');
  const workers = threadCount(threads);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const api = await loadNoddi(await readFile(WASM));
  const input = await readDwi({ dwi, bval, bvec, api });
  const shells = input.table.shells.map((b, i) => `${input.table.shellCounts[i]}×b${b}`).join(', ');
  onProgress(`${input.name}: ${input.table.b0.length}×b0, ${shells}`);
  const withNoddi = noddi && !input.table.noddiError;
  if (noddi && input.table.noddiError) onProgress(`${input.table.noddiError} Fitting the tensor only.`);

  let brain;
  let mask;
  if (maskFile !== undefined) {
    brain = await readMask(maskFile, input);
    mask = 'supplied';
  } else if (noMask) {
    brain = new Uint8Array(input.voxels).fill(1);
    mask = 'none';
  } else {
    onProgress(`Extracting the brain from the mean b0 with MindGrab ${MINDGRAB_VERSION} (CPU)`);
    const extracted = await mindgrabMask(input);
    brain = extracted.mask;
    mask = `mindgrab-${MINDGRAB_VERSION}-${extracted.backend}`;
    onProgress(`MindGrab brain mask in ${(extracted.elapsedMs / 1000).toFixed(0)} s`);
  }
  const indices = maskIndices(brain);
  if (!indices.length) throw new Error('The brain mask has no voxels. Supply a mask, or check the b0 volumes.');

  onProgress(`Fitting ${withNoddi ? 'tensor and NODDI' : 'tensor'} to ${indices.length} voxels on ${workers} thread${workers === 1 ? '' : 's'}`);
  const started = performance.now();
  let reported = 0;
  const maps = await fitVolume({
    data: input.data,
    voxels: input.voxels,
    volumes: input.bvals.length,
    indices,
    bvals: input.bvals,
    bvecs: input.bvecs,
    weighted: tensorFit === 'wls',
    noddi: withNoddi,
    spawn: spawnThread,
    workers,
    onProgress: (fraction) => {
      const percent = Math.floor(fraction * 10) * 10;
      if (percent > reported) onProgress(`${(reported = percent)}%`);
    },
  });
  const seconds = Math.round((performance.now() - started) / 100) / 10;

  const entries = outputEntries(maps, brain, bidsStem(input.name));
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const nifti = createNiftiFromData(entry.data, input.buffer, { dims: [...input.dims, entry.frames] });
    await publish(join(destination, entry.name), gzipSync(new Uint8Array(nifti)));
  }
  return {
    output: destination,
    files: entries.map((entry) => entry.name),
    provenance: {
      app: `noddi command line ${packageJson.version}`,
      method: withNoddi ? 'dti+noddi-amico' : 'dti',
      tensorFit,
      maskVoxels: indices.length,
      mask,
      noddiRefused: noddi && input.table.noddiError ? input.table.noddiError : null,
      threads: workers,
      fitSeconds: seconds,
    },
  };
}

/**
 * Fits the noiseless phantom (8^3 grid) in this runtime on two worker threads and checks the
 * known tissue: the tensor and NODDI directions along each voxel's fibre, ICVF within 0.15 (AMICO
 * reads about 0.1 high on this phantom) and ODI below 0.1 (no dispersion).
 */
export async function checkInstallation() {
  const size = 8;
  const phantom = multiShellPhantom({ size, noise: 0 });
  const api = await loadNoddi(await readFile(WASM));
  const { bvals, bvecs } = parseBvalBvec(phantom.bval, phantom.bvec);
  const frames = readNiftiFrames(phantom.nifti.buffer);
  const indices = Uint32Array.from(phantom.inside);
  const maps = await fitVolume({ data: frames.data, voxels: phantom.voxels, volumes: bvals.length, indices, bvals, bvecs, weighted: true, noddi: !api.describe(bvals, bvecs).noddiError, spawn: spawnThread, workers: 2 });
  if (!maps.noddi) throw new Error('NODDI refused the two-shell phantom.');
  let worstDirection = 1;
  let worstIcvf = 0;
  let worstOdi = 0;
  for (const voxel of phantom.inside) {
    const x = voxel % size;
    const y = Math.floor(voxel / size) % size;
    const z = Math.floor(voxel / size ** 2);
    const truth = phantomTissue(x, y, z, size);
    const [dx, dy, dz] = truth.direction;
    const tensor = Math.abs(maps.tensor.V1x[voxel] * dx + maps.tensor.V1y[voxel] * dy + maps.tensor.V1z[voxel] * dz);
    const noddiDirection = Math.abs(maps.noddi.dirx[voxel] * dx + maps.noddi.diry[voxel] * dy + maps.noddi.dirz[voxel] * dz);
    worstDirection = Math.min(worstDirection, tensor, noddiDirection);
    worstIcvf = Math.max(worstIcvf, Math.abs(maps.noddi.ICVF[voxel] - truth.icvf));
    worstOdi = Math.max(worstOdi, maps.noddi.OD[voxel]);
  }
  if (!(worstDirection > 0.95 && worstIcvf < 0.15 && worstOdi < 0.1)) {
    throw new Error(`The phantom fit failed its check: worst direction cosine ${worstDirection.toFixed(4)} (needs > 0.95), worst ICVF error ${worstIcvf.toFixed(4)} (needs < 0.15), largest ODI ${worstOdi.toFixed(4)} (needs < 0.1).`);
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    noddi: packageJson.version,
    mindgrab: MINDGRAB_VERSION,
    phantomDirectionCosine: Number(worstDirection.toFixed(4)),
    phantomIcvfError: Number(worstIcvf.toFixed(4)),
    phantomOdi: Number(worstOdi.toFixed(4)),
  };
}
