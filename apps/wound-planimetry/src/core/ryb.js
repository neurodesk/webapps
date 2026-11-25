// Pure DOM-free color-based Red-Yellow-Black (RYB) wound tissue estimation
// using CIE L*a*b* and HSV hue thresholds (inspired by Mukherjee et al.,
// BioMed Res. Int. 2014, DOI 10.1155/2014/851582). Heuristic color-based
// estimates only — not trained clinical tissue classification.
import { ALPHA_OPAQUE_MIN, rgbToHue } from "./color.js";

export const RYB_CLASSES = Object.freeze([
  Object.freeze({ code: 1, key: "red", label: "Red (granulation)" }),
  Object.freeze({ code: 2, key: "yellow", label: "Yellow (slough / fibrin)" }),
  Object.freeze({ code: 3, key: "black", label: "Black (eschar / necrosis)" }),
  Object.freeze({ code: 4, key: "unclassified", label: "Unclassified" }),
]);

const ESCHAR_MAX_CHROMA = 25;
const RED_HUE_LOW_MAX = 35;
const RED_HUE_HIGH_MIN = 315;
const YELLOW_HUE_MIN = 30;
const YELLOW_HUE_MAX = 75;

/**
 * Estimate color-based RYB tissue classes for opaque pixels inside the wound mask:
 *   0 = outside wound mask (or transparent)
 *   1 = Red (granulation)
 *   2 = Yellow (slough / fibrin)
 *   3 = Black (eschar / necrosis)
 *   4 = Unclassified
 *
 * @param {{ L: Float32Array, a: Float32Array, b: Float32Array, opaque?: Uint8Array, rgba?: Uint8Array | Uint8ClampedArray, H?: Float32Array }} colors
 * @param {Uint8Array} mask
 * @param {{ escharL?: number, granulationA?: number, sloughB?: number, pixelsPerMm?: number }} [options]
 */
export function classifyRyb(
  colors,
  mask,
  { escharL = 28, granulationA = 22, sloughB = 18, pixelsPerMm = 0 } = {},
) {
  const { L, a, b, opaque = null, rgba = null, H = null } = colors;
  const count = mask.length;
  const labels = new Uint8Array(count);
  const counts = [0, 0, 0, 0, 0];

  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    if (opaque && !opaque[i]) continue;
    const p = i * 4;
    if (!opaque && rgba && rgba[p + 3] < ALPHA_OPAQUE_MIN) continue;

    const li = L[i];
    const ai = a[i];
    const bi = b[i];
    const hi = rgba ? rgbToHue(rgba[p], rgba[p + 1], rgba[p + 2]) : H ? H[i] : 0;
    const chroma = Math.hypot(ai, bi);

    let cls = 4;
    if (li < escharL && chroma < ESCHAR_MAX_CHROMA) {
      cls = 3; // Black: eschar / necrosis
    } else if (li >= escharL && ai > granulationA && (hi <= RED_HUE_LOW_MAX || hi >= RED_HUE_HIGH_MIN)) {
      cls = 1; // Red: granulation
    } else if (
      li >= escharL &&
      bi > sloughB &&
      bi > 0.85 * ai &&
      hi >= YELLOW_HUE_MIN &&
      hi <= YELLOW_HUE_MAX
    ) {
      cls = 2; // Yellow: slough / fibrin (warm yellow/ochre hue only; excludes green)
    }

    labels[i] = cls;
    counts[cls]++;
  }

  const totalPx = counts[1] + counts[2] + counts[3] + counts[4];
  const calibrated = Number.isFinite(pixelsPerMm) && pixelsPerMm > 0;
  const cm2PerPx = calibrated ? 1 / (pixelsPerMm * pixelsPerMm * 100) : null;

  const classes = Object.fromEntries(
    RYB_CLASSES.map(({ code, key, label }) => {
      const pixels = counts[code];
      const percent = totalPx > 0 ? (pixels / totalPx) * 100 : null;
      return [
        key,
        {
          code,
          key,
          label,
          pixels,
          percent,
          areaCm2: calibrated && totalPx > 0 ? pixels * cm2PerPx : null,
        },
      ];
    }),
  );

  const devitalizedPx = counts[2] + counts[3];
  const devitalizedPercent = totalPx > 0 ? (devitalizedPx / totalPx) * 100 : null;
  const granulationToDevitalizedRatio = totalPx > 0 && devitalizedPx > 0 ? counts[1] / devitalizedPx : null;

  return {
    labels,
    totalPx,
    classes,
    devitalizedPx,
    devitalizedPercent,
    devitalizedAreaCm2: calibrated && totalPx > 0 ? devitalizedPx * cm2PerPx : null,
    granulationToDevitalizedRatio,
  };
}
