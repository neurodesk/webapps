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
 * Eccentricity (DL): matplotlib's `rainbow_r`, red at the fovea to violet at the
 * periphery.
 *
 * Unlike gist_rainbow this cannot be transcribed — matplotlib defines `rainbow`
 * by function, and two of its three channels are curves where NiiVue only
 * interpolates linearly. Sampled at 17 points, which stays within 1.4/255 of
 * matplotlib; 9 points is off by 4.9 and visibly banded.
 */
export const ECCENTRICITY = {
  I: [0, 16, 32, 48, 64, 80, 96, 112, 128, 143, 159, 175, 191, 207, 223, 239, 255],
  R: [255, 255, 255, 255, 254, 222, 190, 158, 126, 96, 64, 32, 0, 32, 64, 96, 128],
  G: [0, 50, 98, 142, 181, 213, 236, 250, 255, 250, 236, 213, 181, 142, 98, 50, 0],
  B: [0, 25, 50, 74, 98, 121, 142, 162, 181, 197, 212, 225, 235, 244, 250, 254, 255],
  A: [255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]
};

/**
 * Polar angle (DL): yellow, blue, green, red, yellow, evenly spaced.
 *
 * **Cyclic** — it ends on the colour it starts on, because 0 and 2*pi are the
 * same direction. That is what makes the display window part of the map rather
 * than a preference; see `colormapWindow`. `I` is an array index in NiiVue, so
 * the quarter points are rounded to whole numbers: every anchor colour still
 * lands exactly and the ramp shifts by at most a quarter of one of 256 steps.
 */
export const POLAR_ANGLE = {
  I: [0, 64, 128, 191, 255],
  R: [255, 0, 0, 255, 255],
  G: [255, 0, 255, 0, 255],
  B: [0, 255, 0, 0, 0],
  A: [255, 255, 255, 255, 255]
};

export const EXTRA_COLORMAPS = Object.freeze({
  gist_rainbow: GIST_RAINBOW,
  eccentricity: ECCENTRICITY,
  polar_angle: POLAR_ANGLE
});

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
 * Most maps have none. These two do: a cyclic map under the 2nd-98th percentile
 * default wraps inside the data, so two angles a quarter-turn apart render
 * alike, and eccentricity has to start at zero for two subjects to be
 * comparable. Null when the key needs no window, and when a polar-angle map's
 * values fit no convention — better than inventing a turn the data lacks.
 *
 * @param {string} key
 * @param {ArrayLike<number>|null} values one per vertex
 * @param {{low: number, high: number}|null} [autoRange] the robust range
 * @returns {{low: number, high: number, unit: string|null, note: string}|null}
 */
export function colormapWindow(key, values, autoRange = null) {
  const { min, max } = extent(values);

  if (key === 'eccentricity') {
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

  if (key === 'polar_angle') {
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
