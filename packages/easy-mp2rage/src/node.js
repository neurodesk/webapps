import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sameVoxelGrid } from '@neurodesk/webapp-components/file-io/nifti';
import packageJson from '../package.json' with { type: 'json' };
import { initSync, denoise_uni, t1map_b1, t1map_sa2rage, version } from '../wasm/mp2rage_wasm.js';
import { readNifti, voxelGrid, writeNiftiGz } from './nifti.js';
import { B1_MAP_KINDS, outputFiles, parametersRecord } from './outputs.js';

export const MP2RAGE_PARAMETERS = ['TR', 'TI1', 'TI2', 'FA1', 'FA2', 'NZ1', 'NZ2', 'TRFLASH', 'inversion efficiency'];
export const SA2RAGE_PARAMETERS = ['TR', 'TD1', 'TD2', 'FA1', 'FA2', 'NZ1', 'NZ2', 'TRFLASH', 'average T1'];

const SOFTWARE = `easy-mp2rage command line ${packageJson.version} (wasm)`;
const NOTE = 'Computed locally by the easy-mp2rage command line; no data uploaded.';

let core;
function loadCore() {
  if (!core) {
    initSync({ module: readFileSync(new URL('../wasm/mp2rage_wasm_bg.wasm', import.meta.url)) });
    core = { version: version() };
  }
  return core;
}

export function checkInstallation() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    wasmCore: loadCore().version,
  };
}

export function parseAcquisition(text, names, option) {
  const values = String(text).split(',').map((value) => Number(value.trim()));
  if (values.length !== names.length) {
    throw new Error(`${option} needs ${names.length} comma-separated values: ${names.join(', ')}.`);
  }
  values.forEach((value, index) => {
    if (!Number.isFinite(value) || value < 1e-6) throw new Error(`${option} ${names[index]} must be a positive number, not "${text.split(',')[index]}".`);
  });
  return values;
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

async function readVolume(path, role) {
  const bytes = await readFile(path);
  try {
    return await readNifti(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (error) {
    throw new Error(`${role} ${path}: ${error.message}`);
  }
}

const grid = (volume) => volume.dims.slice(0, 3);

// The core combines these images voxel for voxel, so their dimensions and affines must agree;
// sameVoxelGrid allows 1e-5 in each affine coefficient for float32 header rounding.
function assertSameGrid(uni, other, role) {
  if (!sameVoxelGrid(voxelGrid(uni), voxelGrid(other))) {
    throw new Error(`${role} (${grid(other).join('x')}) and UNI (${grid(uni).join('x')}) are not on the same voxel grid. Dimensions, voxel size, orientation and origin must all match.`);
  }
}

async function writeOutputs({ output, task, mode, uni, volumes, parameters }) {
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  const files = [];
  for (const [key, name] of outputFiles(task, mode)) {
    await writeFile(join(destination, name), await writeNiftiGz(volumes[key], grid(uni), uni.affine));
    files.push(name);
  }
  const record = parametersRecord({ software: SOFTWARE, note: NOTE, task, mode, ...parameters });
  await writeFile(join(destination, 'parameters.json'), JSON.stringify(record, null, 2));
  files.push('parameters.json');
  return { output: destination, files };
}

export async function correct({
  uni,
  inv2,
  b1,
  sa2rage,
  mp2rage,
  sa2rageParameters,
  b1Type,
  referenceAngle = 80,
  extendFov = false,
  fallbackUncorrected = false,
  output,
}) {
  if (!uni || !output) throw new Error('A UNI image and an output directory are required.');
  if (Boolean(b1) === Boolean(sa2rage)) throw new Error('Supply exactly one B1 source: a measured B1 map or SA2RAGE.');
  if (mp2rage?.length !== MP2RAGE_PARAMETERS.length) throw new Error('Supply all nine MP2RAGE acquisition parameters in the declared order.');
  if (mp2rage[8] > 1) throw new Error('Inversion efficiency must not exceed 1.');
  if (sa2rage && sa2rageParameters?.length !== SA2RAGE_PARAMETERS.length) throw new Error('Supply all nine SA2RAGE acquisition parameters.');
  if (b1 && !Object.hasOwn(B1_MAP_KINDS, b1Type ?? '')) throw new Error('Declare the measured B1 map units: tfl, percent or relative.');
  if (b1 && !(referenceAngle >= 0.001 && referenceAngle <= 180)) throw new Error('The reference angle must be between 0.001 and 180 degrees.');
  const destination = resolve(output);
  await assertNewOutput(destination);
  loadCore();
  const uniVolume = await readVolume(uni, 'UNI');
  const inv2Volume = inv2 ? await readVolume(inv2, 'INV2') : null;
  if (inv2Volume) assertSameGrid(uniVolume, inv2Volume, 'INV2');
  const dims = Uint32Array.from(grid(uniVolume));
  // Without INV2 the core masks with UNI itself, as the web app does.
  const mask = inv2Volume ? inv2Volume.data : uniVolume.data.slice();
  const mp = Float64Array.from(mp2rage);
  let mode;
  let result;
  if (sa2rage) {
    mode = 'sa2rage';
    const sa = await readVolume(sa2rage, 'SA2RAGE');
    if ((sa.dims[3] || 1) < 2) throw new Error(`SA2RAGE must be a 2-volume (S1,S2) image, this one is ${sa.dims.join('x')}.`);
    result = t1map_sa2rage(
      uniVolume.data,
      mask,
      sa.data,
      dims,
      uniVolume.affine,
      Uint32Array.from(grid(sa)),
      sa.affine,
      mp,
      Float64Array.from(sa2rageParameters),
      fallbackUncorrected,
    );
  } else {
    mode = 'b1map';
    const map = await readVolume(b1, 'B1 map');
    result = t1map_b1(
      uniVolume.data,
      mask,
      map.data,
      dims,
      uniVolume.affine,
      Uint32Array.from(grid(map)),
      map.affine,
      B1_MAP_KINDS[b1Type],
      referenceAngle,
      mp,
      extendFov,
      fallbackUncorrected,
    );
  }
  const volumes = { t1: result.t1, b1: result.b1, t1u: result.t1_uncorr, unic: result.uni_corr };
  const parameters = {
    mp2rage: [...mp2rage],
    sa2rage: sa2rageParameters,
    b1MapType: b1Type,
    referenceAngle,
    extendFov,
    fallbackUncorrected,
    maskSource: inv2Volume ? 'INV2' : 'UNI',
  };
  return writeOutputs({ output: destination, task: 't1', mode, uni: uniVolume, volumes, parameters });
}

export async function denoise({ uni, inv1, inv2, regularization = 6, output }) {
  if (!uni || !inv1 || !inv2 || !output) throw new Error('UNI, INV1 and INV2 images and an output directory are required.');
  if (!(regularization >= 1)) throw new Error(`Regularization must be a number of at least 1, not "${regularization}".`);
  const destination = resolve(output);
  await assertNewOutput(destination);
  loadCore();
  const uniVolume = await readVolume(uni, 'UNI');
  const inv1Volume = await readVolume(inv1, 'INV1');
  const inv2Volume = await readVolume(inv2, 'INV2');
  assertSameGrid(uniVolume, inv1Volume, 'INV1');
  assertSameGrid(uniVolume, inv2Volume, 'INV2');
  const denoised = denoise_uni(uniVolume.data, inv1Volume.data, inv2Volume.data, Uint32Array.from(grid(uniVolume)), regularization);
  return writeOutputs({ output: destination, task: 'denoise', uni: uniVolume, volumes: { unic: denoised }, parameters: { regularization } });
}
