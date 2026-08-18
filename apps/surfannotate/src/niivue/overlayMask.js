// Restricting overlays to the vertices a binary mask marks.
//
// Pure — no DOM and no NiiVue call, but written around one NiiVue fact. Mesh
// layers are composited on the CPU in `blendColormap`, which decides a vertex is
// transparent on one test and one test only:
//
//     const v = layer.values[j];
//     if (v < mnCal) continue;              // mnCal = cal_min, or -Infinity
//
// There is no per-vertex alpha to write and no "skip this vertex" flag. The
// value *is* the alpha channel, so masking has to happen in the values — hence
// MASKED_OUT below, and hence the pristine copy the caller has to keep.
//
// Two things follow, both easy to get wrong:
//
//  - NaN does not work as the sentinel. `NaN < mnCal` is false, so the vertex is
//    kept, and every arithmetic step after it stays NaN until the colour lookup
//    reads past the end of the LUT and writes black. -Infinity is the only value
//    that is reliably below every finite cal_min.
//  - `isTransparentBelowCalMin` must be turned on for the test to run at all;
//    with it off, `mnCal` is -Infinity and even MASKED_OUT survives. But that
//    flag also drops genuine data below the window, which today clamps to the
//    bottom colour. Clamping the kept values up to cal_min ourselves is what
//    keeps the mask from quietly punching holes in the overlay everywhere the
//    2nd percentile cut.

/** Below every finite `cal_min`, which is what makes a vertex transparent. */
export const MASKED_OUT = -Infinity;

/**
 * Any non-zero, finite value marks a vertex as inside the mask.
 *
 * Deliberately not a threshold: a binary mask is 1s and 0s, and picking 0.5
 * would silently reinterpret a mask written as 2s, or as region labels.
 *
 * @param {ArrayLike<number>} values one per vertex
 * @returns {Uint8Array} 1 inside, 0 outside
 */
export function toBinaryMask(values) {
  const mask = new Uint8Array(values.length);
  for (let v = 0; v < values.length; v++) {
    const value = values[v];
    mask[v] = Number.isFinite(value) && value !== 0 ? 1 : 0;
  }
  return mask;
}

/** How many vertices a mask keeps. */
export function maskedInCount(mask) {
  let count = 0;
  for (let v = 0; v < mask.length; v++) count += mask[v];
  return count;
}

/**
 * The values to hand NiiVue: the overlay's own where the mask keeps a vertex,
 * MASKED_OUT where it does not.
 *
 * Kept values are clamped up to `calMin` because the mask needs
 * `isTransparentBelowCalMin` on, and that would otherwise also drop everything
 * below the display window. Clamping reproduces exactly what an unmasked
 * overlay does with those vertices today — paint them the bottom colour.
 *
 * A vertex whose value is not finite is dropped rather than clamped. There is
 * no colour for "no data", and NiiVue renders it black.
 *
 * @param {ArrayLike<number>} base the overlay's pristine values
 * @param {ArrayLike<number>} mask 1 inside, 0 outside
 * @param {number} calMin the layer's display-window floor
 * @param {Float32Array} [out] reused across calls; allocated when absent
 * @returns {Float32Array}
 */
export function maskedValues(base, mask, calMin, out = new Float32Array(base.length)) {
  const floor = Number.isFinite(calMin) ? calMin : -Number.MAX_VALUE;
  for (let v = 0; v < base.length; v++) {
    const value = base[v];
    out[v] = mask[v] && Number.isFinite(value) ? Math.max(value, floor) : MASKED_OUT;
  }
  return out;
}

/**
 * Whether an overlay is anatomical shading rather than data.
 *
 * Curvature is the surface's own shape, not a measurement on it: it is what the
 * user is looking *through* the mask at, so masking it would leave nothing
 * underneath. Matched on the FreeSurfer naming the request named — `lh.curv`,
 * `rh.curv` and anything extending them — and used only as the default for a
 * per-overlay switch, so a curvature file under another name is one click away.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isCurvatureName(name) {
  return /^[lr]h\.curv/i.test(name || '');
}
