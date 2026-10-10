import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import createNiimath from '@niivue/niimath/niimath.js';
import { loadMindgrabCpu } from '@neurodesk/node-drivers/mindgrab';
import { runNiimath } from '@neurodesk/node-drivers/niimath';
import packageJson from '../package.json' with { type: 'json' };
import { AIR_TEMPLATE, DEFAULT_MODEL, MODELS, checkAirTemplate, finishReport, parseModel, qcTissues, segmentForQc, sha256Hex } from './pipeline.js';

const MINDGRAB_PACKAGE = import.meta.resolve('@brainchop/mindgrab/package.json');
// The package does not export its package.json; niimath.js sits in its dist/.
const NIIMATH_PACKAGE = new URL('../package.json', import.meta.resolve('@niivue/niimath/niimath.js'));

const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function defaultCacheDir() {
  if (process.env.NEURODESK_BROWSERQC_MODEL_DIR) return process.env.NEURODESK_BROWSERQC_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'browserqc', packageJson.version);
}

async function loadAirTemplate({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  const path = join(cacheDir, AIR_TEMPLATE.name);
  const cached = await readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (cached) return new Uint8Array(await checkAirTemplate(cached));
  if (offline) {
    throw new Error(`${AIR_TEMPLATE.name} is missing from the offline model directory ${cacheDir}. Run "browserqc download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${AIR_TEMPLATE.name}`);
  const response = await fetch(AIR_TEMPLATE.url);
  if (!response.ok) throw new Error(`Download of ${AIR_TEMPLATE.url} failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await checkAirTemplate(new Uint8Array(await response.arrayBuffer())));
  await mkdir(cacheDir, { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
  return bytes;
}

export async function downloadModels(options = {}) {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  await loadAirTemplate({ ...options, cacheDir });
  return { directory: resolve(cacheDir), count: 1 };
}

async function packageVersion(url) {
  return JSON.parse(await readFile(new URL(url), 'utf8')).version;
}

// Every MindGrab CPU module a model needs, and a niimath instance that runs.
async function checkEngines() {
  const modules = ['mindgrab', ...new Set(Object.entries(MODELS).map(([id, model]) => model.pve ?? id))];
  for (const name of modules) {
    for (const extension of ['js', 'wasm']) await access(new URL(`dist/brainchop-${name}.${extension}`, MINDGRAB_PACKAGE));
  }
  const { log } = await runNiimath(createNiimath, ['--version']);
  if (!/^v\d/.test(log[0] ?? '')) throw new Error(`The niimath WebAssembly module did not report its version: ${log.join(' ')}`);
  return log[0];
}

export async function checkInstallation() {
  const niimathEngine = await checkEngines();
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    browserqc: packageJson.version,
    mindgrab: await packageVersion(MINDGRAB_PACKAGE),
    niimath: await packageVersion(NIIMATH_PACKAGE),
    niimathEngine,
    models: Object.keys(MODELS),
  };
  if (process.env.NEURODESK_BROWSERQC_MODEL_DIR) {
    await loadAirTemplate({ offline: true });
    report.airTemplateSha256 = AIR_TEMPLATE.sha256;
  }
  return report;
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

const isGzip = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

// NIfTI-1 and NIfTI-2 begin with their header size, 348 or 540, in the file's byte order.
function assertNifti(bytes, path) {
  const raw = isGzip(bytes) ? gunzipSync(bytes) : bytes;
  const view = raw.length >= 348 ? new DataView(raw.buffer, raw.byteOffset, 4) : null;
  const nifti = view && [348, 540].some((size) => view.getInt32(0, true) === size || view.getInt32(0, false) === size);
  if (!nifti) throw new Error(`${path} is not a NIfTI image. Convert DICOM with dcm2niix first.`);
}

async function readSidecar(path) {
  let sidecar;
  try {
    sidecar = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`The BIDS sidecar ${path} is not readable JSON: ${error.message}`);
  }
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) throw new Error(`The BIDS sidecar ${path} must be a JSON object.`);
  return sidecar;
}

/**
 * The argv and staged files @niivue/niimath's qc() builds in the web app, so
 * niimath reads identically named files and writes an identical report.
 */
export function qcCommand(input, tissues, air) {
  const plainName = (bytes) => (isGzip(bytes) ? 'input.nii.gz' : 'input.nii');
  const inName = `__nimi_${plainName(input)}`;
  const inputs = { [inName]: input };
  let counter = 0;
  const stage = (bytes, name = plainName(bytes)) => {
    const staged = `__nimx${counter++}_${name}`;
    inputs[staged] = bytes;
    return staged;
  };
  const args = ['--qc', inName];
  if ('pve' in tissues) args.push('--pve', ...tissues.pve.map((bytes) => stage(bytes)));
  else args.push('--seg', stage(tissues.seg), '--csf', tissues.csf.join(','), '--wm', tissues.wm.join(','));
  if (tissues.mask) args.push('--mask', stage(tissues.mask));
  args.push('--air', stage(air, AIR_TEMPLATE.name), '--json', 'qc.json');
  return { args, inputs };
}

const bytesOf = (buffer) => new Uint8Array(buffer);

function artifactFiles(segmentation, report) {
  const images = segmentation.kind === 'pve'
    ? ['csf', 'gm', 'wm'].map((name) => ({ name: `${name}.nii`, bytes: bytesOf(segmentation.tissues[name]) }))
    : [{ name: 'labels.nii', bytes: bytesOf(segmentation.image) }];
  return [
    { name: 'brain-mask.nii', bytes: bytesOf(segmentation.mask) },
    ...images,
    // The app's automation download: two-space JSON, no trailing newline.
    { name: 'qc.json', bytes: new TextEncoder().encode(JSON.stringify(report, null, 2)) },
  ];
}

export async function runQc({
  input,
  output,
  model = DEFAULT_MODEL,
  bids,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  const chosen = parseModel(model);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const t1 = new Uint8Array(await readFile(input));
  assertNifti(t1, input);
  const sidecar = bids === undefined ? null : await readSidecar(bids);
  const air = await loadAirTemplate({ cacheDir, offline, onProgress });
  const mindgrab = await loadMindgrabCpu(MINDGRAB_PACKAGE);
  onProgress(`Brain mask and ${MODELS[chosen].label} (MindGrab ${mindgrab.version}, CPU)`);
  const started = performance.now();
  const segmentation = await segmentForQc(mindgrab, t1, chosen);
  onProgress('Computing image-quality metrics (niimath)');
  const tissues = qcTissues(segmentation, chosen);
  const staged = 'pve' in tissues
    ? { pve: tissues.pve.map(bytesOf), mask: bytesOf(tissues.mask) }
    : { ...tissues, seg: bytesOf(tissues.seg), mask: bytesOf(tissues.mask) };
  const { args, inputs } = qcCommand(t1, staged, air);
  const { outputs } = await runNiimath(createNiimath, args, { inputs, outputs: ['qc.json'] });
  const report = JSON.parse(new TextDecoder().decode(outputs['qc.json']));
  report.provenance.air_template = AIR_TEMPLATE.name;
  finishReport(report, { model: chosen, bids: sidecar });
  const seconds = (performance.now() - started) / 1000;
  const files = artifactFiles(segmentation, report);
  await mkdir(destination, { recursive: true });
  for (const file of files) await writeFile(join(destination, file.name), file.bytes, { flag: 'wx' });
  return { output: destination, files: files.map((file) => file.name), seconds, inputSha256: await sha256Hex(t1) };
}
