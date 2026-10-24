// BISON assets in Node: from a local directory laid out as the dataset's bison/ folder
// (`BISON_ASSET_DIR`, needed while the held assets are unpublished), or downloaded once into a
// cache. Every file is verified against the manifest, the local directory's included.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ASSETS, assetsFor, fetchReader, loadAssets, verifyAsset } from './assets.js';

/** The local asset directory: the option, else BISON_ASSET_DIR, else none. */
export function assetDirectory(option) {
  return option ?? (process.env.BISON_ASSET_DIR || null);
}

export function directoryReader(dir) {
  return async (asset) => {
    try {
      return await readFile(join(dir, asset.filename));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`${asset.filename} is missing from the BISON asset directory ${dir}.`);
      throw error;
    }
  };
}

// Named after the asset set, so a re-pinned asset never meets a stale cached copy.
export function defaultCacheDir() {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  const pins = ASSETS.map(({ filename, sha256 }) => `${filename} ${sha256}`).sort().join('\n');
  return join(cache, 'neurodesk', 'bison', createHash('sha256').update(pins).digest('hex').slice(0, 16));
}

async function writeAtomically(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

// Reads a verified cached copy, else downloads, verifies and caches.
function cacheReader(cacheDir, { offline, fetch }) {
  const download = fetchReader({ fetch });
  return async (asset) => {
    const path = join(cacheDir, asset.filename);
    try {
      return await verifyAsset(asset, new Uint8Array(await readFile(path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cached ${asset.filename} is not usable (${error.message}). Delete ${path} and download it again.`);
    }
    if (offline) throw new Error(`${asset.filename} is missing from the offline asset cache ${cacheDir}.`);
    const bytes = await verifyAsset(asset, new Uint8Array(await download(asset)));
    await writeAtomically(path, bytes);
    return bytes;
  };
}

/**
 * The verified assets for `modes` ('t1', 't1-flair').
 * @param {{ modes: string[], assetDir?: string, cacheDir?: string, offline?: boolean, onProgress?: Function, fetch?: Function }} options
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function loadNodeAssets({ modes, assetDir, cacheDir = defaultCacheDir(), offline = false, onProgress, fetch = globalThis.fetch }) {
  const dir = assetDirectory(assetDir);
  const read = dir ? directoryReader(dir) : cacheReader(cacheDir, { offline, fetch });
  return loadAssets(assetsFor(modes), { read, onProgress });
}
