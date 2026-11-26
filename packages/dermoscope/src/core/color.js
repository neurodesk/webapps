// Color space conversions (sRGB <-> CIE L*a*b* D65), Rec.709 luminance,
// Shades of Gray color constancy (Finlayson & Trezzi 2004; Barata et al. 2015),
// and Stolz 6-color dermoscopic prototypes in CIE L*a*b*.

const D65_XN = 0.95047;
const D65_YN = 1.0;
const D65_ZN = 1.08883;
const LAB_DELTA = 6 / 29;
const LAB_DELTA3 = LAB_DELTA * LAB_DELTA * LAB_DELTA;
const LAB_FACTOR = 1 / (3 * LAB_DELTA * LAB_DELTA);
const LAB_OFFSET = 4 / 29;

const SRGB_TO_LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const u = i / 255;
  SRGB_TO_LINEAR[i] = u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

/**
 * Six standard dermoscopic color classes (Nachbar & Stolz 1994; Kasmi & Mokrani 2016)
 * represented by CIE L*a*b* (D65) prototype centers and display RGB triples.
 */
export const DERMOSCOPIC_COLORS = Object.freeze([
  Object.freeze({ id: 1, key: "white", label: "White", lab: Object.freeze([88, 1, 4]), rgb: Object.freeze([242, 242, 240]) }),
  Object.freeze({ id: 2, key: "red", label: "Red", lab: Object.freeze([46, 42, 22]), rgb: Object.freeze([214, 62, 58]) }),
  Object.freeze({ id: 3, key: "lightBrown", label: "Light brown", lab: Object.freeze([58, 14, 30]), rgb: Object.freeze([196, 134, 74]) }),
  Object.freeze({ id: 4, key: "darkBrown", label: "Dark brown", lab: Object.freeze([32, 14, 18]), rgb: Object.freeze([104, 54, 28]) }),
  Object.freeze({ id: 5, key: "blueGray", label: "Blue-gray", lab: Object.freeze([45, -4, -14]), rgb: Object.freeze([92, 126, 158]) }),
  Object.freeze({ id: 6, key: "black", label: "Black", lab: Object.freeze([12, 1, 1]), rgb: Object.freeze([24, 24, 28]) }),
]);

/** Compute per-pixel luminance Float32Array from RGBA bytes. */
export function rgbaToLuminance(rgba, width, height) {
  const count = width * height;
  const lum = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    lum[i] = 0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
  }
  return lum;
}

function labF(t) {
  return t > LAB_DELTA3 ? Math.cbrt(t) : t * LAB_FACTOR + LAB_OFFSET;
}

/** Convert one sRGB triple [0..255] to CIE L*a*b* (D65, 2° observer). */
export function rgbToLab(r, g, b) {
  const lr = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(r)))];
  const lg = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(g)))];
  const lb = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(b)))];
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65_XN;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / D65_YN;
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / D65_ZN;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Convert an RGBA buffer into separate Float32Array planes for L*, a*, b*. */
export function rgbaToLabPlanes(rgba, width, height) {
  const count = width * height;
  const L = new Float32Array(count);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    const lr = SRGB_TO_LINEAR[rgba[o]];
    const lg = SRGB_TO_LINEAR[rgba[o + 1]];
    const lb = SRGB_TO_LINEAR[rgba[o + 2]];
    const fx = labF((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / D65_XN);
    const fy = labF((0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / D65_YN);
    const fz = labF((0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / D65_ZN);
    L[i] = 116 * fy - 16;
    a[i] = 500 * (fx - fy);
    b[i] = 200 * (fy - fz);
  }
  return { L, a, b };
}

/** Classify a CIE L*a*b* pixel to the nearest Stolz dermoscopic color id (1..6). */
export function classifyDermoscopicColor(L, a, b) {
  let bestId = 1;
  let bestDist2 = Infinity;
  for (let c = 0; c < DERMOSCOPIC_COLORS.length; c++) {
    const proto = DERMOSCOPIC_COLORS[c];
    const dL = L - proto.lab[0];
    const da = a - proto.lab[1];
    const db = b - proto.lab[2];
    const d2 = dL * dL + da * da + db * db;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestId = proto.id;
    }
  }
  return bestId;
}

function clampByte(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

/**
 * Shades of Gray color constancy (Finlayson & Trezzi 2004; Barata et al. 2015).
 * Estimates the scene illuminant using the Minkowski p-norm (default p = 6) over
 * valid non-vignette, non-saturated pixels and applies diagonal von Kries scaling.
 */
export function applyShadesOfGray(rgba, width, height, validMask, { p = 6 } = {}) {
  const count = width * height;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let used = 0;

  for (let i = 0; i < count; i++) {
    if (validMask && validMask[i] === 0) continue;
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    // Exclude clipped highlights and near-black artifacts from illuminant estimation.
    if (r >= 252 || g >= 252 || b >= 252) continue;
    if (r + g + b <= 15) continue;
    sumR += (r / 255) ** p;
    sumG += (g / 255) ** p;
    sumB += (b / 255) ** p;
    used++;
  }

  const out = new Uint8ClampedArray(rgba.length);
  if (used === 0) {
    out.set(rgba);
    return { rgba: out, illuminant: [1, 1, 1], gains: [1, 1, 1], sampledPixels: 0 };
  }

  const eR = (sumR / used) ** (1 / p);
  const eG = (sumG / used) ** (1 / p);
  const eB = (sumB / used) ** (1 / p);

  if (eR <= 1e-6 || eG <= 1e-6 || eB <= 1e-6) {
    out.set(rgba);
    return { rgba: out, illuminant: [eR, eG, eB], gains: [1, 1, 1], sampledPixels: used };
  }

  const target = Math.sqrt((eR * eR + eG * eG + eB * eB) / 3);
  const gainR = Math.max(0.5, Math.min(2.0, target / eR));
  const gainG = Math.max(0.5, Math.min(2.0, target / eG));
  const gainB = Math.max(0.5, Math.min(2.0, target / eB));

  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (validMask && validMask[i] === 0) {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = rgba[o + 3];
      continue;
    }
    out[o] = clampByte(rgba[o] * gainR);
    out[o + 1] = clampByte(rgba[o + 1] * gainG);
    out[o + 2] = clampByte(rgba[o + 2] * gainB);
    out[o + 3] = rgba[o + 3];
  }

  return {
    rgba: out,
    illuminant: [eR, eG, eB],
    gains: [gainR, gainG, gainB],
    sampledPixels: used,
  };
}
