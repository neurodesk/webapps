// Colour maps NiiVue 0.69 does not ship, registered at startup.
//
// NiiVue's ColorMap is a set of control points: I holds positions on 0..255 and
// R/G/B/A the channel values there; it interpolates between them.

/**
 * matplotlib's gist_rainbow. Control points transcribed from
 * `_gist_rainbow_data` in matplotlib/_cm.py, with positions scaled to 0..255.
 *
 * Unlike `jet` it starts and ends on magenta rather than dark blue/red, so the
 * two ends of the scale stay distinguishable — which is why it is a common
 * choice for cortical parcellation and retinotopy overlays.
 */
const GIST_RAINBOW = {
  I: [0, 8, 55, 102, 149, 196, 243, 255],
  R: [255, 255, 255, 0, 0, 0, 255, 255],
  G: [0, 0, 255, 255, 255, 0, 0, 0],
  B: [41, 0, 0, 0, 255, 255, 255, 191],
  A: [255, 255, 255, 255, 255, 255, 255, 255]
};

/**
 * Eccentricity, `RYGBP_eccentricity` (DL): matplotlib's `rainbow_r` — red at
 * the fovea, through yellow, green and blue, to purple at the periphery. The
 * key spells that sequence out, so the name says what the scale looks like.
 *
 * Unlike gist_rainbow this cannot be transcribed — matplotlib defines `rainbow`
 * by function, and two of its three channels are curves where NiiVue only
 * interpolates linearly. Sampled at 17 points, which stays within 1.4/255 of
 * matplotlib; 9 points is off by 4.9 and visibly banded.
 */
export const ECCENTRICITY_RYGBP = {
  I: [0, 16, 32, 48, 64, 80, 96, 112, 128, 143, 159, 175, 191, 207, 223, 239, 255],
  R: [255, 255, 255, 255, 254, 222, 190, 158, 126, 96, 64, 32, 0, 32, 64, 96, 128],
  G: [0, 50, 98, 142, 181, 213, 236, 250, 255, 250, 236, 213, 181, 142, 98, 50, 0],
  B: [0, 25, 50, 74, 98, 121, 142, 162, 181, 197, 212, 225, 235, 244, 250, 254, 255],
  A: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
};

/**
 * Polar angle, `YBGR_polar-angle` (DL): yellow, blue, green, red, yellow,
 * evenly spaced.
 *
 * **Cyclic** — it ends on the colour it starts on, because 0 and 2*pi are the
 * same direction. That is what makes the display window part of the map rather
 * than a preference; see `colormapWindow`. `I` is an array index in NiiVue, so
 * the quarter points are rounded to whole numbers: every anchor colour still
 * lands exactly and the ramp shifts by at most a quarter of one of 256 steps.
 */
export const POLAR_ANGLE_YBGR = {
  I: [0, 64, 128, 191, 255],
  R: [255, 0, 0, 255, 255],
  G: [255, 0, 255, 0, 255],
  B: [0, 255, 0, 0, 0],
  A: [255, 255, 255, 255, 255]
};

/**
 * Polar angle, `RYGBP_polar-angle`: gist_rainbow read as a turn — red, yellow,
 * green, blue, pink (magenta), and back to red. The convention many
 * retinotopy figures are drawn in.
 *
 * Same control points as `gist_rainbow`; what differs is the treatment. Under
 * this key the map is a *polar-angle* map: it gets the wheel legend and the
 * one-full-turn window. Note it is only nearly cyclic — matplotlib's two ends
 * are (255, 0, 41) and (255, 0, 191), a red and a magenta — so there is a
 * faint seam at 0 = 2*pi on the right horizontal meridian. That is the map as
 * people know it, and is left as is rather than "corrected" into something
 * that no longer matches the figures it is meant to be compared with.
 */
export const POLAR_ANGLE_RYGBP = GIST_RAINBOW;

/**
 * `RYBC`: red, yellow, blue, cyan, evenly spaced and linearly interpolated
 * between. Used for both quantities, and the two differ in one stop: as
 * `RYBC_polar-angle` the ramp comes back to red at the full turn, so it is
 * cyclic and gets the wheel and the full-turn window; as `RYBC_eccentricity`
 * it runs red at the fovea out to cyan at the periphery and stops there,
 * with the rings and the zero-anchored window.
 */
export const POLAR_ANGLE_RYBC = {
  I: [0, 64, 128, 191, 255],
  R: [255, 255, 0, 0, 255],
  G: [0, 255, 0, 255, 0],
  B: [0, 0, 255, 255, 0],
  A: [255, 255, 255, 255, 255]
};
export const ECCENTRICITY_RYBC = {
  I: [0, 85, 170, 255],
  R: [255, 255, 0, 0],
  G: [0, 255, 0, 255],
  B: [0, 0, 255, 255],
  A: [255, 255, 255, 255]
};

/**
 * The colour a control-point map takes at one LUT index, interpolated the way
 * NiiVue's `makeLut` does it: linearly within the segment the index falls in.
 * Rounded, because that is what the LUT holds.
 *
 * @param {{I: number[], R: number[], G: number[], B: number[], A: number[]}} cmap
 * @param {number} index 0..255
 * @returns {[number, number, number, number]} RGBA
 */
export function sampleControlPoints(cmap, index) {
  const last = cmap.I.length - 1;
  let k = 0;
  while (k < last - 1 && cmap.I[k + 1] < index) k++;
  const lo = cmap.I[k];
  const hi = cmap.I[k + 1];
  const f = hi === lo ? 0 : (index - lo) / (hi - lo);
  return ['R', 'G', 'B', 'A'].map((channel) =>
    Math.round(cmap[channel][k] + f * (cmap[channel][k + 1] - cmap[channel][k])));
}

/**
 * The same polar-angle map seen from the other hemisphere: mirrored about the
 * vertical meridian, so the colour at angle θ becomes the colour at π − θ.
 * A left-hemisphere map and a right-hemisphere map then read alike — the
 * upper field stays up, the lower field stays down, and what was nasal is
 * temporal.
 *
 * On the 256-entry LUT that is index j ← (128 − j) mod 256: every control
 * point moves to its mirror image, and the two ends the map needs — 0 and
 * 255 — are the original's colours at 128 and 129. The original's own ends
 * land next to each other at 128 and 129, so a map that is only nearly
 * cyclic (gist_rainbow) keeps its seam, now on the left horizontal meridian
 * rather than the right — which is exactly where a mirror puts it.
 *
 * Derived rather than transcribed, so the flipped map cannot drift from the
 * one it mirrors. Stops are keyed by index, because NiiVue divides by the
 * segment length and two stops on one index would paint that entry black.
 *
 * @param {{I: number[], R: number[], G: number[], B: number[], A: number[]}} cmap
 * @returns {{I: number[], R: number[], G: number[], B: number[], A: number[]}}
 */
export function mirrorPolarAngle(cmap) {
  const stops = new Map();
  for (let k = 0; k < cmap.I.length; k++) {
    stops.set((128 - cmap.I[k] + 256) % 256, [cmap.R[k], cmap.G[k], cmap.B[k], cmap.A[k]]);
  }
  if (!stops.has(0)) stops.set(0, sampleControlPoints(cmap, 128));
  if (!stops.has(255)) stops.set(255, sampleControlPoints(cmap, 129));
  const I = [...stops.keys()].sort((a, b) => a - b);
  const channel = (c) => I.map((index) => stops.get(index)[c]);
  return { I, R: channel(0), G: channel(1), B: channel(2), A: channel(3) };
}

/**
 * What a colour map *measures*, which is what decides its legend and window.
 * Keyed by name so several maps can share a role: every polar-angle map gets
 * the wheel and the full turn, whichever colours it runs through.
 */
const COLORMAP_ROLES = Object.freeze({
  RYGBP_eccentricity: 'eccentricity',
  RYBC_eccentricity: 'eccentricity',
  'YBGR_polar-angle': 'polar_angle',
  'RYGBP_polar-angle': 'polar_angle',
  'RYBC_polar-angle': 'polar_angle'
});

/**
 * A polar-angle map's mirror image is registered under its own key, because a
 * NiiVue layer is coloured by key and nothing else. The suffix is an
 * implementation detail: the picker lists only the base maps, and the flip is
 * a checkbox that composes the key (`colormapKey`) and reads it back
 * (`baseColormap`, `isFlipped`).
 */
const FLIP_SUFFIX = '-flipped';

/** The map a key names before any flip. */
export function baseColormap(key) {
  return key.endsWith(FLIP_SUFFIX) ? key.slice(0, -FLIP_SUFFIX.length) : key;
}

/** Whether a key names the mirrored form of its base map. */
export function isFlipped(key) {
  return key.endsWith(FLIP_SUFFIX);
}

/** Only a polar-angle map has a hemisphere to be flipped for. */
export function canFlip(key) {
  return colormapRole(key) === 'polar_angle';
}

/**
 * The key to colour a layer with: the base map, or its mirror image when
 * asked for and it has one. A flip requested on a map that cannot take it is
 * ignored rather than refused, so the checkbox can stay set across a switch
 * to an eccentricity map and back.
 * @param {string} base
 * @param {boolean} flipped
 */
export function colormapKey(base, flipped) {
  return flipped && canFlip(base) ? `${base}${FLIP_SUFFIX}` : base;
}

const BASE_COLORMAPS = {
  gist_rainbow: GIST_RAINBOW,
  RYGBP_eccentricity: ECCENTRICITY_RYGBP,
  RYBC_eccentricity: ECCENTRICITY_RYBC,
  'YBGR_polar-angle': POLAR_ANGLE_YBGR,
  'RYGBP_polar-angle': POLAR_ANGLE_RYGBP,
  'RYBC_polar-angle': POLAR_ANGLE_RYBC
};

export const EXTRA_COLORMAPS = Object.freeze(Object.fromEntries(
  Object.entries(BASE_COLORMAPS).flatMap(([key, cmap]) =>
    canFlip(key)
      ? [[key, cmap], [`${key}${FLIP_SUFFIX}`, mirrorPolarAngle(cmap)]]
      : [[key, cmap]])
));

/**
 * The retinotopic quantity a colour map is for, or null for an ordinary map.
 * @param {string} key
 * @returns {'eccentricity'|'polar_angle'|null}
 */
export function colormapRole(key) {
  return COLORMAP_ROLES[baseColormap(key)] ?? null;
}

/**
 * Register every extra colour map on a NiiVue instance. Safe to call more than
 * once — addColormap overwrites by key.
 * @param {import('@niivue/niivue').Niivue} nv
 * @returns {string[]} the keys registered
 */
export function registerExtraColormaps(nv) {
  const registered = [];
  for (const [key, cmap] of Object.entries(EXTRA_COLORMAPS)) {
    try {
      nv.addColormap(key, cmap);
      registered.push(key);
    } catch (error) {
      console.warn(`surfannotate: could not register colormap "${key}"`, error);
    }
  }
  return registered;
}

/** The interpolated LUT NiiVue uses to render a named colour map. */
export function sampledColormap(nv, key) {
  return nv.colormap(key);
}

/**
 * One full turn, smallest first. Matched against the data's own maximum: an
 * angle map in degrees never peaks below 7 and one in radians never above 2*pi,
 * so nothing has to be configured. The tolerance is for a max of 6.2832.
 */
const FULL_CYCLES = [
  { span: 2 * Math.PI, unit: 'radians' },
  { span: 360, unit: 'degrees' }
];
const CYCLE_TOLERANCE = 1.01;

/**
 * The unit of a window that spans exactly one full turn, or null for a window
 * that does not. Distinct from the test above, which asks whether a *maximum*
 * fits inside a turn: a legend is handed a window that may have been typed by
 * hand, and 0 – 5 is neither radians nor degrees of anything.
 *
 * @param {number} span
 * @returns {'radians'|'degrees'|null}
 */
export function cycleUnit(span) {
  const cycle = FULL_CYCLES.find(
    (candidate) => Math.abs(span - candidate.span) <= candidate.span * (CYCLE_TOLERANCE - 1)
  );
  return cycle ? cycle.unit : null;
}

/**
 * The display window a colour map is only meaningful in (DL).
 *
 * Most maps have none. The retinotopy maps do: a cyclic map under the 2nd-98th
 * percentile default wraps inside the data, so two angles a quarter-turn apart
 * render alike, and eccentricity has to start at zero for two subjects to be
 * comparable. The rule is keyed on the map's role, so every polar-angle map
 * gets the same turn. Null when the key needs no window, and when a
 * polar-angle map's values fit no convention — better than inventing a turn
 * the data lacks.
 *
 * @param {string} key
 * @param {ArrayLike<number>|null} values one per vertex
 * @param {{low: number, high: number}|null} [autoRange] the robust range
 * @returns {{low: number, high: number, unit: string|null, note: string}|null}
 */
export function colormapWindow(key, values, autoRange = null) {
  const { min, max } = extent(values);
  const role = colormapRole(key);

  if (role === 'eccentricity') {
    const high = Number.isFinite(autoRange?.high) ? autoRange.high : max;
    if (!Number.isFinite(high) || high <= 0) return null;
    return {
      low: 0,
      high,
      unit: null,
      note: `Eccentricity: window set to 0 – ${round(high)}, so the fovea sits at ` +
        "the bottom of the scale. Auto goes back to the data's percentile range."
    };
  }

  if (role === 'polar_angle') {
    if (!Number.isFinite(min)) return null;
    const cycle = FULL_CYCLES.find((candidate) => max <= candidate.span * CYCLE_TOLERANCE);
    if (!cycle) return null;
    // Signed data is the same turn centred on zero.
    const low = min < 0 ? -cycle.span / 2 : 0;
    return {
      low,
      high: low + cycle.span,
      unit: cycle.unit,
      note: `Polar angle: window set to one full cycle, ${round(low)} – ` +
        `${round(low + cycle.span)} (${cycle.unit}), because the colour map wraps. ` +
        "Auto goes back to the data's percentile range."
    };
  }

  return null;
}

/** Smallest and largest finite value, or NaN either side when there are none. */
function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < (values?.length || 0); i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min > max) return { min: NaN, max: NaN };
  return { min, max };
}

/** Enough decimals to tell 2*pi from 6. */
function round(value) {
  return Number(value.toFixed(3));
}
