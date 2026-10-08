import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { decodeNiftiBuffer, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import { loadMindgrabCpu } from '@neurodesk/runtime-support/node/mindgrab';
import { runNiimath } from '@neurodesk/runtime-support/node/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import packageJson from '../package.json' with { type: 'json' };
import { countDirections } from './gradients.js';
import { MASK_OPTIONS, TENSOR_MAPS, extractB0, fitTensor, mapFileName } from './tensor.js';

const MINDGRAB_PACKAGE = import.meta.resolve('@brainchop/mindgrab/package.json');
const readVersion = async (url) => JSON.parse(await readFile(new URL(url), 'utf8')).version;
export const NIIMATH_VERSION = await readVersion(new URL('../package.json', import.meta.resolve('@niivue/niimath')));
export const MINDGRAB_VERSION = await readVersion(MINDGRAB_PACKAGE);

const run = (args, files) => runNiimath(createNiimath, args, files);

// NIfTI-1 and NIfTI-2 begin with their header size, 348 or 540, in the file's byte order.
function isNifti(buffer) {
  if (buffer.byteLength < 348) return false;
  const view = new DataView(buffer, 0, 4);
  return [348, 540].some((size) => view.getInt32(0, true) === size || view.getInt32(0, false) === size);
}

async function readNifti(path, role) {
  const bytes = new Uint8Array(await readFile(path));
  const decoded = await decodeNiftiBuffer(bytes);
  if (!isNifti(decoded)) throw new Error(`The ${role} ${path} is not NIfTI. Convert DICOM with dcm2niix first.`);
  return { bytes, header: parseNiftiHeader(decoded) };
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

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * The web app's brain mask: MindGrab on the first b0 volume, here on MindGrab's CPU modules. Like
 * the app, a failed mask leaves the fit unmasked and says why.
 */
async function mindgrabMask(dwi, bvalText, onProgress) {
  onProgress('Brain extraction (MindGrab, CPU)');
  try {
    const b0 = await extractB0(run, { dwi, bvalText });
    const mindgrab = await loadMindgrabCpu(MINDGRAB_PACKAGE);
    const result = await mindgrab.segment(b0, MASK_OPTIONS);
    const provenance = { model: MASK_OPTIONS.model, version: MINDGRAB_VERSION, backend: result.backend, elapsedMs: Math.round(result.elapsedMs) };
    if (!result.mask) return { failure: 'MindGrab returned no brain mask', provenance };
    return { mask: new Uint8Array(result.mask), provenance };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error), provenance: null };
  }
}

/**
 * Fits the diffusion tensor and writes every dtifit map under the web app's download names,
 * <dwi>_FA.nii.gz and so on. The brain mask is MindGrab's, as in the web app, unless `maskFile`
 * gives one on the DWI grid or `noMask` fits every voxel. A MindGrab mask is written as
 * <dwi>_mask.nii.gz.
 */
export async function fit({ dwi, bval, bvec, output, maskFile, noMask = false, onProgress = () => {} } = {}) {
  if (!dwi || !bval || !bvec || !output) throw new Error('A diffusion image, its bval and bvec files and an output directory are required.');
  if (maskFile !== undefined && noMask) throw new Error('Give a mask file or no mask, not both.');
  const destination = resolve(output);
  await assertNewOutput(destination);
  const image = await readNifti(dwi, 'diffusion image');
  const [bvalBytes, bvecBytes] = await Promise.all([readFile(bval), readFile(bvec)]);
  const bvalText = bvalBytes.toString('utf8');
  const directions = countDirections(bvalText, bvecBytes.toString('utf8'));
  const volumes = image.header.dims[0] >= 4 ? Math.max(1, image.header.dims[4]) : 1;
  if (directions !== volumes) throw new Error(`Volume mismatch: ${basename(dwi)} has ${volumes} volumes but its bval/bvec list ${directions} directions.`);

  let maskBytes;
  let maskFailure = null;
  let maskProvenance = null;
  const mindgrab = maskFile === undefined && !noMask;
  if (mindgrab) {
    const computed = await mindgrabMask(image.bytes, bvalText, onProgress);
    maskBytes = computed.mask;
    maskFailure = computed.failure ?? null;
    maskProvenance = computed.provenance;
    if (maskFailure) onProgress(`Brain mask failed (${maskFailure}); fitting without a mask`);
  } else if (maskFile !== undefined) {
    maskBytes = (await readNifti(maskFile, 'brain mask')).bytes;
    maskProvenance = { source: 'provided', name: basename(maskFile) };
  }

  onProgress('Fitting the diffusion tensor (niimath dtifit)');
  const started = performance.now();
  const maps = await fitTensor(run, { dwi: image.bytes, bval: bvalBytes, bvec: bvecBytes, mask: maskBytes });
  const name = basename(dwi);
  const written = TENSOR_MAPS.map((map) => [mapFileName(name, map), maps[map]]);
  if (mindgrab && maskBytes) written.push([mapFileName(name, 'mask'), maskBytes]);
  await mkdir(destination, { recursive: true });
  for (const [file, bytes] of written) await writeAtomically(join(destination, file), bytes);
  return {
    output: destination,
    files: written.map(([file]) => file),
    provenance: {
      app: `DWI2TRX command line ${packageJson.version}`,
      algorithm: 'niimath dtifit',
      niimath: `@niivue/niimath ${NIIMATH_VERSION} WebAssembly`,
      masked: Boolean(maskBytes),
      maskFailure,
      mask: maskProvenance,
      fitSeconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

// An 8^3 DWI of one tensor, eigenvalues 1.5, 0.5 and 0.5 um^2/ms along x, y and z, b = 1000.
function phantom() {
  const directions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [Math.SQRT1_2, Math.SQRT1_2, 0], [Math.SQRT1_2, 0, Math.SQRT1_2], [0, Math.SQRT1_2, Math.SQRT1_2]];
  const bytes = Buffer.alloc(352 + 8 ** 3 * directions.length * 4);
  bytes.writeInt32LE(348, 0);
  [4, 8, 8, 8, directions.length, 1, 1, 1].forEach((value, i) => bytes.writeInt16LE(value, 40 + 2 * i));
  bytes.writeInt16LE(16, 70);
  bytes.writeInt16LE(32, 72);
  for (let i = 0; i < 8; i += 1) bytes.writeFloatLE(1, 76 + 4 * i);
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  bytes.writeInt16LE(1, 254);
  for (const offset of [280, 300, 320]) bytes.writeFloatLE(1, offset);
  bytes.write('n+1\0', 344, 'latin1');
  directions.forEach(([x, y, z], direction) => {
    const signal = 1000 * Math.exp(-1000 * (0.0015 * x * x + 0.0005 * y * y + 0.0005 * z * z));
    for (let voxel = 0; voxel < 8 ** 3; voxel += 1) bytes.writeFloatLE(signal, 352 + 4 * (direction * 8 ** 3 + voxel));
  });
  const bval = Buffer.from(directions.map((_, i) => (i ? 1000 : 0)).join(' '));
  const bvec = Buffer.from([0, 1, 2].map((axis) => directions.map((d) => d[axis]).join(' ')).join('\n'));
  return { dwi: new Uint8Array(bytes), bval: new Uint8Array(bval), bvec: new Uint8Array(bvec) };
}

// FA of eigenvalues (1.5, 0.5, 0.5): sqrt(3/2) * |lambda - mean| / |lambda| = 0.6030.
const PHANTOM_FA = Math.sqrt(1.5 * (2 / 3) / 2.75);

/** Fits the phantom tensor inside this runtime; its FA must be the analytic value. */
export async function checkInstallation() {
  const maps = await fitTensor(run, phantom());
  const fa = await decodeNiftiBuffer(maps.FA);
  const view = new DataView(fa);
  const value = view.getFloat32(Math.ceil(view.getFloat32(108, true)) + 4 * 100, true);
  if (!(Math.abs(value - PHANTOM_FA) < 1e-3)) throw new Error(`dtifit failed its phantom check: FA ${value}, expected ${PHANTOM_FA.toFixed(4)}.`);
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    dwi2trx: packageJson.version,
    niimath: NIIMATH_VERSION,
    mindgrab: MINDGRAB_VERSION,
    phantomFa: Number(value.toFixed(4)),
  };
}
