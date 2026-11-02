// How a SamSrf map is drawn on the cortex. Pure, so it is tested under Node.
//
// NiiVue (1.0.0-rc.26) colours a mesh layer from calMin to calMax and leaves
// only nonnegative values below calMin transparent; NaN is drawn black. So a
// layer is encoded rather than handed over raw: shown vertices map their value's
// place in the display window onto [1, 2], hidden ones are 0, and the layer is
// drawn with calMin 1 and calMax 2. The window and the R² threshold therefore
// live here, not in NiiVue.

export const POLAR_COLORMAP = "samsrf-polar";

// Red, yellow, green, cyan, blue, magenta and back to red: a full turn ends on the
// colour it starts on, because -180° and 180° are the same direction.
export const POLAR_COLORMAP_POINTS = Object.freeze({
  I: [0, 43, 85, 128, 170, 213, 255],
  R: [255, 255, 0, 0, 0, 255, 255],
  G: [0, 255, 255, 255, 0, 0, 0],
  B: [0, 0, 0, 255, 255, 255, 0],
  A: [255, 255, 255, 255, 255, 255, 255],
});

/** @typedef {'polar' | 'eccentricity' | 'r2' | 'size' | 'other'} MapKind */

/** @returns {MapKind} */
export function mapKind(name) {
  if (/^polar/i.test(name)) return "polar";
  if (/^eccentricity/i.test(name)) return "eccentricity";
  if (/^(r\^?2|r²)$/i.test(name.trim())) return "r2";
  if (/sigma|fwhm|centre|surround|size/i.test(name)) return "size";
  return "other";
}

const LABELS = { polar: "Polar angle", eccentricity: "Eccentricity", r2: "R²" };

export function mapLabel(name) {
  return LABELS[mapKind(name)] ?? name;
}

const COLORMAPS = { polar: POLAR_COLORMAP, eccentricity: "plasma", r2: "warm", size: "viridis", other: "viridis" };

/** The order maps are offered in: the four retinotopy maps first. */
export function mapOrder(names) {
  const rank = { polar: 0, eccentricity: 1, size: 2, r2: 3, other: 4 };
  return [...names].sort((a, b) => rank[mapKind(a)] - rank[mapKind(b)]);
}

/**
 * The value window and colormap for a map. Eccentricity runs to the stimulus
 * radius (the model's scaling factor) when there is one; sizes and other maps
 * use the 2nd to 98th percentile of the vertices that pass the threshold.
 */
export function mapStyle(name, values, { r2, threshold, scalingFactor }) {
  const kind = mapKind(name);
  const colormap = COLORMAPS[kind];
  if (kind === "polar") return { colormap, window: [-180, 180] };
  if (kind === "r2") return { colormap, window: [0, 1] };
  const [low, high] = percentiles(shownValues(values, r2, threshold), 0.02, 0.98);
  if (kind === "eccentricity") return { colormap, window: [0, Number(scalingFactor) > 0 ? Number(scalingFactor) : Math.max(high, 1e-6)] };
  if (kind === "size") return { colormap, window: [0, Math.max(high, 1e-6)] };
  return { colormap, window: low < high ? [low, high] : [low - 1, low + 1] };
}

function shownValues(values, r2, threshold) {
  const shown = [];
  for (let index = 0; index < values.length; index++) {
    if (r2[index] > threshold && Number.isFinite(values[index])) shown.push(values[index]);
  }
  return shown;
}

function percentiles(values, low, high) {
  if (!values.length) return [0, 1];
  const sorted = Float64Array.from(values).sort();
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  return [at(low), at(high)];
}

/**
 * Encode a map for a NiiVue mesh layer (see the note at the top): a vertex is
 * shown when its R² is above the threshold, as SamSrf's DisplayMaps does.
 * @returns {Float32Array}
 */
export function encodeOverlay(values, r2, threshold, [low, high]) {
  const encoded = new Float32Array(values.length);
  const span = high - low || 1;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!(r2[index] > threshold) || !Number.isFinite(value)) continue;
    encoded[index] = 1 + Math.min(1, Math.max(0, (value - low) / span));
  }
  return encoded;
}

/** How many vertices a threshold keeps, for the info bar. */
export function countShown(r2, threshold) {
  let count = 0;
  for (const value of r2) if (value > threshold) count++;
  return count;
}

/** Camera positions for the left and right hemisphere. */
export function cameraFor(view, hemisphere) {
  const left = hemisphere !== "rh";
  const views = {
    lateral: { azimuth: left ? 90 : 270, elevation: 0 },
    medial: { azimuth: left ? 270 : 90, elevation: 0 },
    posterior: { azimuth: 0, elevation: 0 },
    ventral: { azimuth: 180, elevation: -90 },
  };
  return views[view] ?? views.lateral;
}

/** lh or rh from file names such as lh_uBars1.gii, rh.inflated. */
export function hemisphereOf(names) {
  for (const name of names) {
    const match = /(?:^|[^a-z])(lh|rh)(?:[^a-z]|$)/i.exec(name);
    if (match) return match[1].toLowerCase();
  }
  return null;
}
