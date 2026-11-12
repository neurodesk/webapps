import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import manifest from '../model.manifest.json' with { type: 'json' };
import qsmxt from '../qsmxt.json' with { type: 'json' };
import examples from '../examples.manifest.json' with { type: 'json' };

export const MODEL_ASSETS = Object.freeze(manifest.assets);
export const QSMXT = qsmxt;
export const EXAMPLE_ASSETS = Object.freeze(examples.assets);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const offlineByDefault = () => process.env.QSMBLY_OFFLINE === '1' || process.env.NEURODESK_OFFLINE === '1';

export function releasePlatform(platform = process.platform, arch = process.arch) {
  const id = { 'linux-x64': 'linux-x64', 'win32-x64': 'windows-x64', 'darwin-arm64': 'macos-arm64' }[`${platform}-${arch}`];
  if (!id) throw new Error(`QSMxT ${qsmxt.version} is not packaged for ${platform}-${arch}.`);
  return id;
}

export const nativeDirectory = () => join(PACKAGE_ROOT, 'native');

export function qsmxtExecutable(platform = releasePlatform()) {
  return join(nativeDirectory(), qsmxt.targets[platform].executables[0]);
}

export function defaultCacheDir() {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'qsmbly', 'models');
}

// The release's models/ directory (set by the launcher) is read first, so an offline model pack
// copied there is used; downloads go to the user cache, which is writable on every platform.
export function modelDirectories({ cacheDir = defaultCacheDir() } = {}) {
  const bundled = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  return { search: [...new Set([bundled, cacheDir].filter(Boolean))], cacheDir };
}

// These audited commands cannot resolve model weights. Every other native command
// receives the complete registry, including QSMART and future processing commands.
const CONTROL_COMMANDS = new Set(['help', 'init', 'validate', 'dicom-convert', 'example', '--version', '-V']);

// Every hosted weight the pinned native resolver can fetch is checked at build time against
// its immutable registry source. Refuse an incomplete manifest before starting that binary.
export function nativeModelAssets() {
  const files = MODEL_ASSETS.map((asset) => asset.filename).sort();
  if (JSON.stringify(files) !== JSON.stringify([...QSMXT.weightFiles].sort())) {
    throw new Error('The model manifest does not cover every native QSMxT weight file. Install a complete QSMbly release.');
  }
  return MODEL_ASSETS;
}

async function fileSha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function findVerified(asset, search) {
  for (const directory of search) {
    const path = join(directory, asset.filename);
    const info = await stat(path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (info && info.size === asset.bytes && (await fileSha256(path)) === asset.sha256) return path;
  }
  return null;
}

async function download(asset, cacheDir, onProgress) {
  onProgress(`Downloading ${asset.filename} (${Math.round(asset.bytes / 1e6)} MB)…`);
  const response = await fetch(asset.url);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
  await mkdir(cacheDir, { recursive: true });
  const path = join(cacheDir, asset.filename);
  const partial = `${path}.${randomUUID()}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  const measure = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), measure, createWriteStream(partial, { flags: 'wx' }));
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new Error(`${asset.filename} download failed checksum verification.`);
    }
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return path;
}

/** Make every asset available, verified by size and SHA-256, downloading only what is missing. */
export async function ensureModels(assets, { cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  const { search } = modelDirectories({ cacheDir });
  const paths = [];
  for (const asset of assets) {
    let path = await findVerified(asset, search);
    if (!path) {
      if (offline) {
        throw new Error(`${asset.filename} (${asset.model}) is not in ${search.join(' or ')}. Run "qsmbly download-models" while online, or copy the model pack there.`);
      }
      path = await download(asset, cacheDir, onProgress);
    }
    paths.push(path);
  }
  return paths;
}

// Native QSMxT has no offline switch. Supply its complete hosted registry in one verified
// directory, so every local resolution succeeds and its mutable download fallback is unreachable.
export async function ensureNativeModelDirectory(assets, options = {}) {
  const { cacheDir = defaultCacheDir() } = options;
  const { search } = modelDirectories({ cacheDir });
  for (const directory of search) {
    const present = await Promise.all(assets.map((asset) => findVerified(asset, [directory])));
    if (present.every(Boolean)) return directory;
  }
  const paths = await ensureModels(assets, options);
  await mkdir(cacheDir, { recursive: true });
  for (const [index, path] of paths.entries()) {
    const destination = join(cacheDir, assets[index].filename);
    if (resolve(path) === resolve(destination)) continue;
    const partial = `${destination}.${randomUUID()}.partial`;
    try {
      await copyFile(path, partial);
      await rename(partial, destination);
    } finally {
      await rm(partial, { force: true });
    }
  }
  return cacheDir;
}

export async function downloadModels({ models, cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  const unknown = (models ?? []).filter((id) => !MODEL_ASSETS.some((asset) => asset.model === id));
  if (unknown.length) throw new Error(`Unknown model ${unknown.join(', ')}. Models: ${[...new Set(MODEL_ASSETS.map((asset) => asset.model))].join(', ')}.`);
  const assets = models?.length ? MODEL_ASSETS.filter((asset) => models.includes(asset.model)) : MODEL_ASSETS;
  await ensureModels(assets, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: assets.length, bytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) };
}

export function qsmxtEnvironment({ modelDir = defaultCacheDir(), environment = process.env } = {}) {
  return { ...environment, QSM_MODEL_DIR: modelDir, QSM_MODEL_CACHE: modelDir, QSMXT_EXAMPLE_BASE_URL: examples.baseUrl };
}

export function qsmxtVersion(executable = qsmxtExecutable()) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot start QSMxT at ${executable}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`QSMxT --version failed: ${result.stderr}`);
  return parseQsmxtVersion(result.stdout);
}

export function parseQsmxtVersion(output) {
  const banner = /^qsmxt (\S+)(?: \((?:main|rev) ([0-9a-f]{40})\))?$/m.exec(output);
  const core = /^(?:qsm-core|QSM\.rs \(qsm-core\)): (\S+)/m.exec(output)?.[1];
  const deepLearning = /^deep-learning models: (\S+)$/m.exec(output)?.[1];
  return { version: banner?.[1], sourceCommit: banner?.[2], qsmCore: core, deepLearning: deepLearning === 'enabled' };
}

export async function checkInstallation() {
  const executable = qsmxtExecutable();
  const native = qsmxtVersion(executable);
  if (native.version !== qsmxt.version || native.qsmCore !== qsmxt.qsmCore || native.sourceCommit !== qsmxt.build.commit || !native.deepLearning) {
    throw new Error(`Expected QSMxT ${qsmxt.version} with qsm-core ${qsmxt.qsmCore} and deep learning, found ${JSON.stringify(native)}.`);
  }
  const { search, cacheDir } = modelDirectories();
  return {
    executable: process.execPath,
    node: process.version,
    onnxRuntime: null,
    qsmxt: { ...native, executable },
    models: { search, cacheDir, available: MODEL_ASSETS.length },
  };
}

/** Run the pinned QSMxT after preparing its verified local weights; resolves to its exit code. */
export async function runQsmxt(args, { onProgress = () => {}, offline = offlineByDefault() } = {}) {
  if (args[0] === 'update') {
    throw new Error(`qsmbly pins QSMxT ${QSMXT.version}. Install a newer QSMbly release instead of "update".`);
  }
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const help = args[0] === 'help' || options.some((arg) => ['--help', '-h'].includes(arg));
  const exampleList = args[0] === 'example' && options.includes('--list');
  if (!help && ['slurm', 'tui'].includes(args[0])) {
    throw new Error('QSMbly does not support native SLURM generation or the TUI: their jobs launch QSMxT directly and bypass verified model preflight. Use "run" for processing and write scheduler jobs that invoke "qsmbly run".');
  }
  if (offline && !help && args[0] === 'example' && !exampleList) {
    throw new Error('Offline QSMbly does not support example downloads. Use "example --list", or prepare example data online and process it with "run" offline.');
  }
  const compute = !CONTROL_COMMANDS.has(args[0]) && !help && !(args[0] === 'run' && options.includes('--dry'));
  const modelDir = compute
    ? await ensureNativeModelDirectory(nativeModelAssets(), { offline, onProgress })
    : defaultCacheDir();
  const child = spawn(qsmxtExecutable(), args, { stdio: 'inherit', env: qsmxtEnvironment({ modelDir }) });
  // The terminal delivers Ctrl-C to QSMxT as well; wait for it to stop rather than leaving it running.
  const ignore = () => {};
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, ignore);
  try {
    return await new Promise((resolvePromise, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolvePromise(code ?? 128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1)));
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, ignore);
  }
}
