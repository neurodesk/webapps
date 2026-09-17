// Turning the ordered ROI list into one label per vertex, for the
// whole-parcellation exports. Pure: takes the resolved masks, gives back arrays.

/**
 * @typedef {object} ParcellationLabels
 * @property {Int32Array} labels   0 for unclaimed, else 1-based position in `entries`
 * @property {Array<{name: string, rgb: number[]}>} entries  in list order, RGB bytes
 * @property {string[]} skipped    ROIs left out because they did not resolve
 */

/**
 * @param {Array<{name: string, mask: Uint8Array|null, colorIndex: number}>} rois
 *   in list order — the order is the priority the masks were resolved under,
 *   so they are already disjoint and nothing here has to arbitrate
 * @param {number} vertexCount
 * @param {number[][]} palette RGB in 0..1, indexed by colorIndex
 * @returns {ParcellationLabels}
 */
export function parcellationLabels(rois, vertexCount, palette) {
  const labels = new Int32Array(vertexCount);
  const entries = [];
  const skipped = [];
  for (const roi of rois) {
    if (!roi.mask) {
      skipped.push(roi.name);
      continue;
    }
    const key = entries.length + 1;
    entries.push({
      name: roi.name,
      rgb: palette[roi.colorIndex % palette.length].map((c) => Math.round(c * 255))
    });
    for (let v = 0; v < vertexCount; v++) if (roi.mask[v]) labels[v] = key;
  }
  return { labels, entries, skipped };
}
