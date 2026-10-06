import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import manifest from '../disconnectome.manifest.json' with { type: 'json' };
import packageJson from '../package.json' with { type: 'json' };
import createModule from '../wasm/nii2tvx.mjs';
import { gridAdvice, isGridMismatch, lesionId, tableName } from './disconnectome.js';
import { openAtlas, toTsv } from './index.js';

/** The query atlases, each with its pinned TVX asset, in the order the web app offers them. */
export const ATLASES = manifest.atlases.map((entry) => ({
  id: entry.id,
  label: entry.label,
  default: entry.default === true,
  asset: manifest.assets.find(({ filename }) => filename === entry.tvx),
}));

export const DEFAULT_ATLAS = ATLASES.find((atlas) => atlas.default);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const offlineByDefault = () => process.env.NEURODESK_OFFLINE === '1';

export function defaultCacheDir() {
  if (process.env.NEURODESK_DISCONNECTOME_MODEL_DIR) return process.env.NEURODESK_DISCONNECTOME_MODEL_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(cache, 'neurodesk', 'disconnectome', manifest.revision);
}

export function findAtlas(id) {
  const atlas = ATLASES.find((entry) => entry.id === id);
  if (!atlas) throw new Error(`Unknown atlas "${id}". Choose ${ATLASES.map((entry) => entry.id).join(' or ')}.`);
  return atlas;
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

/** The atlas's TVX bytes, checked against the manifest's size and SHA-256 on every load. */
async function loadAtlasBytes(atlas, { cacheDir, offline, onProgress }) {
  const { filename, bytes: size, sha256: digest } = atlas.asset;
  const path = join(cacheDir, ...filename.split('/'));
  const verified = (bytes) => bytes.length === size && sha256(bytes) === digest;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (bytes) {
    if (!verified(bytes)) throw new Error(`Cached ${filename} failed checksum verification. Delete ${path} and download it again.`);
    return bytes;
  }
  if (offline) {
    throw new Error(`${filename} is missing from the offline atlas directory ${cacheDir}. Run "disconnectome download-models" while online, or reinstall the complete release.`);
  }
  onProgress(`Downloading the ${atlas.label} atlas…`);
  const response = await fetch(manifest.base_url + filename);
  if (!response.ok) throw new Error(`Failed to download ${filename}: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${filename} download failed checksum verification.`);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomically(path, bytes);
  return bytes;
}

export async function downloadModels({ cacheDir = defaultCacheDir(), offline = offlineByDefault(), onProgress = () => {} } = {}) {
  for (const atlas of ATLASES) await loadAtlasBytes(atlas, { cacheDir, offline, onProgress });
  return { directory: resolve(cacheDir), count: ATLASES.length, revision: manifest.revision };
}

/** Instantiates the WebAssembly query core and, inside a portable archive, checks every atlas. */
export async function checkInstallation() {
  const module = await createModule({ printErr: () => {} });
  if (typeof module._tvx_open !== 'function') throw new Error('The nii2tvx WebAssembly module did not load.');
  const models = process.env.NEURODESK_DISCONNECTOME_MODEL_DIR ? await downloadModels({ offline: true }) : null;
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    disconnectome: packageJson.version,
    ...(models ? { models } : {}),
  };
}

/** One lesion against every bundle of an atlas. A lesion off the atlas grid is refused with the
 *  web app's advice, followed by the reason the C core gave. */
export async function scoreLesion(atlasBytes, lesion, onProgress = () => {}) {
  onProgress('Opening the tract atlas…');
  const atlas = await openAtlas(atlasBytes);
  try {
    onProgress(`Scoring ${atlas.tracts.length} bundles…`);
    return { tracts: atlas.tracts, fractions: await atlas.query(lesion) };
  } catch (error) {
    if (!isGridMismatch(error)) throw error;
    throw new Error(`${gridAdvice(manifest.grid)}\n${error.message}`);
  } finally {
    atlas.close();
  }
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

/**
 * Score one lesion against every bundle of an atlas and write the web app's download: one TSV
 * row named after the lesion, in a file named after the lesion and the atlas.
 */
export async function analyze({
  input,
  output,
  atlas: atlasId = DEFAULT_ATLAS.id,
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  onProgress = () => {},
} = {}) {
  if (!input || !output) throw new Error('A lesion mask and an output directory are required.');
  const atlas = findAtlas(atlasId);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const lesion = await readFile(input);
  const atlasBytes = await loadAtlasBytes(atlas, { cacheDir, offline, onProgress });
  const { tracts, fractions } = await scoreLesion(atlasBytes, lesion, onProgress);
  const id = lesionId(basename(input));
  const name = tableName(id, atlas.id);
  await mkdir(destination, { recursive: true });
  await writeAtomically(join(destination, name), toTsv(tracts, [{ id, fractions }]));
  // As the app counts them: NaN is a bundle with no streamlines in the volume, not damage.
  const damaged = Array.from(fractions).filter((fraction) => fraction >= Number.EPSILON).length;
  return { output: destination, file: name, atlas: atlas.id, bundles: tracts.length, damaged };
}
