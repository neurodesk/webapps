// Pinned Allen CCFv3 50 um atlas asset management for Node: SHA-256 verified downloads,
// atomic staging, bounded gunzip decompression, and offline mode.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { readNiftiImageData } from "@neurodesk/webapp-components/file-io/nifti";
import manifest from "../model.manifest.json" with { type: "json" };

export const ATLAS_ASSETS = Object.freeze(manifest.assets);
export const ATLAS_METADATA = Object.freeze(manifest.atlas);
export const MAX_ATLAS_DECOMPRESSED_BYTES = 128 * 1024 * 1024;

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const offlineByDefault = () => process.env.NEURODESK_OFFLINE === "1";

export function defaultCacheDir() {
  if (process.env.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR) {
    return process.env.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR;
  }
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "neurodesk", "lightsheet-atlas", "allen_mouse_50um");
}

function validateCacheDir(cacheDir) {
  if (typeof cacheDir !== "string" || !cacheDir.trim()) {
    throw new Error("cacheDir must be a non-empty path.");
  }
  return resolve(cacheDir);
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: "wx" });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

async function readVerifiedAsset(directory, asset) {
  const path = join(directory, asset.filename);
  const bytes = await readFile(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!bytes) return null;
  if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
    return { path, valid: false, bytes };
  }
  return { path, valid: true, bytes };
}

/**
 * Ensures all pinned Allen CCFv3 50 um atlas files exist in `cacheDir` with verified SHA-256 digests.
 */
export async function downloadModels({
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  const directory = validateCacheDir(cacheDir);
  if (!offline) await mkdir(directory, { recursive: true });
  const files = [];

  for (const [index, asset] of ATLAS_ASSETS.entries()) {
    const existing = await readVerifiedAsset(directory, asset);
    if (existing?.valid) {
      files.push({ id: asset.id, filename: asset.filename, path: existing.path, sha256: asset.sha256, bytes: asset.bytes, cached: true });
      onProgress(`Verified cached ${asset.filename} (${index + 1}/${ATLAS_ASSETS.length})`);
      continue;
    }
    if (offline) {
      const reason = existing ? "checksum mismatch" : "missing";
      const bundledDir = process.env.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR
        ? resolve(process.env.NEURODESK_LIGHTSHEET_ATLAS_MODEL_DIR)
        : null;
      if (bundledDir && directory === bundledDir && offlineByDefault()) {
        throw new Error(
          `Offline mode: bundled Allen atlas asset '${asset.filename}' is ${reason} in ${directory}. `
          + `Reinstall the portable archive, or run 'lightsheet-atlas download-models --cache-dir <writable-dir>' while online and pass '--cache-dir <writable-dir>'.`,
        );
      }
      throw new Error(`Offline mode: required Allen atlas asset '${asset.filename}' is ${reason} in ${directory}. Run 'lightsheet-atlas download-models --cache-dir "${directory}"' while online.`);
    }
    if (typeof fetchImpl !== "function") {
      throw new Error("Fetch API is unavailable; cannot download Allen atlas assets.");
    }
    onProgress(`Downloading ${asset.filename} (${index + 1}/${ATLAS_ASSETS.length})…`);
    const response = await fetchImpl(asset.url);
    if (!response.ok) {
      throw new Error(`Failed to download ${asset.filename} from ${asset.url}: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== asset.bytes) {
      throw new Error(`${asset.filename}: expected ${asset.bytes} bytes, got ${bytes.byteLength}.`);
    }
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw new Error(`${asset.filename}: SHA-256 mismatch (expected ${asset.sha256}, got ${digest}).`);
    }
    const target = join(directory, asset.filename);
    await writeAtomically(target, bytes);
    files.push({ id: asset.id, filename: asset.filename, path: target, sha256: asset.sha256, bytes: asset.bytes, cached: false });
  }

  return { directory, count: files.length, files };
}

/** Checks which atlas files are present and SHA-256 verified in `cacheDir` without modifying disk. */
export async function inspectModels(cacheDir = defaultCacheDir()) {
  const directory = validateCacheDir(cacheDir);
  const assets = [];
  let ready = true;
  for (const asset of ATLAS_ASSETS) {
    const existing = await readVerifiedAsset(directory, asset);
    const ok = Boolean(existing?.valid);
    if (!ok) ready = false;
    assets.push({
      id: asset.id,
      filename: asset.filename,
      expectedBytes: asset.bytes,
      expectedSha256: asset.sha256,
      present: Boolean(existing),
      verified: ok,
    });
  }
  return { directory, ready, count: ATLAS_ASSETS.length, assets };
}

function boundedGunzip(bytes, label) {
  try {
    return new Uint8Array(gunzipSync(bytes, { maxOutputLength: MAX_ATLAS_DECOMPRESSED_BYTES }));
  } catch (error) {
    throw new Error(`Failed to decompress ${label}: ${error.message}`, { cause: error });
  }
}

/** Loads and decompresses the verified Allen CCFv3 50 um atlas from `cacheDir`. */
export async function loadAtlas({
  cacheDir = defaultCacheDir(),
  offline = offlineByDefault(),
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
} = {}) {
  const { directory } = await downloadModels({ cacheDir, offline, fetchImpl, onProgress });
  const readAsset = async (id) => {
    const asset = ATLAS_ASSETS.find((entry) => entry.id === id);
    const verified = await readVerifiedAsset(directory, asset);
    if (!verified?.valid) {
      throw new Error(`Allen atlas asset '${asset.filename}' failed integrity verification in ${directory}.`);
    }
    return verified.bytes;
  };
  const templateGz = await readAsset("template");
  const annotationGz = await readAsset("annotation");
  const structuresBytes = await readAsset("structures");
  const template = boundedGunzip(templateGz, "allen_mouse_50um_template.nii.gz");
  const annotation = boundedGunzip(annotationGz, "allen_mouse_50um_annotation.nii.gz");
  const structures = JSON.parse(new TextDecoder().decode(structuresBytes));
  return {
    template,
    annotation,
    structures,
    annotationData: readNiftiImageData(annotation, Uint16Array).data,
  };
}
