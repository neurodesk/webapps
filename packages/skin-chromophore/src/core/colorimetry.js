// Pure DOM-free skin colorimetry: IEC 61966-2-1 sRGB -> CIE XYZ (D65) -> CIE L*a*b*,
// Shades of Gray (p=6) white balance, Individual Typology Angle (ITA°), and exact CIEDE2000.

export const D65_WHITE = Object.freeze({
  Xn: 0.95047,
  Yn: 1.0,
  Zn: 1.08883,
});

const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const POW_25_7 = 25 ** 7;

/** IEC 61966-2-1 sRGB transfer function: normalized sRGB [0, 1] -> linear RGB [0, 1]. */
export function srgbToLinear(channel) {
  const c = channel < 0 ? 0 : channel > 1 ? 1 : channel;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Inverse IEC 61966-2-1 sRGB transfer function: linear RGB [0, 1] -> normalized sRGB [0, 1]. */
export function linearToSrgb(linear) {
  const u = linear < 0 ? 0 : linear > 1 ? 1 : linear;
  return u <= 0.0031308 ? 12.92 * u : 1.055 * (u ** (1 / 2.4)) - 0.055;
}

/** Precomputed 8-bit sRGB [0..255] -> linear RGB [0, 1] lookup table. */
export const SRGB_TO_LINEAR_LUT = (() => {
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbToLinear(i / 255);
  return lut;
})();

/** Linear sRGB -> CIE XYZ (D65, 2° standard observer, IEC 61966-2-1). */
export function linearRgbToXyz(r, g, b) {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

function labF(t) {
  return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

/** CIE XYZ (D65) -> CIE L*a*b* (CIE 1976). */
export function xyzToLab(x, y, z) {
  const fx = labF(x / D65_WHITE.Xn);
  const fy = labF(y / D65_WHITE.Yn);
  const fz = labF(z / D65_WHITE.Zn);
  return [
    116 * fy - 16,
    500 * (fx - fy),
    200 * (fy - fz),
  ];
}

/** Linear RGB [0, 1] -> CIE L*a*b* (D65). */
export function linearRgbToLab(r, g, b) {
  const [x, y, z] = linearRgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** 8-bit sRGB [0..255] -> CIE L*a*b* (D65). */
export function srgbToLab(r8, g8, b8) {
  const r = SRGB_TO_LINEAR_LUT[r8 & 255];
  const g = SRGB_TO_LINEAR_LUT[g8 & 255];
  const b = SRGB_TO_LINEAR_LUT[b8 & 255];
  return linearRgbToLab(r, g, b);
}

/**
 * Shades of Gray (Finlayson & Trezzi 2004) illuminant normalization gains in linear RGB space
 * using the Minkowski p-norm (default p = 6) over valid pixels.
 */
export function computeShadesOfGrayGains(rgba, validMask = null, p = 6) {
  const count = rgba.length >>> 2;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let valid = 0;
  for (let i = 0; i < count; i++) {
    if (validMask && !validMask[i]) continue;
    const base = i << 2;
    const r = SRGB_TO_LINEAR_LUT[rgba[base]];
    const g = SRGB_TO_LINEAR_LUT[rgba[base + 1]];
    const b = SRGB_TO_LINEAR_LUT[rgba[base + 2]];
    sumR += r ** p;
    sumG += g ** p;
    sumB += b ** p;
    valid++;
  }
  if (!valid) return { r: 1, g: 1, b: 1 };
  const eR = (sumR / valid) ** (1 / p);
  const eG = (sumG / valid) ** (1 / p);
  const eB = (sumB / valid) ** (1 / p);
  const meanE = (eR + eG + eB) / 3;
  if (meanE < 1e-6) return { r: 1, g: 1, b: 1 };
  return {
    r: eR > 1e-6 ? meanE / eR : 1,
    g: eG > 1e-6 ? meanE / eG : 1,
    b: eB > 1e-6 ? meanE / eB : 1,
  };
}

/**
 * Six skin typology bands by Individual Typology Angle (Chardon et al. 1991; Del Bino & Bernerd 2013).
 * Ordered from lightest (>55°) to darkest (<=-30°).
 */
export const ITA_BANDS = Object.freeze([
  Object.freeze({ id: "very-light", label: "Very Light", min: 55, max: 90 }),
  Object.freeze({ id: "light", label: "Light", min: 41, max: 55 }),
  Object.freeze({ id: "intermediate", label: "Intermediate", min: 28, max: 41 }),
  Object.freeze({ id: "tan", label: "Tan", min: 10, max: 28 }),
  Object.freeze({ id: "brown", label: "Brown", min: -30, max: 10 }),
  Object.freeze({ id: "dark", label: "Dark", min: -90, max: -30 }),
]);

export const ITA_MIN_B = 1.0;
export const ITA_UNAVAILABLE_BAND = 6;
export const ITA_UNAVAILABLE_LABEL = "Outside skin domain";

/** True when CIE b* lies in the valid yellow-positive skin domain (b* > 1) for ITA°. */
export function isItaValidB(b) {
  return Number.isFinite(b) && b > ITA_MIN_B;
}

/**
 * Individual Typology Angle (ITA°) in degrees: atan((L* - 50) / b*) * 180 / π
 * defined only for yellow-positive skin pixels (b* > 1); returns NaN outside that domain
 * where atan((L* - 50) / b*) flips discontinuously from -90° to +90°.
 */
export function computeIta(L, b) {
  if (!Number.isFinite(L) || !isItaValidB(b)) return Number.NaN;
  return Math.atan((L - 50) / b) * RAD_TO_DEG;
}

/**
 * Band index 0..5 into ITA_BANDS for a valid ITA° angle, or ITA_UNAVAILABLE_BAND (6)
 * when ITA° is non-finite or b* <= 1.
 */
export function itaBandIndex(ita, b = undefined) {
  if (!Number.isFinite(ita) || (b !== undefined && !isItaValidB(b))) {
    return ITA_UNAVAILABLE_BAND;
  }
  if (ita > 55) return 0;
  if (ita > 41) return 1;
  if (ita > 28) return 2;
  if (ita > 10) return 3;
  if (ita > -30) return 4;
  return 5;
}

/** Six-band skin typology classification label from ITA°, or "Outside skin domain". */
export function classifyIta(ita, b = undefined) {
  const idx = itaBandIndex(ita, b);
  return idx === ITA_UNAVAILABLE_BAND ? ITA_UNAVAILABLE_LABEL : ITA_BANDS[idx].label;
}

/**
 * Exact CIEDE2000 (ΔE2000) color difference following Sharma, Wu & Dalal (2005),
 * Color Research & Application 30(1):21-30, DOI 10.1002/col.20070.
 */
export function ciede2000(lab1, lab2, { kL = 1, kC = 1, kH = 1 } = {}) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;

  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + POW_25_7)));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);

  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) * RAD_TO_DEG) + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) * RAD_TO_DEG) + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp = 0;
  const Cprod = C1p * C2p;
  if (Cprod !== 0) {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(Cprod) * Math.sin((dhp / 2) * DEG_TO_RAD);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;

  let hbarp;
  if (Cprod === 0) {
    hbarp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2;
  } else {
    hbarp = (h1p + h2p - 360) / 2;
  }

  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * DEG_TO_RAD)
    + 0.24 * Math.cos((2 * hbarp) * DEG_TO_RAD)
    + 0.32 * Math.cos((3 * hbarp + 6) * DEG_TO_RAD)
    - 0.20 * Math.cos((4 * hbarp - 63) * DEG_TO_RAD);

  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Cbarp7 = Cbarp ** 7;
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + POW_25_7));
  const L50Sq = (Lbarp - 50) ** 2;
  const SL = 1 + (0.015 * L50Sq) / Math.sqrt(20 + L50Sq);
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;
  const RT = -Math.sin((2 * dTheta) * DEG_TO_RAD) * RC;

  const tL = dLp / (kL * SL);
  const tC = dCp / (kC * SC);
  const tH = dHp / (kH * SH);
  const sum = tL * tL + tC * tC + tH * tH + RT * tC * tH;
  return Math.sqrt(sum > 0 ? sum : 0);
}
