// Experimental automated ABCD morphometry and optional Stolz Total Dermoscopy Score (TDS)
// Following Nachbar & Stolz (1994) and Kasmi & Mokrani (2016).
// Nachbar & Stolz weights and thresholds were evaluated on clinician-scored lesions.
// Experimental automated morphometry only — not a clinical diagnosis.

import { DERMOSCOPIC_COLORS, classifyDermoscopicColor } from "./color.js";
import { DISCLAIMER, TDS_WEIGHTS } from "../config.js";

const COLOR_COVERAGE_THRESHOLD_PCT = 5;
const BORDER_GRADIENT_CUTOFF = 18;
const BORDER_CONTRAST_METRIC = "0.7 * CIE76_deltaE + 0.3 * abs(deltaL)";

/**
 * Compute perimeter from an ordered 8-connected closed contour using Kulpa chain-code weights.
 * Supports per-axis scale factors (working / original) to preserve physical perimeter on anisotropic resizes.
 */
export function contourPerimeter(contour, { scaleX = 1, scaleY = 1 } = {}) {
  const n = contour.length;
  if (n === 0) return 0;
  if (n === 1) return 2 / scaleX + 2 / scaleY;
  if (scaleX === 1 && scaleY === 1) {
    let ortho = 0;
    let diag = 0;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = contour[i];
      const [x1, y1] = contour[(i + 1) % n];
      const dx = Math.abs(x1 - x0);
      const dy = Math.abs(y1 - y0);
      if (dx === 1 && dy === 1) diag++;
      else if (dx + dy === 1) ortho++;
      else ortho += Math.hypot(dx, dy);
    }
    // Kulpa chain-code estimator (0.948 / 1.343) reduces discrete staircase bias on curves.
    return 0.948 * ortho + 1.343 * diag;
  }

  let total = 0;
  const diagFactor = 1.343 / Math.SQRT2;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = contour[i];
    const [x1, y1] = contour[(i + 1) % n];
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const step = Math.hypot(dx / scaleX, dy / scaleY);
    total += dx === 1 && dy === 1 ? diagFactor * step : 0.948 * step;
  }
  return total;
}

/** Compute centroid, 2nd central moments, principal axes, compactness and circularity. */
export function computeGeometry(
  mask,
  contour,
  width,
  height,
  { pixelsPerMm = 0, scaleFactor = 1, scaleX = null, scaleY = null } = {},
) {
  const sx = scaleX ?? scaleFactor;
  const sy = scaleY ?? scaleFactor;
  let areaPx = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      areaPx++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (areaPx === 0) {
    return {
      areaPx: 0,
      areaMm2: null,
      perimeterPx: 0,
      perimeterMm: null,
      equivalentDiameterPx: 0,
      equivalentDiameterMm: null,
      majorAxisPx: 0,
      majorAxisMm: null,
      minorAxisPx: 0,
      minorAxisMm: null,
      orientationRad: 0,
      orientationDeg: 0,
      compactness: 0,
      circularity: 0,
      centroid: [width / 2, height / 2],
      bbox: [0, 0, 0, 0],
      calibrated: false,
      scaleX: sx,
      scaleY: sy,
      effectivePixelsPerMm: 0,
      effectivePixelsPerMmX: 0,
      effectivePixelsPerMmY: 0,
    };
  }

  const cx = sumX / areaPx;
  const cy = sumY / areaPx;

  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      const dx = x - cx;
      mu20 += dx * dx;
      mu02 += dy * dy;
      mu11 += dx * dy;
    }
  }
  mu20 /= areaPx;
  mu02 /= areaPx;
  mu11 /= areaPx;

  const orientationRad = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  const orientationDeg = (orientationRad * 180) / Math.PI;
  const delta = Math.hypot(mu20 - mu02, 2 * mu11);
  const lambda1 = Math.max(0, 0.5 * (mu20 + mu02 + delta));
  const lambda2 = Math.max(0, 0.5 * (mu20 + mu02 - delta));
  const majorAxisPx = 4 * Math.sqrt(lambda1);
  const minorAxisPx = 4 * Math.sqrt(lambda2);
  const equivalentDiameterPx = 2 * Math.sqrt(areaPx / Math.PI);
  const perimeterPx = Math.max(4, contourPerimeter(contour));
  const rawCompactness = (perimeterPx * perimeterPx) / (4 * Math.PI * areaPx);
  const compactness = Math.max(1, rawCompactness);
  const circularity = Math.min(1, (4 * Math.PI * areaPx) / (perimeterPx * perimeterPx));

  // Physical calibration accounts for exact per-axis resize ratios (scaleX, scaleY).
  const calibrated = pixelsPerMm > 0;
  const areaOrigPx = areaPx / (sx * sy);
  const equivalentDiameterOrigPx = 2 * Math.sqrt(areaOrigPx / Math.PI);
  const perimeterOrigPx = Math.max(2 / sx + 2 / sy, contourPerimeter(contour, { scaleX: sx, scaleY: sy }));
  const mu20Orig = mu20 / (sx * sx);
  const mu02Orig = mu02 / (sy * sy);
  const mu11Orig = mu11 / (sx * sy);
  const deltaOrig = Math.hypot(mu20Orig - mu02Orig, 2 * mu11Orig);
  const majorAxisOrigPx = 4 * Math.sqrt(Math.max(0, 0.5 * (mu20Orig + mu02Orig + deltaOrig)));
  const minorAxisOrigPx = 4 * Math.sqrt(Math.max(0, 0.5 * (mu20Orig + mu02Orig - deltaOrig)));
  const effectivePixelsPerMmX = calibrated ? pixelsPerMm * sx : 0;
  const effectivePixelsPerMmY = calibrated ? pixelsPerMm * sy : 0;
  const effectivePixelsPerMm = calibrated ? pixelsPerMm * Math.sqrt(sx * sy) : 0;

  return {
    areaPx,
    areaMm2: calibrated ? areaOrigPx / (pixelsPerMm * pixelsPerMm) : null,
    perimeterPx,
    perimeterMm: calibrated ? perimeterOrigPx / pixelsPerMm : null,
    equivalentDiameterPx,
    equivalentDiameterMm: calibrated ? equivalentDiameterOrigPx / pixelsPerMm : null,
    majorAxisPx,
    majorAxisMm: calibrated ? majorAxisOrigPx / pixelsPerMm : null,
    minorAxisPx,
    minorAxisMm: calibrated ? minorAxisOrigPx / pixelsPerMm : null,
    orientationRad,
    orientationDeg,
    compactness,
    circularity,
    centroid: [cx, cy],
    bbox: [minX, minY, maxX, maxY],
    calibrated,
    scaleX: sx,
    scaleY: sy,
    effectivePixelsPerMm,
    effectivePixelsPerMmX,
    effectivePixelsPerMmY,
  };
}

/**
 * Evaluate asymmetry across one reflection axis defined by its normal unit vector (nx, ny)
 * passing through centroid (cx, cy). Pixels within 0.5 px of the axis are excluded from the
 * half-mean comparison so odd-sized symmetric lesions score exact zero half-difference.
 */
function axisAsymmetry(mask, lab, width, height, cx, cy, nx, ny, areaPx) {
  let shapeMismatch = 0;
  let overlapCount = 0;
  let deltaESum = 0;
  let posCount = 0;
  let negCount = 0;
  let posL = 0;
  let posA = 0;
  let posB = 0;
  let negL = 0;
  let negA = 0;
  let negB = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      const dx = x - cx;
      const dy = y - cy;
      const proj = dx * nx + dy * ny;

      if (proj > 0.5) {
        posCount++;
        posL += lab.L[idx];
        posA += lab.a[idx];
        posB += lab.b[idx];
      } else if (proj < -0.5) {
        negCount++;
        negL += lab.L[idx];
        negA += lab.a[idx];
        negB += lab.b[idx];
      }

      const rx = Math.round(x - 2 * proj * nx);
      const ry = Math.round(y - 2 * proj * ny);
      if (rx < 0 || rx >= width || ry < 0 || ry >= height) {
        shapeMismatch++;
        continue;
      }
      const rIdx = ry * width + rx;
      if (!mask[rIdx]) {
        shapeMismatch++;
      } else {
        overlapCount++;
        deltaESum += Math.hypot(
          lab.L[idx] - lab.L[rIdx],
          lab.a[idx] - lab.a[rIdx],
          lab.b[idx] - lab.b[rIdx],
        );
      }
    }
  }

  const shapeXorRatio = areaPx > 0 ? shapeMismatch / areaPx : 0;
  const meanColorDeltaE = overlapCount > 0 ? deltaESum / overlapCount : 0;
  const halfLabDeltaE =
    posCount > 0 && negCount > 0
      ? Math.hypot(
          posL / posCount - negL / negCount,
          posA / posCount - negA / negCount,
          posB / posCount - negB / negCount,
        )
      : 0;

  const asymmetric = shapeXorRatio >= 0.12 || meanColorDeltaE >= 12 || halfLabDeltaE >= 8;

  return {
    shapeXorRatio,
    meanColorDeltaE,
    halfLabDeltaE,
    asymmetric,
  };
}

/**
 * A — Asymmetry (0, 1, or 2): fold mask and CIELAB around centroid across principal major and minor axes.
 */
export function computeAsymmetry(mask, lab, geometry, width, height) {
  if (geometry.areaPx === 0) {
    return {
      score: null,
      major: { shapeXorRatio: 0, meanColorDeltaE: 0, halfLabDeltaE: 0, asymmetric: false },
      minor: { shapeXorRatio: 0, meanColorDeltaE: 0, halfLabDeltaE: 0, asymmetric: false },
    };
  }
  const [cx, cy] = geometry.centroid;
  const cos = Math.cos(geometry.orientationRad);
  const sin = Math.sin(geometry.orientationRad);
  // Reflection across major axis uses normal (-sin, cos); across minor axis uses normal (cos, sin).
  const major = axisAsymmetry(mask, lab, width, height, cx, cy, -sin, cos, geometry.areaPx);
  const minor = axisAsymmetry(mask, lab, width, height, cx, cy, cos, sin, geometry.areaPx);
  const score = (major.asymmetric ? 1 : 0) + (minor.asymmetric ? 1 : 0);
  return { score, major, minor };
}

/**
 * B — Border abruptness (0..8): weighted radial Lab contrast (0.7*ΔE76 + 0.3*|ΔL*|) across
 * 8 equal 45° angular sectors. Verifies inner samples lie inside `mask` and outer samples lie
 * outside `mask` (and inside `validMask`). Sectors with insufficient valid samples are marked
 * unavailable (`null`) instead of silently scored as gradual.
 */
export function computeBorderAbruptness(
  contour,
  lab,
  validMask,
  geometry,
  width,
  height,
  { mask = null, minSectorSamples = null } = {},
) {
  const sectorSums = new Float64Array(8);
  const sectorValidSamples = new Uint32Array(8);
  const sectorTotalPoints = new Uint32Array(8);
  const [cx, cy] = geometry.centroid;
  const baseAngle = geometry.orientationRad;
  const radialSteps = [2, 3, 4, 5];

  for (let i = 0; i < contour.length; i++) {
    const [bx, by] = contour[i];
    const vx = bx - cx;
    const vy = by - cy;
    const dist = Math.hypot(vx, vy);
    if (dist < 1e-6) continue;
    const ux = vx / dist;
    const uy = vy / dist;

    let angle = Math.atan2(vy, vx) - baseAngle;
    while (angle < 0) angle += 2 * Math.PI;
    while (angle >= 2 * Math.PI) angle -= 2 * Math.PI;
    const sector = Math.min(7, Math.floor((angle / (2 * Math.PI)) * 8));
    sectorTotalPoints[sector]++;

    let inL = 0;
    let inA = 0;
    let inB = 0;
    let inN = 0;
    let outL = 0;
    let outA = 0;
    let outB = 0;
    let outN = 0;

    for (const d of radialSteps) {
      const ix = Math.round(bx - d * ux);
      const iy = Math.round(by - d * uy);
      if (ix >= 0 && ix < width && iy >= 0 && iy < height) {
        const iIdx = iy * width + ix;
        if ((!validMask || validMask[iIdx]) && (!mask || mask[iIdx] === 1)) {
          inL += lab.L[iIdx];
          inA += lab.a[iIdx];
          inB += lab.b[iIdx];
          inN++;
        }
      }
      const ox = Math.round(bx + d * ux);
      const oy = Math.round(by + d * uy);
      if (ox >= 0 && ox < width && oy >= 0 && oy < height) {
        const oIdx = oy * width + ox;
        if ((!validMask || validMask[oIdx]) && (!mask || mask[oIdx] === 0)) {
          outL += lab.L[oIdx];
          outA += lab.a[oIdx];
          outB += lab.b[oIdx];
          outN++;
        }
      }
    }

    if (inN > 0 && outN > 0) {
      const dL = outL / outN - inL / inN;
      const dA = outA / outN - inA / inN;
      const dB = outB / outN - inB / inN;
      const deltaE = Math.hypot(dL, dA, dB);
      const grad = 0.7 * deltaE + 0.3 * Math.abs(dL);
      sectorSums[sector] += grad;
      sectorValidSamples[sector]++;
    }
  }

  const minReq = minSectorSamples ?? Math.max(1, Math.min(3, Math.floor(contour.length / 24)));
  const sectorGradients = [];
  const abruptSectors = [];
  const sectorCoverage = [];
  let availableSectors = 0;
  let score = 0;

  for (let s = 0; s < 8; s++) {
    const total = sectorTotalPoints[s];
    const valid = sectorValidSamples[s];
    const coverage = total > 0 ? valid / total : 0;
    sectorCoverage.push(coverage);

    if (total > 0 && valid >= minReq && coverage >= 0.25) {
      const meanGrad = sectorSums[s] / valid;
      const abrupt = meanGrad >= BORDER_GRADIENT_CUTOFF;
      sectorGradients.push(meanGrad);
      abruptSectors.push(abrupt);
      availableSectors++;
      if (abrupt) score++;
    } else {
      sectorGradients.push(null);
      abruptSectors.push(null);
    }
  }

  return {
    score: availableSectors > 0 ? score : null,
    cutoff: BORDER_GRADIENT_CUTOFF,
    contrastMetric: BORDER_CONTRAST_METRIC,
    availableSectors,
    unavailableSectors: 8 - availableSectors,
    sectorGradients,
    abruptSectors,
    sectorValidSamples: Array.from(sectorValidSamples),
    sectorTotalPoints: Array.from(sectorTotalPoints),
    sectorCoverage,
  };
}

/**
 * C — Color variegation (1..6): classify lesion pixels into the 6 Stolz dermoscopic color prototypes
 * in CIELAB and count those covering >= 5% of the lesion area (minimum 1 when lesion is present).
 */
export function computeColorVariegation(mask, lab, width, height) {
  const count = width * height;
  const colorMap = new Uint8Array(count);
  const pixelCounts = new Uint32Array(DERMOSCOPIC_COLORS.length);
  let areaPx = 0;

  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    areaPx++;
    const colorId = classifyDermoscopicColor(lab.L[i], lab.a[i], lab.b[i]);
    colorMap[i] = colorId;
    pixelCounts[colorId - 1]++;
  }

  const breakdown = DERMOSCOPIC_COLORS.map((proto, index) => {
    const pixels = pixelCounts[index];
    const percentage = areaPx > 0 ? (pixels / areaPx) * 100 : 0;
    return {
      id: proto.id,
      key: proto.key,
      label: proto.label,
      rgb: proto.rgb,
      pixels,
      percentage,
      present: areaPx > 0 && percentage >= COLOR_COVERAGE_THRESHOLD_PCT,
    };
  });

  const detectedCount = breakdown.filter((entry) => entry.present).length;
  const score = areaPx > 0 ? Math.max(1, Math.min(6, detectedCount)) : null;

  return {
    score,
    thresholdPct: COLOR_COVERAGE_THRESHOLD_PCT,
    breakdown,
    colorMap,
  };
}

/** Build an empty ABCD payload when segmentation fails (no bogus scores computed). */
export function emptyAbcdMetrics({
  width,
  height,
  pixelsPerMm = 0,
  scaleFactor = 1,
  scaleX = null,
  scaleY = null,
  differentialStructures = null,
  failureReason = "No lesion detected.",
}) {
  const count = width * height;
  const emptyMask = new Uint8Array(count);
  const geometry = computeGeometry(emptyMask, [], width, height, {
    pixelsPerMm,
    scaleFactor,
    scaleX,
    scaleY,
  });
  const dScore =
    differentialStructures === null || differentialStructures === undefined || differentialStructures === 0
      ? null
      : Math.max(1, Math.min(5, Math.round(differentialStructures)));

  return {
    segmented: false,
    failureReason,
    geometry,
    asymmetry: {
      score: null,
      major: { shapeXorRatio: null, meanColorDeltaE: null, halfLabDeltaE: null, asymmetric: null },
      minor: { shapeXorRatio: null, meanColorDeltaE: null, halfLabDeltaE: null, asymmetric: null },
    },
    border: {
      score: null,
      cutoff: BORDER_GRADIENT_CUTOFF,
      contrastMetric: BORDER_CONTRAST_METRIC,
      availableSectors: 0,
      unavailableSectors: 8,
      sectorGradients: Array(8).fill(null),
      abruptSectors: Array(8).fill(null),
      sectorValidSamples: Array(8).fill(0),
      sectorTotalPoints: Array(8).fill(0),
      sectorCoverage: Array(8).fill(0),
    },
    color: {
      score: null,
      thresholdPct: COLOR_COVERAGE_THRESHOLD_PCT,
      breakdown: DERMOSCOPIC_COLORS.map((proto) => ({
        id: proto.id,
        key: proto.key,
        label: proto.label,
        rgb: proto.rgb,
        pixels: 0,
        percentage: 0,
        present: false,
      })),
      colorMap: new Uint8Array(count),
    },
    diameter: {
      equivalentDiameterPx: 0,
      equivalentDiameterMm: null,
      majorAxisPx: 0,
      majorAxisMm: null,
      differentialStructures: dScore,
      exceeds6mm: null,
    },
    scores: {
      A: null,
      B: null,
      C: null,
      D: dScore,
      tds: null,
      weightedA: null,
      weightedB: null,
      weightedC: null,
      weightedD: null,
    },
    disclaimer: DISCLAIMER,
  };
}

/**
 * Compute experimental automated A/B/C morphometry and optional Stolz Total Dermoscopy Score (TDS).
 * Composite TDS is computed only when a clinician/educational D score (1..5) is explicitly provided.
 */
export function computeAbcdMetrics({
  mask,
  contour,
  lab,
  validMask,
  width,
  height,
  pixelsPerMm = 0,
  scaleFactor = 1,
  scaleX = null,
  scaleY = null,
  differentialStructures = null,
}) {
  const geometry = computeGeometry(mask, contour, width, height, {
    pixelsPerMm,
    scaleFactor,
    scaleX,
    scaleY,
  });
  if (geometry.areaPx === 0) {
    return emptyAbcdMetrics({
      width,
      height,
      pixelsPerMm,
      scaleFactor,
      scaleX,
      scaleY,
      differentialStructures,
      failureReason: "No lesion detected.",
    });
  }

  const asymmetry = computeAsymmetry(mask, lab, geometry, width, height);
  const border = computeBorderAbruptness(contour, lab, validMask, geometry, width, height, { mask });
  const color = computeColorVariegation(mask, lab, width, height);
  const dScore =
    differentialStructures === null || differentialStructures === undefined || differentialStructures === 0
      ? null
      : Math.max(1, Math.min(5, Math.round(differentialStructures)));

  const weightedA =
    asymmetry.score !== null ? Number((TDS_WEIGHTS.asymmetry * asymmetry.score).toFixed(4)) : null;
  const weightedB =
    border.score !== null ? Number((TDS_WEIGHTS.border * border.score).toFixed(4)) : null;
  const weightedC =
    color.score !== null ? Number((TDS_WEIGHTS.color * color.score).toFixed(4)) : null;
  const weightedD =
    dScore !== null ? Number((TDS_WEIGHTS.differentialStructures * dScore).toFixed(4)) : null;

  const borderComplete = border.score !== null && border.unavailableSectors === 0;
  const canComputeTds =
    dScore !== null && asymmetry.score !== null && borderComplete && color.score !== null;
  const tds = canComputeTds
    ? Number(
        (
          TDS_WEIGHTS.asymmetry * asymmetry.score +
          TDS_WEIGHTS.border * border.score +
          TDS_WEIGHTS.color * color.score +
          TDS_WEIGHTS.differentialStructures * dScore
        ).toFixed(4),
      )
    : null;

  return {
    segmented: true,
    failureReason: null,
    geometry,
    asymmetry,
    border,
    color,
    diameter: {
      equivalentDiameterPx: geometry.equivalentDiameterPx,
      equivalentDiameterMm: geometry.equivalentDiameterMm,
      majorAxisPx: geometry.majorAxisPx,
      majorAxisMm: geometry.majorAxisMm,
      differentialStructures: dScore,
      exceeds6mm: geometry.equivalentDiameterMm !== null ? geometry.equivalentDiameterMm >= 6 : null,
    },
    scores: {
      A: asymmetry.score,
      B: border.score,
      C: color.score,
      D: dScore,
      tds,
      weightedA,
      weightedB,
      weightedC,
      weightedD,
    },
    disclaimer: DISCLAIMER,
  };
}
