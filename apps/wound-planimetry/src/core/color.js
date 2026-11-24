// Pure DOM-free sRGB <-> CIE L*a*b* (D65) and HSV hue conversions for wound
// planimetry and color-based RYB tissue estimation.

const D65_X = 0.95047;
const D65_Y = 1.0;
const D65_Z = 1.08883;
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA_DIV_116 = 841 / 108;
const LAB_OFFSET = 4 / 29;

export const ALPHA_OPAQUE_MIN = 128;

function linearizeSrgb(channelByte) {
  const u = channelByte / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

function labF(t) {
  return t > LAB_EPSILON ? Math.cbrt(t) : LAB_KAPPA_DIV_116 * t + LAB_OFFSET;
}

/**
 * Convert an sRGB triplet (0–255 per channel) to CIE L*a*b* (D65 illuminant).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]} [L*, a*, b*]
 */
export function rgbToLab(r, g, b) {
  const rl = linearizeSrgb(r);
  const gl = linearizeSrgb(g);
  const bl = linearizeSrgb(b);

  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65_X;
  const y = (0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / D65_Y;
  const z = (0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / D65_Z;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  return [
    116 * fy - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}

/**
 * Compute HSV hue in degrees [0, 360) for an sRGB triplet (0–255 per channel).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number}
 */
export function rgbToHue(r, g, b) {
  const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const delta = max - min;
  if (delta === 0) return 0;
  let h;
  if (max === r) h = 60 * (((g - b) / delta) % 6);
  else if (max === g) h = 60 * ((b - r) / delta + 2);
  else h = 60 * ((r - g) / delta + 4);
  return h < 0 ? h + 360 : h;
}

/**
 * Convert an sRGB triplet (0–255 per channel) to HSV with H in [0, 360), S in [0, 1], V in [0, 1].
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]} [H, S, V]
 */
export function rgbToHsv(r, g, b) {
  const rf = r / 255;
  const gf = g / 255;
  const bf = b / 255;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const delta = max - min;
  const h = rgbToHue(r, g, b);
  const s = max === 0 ? 0 : delta / max;
  return [h, s, max];
}

// Precompute 256-entry sRGB linearization lookup table for fast whole-image conversion.
const SRGB_LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_LUT[i] = linearizeSrgb(i);

/**
 * Convert an RGBA pixel buffer into CIE L*a*b* Float32Arrays plus an opacity mask
 * (alpha >= 128). Transparent pixels are excluded (opaque[i] = 0) and skipped.
 * Hue is computed on demand for wound-bed pixels in classifyRyb to avoid
 * allocating unused full-image H/S/V arrays.
 *
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @returns {{ L: Float32Array, a: Float32Array, b: Float32Array, opaque: Uint8Array, rgba: Uint8Array | Uint8ClampedArray }}
 */
export function rgbaToColorArrays(rgba, width, height) {
  const count = width * height;
  const L = new Float32Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  const opaque = new Uint8Array(count);

  for (let i = 0, p = 0; i < count; i++, p += 4) {
    if (rgba[p + 3] < ALPHA_OPAQUE_MIN) continue;
    opaque[i] = 1;
    const rl = SRGB_LUT[rgba[p]];
    const gl = SRGB_LUT[rgba[p + 1]];
    const bl = SRGB_LUT[rgba[p + 2]];
    const fx = labF((0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / D65_X);
    const fy = labF((0.2126729 * rl + 0.7151522 * gl + 0.0721750 * bl) / D65_Y);
    const fz = labF((0.0193339 * rl + 0.1191920 * gl + 0.9503041 * bl) / D65_Z);
    L[i] = 116 * fy - 16;
    a[i] = 500 * (fx - fy);
    b[i] = 200 * (fy - fz);
  }

  return { L, a, b, opaque, rgba };
}
