// The lcmodel command line: the web app's fit operation in Node. Files are
// read and sorted as the app sorts dropped files, the committed WebAssembly
// module runs FID-A and LCModel, the pipeline (pipeline.js) makes every choice
// the app makes, and the app's downloads are written under the app's names.
// Library basis sets come from a model directory and are checked against
// model.manifest.json on every load.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import packageJson from "../package.json" with { type: "json" };
import manifest from "../model.manifest.json" with { type: "json" };
import PARAMETERS from "./parameters.json" with { type: "json" };
import { STATUS, fileStem, groupCsvLong, groupCsvWide } from "./group.js";
import { parseControl, sortInputs, textHead } from "./inputs.js";
import { lcmodelError } from "./lcmodel-io.js";
import { basisLibrary } from "./library.js";
import {
  CUSTOM,
  chooseBasis,
  datasetLabel,
  failedEntry,
  fidaInput,
  fitPlanned,
  fitSummary,
  groupMeasurements,
  groupRecords,
  headerFor,
  parseCustomBasis,
  planGroup,
  rawAcquisition,
  rawInput,
  reportVersions,
  resultTexts,
  settingsFrom,
} from "./pipeline.js";
import { recommendBasis } from "./basis-select.js";
import { correctionFor, tissueTexts } from "./tissue.js";
import { loadLcmodel } from "./wasm.js";

export { PARAMETERS };

const APP = `lcmodel command line ${packageJson.version}`;
const LIBRARY = basisLibrary(manifest);
const FRACTIONS = ["fractionGM", "fractionWM", "fractionCSF"];

export const T1_UNSUPPORTED = "--t1 is not supported yet: segmenting a T1 image for the tissue correction needs the web app (https://github.com/neurodesk/webapps/issues/203). Give the voxel's fractions with --fraction-gm, --fraction-wm and --fraction-csf instead.";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === "1";

/** The command-line option for an automation parameter: basisSet is --basis-set, frequencyMHz --frequency-mhz. */
export function optionName(key) {
  return key.replace(/[A-Z]+/g, (letters) => `-${letters.toLowerCase()}`);
}

/**
 * Typed automation parameters from parseArgs values, checked against
 * parameters.json (the app's fit operation). Absent options stay absent.
 */
export function parseParameters(values = {}) {
  const parameters = {};
  for (const [key, field] of Object.entries(PARAMETERS)) {
    const flag = `--${optionName(key)}`;
    const value = values[optionName(key)];
    if (value === undefined) continue;
    if (field.type === "boolean") {
      parameters[key] = value;
    } else if (field.enum) {
      if (!field.enum.includes(value)) throw new Error(`${flag} must be one of ${field.enum.join(", ")}, not "${value}".`);
      parameters[key] = value;
    } else {
      const number = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isFinite(number)) throw new Error(`${flag} must be a number, not "${value}".`);
      if (number < field.minimum || number > field.maximum) throw new Error(`${flag} must be from ${field.minimum} to ${field.maximum}, not ${number}.`);
      parameters[key] = number;
    }
  }
  const given = FRACTIONS.filter((key) => parameters[key] !== undefined);
  if (given.length && given.length < 3) throw new Error("Give all three tissue fractions (--fraction-gm, --fraction-wm, --fraction-csf), or none.");
  return parameters;
}

// ---------------------------------------------------------------------------
// Basis sets
// ---------------------------------------------------------------------------

function installedSha256() {
  const entries = manifest.assets.map(({ filename, sha256: digest }) => [filename, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

// Named after the installed set, so a re-pinned basis set never meets a stale cached copy.
export function defaultCacheDir() {
  if (process.env.NEURODESK_LCMODEL_MODEL_DIR) return process.env.NEURODESK_LCMODEL_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "neurodesk", "lcmodel", installedSha256().slice(0, 16));
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/** One manifest asset, from the model directory or downloaded into it; checked every time. */
async function loadAsset(asset, { cacheDir, offline, onProgress }) {
  const path = join(cacheDir, ...asset.filename.split("/"));
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (bytes) {
    if (!verified(bytes)) throw new Error(`Cached ${asset.filename} failed checksum verification. Delete ${path} and download it again.`);
    return bytes;
  }
  if (offline) {
    throw new Error(`${asset.filename} is missing from the offline model directory ${cacheDir}. Run "lcmodel download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.filename}…`);
  const response = await fetch(manifest.base_url + asset.filename);
  if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.filename} download failed checksum verification.`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

/** Every library basis set, downloaded once and verified. */
export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const asset of manifest.assets) await loadAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: manifest.assets.length, installedSha256: installedSha256() };
}

async function libraryBasisText(library, options) {
  const asset = manifest.assets.find((a) => a.filename === library.file);
  return gunzipSync(await loadAsset(asset, options)).toString("utf8");
}

// ---------------------------------------------------------------------------
// FID-A and LCModel
// ---------------------------------------------------------------------------

const wasmBytes = () => readFile(new URL("./lcmodel.wasm", import.meta.url));

/** The pipeline's engine: the WebAssembly module with `files` loaded into it. */
async function createEngine(files, { basisOptions, onProgress }) {
  const lcm = await loadLcmodel(await wasmBytes(), { onProgress });
  for (const file of files) lcm.addFile(file.name, file.bytes);
  const loaded = files.length ? lcm.load() : null;
  return {
    loaded,
    async process(k, options) {
      const result = lcm.process(k, options);
      if (result.error) throw new Error(result.error);
      return result;
    },
    async fit({ control, files: inputs, basis, fdate }) {
      const text = basis.library ? await libraryBasisText(basis.library, basisOptions) : basis.text;
      onProgress("Fitting with LCModel", 0.35);
      const result = lcm.run({ control, files: { ...inputs, [basis.name]: text }, fdate });
      if (result.error) throw new Error(lcmodelError(result.error, result.outputs));
      return result;
    },
  };
}

export async function checkInstallation() {
  const engine = await createEngine([], { basisOptions: null, onProgress: () => {} });
  if (engine.loaded !== null) throw new Error("WebAssembly module check failed.");
  const models = process.env.NEURODESK_LCMODEL_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    lcmodelWasmSha256: sha256(await wasmBytes()),
    ...(models ? { models } : {}),
  };
}

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

/**
 * Files as the app receives them: a file by its name, a folder's files by
 * their path from the folder (the folder picker's webkitRelativePath), so
 * subjects with the same file names pair within their folders.
 */
async function readInputs(paths) {
  const files = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new Error(`Input ${path} does not exist.`);
    }
    if (info.isDirectory()) {
      const root = resolve(path);
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      const inside = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort();
      for (const file of inside) files.push({ name: [basename(root), ...relative(root, file).split(sep)].join("/"), path: file });
    } else {
      files.push({ name: basename(path), path });
    }
  }
  const names = new Set();
  for (const file of files) {
    if (names.has(file.name)) throw new Error(`Two inputs are named ${file.name}; give the folders that hold them instead.`);
    names.add(file.name);
  }
  return Promise.all(files.map(async ({ name, path }) => {
    const bytes = new Uint8Array(await readFile(path));
    return { name, bytes, head: textHead(bytes) };
  }));
}

/** A user's own .BASIS file, gzipped or not. */
async function readBasisFile(path) {
  let bytes = await readFile(path);
  if (/\.gz$/i.test(path)) bytes = gunzipSync(bytes);
  return parseCustomBasis(basename(path), bytes.toString("utf8"));
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

async function writeTexts(directory, texts) {
  const written = [];
  for (const item of texts) {
    await writeFile(join(directory, item.name), item.body ?? item.make(), { flag: "wx" });
    written.push(item.name);
  }
  return written;
}

// ---------------------------------------------------------------------------
// The fit operation
// ---------------------------------------------------------------------------

const decode = (file) => new TextDecoder().decode(file.bytes);

/**
 * Preprocess and fit spectroscopy data as the web app's fit operation does, or
 * every dataset among them as its fit-group operation does, and write the
 * app's downloads into `output`, which must be new or empty.
 * @param {{inputs: string[], output: string, basis?: string, t1?: string, parameters?: object,
 *   cacheDir?: string, offline?: boolean, onProgress?: (fraction: number|undefined, message: string) => void,
 *   log?: (message: string, level?: string) => void}} options
 *   `parameters` are the fit operation's (parseParameters).
 */
export async function fit({
  inputs,
  output,
  basis,
  t1,
  parameters: p = {},
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
  log = () => {},
}) {
  if (t1) throw new Error(T1_UNSUPPORTED);
  if (!inputs?.length || !output) throw new Error("Spectroscopy files and an output directory are required.");
  if (basis && p.basisSet && p.basisSet !== "auto") throw new Error("Give --basis or --basis-set, not both.");
  const destination = resolve(output);
  await assertNewOutput(destination);
  const started = performance.now();
  const files = await readInputs(inputs);
  const sorted = sortInputs(files);
  const custom = basis ? await readBasisFile(basis) : sorted.basis[0] ? parseCustomBasis(sorted.basis[0].name, decode(sorted.basis[0])) : null;
  const control = sorted.control.length ? parseControl(decode(sorted.control[0])) : null;
  const report = (fraction, message) => onProgress(fraction, message);
  const engineOptions = { basisOptions: { cacheDir, offline, onProgress: (message) => report(undefined, message) }, onProgress: (text, fraction) => report(fraction, text) };
  let input;
  let engine;
  if (sorted.raw.length) {
    const water = sorted.water[0];
    input = rawInput({ name: sorted.raw[0].name, text: decode(sorted.raw[0]), waterName: water?.name ?? null, water: water ? decode(water) : null, control });
    engine = await createEngine([], engineOptions);
  } else if (sorted.other.length) {
    report(undefined, "Reading the data with FID-A…");
    engine = await createEngine(sorted.other, engineOptions);
    const { loaded } = engine;
    for (const e of loaded.errors) log(`${e.file}: ${e.error}`, "warning");
    for (const e of loaded.ignored) log(`${e.file}: ${e.reason}`, "info");
    for (const name of loaded.unpairedWater ?? []) log(`${name}: a water reference with no spectrum to pair it with`, "warning");
    if (!loaded.datasets.length) {
      const first = loaded.errors[0];
      throw new Error(first ? `${first.file}: ${first.error}` : "No readable spectroscopy data found.");
    }
    input = fidaInput(loaded);
  } else if (sorted.water.length) {
    throw new Error("Only a water reference was found; add the water-suppressed spectrum.");
  } else {
    throw new Error("No spectroscopy data found among the files.");
  }
  if (typeof p.edited === "boolean" && input.kind === "fida") {
    for (const ds of input.datasets) if (ds.header.editing) ds.editOverride = p.edited;
  }
  const acquisition = input.kind === "raw" ? rawAcquisition(input, p) : null;
  if (acquisition && !(acquisition.hzpppm && acquisition.deltat)) {
    throw new Error(`${input.name} records no ${acquisition.hzpppm ? "dwell time" : "spectrometer frequency"}; give --frequency-mhz and --dwell-time-ms.`);
  }
  const bases = { library: LIBRARY, custom };
  const settings = settingsFrom(p);
  const versions = reportVersions(APP);
  const onStep = (message) => report(undefined, message);
  await mkdir(destination, { recursive: true });
  const group = input.kind === "fida" && input.datasets.length > 1;
  // A WebAssembly trap may leave the module broken: the next dataset gets a fresh one.
  const recycle = () => createEngine(sorted.other, engineOptions);
  const result = group
    ? await fitGroup(engine, { input, p, settings, bases, versions, destination, onStep, log, recycle })
    : await fitOne(engine, { input, p, settings, bases, acquisition, versions, destination, onStep, log });
  result.provenance = {
    app: APP,
    parameters: p,
    basisFile: custom ? { name: custom.name, sha256: custom.sha256 ?? null } : null,
    preprocessing: input.kind === "fida" ? settings.preprocessing : null,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    ...result.provenance,
  };
  return { output: destination, ...result };
}

async function fitOne(engine, { input, p, settings, bases, acquisition, versions, destination, onStep, log }) {
  const choice = chooseBasis(input, 0, { basisSet: p.basisSet ?? "auto", bases, acquisition });
  const entry = await fitPlanned(engine, { input, index: 0, basisId: choice, settings, bases, acquisition, onStep, log });
  const f = entry.fit;
  const header = input.kind === "fida" ? input.datasets[0].header : null;
  const fractions = p.fractionGM === undefined ? null : { gm: p.fractionGM, wm: p.fractionWM, csf: p.fractionCSF };
  const correction = correctionFor(f.rows, { fractions, header, waterScaled: f.water, edited: Boolean(f.lcm.edited), metaboliteRelaxation: p.metaboliteRelaxation ?? true });
  if (correction?.reason) throw new Error(correction.reason);
  f.correction = correction ? { ...correction, source: { kind: "entered" } } : null;
  const texts = Object.values(resultTexts(entry, input, versions));
  if (f.correction) texts.push(...Object.values(tissueTexts(f.correction, fileStem(datasetLabel(input, 0)), f.ratioTo, { voxel: header?.voxel ?? null })));
  const written = await writeTexts(destination, texts);
  const summary = fitSummary(entry, choice === CUSTOM ? bases.custom.name : choice);
  return { files: written, ...summary };
}

async function fitGroup(engine, { input, p, settings, bases, versions, destination, onStep, log, recycle }) {
  if (p.fractionGM !== undefined) throw new Error("Tissue fractions describe one voxel; give them with one dataset, not a group of datasets.");
  const explicit = Boolean(p.basisSet && p.basisSet !== "auto");
  const first = headerFor(input, 0, null);
  const choice = bases.custom ? CUSTOM : explicit ? p.basisSet : recommendBasis(first, bases.library)?.basis.id ?? null;
  const plan = planGroup(input, { choice, explicit, bases, acquisition: null });
  const n = input.datasets.length;
  log(`Fitting ${n} datasets. ${plan.description}`);
  const fits = new Map();
  for (let k = 0; k < n; k += 1) {
    const label = input.datasets[k].label;
    const step = (message) => onStep(`Dataset ${k + 1} of ${n} (${label}): ${message}`);
    try {
      const entry = await fitPlanned(engine, { input, index: k, basisId: plan.bases[k], settings, bases, acquisition: null, onStep: step, log });
      fits.set(k, entry);
      log(`${label}: fitted with ${entry.basis.label}`);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) engine = await recycle();
      fits.set(k, failedEntry(k, error, plan.bases[k]));
      log(`${label}: ${error.message}`, "error");
    }
  }
  const entries = [...fits.values()];
  const fitted = entries.filter((e) => e.status === STATUS.fitted);
  if (!fitted.length) throw new Error(`No dataset could be fitted: ${entries[0]?.error ?? "unknown error"}`);
  const { records } = groupRecords(input, fits);
  const texts = [
    { name: "lcmodel_group.csv", body: groupCsvLong(records) },
    { name: "lcmodel_group_wide.csv", body: groupCsvWide(records) },
  ];
  for (const entry of fitted) texts.push(...Object.values(resultTexts(entry, input, versions)));
  const written = await writeTexts(destination, texts);
  return {
    files: written,
    measurements: { datasets: groupMeasurements(records) },
    provenance: {
      basisSelection: plan.mode,
      basisNote: plan.description,
      lineBroadening: settings.lineBroadening,
      macromoleculeModel: settings.mmModel,
      fitted: fitted.length,
      failed: entries.length - fitted.length,
    },
  };
}
