// BISON assets in the browser: published files from their pinned URLs, held files from a base URL
// the host gives (a local copy of the asset directory) while their publication is pending. Every
// file is checked against the manifest's size and sha256 (assets.js) and kept in the shared,
// content-addressed Cache Storage of fetchModel, so a later run does not download it again.
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { assetsFor, loadAssets, manifest } from './assets.js';

/** The URL of one asset: its pinned URL, or heldBaseUrl + filename for a held asset. Null when there is none. */
export function assetUrl(asset, heldBaseUrl = null) {
  if (asset.held && heldBaseUrl) return new URL(asset.filename, heldBaseUrl).href;
  return asset.url ?? null;
}

// A base URL names a directory, so it ends with "/" (else new URL() replaces its last part).
function directoryUrl(value) {
  const url = new URL(value, globalThis.location?.href);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

/** The error for held assets that have no URL. */
export function heldAssetError(assets) {
  const names = assets.map((asset) => asset.filename).join(', ');
  return new Error(`The BISON models are not published yet (${manifest.held_assets.status}). Give the URL of a local BISON asset directory for: ${names}.`);
}

/**
 * The verified assets for `modes` ('t1', 't1-flair'), as a Map of manifest filename to bytes.
 * onProgress(message, fraction) reports each file and the fraction of all bytes received.
 * Held assets without a URL are refused before the first download.
 * @param {{ modes: string[], heldBaseUrl?: string|URL|null, onProgress?: Function, signal?: AbortSignal, fetch?: Function, cache?: string|object|null }} options
 * @returns {Promise<Map<string, Uint8Array>>}
 */
export async function loadBrowserAssets({ modes, heldBaseUrl = null, onProgress = () => {}, signal, fetch = globalThis.fetch, cache } = {}) {
  const assets = assetsFor(modes);
  const base = heldBaseUrl ? directoryUrl(heldBaseUrl) : null;
  const missing = assets.filter((asset) => !assetUrl(asset, base));
  if (missing.length) throw heldAssetError(missing);
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  let done = 0;
  let message = '';
  const read = async (asset) => {
    signal?.throwIfAborted();
    let bytes;
    try {
      bytes = await fetchModel(
        { url: assetUrl(asset, base), integrity: { bytes: asset.bytes, sha256: asset.sha256 } },
        {
          fetch,
          signal,
          ...(cache === undefined ? {} : { cache }),
          requestFailureMessage: `${asset.filename} did not download.`,
          onProgress: ({ received }) => onProgress(message, (done + received) / total),
        },
      );
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message?.startsWith(asset.filename)) throw error;
      throw new Error(`${asset.filename}: ${error?.message ?? error}`, { cause: error });
    }
    done += asset.bytes;
    return bytes;
  };
  return loadAssets(assets, {
    read,
    onProgress: (text) => {
      message = text;
      onProgress(text, done / total);
    },
  });
}
