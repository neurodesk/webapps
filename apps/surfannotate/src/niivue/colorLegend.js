// The on-canvas legend for whatever colour map an overlay is drawn in: a wheel
// for the two retinotopy maps, a bar for everything else.
//
// Pure — no DOM and no NiiVue call. The caller passes the LUT, which is what
// keeps the legend honest: `nv.colormap(key)` hands back the same 256 RGBA
// entries the shader samples, so a legend built from it cannot disagree with the
// surface. Rebuilding the colours from EXTRA_COLORMAPS would drift the moment
// NiiVue changed its interpolation, and would say nothing at all about the maps
// NiiVue ships.

import { cycleUnit } from './colormaps.js';

const TWO_PI = 2 * Math.PI;

/** Where a wheel's tick labels sit, as a multiple of the disk radius. */
const ANGLE_LABEL_RADIUS = 1.16;
/** The eccentricity rings, straight from the reference figure. */
const ECCENTRICITY_RINGS = [1 / 3, 2 / 3, 1];
/**
 * Their labels go up the diagonal, where the reference figure stacks them
 * straight up the vertical. That figure is eight inches across; on a wheel a
 * hundred pixels wide three labels on one radius land ~16px apart and collide,
 * and the diagonal is what separates them in both axes at once.
 */
const ECCENTRICITY_LABEL_ANGLE = Math.PI / 4;
const ECCENTRICITY_LABEL_OFFSET = 0.12;

/**
 * Which legend a colour map needs.
 *
 * @param {string} key
 * @returns {'eccentricity'|'polar_angle'|'bar'}
 */
export function legendKind(key) {
  return key === 'eccentricity' || key === 'polar_angle' ? key : 'bar';
}

/**
 * Decimals enough to tell one end of a range from the other. Shared with the
 * overlay range boxes so a tick and the box it came from never round apart.
 *
 * @param {number} span
 * @returns {number}
 */
export function rangeDecimals(span) {
  return span >= 100 ? 1 : span >= 1 ? 3 : 5;
}

/**
 * The labelled positions around a legend.
 *
 * Two coordinate shapes, because the two layouts have nothing in common: a bar
 * tick is `{label, x}` with x a fraction along the bar, and a wheel tick is
 * `{label, x, y}` on a unit circle centred on the disk with **y pointing up**.
 * The caller flips y once when it places the element.
 *
 * @param {'eccentricity'|'polar_angle'|'bar'} kind
 * @param {number} low
 * @param {number} high
 * @returns {Array<{label: string, x: number, y?: number}>}
 */
export function legendTicks(kind, low, high) {
  const span = high - low;
  if (!Number.isFinite(span) || span <= 0) return [];

  if (kind === 'polar_angle') {
    const unit = cycleUnit(span);
    // East, north, west, south — counter-clockwise, because that is how the
    // data is measured. See the note on paintLegend.
    return [0, 0.25, 0.5, 0.75].map((turn) => {
      const angle = turn * TWO_PI;
      return {
        label: angleLabel(low + turn * span, unit, span),
        x: Math.cos(angle) * ANGLE_LABEL_RADIUS,
        y: Math.sin(angle) * ANGLE_LABEL_RADIUS
      };
    });
  }

  if (kind === 'eccentricity') {
    return ECCENTRICITY_RINGS.map((ring) => {
      const radius = ring + ECCENTRICITY_LABEL_OFFSET;
      return {
        label: format(low + ring * span, span),
        x: Math.cos(ECCENTRICITY_LABEL_ANGLE) * radius,
        y: Math.sin(ECCENTRICITY_LABEL_ANGLE) * radius
      };
    });
  }

  return [0, 0.5, 1].map((fraction) => ({
    label: format(low + fraction * span, span),
    x: fraction
  }));
}

/**
 * The legend's colour field, as RGBA pixels ready for `putImageData`.
 *
 * A bar is a left-to-right ramp. A wheel is a disk — coloured by radius for
 * eccentricity, by azimuth for polar angle — with everything outside it
 * transparent and one pixel of coverage at the rim so the edge is not jagged.
 *
 * The azimuth is `atan2(-y, x)`, and **the minus is load-bearing**: canvas y
 * points down, so without it the wheel comes out mirrored and the upper and
 * lower visual field swap places. Polar angle here is measured the standard
 * way, counter-clockwise from the right horizontal meridian, which is what this
 * subject's V2 shows — dorsal V2 (the lower field) sits near 4.5 rad and
 * ventral V2 (the upper field) near 1.9 rad, and only that convention puts them
 * in the right quadrants.
 *
 * @param {'eccentricity'|'polar_angle'|'bar'} kind
 * @param {ArrayLike<number>} lut 256 RGBA entries, i.e. `nv.colormap(key)`
 * @param {number} width in pixels
 * @param {number} height in pixels
 * @returns {Uint8ClampedArray} width * height * 4
 */
export function paintLegend(kind, lut, width, height = width) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const radius = Math.min(width, height) / 2;
  const centreX = width / 2;
  const centreY = height / 2;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const at = (row * width + column) * 4;
      let index;
      let coverage = 1;

      if (kind === 'bar') {
        index = sample(width > 1 ? column / (width - 1) : 0);
      } else {
        const x = column + 0.5 - centreX;
        const y = row + 0.5 - centreY;
        const distance = Math.hypot(x, y);
        coverage = clamp(radius - distance + 0.5, 0, 1);
        if (coverage === 0) continue;
        index = kind === 'polar_angle'
          ? sample(azimuth(x, y) / TWO_PI)
          : sample(distance / radius);
      }

      pixels[at] = lut[index * 4];
      pixels[at + 1] = lut[index * 4 + 1];
      pixels[at + 2] = lut[index * 4 + 2];
      pixels[at + 3] = lut[index * 4 + 3] * coverage;
    }
  }
  return pixels;
}

/** Counter-clockwise from the right horizontal meridian, in [0, 2*pi). */
function azimuth(x, y) {
  const angle = Math.atan2(-y, x);
  return angle < 0 ? angle + TWO_PI : angle;
}

/** The LUT entry a fraction of the scale lands on. */
function sample(fraction) {
  return Math.min(255, Math.max(0, Math.round(clamp(fraction, 0, 1) * 255)));
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** A tick on a scale whose unit we know, or a plain number when we do not. */
function angleLabel(value, unit, span) {
  if (unit === 'degrees') return `${format(value, span)}°`;
  if (unit === 'radians') return radianLabel(value);
  return format(value, span);
}

/**
 * Quarter turns read better as multiples of pi than as 1.571. Anything that is
 * not a whole multiple of pi/2 falls back to a decimal rather than being forced
 * into a fraction it does not fit.
 */
function radianLabel(value) {
  const halves = Math.round((value / Math.PI) * 2);
  if (Math.abs(value - (halves * Math.PI) / 2) > 1e-6) return String(round(value, 3));
  if (halves === 0) return '0';

  const sign = halves < 0 ? '−' : '';
  const count = Math.abs(halves);
  if (count % 2 === 0) {
    const multiple = count / 2;
    return `${sign}${multiple === 1 ? '' : multiple}π`;
  }
  return `${sign}${count === 1 ? '' : count}π/2`;
}

function format(value, span) {
  return String(round(value, rangeDecimals(span)));
}

function round(value, decimals) {
  return Number(value.toFixed(decimals));
}
