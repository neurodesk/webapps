// BISON's assets: the ICBM 2009c template and mask (published), and the BISON priors, average
// FLAIR, histogram tables and classifiers (held until the authors allow publication). Every file is
// checked against the manifest's size and sha256, whatever it is read from. No DOM, no Node imports.
import manifest from '../model.manifest.json' with { type: 'json' };

export { manifest };

/** The held assets have no URL until they are uploaded; read them from a local directory. */
export const HELD_PENDING = manifest.held_assets.base_url === 'PENDING';

function entry(asset, held) {
  let url = asset.url ?? null;
  if (!url && !held) url = manifest.base_url + asset.filename;
  if (!url && held && !HELD_PENDING) url = manifest.held_assets.base_url + asset.filename;
  return Object.freeze({ ...asset, held, url });
}

export const ASSETS = Object.freeze([
  ...manifest.assets.map((asset) => entry(asset, false)),
  ...manifest.held_assets.assets.map((asset) => entry(asset, true)),
]);

export const TEMPLATE_T1 = 'templates/mni_icbm152_t1_tal_nlin_sym_09c.nii.gz';
export const TEMPLATE_MASK = 'templates/mni_icbm152_t1_tal_nlin_sym_09c_mask.nii.gz';
export const TEMPLATE_COPYING = 'templates/COPYING';
export const BISON_LICENCE = 'models/LICENCE-BISON.txt';
export const AV_FLAIR = 'models/t1-flair/Av_FLAIR.nii.gz';

const priors = (dir, count) => Array.from({ length: count }, (_, k) => `models/${dir}/SP_${k + 1}.nii.gz`);

/** The files each mode reads besides the template, mask and licences. */
export const MODE_ASSETS = Object.freeze({
  t1: Object.freeze({
    classifier: 'models/bison-t1.onnx',
    priors: Object.freeze(priors('t1', 8)),
    t1Histogram: 'models/t1/t1-histogram.json',
  }),
  't1-flair': Object.freeze({
    classifier: 'models/bison-t1-flair.onnx',
    priors: Object.freeze(priors('t1-flair', 9)),
    t1Histogram: 'models/t1-flair/t1-histogram.json',
    flairHistogram: 'models/t1-flair/flair-histogram.json',
    avFlair: AV_FLAIR,
  }),
});

export function findAsset(filename) {
  const asset = ASSETS.find((candidate) => candidate.filename === filename);
  if (!asset) throw new Error(`${filename} is not a BISON asset.`);
  return asset;
}

/** The assets that the given modes need, each once, in manifest order. */
export function assetsFor(modes) {
  const wanted = new Set([TEMPLATE_T1, TEMPLATE_MASK, TEMPLATE_COPYING, BISON_LICENCE]);
  for (const mode of modes) {
    const files = MODE_ASSETS[mode];
    if (!files) throw new Error(`Unknown BISON mode: ${mode}`);
    for (const value of Object.values(files)) {
      for (const filename of [value].flat()) wanted.add(filename);
    }
  }
  return ASSETS.filter((asset) => wanted.has(asset.filename));
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyAsset(asset, bytes) {
  if (bytes.byteLength !== asset.bytes) throw new Error(`${asset.filename} has ${bytes.byteLength} bytes, not ${asset.bytes}.`);
  if ((await sha256Hex(bytes)) !== asset.sha256) throw new Error(`${asset.filename} failed checksum verification.`);
  return bytes;
}

/**
 * Reads and verifies assets. `read(asset)` returns the bytes from wherever the host keeps them.
 * @returns {Promise<Map<string, Uint8Array>>} filename to verified bytes
 */
export async function loadAssets(assets, { read, onProgress = () => {} }) {
  const files = new Map();
  for (const asset of assets) {
    onProgress(`Loading ${asset.filename}`);
    const bytes = new Uint8Array(await read(asset));
    files.set(asset.filename, await verifyAsset(asset, bytes));
  }
  return files;
}

/**
 * A reader that fetches each asset from its pinned URL, or from `baseUrl` + filename when the host
 * serves a local copy of the asset directory.
 */
export function fetchReader({ baseUrl = null, fetch = globalThis.fetch } = {}) {
  return async (asset) => {
    const url = baseUrl ? new URL(asset.filename, baseUrl).href : asset.url;
    if (!url) throw new Error(`${asset.filename} is not published yet (held: ${manifest.held_assets.status}). Use a local BISON asset directory.`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${asset.filename}: HTTP ${response.status}`);
    return response.arrayBuffer();
  };
}
