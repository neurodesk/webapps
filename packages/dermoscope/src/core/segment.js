// Dermoscopic lesion border segmentation:
// 1. Estimate perilesional skin CIE L*a*b* from the outer valid ring (5–15% from edge)
// 2. Compute lesion contrast score: Lab distance from perilesional skin + inverted L* + inverted B channel
// 3. Robust normalization preserving small high-contrast lesions (< 1% frame area)
// 4. Otsu thresholding over valid pixels + user thresholdBias (-0.3 to +0.3)
// 5. 3x3 morphological closing + 3x3 opening
// 6. Keep highest area * center-proximity connected component
// 7. Flood-fill internal holes (excluding invalid/transparent pixels) and extract 8-connected contour (Jacob's stopping criterion)
// 8. Validate minimum lesion area (>= 16 px) and genuine foreground-vs-background Lab contrast

import { rgbaToLabPlanes } from "./color.js";

export const MIN_LESION_AREA_PX = 16;
export const MIN_CONTRAST_DELTA_E = 5.0;

function medianOf(values) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

function robustNormalize(values, validMask, { minSpan = 1e-6 } = {}) {
  const validVals = [];
  for (let i = 0; i < values.length; i++) {
    if (validMask[i]) validVals.push(values[i]);
  }
  const out = new Float32Array(values.length);
  if (!validVals.length) return { normalized: out, rawSpan: 0, maxVal: 0 };

  const sorted = Float32Array.from(validVals).sort();
  const n = sorted.length;
  const minVal = sorted[0];
  const maxVal = sorted[n - 1];
  const rawSpan = maxVal - minVal;

  let lo = sorted[Math.floor(n * 0.01)];
  let hi = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  const p999 = sorted[Math.min(n - 1, Math.floor(n * 0.999))];

  // Fall back to p99.9 when p99 collapses (e.g. high-contrast lesion occupying < 1% of the frame).
  if (hi - lo < minSpan || (p999 - lo >= minSpan && hi - lo < 0.25 * (p999 - lo))) {
    hi = p999;
  }
  // Fall back to true min..max when even p99.9 collapses (e.g. lesion occupying < 0.1% of the frame).
  if (hi - lo < minSpan || (rawSpan >= minSpan && hi - lo < 0.25 * rawSpan)) {
    lo = minVal;
    hi = maxVal;
  }

  const span = hi - lo;
  if (span <= 1e-6) return { normalized: out, rawSpan, maxVal };

  for (let i = 0; i < values.length; i++) {
    if (!validMask[i]) continue;
    const v = (values[i] - lo) / span;
    out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return { normalized: out, rawSpan, maxVal };
}

/**
 * Estimate median perilesional skin CIE L*a*b* from the outer valid ring (5–15% from the valid frame edge).
 */
export function estimatePerilesionalSkin(lab, width, height, validMask) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!validMask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    return { L: 70, a: 10, b: 15, sampleCount: 0 };
  }

  const boxW = Math.max(1, maxX - minX + 1);
  const boxH = Math.max(1, maxY - minY + 1);
  const ringL = [];
  const ringA = [];
  const ringB = [];

  for (let y = minY; y <= maxY; y++) {
    const dy = Math.min(y - minY, maxY - y) / boxH;
    const row = y * width;
    for (let x = minX; x <= maxX; x++) {
      const idx = row + x;
      if (!validMask[idx]) continue;
      const dx = Math.min(x - minX, maxX - x) / boxW;
      const edgeFrac = Math.min(dx, dy);
      if (edgeFrac >= 0.05 && edgeFrac <= 0.15) {
        ringL.push(lab.L[idx]);
        ringA.push(lab.a[idx]);
        ringB.push(lab.b[idx]);
      }
    }
  }

  // Fallback for very small images or heavy vignettes where the 5–15% strip has few valid pixels.
  if (ringL.length < 16) {
    ringL.length = 0;
    ringA.length = 0;
    ringB.length = 0;
    for (let y = minY; y <= maxY; y++) {
      const dy = Math.min(y - minY, maxY - y) / boxH;
      const row = y * width;
      for (let x = minX; x <= maxX; x++) {
        const idx = row + x;
        if (!validMask[idx]) continue;
        const dx = Math.min(x - minX, maxX - x) / boxW;
        if (Math.min(dx, dy) <= 0.2) {
          ringL.push(lab.L[idx]);
          ringA.push(lab.a[idx]);
          ringB.push(lab.b[idx]);
        }
      }
    }
  }

  return {
    L: medianOf(ringL),
    a: medianOf(ringA),
    b: medianOf(ringB),
    sampleCount: ringL.length,
  };
}

/** Otsu threshold over valid pixels for a score field in [0, 1]. */
export function otsuThreshold(scores, validMask) {
  const bins = 256;
  const hist = new Uint32Array(bins);
  let total = 0;
  for (let i = 0; i < scores.length; i++) {
    if (!validMask[i]) continue;
    const b = Math.max(0, Math.min(255, Math.round(scores[i] * 255)));
    hist[b]++;
    total++;
  }
  if (total === 0) return 0.5;

  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];

  let wB = 0;
  let sumB = 0;
  let bestVar = -1;
  let bestBin = 128;

  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const diff = mB - mF;
    const betweenVar = wB * wF * diff * diff;
    if (betweenVar > bestVar) {
      bestVar = betweenVar;
      bestBin = b;
    }
  }

  return bestBin / 255;
}

function morphDilate3x3(mask, width, height, validMask) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!validMask[idx]) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let hit = 0;
      for (let ny = y0; ny <= y1 && !hit; ny++) {
        const row = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          if (mask[row + nx]) {
            hit = 1;
            break;
          }
        }
      }
      out[idx] = hit;
    }
  }
  return out;
}

function morphErode3x3(mask, width, height, validMask) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!validMask[idx] || !mask[idx]) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let all = 1;
      for (let ny = y0; ny <= y1 && all; ny++) {
        const row = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          if (!mask[row + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[idx] = all;
    }
  }
  return out;
}

/** Keep the single 8-connected component with highest area * center-proximity. */
function keepPrimaryLesionComponent(mask, width, height) {
  const count = width * height;
  const labels = new Int32Array(count);
  const queue = new Int32Array(count);
  const cxImg = (width - 1) / 2;
  const cyImg = (height - 1) / 2;
  const rx = Math.max(1, width / 2);
  const ry = Math.max(1, height / 2);

  let nextLabel = 0;
  let bestLabel = 0;
  let bestScore = -1;

  for (let start = 0; start < count; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = ++nextLabel;
    let head = 0;
    let tail = 0;
    labels[start] = label;
    queue[tail++] = start;

    let area = 0;
    let sumX = 0;
    let sumY = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      sumX += x;
      sumY += y;

      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const nIdx = row + nx;
          if (mask[nIdx] && !labels[nIdx]) {
            labels[nIdx] = label;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    const meanX = sumX / area;
    const meanY = sumY / area;
    const dist2 = ((meanX - cxImg) / rx) ** 2 + ((meanY - cyImg) / ry) ** 2;
    const centerProximity = Math.exp(-dist2);
    const score = area * centerProximity;
    if (score > bestScore) {
      bestScore = score;
      bestLabel = label;
    }
  }

  const out = new Uint8Array(count);
  if (bestLabel === 0) return out;
  for (let i = 0; i < count; i++) {
    if (labels[i] === bestLabel) out[i] = 1;
  }
  return out;
}

/** Flood-fill internal holes of a binary mask via 4-connected exterior BFS, keeping invalid/transparent pixels excluded. */
function fillInternalHoles(mask, width, height, validMask = null) {
  const count = width * height;
  const exterior = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const seed = (x, y) => {
    const idx = y * width + x;
    if (!mask[idx] && !exterior[idx]) {
      exterior[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(0, y);
    seed(width - 1, y);
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0 && !mask[idx - 1] && !exterior[idx - 1]) {
      exterior[idx - 1] = 1;
      queue[tail++] = idx - 1;
    }
    if (x + 1 < width && !mask[idx + 1] && !exterior[idx + 1]) {
      exterior[idx + 1] = 1;
      queue[tail++] = idx + 1;
    }
    if (y > 0 && !mask[idx - width] && !exterior[idx - width]) {
      exterior[idx - width] = 1;
      queue[tail++] = idx - width;
    }
    if (y + 1 < height && !mask[idx + width] && !exterior[idx + width]) {
      exterior[idx + width] = 1;
      queue[tail++] = idx + width;
    }
  }

  const filled = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (!exterior[i] && (!validMask || validMask[i])) {
      filled[i] = 1;
    }
  }
  return filled;
}

// Clockwise 8-connected Moore neighborhood offsets starting from West (-1, 0).
const MOORE_DX = [-1, -1, 0, 1, 1, 1, 0, -1];
const MOORE_DY = [0, -1, -1, -1, 0, 1, 1, 1];

/**
 * Extract 8-connected boundary mask and ordered outer contour via Moore-Neighbor tracing
 * with Jacob's stopping criterion (returning to start and departing along the initial direction).
 * Handles isolated 1-pixel masks explicitly and reports `contourComplete: false` if the step guard is reached.
 */
export function extractBoundaryContour(mask, width, height) {
  const count = width * height;
  const boundaryMask = new Uint8Array(count);
  let startX = -1;
  let startY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      if (startX === -1) {
        startX = x;
        startY = y;
      }
      const touchesOutside =
        x === 0 ||
        x === width - 1 ||
        y === 0 ||
        y === height - 1 ||
        !mask[idx - 1] ||
        !mask[idx + 1] ||
        !mask[idx - width] ||
        !mask[idx + width];
      if (touchesOutside) boundaryMask[idx] = 1;
    }
  }

  if (startX === -1) {
    return { boundaryMask, contour: [], contourComplete: true };
  }

  // Start from West (dir = 0), which is guaranteed empty because (startX, startY) is topmost-leftmost.
  let backDir = 0;
  let firstDir = -1;
  let cx = startX;
  let cy = startY;

  for (let k = 1; k <= 8; k++) {
    const dir = (backDir + k) & 7;
    const nx = startX + MOORE_DX[dir];
    const ny = startY + MOORE_DY[dir];
    if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) {
      firstDir = dir;
      cx = nx;
      cy = ny;
      backDir = ((dir & 1) ? dir + 5 : dir + 6) & 7;
      break;
    }
  }

  // Isolated 1-pixel mask has no 8-connected foreground neighbors.
  if (firstDir === -1) {
    return { boundaryMask, contour: [[startX, startY]], contourComplete: true };
  }

  const contour = [
    [startX, startY],
    [cx, cy],
  ];
  const maxSteps = Math.max(16, count * 8);

  for (let step = 0; step < maxSteps; step++) {
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const dir = (backDir + k) & 7;
      const nx = cx + MOORE_DX[dir];
      const ny = cy + MOORE_DY[dir];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) {
        // Jacob's stopping criterion: back at start and about to repeat the initial transition.
        if (cx === startX && cy === startY && dir === firstDir) {
          const last = contour[contour.length - 1];
          if (last[0] === startX && last[1] === startY) contour.pop();
          return { boundaryMask, contour, contourComplete: true };
        }
        contour.push([nx, ny]);
        cx = nx;
        cy = ny;
        // Backtrack pixel is the empty neighbor immediately preceding `dir` around the previous pixel.
        backDir = ((dir & 1) ? dir + 5 : dir + 6) & 7;
        found = true;
        break;
      }
    }
    if (!found) {
      return { boundaryMask, contour, contourComplete: false };
    }
  }

  return { boundaryMask, contour, contourComplete: false };
}

function failedSegmentation(count, labPlanes, skin, otsu, applied, contrastScore, failureReason, extra = {}) {
  return {
    segmented: false,
    failureReason,
    mask: new Uint8Array(count),
    boundaryMask: new Uint8Array(count),
    contour: [],
    contourComplete: extra.contourComplete ?? true,
    areaPx: 0,
    foregroundBackgroundDeltaE: extra.foregroundBackgroundDeltaE ?? 0,
    lab: labPlanes,
    perilesionalSkin: skin,
    otsuThreshold: otsu,
    appliedThreshold: applied,
    contrastScore,
  };
}

/**
 * Segment the primary dermoscopic lesion from preprocessed RGBA pixels.
 */
export function segmentLesion(
  rgba,
  width,
  height,
  validMask,
  { thresholdBias = 0, lab = null } = {},
) {
  const count = width * height;
  const effectiveValid = validMask ?? new Uint8Array(count).fill(1);
  const labPlanes = lab ?? rgbaToLabPlanes(rgba, width, height);
  const skin = estimatePerilesionalSkin(labPlanes, width, height, effectiveValid);

  let validCount = 0;
  for (let i = 0; i < count; i++) validCount += effectiveValid[i] ? 1 : 0;
  const emptyContrast = new Float32Array(count);
  if (validCount < MIN_LESION_AREA_PX) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      0.5,
      0.5,
      emptyContrast,
      "No lesion detected: insufficient valid image area.",
    );
  }

  const distRaw = new Float32Array(count);
  const invLRaw = new Float32Array(count);
  const invBRaw = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    if (!effectiveValid[i]) continue;
    const dL = labPlanes.L[i] - skin.L;
    const da = labPlanes.a[i] - skin.a;
    const db = labPlanes.b[i] - skin.b;
    distRaw[i] = Math.hypot(dL, da, db);
    invLRaw[i] = 100 - labPlanes.L[i];
    invBRaw[i] = 255 - rgba[i * 4 + 2];
  }

  const normDist = robustNormalize(distRaw, effectiveValid, { minSpan: 8 });
  const normInvL = robustNormalize(invLRaw, effectiveValid, { minSpan: 8 });
  const normInvB = robustNormalize(invBRaw, effectiveValid, { minSpan: 16 });

  const contrastScore = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (!effectiveValid[i]) continue;
    contrastScore[i] =
      0.5 * normDist.normalized[i] +
      0.25 * normInvL.normalized[i] +
      0.25 * normInvB.normalized[i];
  }

  const autoThreshold = otsuThreshold(contrastScore, effectiveValid);
  const appliedThreshold = Math.max(0.01, Math.min(0.99, autoThreshold + thresholdBias));

  // Reject uniform or negligible-contrast images before binarizing noise.
  if (normDist.maxVal < MIN_CONTRAST_DELTA_E && normInvL.rawSpan < 6 && normInvB.rawSpan < 10) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      autoThreshold,
      appliedThreshold,
      contrastScore,
      "No lesion detected: image has negligible foreground-to-background contrast.",
    );
  }

  const binary = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (effectiveValid[i] && contrastScore[i] >= appliedThreshold) binary[i] = 1;
  }

  // 3x3 morphological closing followed by 3x3 opening.
  const closed = morphErode3x3(morphDilate3x3(binary, width, height, effectiveValid), width, height, effectiveValid);
  const cleaned = morphDilate3x3(morphErode3x3(closed, width, height, effectiveValid), width, height, effectiveValid);

  const primary = keepPrimaryLesionComponent(cleaned, width, height);
  const mask = fillInternalHoles(primary, width, height, effectiveValid);

  let areaPx = 0;
  let fgL = 0;
  let fgA = 0;
  let fgB = 0;
  let bgCount = 0;
  let bgL = 0;
  let bgA = 0;
  let bgB = 0;
  for (let i = 0; i < count; i++) {
    if (!effectiveValid[i]) continue;
    if (mask[i]) {
      areaPx++;
      fgL += labPlanes.L[i];
      fgA += labPlanes.a[i];
      fgB += labPlanes.b[i];
    } else {
      bgCount++;
      bgL += labPlanes.L[i];
      bgA += labPlanes.a[i];
      bgB += labPlanes.b[i];
    }
  }

  if (areaPx < MIN_LESION_AREA_PX) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      autoThreshold,
      appliedThreshold,
      contrastScore,
      "No lesion detected: segmented region is empty or smaller than 16 px.",
    );
  }

  if (bgCount === 0) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      autoThreshold,
      appliedThreshold,
      contrastScore,
      "No lesion detected: no surrounding perilesional skin found.",
    );
  }

  const foregroundBackgroundDeltaE = Math.hypot(
    fgL / areaPx - bgL / bgCount,
    fgA / areaPx - bgA / bgCount,
    fgB / areaPx - bgB / bgCount,
  );

  if (foregroundBackgroundDeltaE < MIN_CONTRAST_DELTA_E) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      autoThreshold,
      appliedThreshold,
      contrastScore,
      "No lesion detected: insufficient foreground-to-background contrast.",
      { foregroundBackgroundDeltaE },
    );
  }

  const { boundaryMask, contour, contourComplete } = extractBoundaryContour(mask, width, height);
  if (!contourComplete || contour.length === 0) {
    return failedSegmentation(
      count,
      labPlanes,
      skin,
      autoThreshold,
      appliedThreshold,
      contrastScore,
      "No lesion detected: lesion boundary contour trace did not close.",
      { foregroundBackgroundDeltaE, contourComplete },
    );
  }

  return {
    segmented: true,
    failureReason: null,
    mask,
    boundaryMask,
    contour,
    contourComplete: true,
    areaPx,
    foregroundBackgroundDeltaE,
    lab: labPlanes,
    perilesionalSkin: skin,
    otsuThreshold: autoThreshold,
    appliedThreshold,
    contrastScore,
  };
}
