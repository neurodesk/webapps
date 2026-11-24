import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { runNiimath } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@neurodesk/runtime-support/niimath/module';
import packageJson from '../package.json' with { type: 'json' };
import { DEFAULT_METHOD, METHODS, OUTPUT_NAMES, TEMPLATE_NAMES, deface, resolveMethod } from './pipeline.js';
import { TEMPLATE_ASSETS } from './templates.js';

export { DEFAULT_METHOD, METHODS };

/** The MNI template and face mask the web app fetches, with their pins. */
export const MODEL_ASSETS = TEMPLATE_ASSETS;

const NIFTI = /\.nii(\.gz)?$/i;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

// The MindGrab package this package pins, which the web app also serves.
const loadMindgrab = () => loadMindgrabCpu(import.meta.resolve('@brainchop/core/package.json'));

/** niimath on the web app's vendored WebAssembly build, one fresh module per command. */
export const niimath = Object.freeze({
  async run(args, { inputs, output }) {
    const { outputs } = await runNiimath(createNiimath, args, { inputs, outputs: [output] });
    return outputs[output];
  },
});

function installedSha256(assets) {
  const entries = assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

// Named after the installed set, so a re-pinned template never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_DEFACE_MODEL_DIR) return process.env.NEURODESK_DEFACE_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'deface', installedSha256(MODEL_ASSETS).slice(0, 16));
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

async function loadAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, asset.filename);
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (bytes) {
    if (!verified(bytes)) throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
    return bytes;
  }
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "deface download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

async function loadTemplates(options) {
  const bytes = {};
  for (const asset of MODEL_ASSETS) bytes[asset.filename] = new Uint8Array(await loadAsset(asset, options));
  return { template: bytes[TEMPLATE_NAMES.template], mask: bytes[TEMPLATE_NAMES.mask] };
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  await loadTemplates({ cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: MODEL_ASSETS.length, installedSha256: installedSha256(MODEL_ASSETS) };
}

// A 2 mm float NIfTI-1 cube of 8 voxels a side holding 1 to 512, in RAS.
function cubeNifti() {
  const n = 8;
  const header = new DataView(new ArrayBuffer(352));
  header.setInt32(0, 348, true);
  for (const [offset, value] of [[40, 3], [42, n], [44, n], [46, n], [48, 1], [50, 1], [52, 1], [70, 16], [72, 32], [254, 1]]) header.setInt16(offset, value, true);
  for (const [offset, value] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1]]) header.setFloat32(offset, value, true);
  for (const [row, values] of [[280, [2, 0, 0, -7]], [296, [0, 2, 0, -7]], [312, [0, 0, 2, -7]]]) {
    values.forEach((value, column) => header.setFloat32(row + 4 * column, value, true));
  }
  new Uint8Array(header.buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  const bytes = new Uint8Array(352 + 4 * n ** 3);
  bytes.set(new Uint8Array(header.buffer));
  new Float32Array(bytes.buffer, 352).set(Float32Array.from({ length: n ** 3 }, (_, i) => i + 1));
  return bytes;
}

/**
 * Proves the niimath module runs (a cube times two must double every voxel) and loads the
 * MindGrab package. With the launcher's model directory set, also verifies the templates offline.
 */
export async function checkInstallation() {
  const cube = cubeNifti();
  const doubled = await niimath.run(['cube.nii', '-gz', '0', '-mul', '2', 'doubled.nii', '-odt', 'float'], { inputs: { 'cube.nii': cube }, output: 'doubled.nii' });
  const before = new Float32Array(cube.buffer, 352);
  const after = new Float32Array(doubled.buffer.slice(doubled.byteOffset + 352, doubled.byteOffset + doubled.byteLength));
  if (after.length !== before.length || after.some((value, i) => value !== 2 * before[i])) throw new Error('niimath WebAssembly check failed.');
  const mindgrab = await loadMindgrab();
  const models = process.env.NEURODESK_DEFACE_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    deface: packageJson.version,
    niimathSmokeTestVoxels: after.length,
    mindgrab: mindgrab.version,
    ...(models ? { models } : {}),
  };
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

// Publishes the outputs together into a directory this run alone owns: an exclusively created
// lock in an otherwise empty directory keeps two runs from interleaving their files, and every
// file is staged before any is renamed into place.
async function publish(directory, files) {
  await mkdir(directory, { recursive: true });
  const lock = join(directory, '.deface.lock');
  try {
    await writeFile(lock, '', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another deface run is writing to ${directory}. Choose a new or empty directory.`);
    throw error;
  }
  const staged = files.map(({ name, bytes }) => ({ path: join(directory, name), partial: join(directory, `${name}.${randomUUID()}.partial`), bytes }));
  try {
    const entries = await readdir(directory);
    if (entries.length !== 1) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
    for (const { partial, bytes } of staged) await writeFile(partial, bytes, { flag: 'wx' });
    for (const { partial, path } of staged) await rename(partial, path);
  } finally {
    for (const { partial } of staged) await rm(partial, { force: true });
    await rm(lock, { force: true });
  }
}

/**
 * Deface one NIfTI image with the web app's method and write its download, defaced.nii,
 * plus brain-mask.nii for the MindGrab methods, into a new or empty directory.
 */
export async function defaceImage({
  input,
  output,
  method = DEFAULT_METHOD,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  if (!NIFTI.test(input)) throw new Error(`${input} is not NIfTI (.nii or .nii.gz). Convert DICOM with dcm2niix first, or use the Deface web app.`);
  const { engine } = resolveMethod(method);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const bytes = new Uint8Array(await readFile(input));
  const templates = engine === 'allineate' ? await loadTemplates({ cacheDir, offline, onProgress }) : undefined;
  const mindgrab = engine === 'mindgrab' ? await loadMindgrab() : undefined;
  const started = performance.now();
  const result = await deface({ input: bytes, method, templates, niimath, mindgrab, onProgress });
  const files = [result.image, ...(result.mask ? [result.mask] : [])];
  await publish(destination, files);
  return {
    output: destination,
    files: files.map(({ name }) => name),
    provenance: {
      app: `Deface command line ${packageJson.version}`,
      input: basename(input),
      ...result.provenance,
      ...(templates ? { templates: Object.fromEntries(MODEL_ASSETS.map(({ filename, sha256: digest }) => [filename, digest])) } : {}),
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

export { OUTPUT_NAMES };
