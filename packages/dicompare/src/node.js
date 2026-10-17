import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import manifest from '../python.manifest.json' with { type: 'json' };
import {
  analyzeFilesCode, analyzeFilesMethod, installCode, installMethod,
  validateAcquisitionCode, validateAcquisitionMethod, versionCode, versionMethod,
} from './python.js';

const require = createRequire(import.meta.url);
const PYODIDE_DIRECTORY = dirname(require.resolve('pyodide/package.json'));
const SCHEMA_DIRECTORY = fileURLToPath(new URL('../schemas/', import.meta.url));
const WHEEL_BASE = 'emfs:/neurodesk/wheels/';
const DICOMPARE_VERSION = /^dicompare-([^-]+)-/.exec(manifest.wheels.at(-1).name)[1];
const PYODIDE_VERSION = manifest.pyodide;
const ASSETS = [...manifest.packageFiles, ...manifest.wheels];

const generateSchemaCode = `
import json
from dicompare.interface import build_schema_from_ui_acquisitions

acqs = json.loads(_ui_acquisitions_json)
meta = json.loads(_schema_metadata_json)

schema = build_schema_from_ui_acquisitions(acqs, meta)
json.dumps(schema, default=str)
  `;
const generateSchemaMethod = 'runPython';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

function installedSha256() {
  const entries = ASSETS.map(({ name, sha256: digest }) => [name, digest]).sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256(JSON.stringify(Object.fromEntries(entries)));
}

function defaultCacheDir() {
  if (process.env.NEURODESK_DICOMPARE_MODEL_DIR) return process.env.NEURODESK_DICOMPARE_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'dicompare', installedSha256().slice(0, 16));
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
  const path = join(cacheDir, asset.name);
  const verified = (bytes) => bytes.length === asset.bytes && sha256(bytes) === asset.sha256;
  const cached = await readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (cached) {
    if (!verified(cached)) throw new Error(`Cached ${asset.name} failed checksum verification. Delete ${path} and download it again.`);
    return cached;
  }
  if (offline) {
    throw new Error(`${asset.name} is missing from the offline Python directory ${cacheDir}. Run "dicompare download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading ${asset.name}…`);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Failed to download ${asset.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${asset.name} download failed checksum verification.`);
  await mkdir(cacheDir, { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const asset of ASSETS) await loadAsset(asset, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: ASSETS.length, installedSha256: installedSha256() };
}

async function verifyPyodideCore() {
  for (const file of manifest.core) {
    const bytes = await readFile(join(PYODIDE_DIRECTORY, file.name));
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Pyodide ${file.name} differs from the build the web app loads.`);
    }
  }
}

// Every Python package is verified on disk before Pyodide starts, so a run never needs the network.
// Pyodide and micropip fall back to the CDN or PyPI for anything missing; refuse that outright.
async function withoutNetwork(callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    throw new Error(`dicompare runs offline; refused to fetch ${input instanceof Request ? input.url : String(input)}`);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

// The web worker's offline start-up: core packages, every staged Pyodide package, then the
// bundled wheels in order through the worker's own install code.
export async function loadDicompare({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  await verifyPyodideCore();
  const wheels = new Map();
  for (const asset of manifest.packageFiles) await loadAsset(asset, { cacheDir, offline, onProgress });
  for (const asset of manifest.wheels) wheels.set(asset.name, await loadAsset(asset, { cacheDir, offline, onProgress }));
  const log = (message) => process.stderr.write(`${message}\n`);
  return withoutNetwork(async () => {
    onProgress('Loading Python runtime...');
    const { loadPyodide } = await import('pyodide');
    const pyodide = await loadPyodide({ indexURL: `${PYODIDE_DIRECTORY}/`, packageCacheDir: resolve(cacheDir), stdout: log, stderr: log });
    onProgress('Installing core packages...');
    await pyodide.loadPackage(['micropip', 'sqlite3'], { messageCallback: () => {} });
    onProgress('Loading offline packages...');
    await pyodide.loadPackage(manifest.packages, { messageCallback: () => {} });
    onProgress('Loading DICOM analysis tools...');
    pyodide.FS.mkdirTree('/neurodesk/wheels');
    for (const [name, bytes] of wheels) pyodide.FS.writeFile(`/neurodesk/wheels/${name}`, bytes);
    await pyodide[installMethod](installCode(WHEEL_BASE, [...wheels.keys()]));
    const versions = JSON.parse(await pyodide[versionMethod](versionCode(DICOMPARE_VERSION)));
    if (versions.dicompare !== DICOMPARE_VERSION) throw new Error(`Installed dicompare ${versions.dicompare}, expected ${DICOMPARE_VERSION}`);
    return { pyodide, versions: { pyodide: PYODIDE_VERSION, python: versions.pyodide, dicompare: versions.dicompare } };
  });
}

// DicompareWorkerAPI.acquisitionToPythonDict: the fields the worker hands to validate_acquisition_direct.
function acquisitionToPythonDict(acquisition) {
  const fields = (list) => list?.map((f) => ({ tag: f.tag, keyword: f.keyword, name: f.name, value: f.value })) || [];
  return {
    protocolName: acquisition.protocolName,
    sliceCount: acquisition.sliceCount || 0,
    acquisitionFields: fields(acquisition.acquisitionFields),
    series: acquisition.series?.map((s) => ({ name: s.name, fields: fields(s.fields) })) || [],
  };
}

async function runJson(pyodide, method, code, globals) {
  for (const [name, value] of Object.entries(globals)) pyodide.globals.set(name, value);
  return JSON.parse(await withoutNetwork(() => pyodide[method](code)));
}

export function createSession({ pyodide }, { onProgress = () => {} } = {}) {
  return {
    // Mirrors pyodide.worker.ts handleAnalyzeFiles.
    async analyzeFiles(files) {
      pyodide.globals.set('progress_callback', (progress) => {
        const p = progress.toJs ? progress.toJs({ dict_converter: Object.fromEntries }) : progress;
        progress.destroy?.();
        onProgress(p.currentOperation || 'Processing...', p.percentage);
      });
      return runJson(pyodide, analyzeFilesMethod, analyzeFilesCode, {
        dicom_file_names: files.map((file) => file.name),
        dicom_file_contents: files.map((file) => file.content),
      });
    },
    // Mirrors DicompareWorkerAPI.validateAcquisitionAgainstSchema and handleValidateAcquisition.
    async validateAcquisition(acquisition, schemaContent, acquisitionIndex) {
      return runJson(pyodide, validateAcquisitionMethod, validateAcquisitionCode, {
        acquisition_data: acquisitionToPythonDict(acquisition),
        schema_content: schemaContent,
        schema_acquisition_index: acquisitionIndex ?? null,
      });
    },
    // Mirrors handleGenerateSchema.
    async generateSchema(acquisitions, metadata) {
      return runJson(pyodide, generateSchemaMethod, generateSchemaCode, {
        _ui_acquisitions_json: JSON.stringify(acquisitions),
        _schema_metadata_json: JSON.stringify(metadata),
      });
    },
  };
}

// Inputs are DICOM files or directories, read recursively in sorted order. Files are named as the
// browser automation names its uploads, `${index}-${name}`, so identical sessions give identical reports.
export async function readDicomInputs(inputs) {
  if (!inputs?.length) throw new Error('Provide at least one DICOM file or directory.');
  const paths = [];
  async function walk(path) {
    const info = await stat(path);
    if (!info.isDirectory()) {
      paths.push(path);
      return;
    }
    const entries = (await readdir(path)).filter((name) => !name.startsWith('.')).sort();
    for (const name of entries) await walk(join(path, name));
  }
  for (const input of inputs) await walk(resolve(input));
  if (!paths.length) throw new Error('The supplied directories contain no files.');
  const files = [];
  for (const [index, path] of paths.entries()) files.push({ name: `${index}-${basename(path)}`, content: new Uint8Array(await readFile(path)) });
  return files;
}

export async function listSchemas() {
  const index = JSON.parse(await readFile(join(SCHEMA_DIRECTORY, 'index.json'), 'utf8'));
  return index.map((path) => basename(path, '.json'));
}

// A schema is a JSON file path or the name of a schema in the web app's library.
export async function readSchema(schema) {
  if (!schema) throw new Error('Provide a schema with --schema.');
  const library = await listSchemas();
  const path = library.includes(schema) && !(await stat(schema).catch(() => null)) ? join(SCHEMA_DIRECTORY, `${schema}.json`) : schema;
  const text = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Schema ${schema} is neither a file nor a library schema (${library.join(', ')}).`);
    throw error;
  });
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The protocol schema must be a JSON object.');
  return { name: basename(path), text };
}

function schemaIndexOf(value = 0) {
  const index = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('The schema acquisition index must be a nonnegative integer.');
  return index;
}

function summarize(comparison) {
  const count = (status) => comparison.reduce((total, { results }) => total + results.filter((result) => result?.status === status).length, 0);
  return { pass: count('pass'), fail: count('fail'), warning: count('warning') };
}

// The reports are the browser automation's artifacts (apps/dicompare/src/automation.ts) byte for byte.
export async function analyze({ inputs, cacheDir, offline, onProgress = () => {} }) {
  const files = await readDicomInputs(inputs);
  const runtime = await loadDicompare({ cacheDir, offline, onProgress });
  const acquisitions = await createSession(runtime, { onProgress }).analyzeFiles(files);
  if (!acquisitions.length) throw new Error('No DICOM acquisitions were found in the supplied files.');
  return { report: { acquisitions }, summary: { acquisitions: acquisitions.length, inputFiles: files.length }, versions: runtime.versions };
}

export async function compare({ inputs, schema, schemaIndex, cacheDir, offline, onProgress = () => {} }) {
  const index = schemaIndexOf(schemaIndex);
  const schemaFile = await readSchema(schema);
  const files = await readDicomInputs(inputs);
  const runtime = await loadDicompare({ cacheDir, offline, onProgress });
  const session = createSession(runtime, { onProgress });
  const acquisitions = await session.analyzeFiles(files);
  if (!acquisitions.length) throw new Error('No DICOM acquisitions were found in the supplied files.');
  const comparison = [];
  for (const acquisition of acquisitions) {
    onProgress(`Validating ${acquisition.protocolName}`);
    const results = await session.validateAcquisition(acquisition, schemaFile.text, index);
    comparison.push({ acquisition: acquisition.id, protocolName: acquisition.protocolName, results });
  }
  return {
    report: { schema: schemaFile.name, schemaIndex: index, acquisitions, comparison },
    summary: { acquisitions: acquisitions.length, inputFiles: files.length, ...summarize(comparison) },
    versions: runtime.versions,
  };
}

// The web app's schema export (src/utils/schemaGeneration.ts) from the acquisitions as analyzed.
export async function buildSchema({ inputs, name, description, version, authors, cacheDir, offline, onProgress = () => {} }) {
  const files = await readDicomInputs(inputs);
  const runtime = await loadDicompare({ cacheDir, offline, onProgress });
  const session = createSession(runtime, { onProgress });
  const acquisitions = await session.analyzeFiles(files);
  if (!acquisitions.length) throw new Error('No DICOM acquisitions were found in the supplied files.');
  onProgress('Building schema');
  const { statistics, ...schema } = await session.generateSchema(acquisitions, {
    name: name || 'Untitled Schema',
    description: description ?? '',
    version: version || '1.0',
    authors: authors || [],
  });
  return { report: schema, summary: { acquisitions: acquisitions.length, inputFiles: files.length }, versions: runtime.versions };
}

export const serialize = (report) => JSON.stringify(report, null, 2);

export async function writeReport(path, report) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  await writeAtomically(destination, serialize(report));
  return destination;
}

export async function checkInstallation() {
  await verifyPyodideCore();
  const library = await listSchemas();
  for (const name of library) await readSchema(name);
  const report = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    pyodide: PYODIDE_VERSION,
    dicompare: DICOMPARE_VERSION,
    schemas: library.length,
  };
  if (!process.env.NEURODESK_DICOMPARE_MODEL_DIR) return report;
  const python = await downloadModels({ offline: true });
  const runtime = await loadDicompare({ offline: true });
  return { ...report, python: runtime.versions.python, models: python };
}
