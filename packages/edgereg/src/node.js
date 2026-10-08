import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createNiftiFromVolume, decodeNiftiBuffer, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { runNiimath } from '@neurodesk/runtime-support/node/niimath';
import { Niimath } from '@niivue/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import packageJson from '../package.json' with { type: 'json' };
import { OUTPUT_DATA_TYPE, registeredName, registrationChain } from './registration.js';

const niimathPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('@niivue/niimath')), 'utf8'));
export const NIIMATH_VERSION = niimathPackage.version;

const OUTPUT = 'registered.nii';

// NIfTI-1 and NIfTI-2 begin with their header size, 348 or 540, in the file's byte order.
function isNifti(buffer) {
  if (buffer.byteLength < 348) return false;
  const view = new DataView(buffer, 0, 4);
  return [348, 540].some((size) => view.getInt32(0, true) === size || view.getInt32(0, false) === size);
}

async function readNiftiFile(path, role) {
  const bytes = new Uint8Array(await readFile(path));
  if (!isNifti(await decodeNiftiBuffer(bytes))) throw new Error(`The ${role} image ${path} is not NIfTI. Convert DICOM with dcm2niix first.`);
  return new File([bytes], basename(path));
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

// The complete file appears under its name at once, and never replaces a file a concurrent run
// wrote there: link() fails when the name exists.
async function publish(path, bytes) {
  const partial = join(dirname(path), `.${randomUUID().slice(0, 8)}.partial`);
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await link(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/**
 * The niimath argv and staged files `ImageProcessor.run` would hand its worker, so the command
 * line runs the web app's chain through the same WebAssembly build. Mirrors @niivue/niimath
 * 1.4.20260909's run(): the input staged as __nimi_<name>, file arguments as the chain staged them.
 */
async function invocation(chain, moving) {
  const input = `__nimi_${moving.name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const inputs = { [input]: new Uint8Array(await moving.arrayBuffer()) };
  for (const file of chain.extraFiles) inputs[file.name] = new Uint8Array(await file.data.arrayBuffer());
  return { args: [input, ...chain.commands, OUTPUT, '-odt', chain.outputDataType], inputs };
}

async function registerFiles(moving, fixed, robustFov) {
  const niimath = new Niimath();
  niimath.setOutputDataType(OUTPUT_DATA_TYPE);
  const chain = registrationChain(niimath.image(moving), fixed, { robustFov });
  const { args, inputs } = await invocation(chain, moving);
  const { outputs } = await runNiimath(createNiimath, args, { inputs, outputs: [OUTPUT] });
  return { bytes: outputs[OUTPUT], args };
}

/**
 * Registers `moving` to `fixed` and writes the web app's download, <moving>_registered.nii,
 * into `output`, which must be new or empty.
 */
export async function register({ moving, fixed, output, robustFov = false } = {}) {
  if (!moving || !fixed || !output) throw new Error('A moving image, a fixed image and an output directory are required.');
  if (typeof robustFov !== 'boolean') throw new Error('robustFov must be true or false.');
  const destination = resolve(output);
  await assertNewOutput(destination);
  const [movingFile, fixedFile] = await Promise.all([readNiftiFile(moving, 'moving'), readNiftiFile(fixed, 'fixed')]);
  const started = performance.now();
  const { bytes, args } = await registerFiles(movingFile, fixedFile, robustFov);
  const name = registeredName(movingFile.name);
  await mkdir(destination, { recursive: true });
  await publish(join(destination, name), bytes);
  return {
    output: destination,
    files: [name],
    provenance: {
      app: `EdgeReg command line ${packageJson.version}`,
      algorithm: 'niimath allineate',
      niimath: `@niivue/niimath ${NIIMATH_VERSION} WebAssembly`,
      robustFov,
      argv: args,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

// A bright off-centre block in a 2 mm 24^3 volume; registering it to a shifted copy must move it.
function phantom(shift) {
  const size = 24;
  const img = new Float32Array(size ** 3);
  for (let z = 6; z < 16; z += 1) {
    for (let y = 5; y < 17; y += 1) {
      for (let x = 4 + shift; x < 14 + shift; x += 1) img[x + size * (y + size * z)] = 100 + x + y + z;
    }
  }
  const affine = [[2, 0, 0, -24], [0, 2, 0, -24], [0, 0, 2, -24]];
  return new Uint8Array(createNiftiFromVolume({ img, hdr: { dims: [3, size, size, size, 1, 1, 1, 1], pixDims: [1, 2, 2, 2, 1, 1, 1, 1], affine } }));
}

// Mean absolute voxel difference of two NIfTI images on one grid.
function distance(a, b) {
  const [x, y] = [a, b].map((bytes) => readNiftiImageData(bytes).data);
  let sum = 0;
  for (let i = 0; i < x.length; i += 1) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

/** Registers a synthetic block to a shifted copy inside this runtime; it must land on the copy. */
export async function checkInstallation() {
  const [moving, fixed] = [phantom(0), phantom(4)];
  const { bytes } = await registerFiles(new File([moving], 'moving.nii'), new File([fixed], 'fixed.nii'), false);
  const [before, after] = [distance(moving, fixed), distance(bytes, fixed)];
  if (!(after < before / 4)) throw new Error(`niimath allineate failed its phantom check (difference ${before.toFixed(2)} before, ${after.toFixed(2)} after).`);
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    edgereg: packageJson.version,
    niimath: NIIMATH_VERSION,
    phantom: { differenceBefore: Number(before.toFixed(2)), differenceAfter: Number(after.toFixed(2)) },
  };
}
