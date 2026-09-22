// DOM-independent configuration, unit-tested under Node (test/config.test.js).
import manifest from '../../../models/disconnectome.manifest.json' with { type: 'json' };

export const APP = Object.freeze({ id: 'disconnectome' });

const asset = (filename) => {
  const entry = manifest.assets.find((item) => item.filename === filename);
  if (!entry) throw new Error(`Not in the disconnectome manifest: ${filename}`);
  // The revision is baked into base_url, so a changed asset is a changed URL and the browser
  // cache can never serve a stale atlas under a new manifest.
  return Object.freeze({ ...entry, url: manifest.base_url + entry.filename });
};

/** The selectable atlases, each pairing the TVX the numbers come from with the decimated TRX
 *  drawn on screen, in the order they are offered. */
export const ATLASES = Object.freeze(manifest.atlases.map((entry) => Object.freeze({
  id: entry.id,
  label: entry.label,
  bundles: entry.bundles,
  tvx: Object.freeze({ ...asset(entry.tvx), label: entry.label }),
  trx: asset(entry.trx),
  source: Object.freeze({ ...entry.source }),
  default: entry.default === true,
})));

export const DEFAULT_ATLAS = ATLASES.find((atlas) => atlas.default) ?? ATLASES[0];

// Examples live in examples.json, the catalog's own contract; the shared
// nd-example-selector downloads and checksums them.

export const GRID = Object.freeze({ ...manifest.grid });

/** Which files a dropped selection should be treated as: the smaller NIfTI is the lesion,
 *  because a binary mask compresses far smaller than the scan it was drawn on. A single file
 *  is always the lesion, since that is the only required input. */
export function assignInputs(files) {
  const images = files.filter((file) => /\.nii(\.gz)?$/i.test(file.name));
  if (!images.length) return { error: 'Choose a .nii or .nii.gz lesion map.' };
  if (images.length === 1) return { lesion: images[0], anatomical: null };
  const byName = images.filter((file) => /lesion|mask|roi/i.test(file.name));
  const lesion = byName.length === 1 ? byName[0] : [...images].sort((a, b) => a.size - b.size)[0];
  const anatomical = images.find((file) => file !== lesion) ?? null;
  return { lesion, anatomical };
}

/** Bundles at or above the threshold, worst first: what the viewer draws and the summary counts. */
export function damagedBundles(tracts, fractions, threshold) {
  const rows = [];
  for (let i = 0; i < tracts.length; i += 1) {
    const fraction = fractions[i];
    // NaN means the bundle has no streamlines in the volume: no data, so it is not drawn.
    if (Number.isNaN(fraction) || fraction < threshold) continue;
    rows.push({ name: tracts[i], fraction });
  }
  return rows.sort((a, b) => b.fraction - a.fraction);
}
