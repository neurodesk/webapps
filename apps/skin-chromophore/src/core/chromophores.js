// Pure DOM-free uncalibrated RGB optical-density proxies (MI, EI, and fixed-basis
// melanin/hemoglobin projection inspired by Tsumura et al., JOSA A 1999), alpha validity
// masking, and peripheral dark dermoscope vignette exclusion.

export const REFLECTANCE_MIN = 1e-3;
export const REFLECTANCE_MAX = 1.0;
export const VIGNETTE_LUMINANCE_THRESHOLD = 22;
export const ALPHA_VALID_THRESHOLD = 128;
export const VIGNETTE_CENTRAL_PROTECT_RATIO = 0.30;

export function clampReflectance(value) {
  if (value < REFLECTANCE_MIN) return REFLECTANCE_MIN;
  if (value > REFLECTANCE_MAX) return REFLECTANCE_MAX;
  return value;
}

/**
 * Uncalibrated RGB Melanin Index proxy: 100 * log10(1 / R) on linearized sRGB reflectance
 * clamped to [1e-3, 1] (inspired by Diffey et al. 1984 / Takiwaki et al. 1994; not
 * calibrated narrow-band spectrophotometry).
 */
export function melaninIndex(linearR) {
  return 100 * Math.log10(1 / clampReflectance(linearR));
}

/**
 * Uncalibrated RGB Erythema Index proxy: 100 * log10(R / G) on linearized sRGB reflectance
 * clamped to [1e-3, 1] (inspired by Diffey et al. 1984 / Takiwaki et al. 1994; not
 * calibrated narrow-band spectrophotometry).
 */
export function erythemaIndex(linearR, linearG) {
  return 100 * Math.log10(clampReflectance(linearR) / clampReflectance(linearG));
}

function normalize3(vec) {
  const norm = Math.hypot(vec[0], vec[1], vec[2]);
  return Object.freeze([vec[0] / norm, vec[1] / norm, vec[2] / norm]);
}

/**
 * Closed-form 3×3 matrix inversion for row-major matrix [[a,b,c],[d,e,f],[g,h,i]].
 * Throws if the matrix is singular.
 */
export function invert3x3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error("Chromophore basis matrix is singular.");
  return Object.freeze([
    Object.freeze([A / det, D / det, G / det]),
    Object.freeze([B / det, E / det, H / det]),
    Object.freeze([C / det, F / det, I / det]),
  ]);
}

// Fixed uncalibrated RGB optical-density basis unit vectors in [-ln(R), -ln(G), -ln(B)] space
// (inspired by Tsumura et al., JOSA A 1999; fixed physiological basis, not per-image ICA):
// - Melanin: broadband monotonic wavelength decay (R < G < B)
// - Hemoglobin: strong green Q-band & blue Soret absorption, minimal red absorption
// - Shading: neutral illumination/geometry vector [1, 1, 1] / sqrt(3)
export const TSUMURA_BASIS = Object.freeze({
  melanin: normalize3([0.32, 0.47, 0.82]),
  hemoglobin: normalize3([0.08, 0.80, 0.59]),
  shading: normalize3([1, 1, 1]),
});

export const TSUMURA_MATRIX = Object.freeze([
  Object.freeze([TSUMURA_BASIS.melanin[0], TSUMURA_BASIS.hemoglobin[0], TSUMURA_BASIS.shading[0]]),
  Object.freeze([TSUMURA_BASIS.melanin[1], TSUMURA_BASIS.hemoglobin[1], TSUMURA_BASIS.shading[1]]),
  Object.freeze([TSUMURA_BASIS.melanin[2], TSUMURA_BASIS.hemoglobin[2], TSUMURA_BASIS.shading[2]]),
]);

export const TSUMURA_INVERSE = invert3x3(TSUMURA_MATRIX);

export const CHROMOPHORE_MODEL_SPEC = Object.freeze({
  kind: "uncalibrated-fixed-basis-rgb-optical-density-proxy",
  perImageIca: false,
  calibratedSpectrophotometry: false,
  reflectanceClamp: Object.freeze([REFLECTANCE_MIN, REFLECTANCE_MAX]),
  opticalDensityDefinition: "d = [-ln(R), -ln(G), -ln(B)] on clamped linear sRGB",
  nonNegativeClipping: "melanin = max(0, c_melanin), hemoglobin = max(0, c_hemoglobin); shading unclipped",
  basisColumns: Object.freeze(["melanin", "hemoglobin", "shading"]),
  basisRows: Object.freeze(["dR", "dG", "dB"]),
  basisMatrix: TSUMURA_MATRIX,
  inverseMatrix: TSUMURA_INVERSE,
});

/**
 * Uncalibrated fixed-basis RGB optical-density chromophore proxy for one linearized RGB pixel
 * (inspired by Tsumura et al., JOSA A 1999; fixed 3×3 basis, not per-image ICA).
 * Projects d = [-ln(R), -ln(G), -ln(B)] via closed-form 3×3 inverse onto melanin,
 * hemoglobin, and neutral shading, clipping melanin and hemoglobin concentrations >= 0.
 */
export function separateChromophores(linearR, linearG, linearB) {
  const dR = -Math.log(clampReflectance(linearR));
  const dG = -Math.log(clampReflectance(linearG));
  const dB = -Math.log(clampReflectance(linearB));
  const inv = TSUMURA_INVERSE;
  const melanin = inv[0][0] * dR + inv[0][1] * dG + inv[0][2] * dB;
  const hemoglobin = inv[1][0] * dR + inv[1][1] * dG + inv[1][2] * dB;
  const shading = inv[2][0] * dR + inv[2][1] * dG + inv[2][2] * dB;
  return {
    melanin: melanin > 0 ? melanin : 0,
    hemoglobin: hemoglobin > 0 ? hemoglobin : 0,
    shading,
  };
}

/**
 * Explicit alpha validity mask (1 = alpha >= 128, 0 = transparent/excluded),
 * independent of dermoscope vignette masking.
 */
export function buildAlphaMask(rgba, width, height, threshold = ALPHA_VALID_THRESHOLD) {
  const total = width * height;
  const alphaMask = new Uint8Array(total);
  let alphaValidCount = 0;
  for (let i = 0; i < total; i++) {
    if (rgba[(i << 2) + 3] >= threshold) {
      alphaMask[i] = 1;
      alphaValidCount++;
    }
  }
  return {
    alphaMask,
    alphaValidCount,
    alphaExcludedCount: total - alphaValidCount,
  };
}

/**
 * Dark dermoscope vignette exclusion via 4-connected flood-fill seeded along all 4 outer
 * border edges (including a small 0..3 px inset for framed dermoscopy exports such as ISIC),
 * constrained outside a central protected disk so a thin dark hair or ruler mark cannot
 * erase a central dark lesion. Respects `alphaMask` when provided.
 */
export function detectVignetteMask(
  rgba,
  width,
  height,
  threshold = VIGNETTE_LUMINANCE_THRESHOLD,
  alphaMask = null,
) {
  const total = width * height;
  const validMask = alphaMask ? new Uint8Array(alphaMask) : new Uint8Array(total).fill(1);
  if (total === 0) {
    return { validMask, vignetteCount: 0, validCount: 0, vignetteGuardTriggered: false };
  }

  let alphaValidCount = 0;
  for (let i = 0; i < total; i++) {
    if (validMask[i]) alphaValidCount++;
  }
  if (alphaValidCount === 0) {
    return { validMask, vignetteCount: 0, validCount: 0, vignetteGuardTriggered: false };
  }

  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const minDim = Math.min(width, height);
  const protectR = VIGNETTE_CENTRAL_PROTECT_RATIO * minDim;
  const protectR2 = protectR * protectR;

  const isPeripheral = (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy >= protectR2;
  };

  const isDark = (idx) => {
    const base = idx << 2;
    const lum = 0.2126 * rgba[base] + 0.7152 * rgba[base + 1] + 0.0722 * rgba[base + 2];
    return lum < threshold;
  };

  const stack = new Int32Array(total);
  let sp = 0;
  let vignetteCount = 0;

  const trySeed = (x, y) => {
    const idx = y * width + x;
    if (validMask[idx] && isPeripheral(x, y) && isDark(idx)) {
      validMask[idx] = 0;
      stack[sp++] = idx;
      vignetteCount++;
    }
  };

  // Scan all 4 outer border edges with a small rim inset (up to 3 px on >=48px images)
  // so 1–2 px bright framing borders (e.g. ISIC_0000004.jpg) do not block vignette seeding.
  const rimDepth = Math.min(3, Math.floor(minDim / 16));
  for (let d = 0; d <= rimDepth; d++) {
    const topY = d;
    const botY = height - 1 - d;
    for (let x = 0; x < width; x++) {
      trySeed(x, topY);
      if (botY !== topY) trySeed(x, botY);
    }
    const leftX = d;
    const rightX = width - 1 - d;
    for (let y = d + 1; y < height - 1 - d; y++) {
      trySeed(leftX, y);
      if (rightX !== leftX) trySeed(rightX, y);
    }
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) trySeed(x - 1, y);
    if (x + 1 < width) trySeed(x + 1, y);
    if (y > 0) trySeed(x, y - 1);
    if (y + 1 < height) trySeed(x, y + 1);
  }

  // Safety guard: never wipe uniformly dark images while preserving alpha exclusions.
  let guardTriggered = vignetteCount >= alphaValidCount * 0.9;
  if (!guardTriggered && vignetteCount > 0) {
    let peripheralAlpha = 0;
    let centralAlpha = 0;
    let centralDark = 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const idx = row + x;
        const alphaValid = alphaMask ? alphaMask[idx] : 1;
        if (!alphaValid) continue;
        if (isPeripheral(x, y)) {
          peripheralAlpha++;
        } else {
          centralAlpha++;
          if (isDark(idx)) centralDark++;
        }
      }
    }
    if (
      peripheralAlpha > 0
      && vignetteCount >= peripheralAlpha * 0.95
      && (centralAlpha === 0 || centralDark >= centralAlpha * 0.9)
    ) {
      guardTriggered = true;
    }
  }

  if (guardTriggered) {
    if (alphaMask) validMask.set(alphaMask);
    else validMask.fill(1);
    return {
      validMask,
      vignetteCount: 0,
      validCount: alphaValidCount,
      vignetteGuardTriggered: true,
    };
  }

  return {
    validMask,
    vignetteCount,
    validCount: alphaValidCount - vignetteCount,
    vignetteGuardTriggered: false,
  };
}
