// Pure DOM-free Target vs Perilesional Reference ROI segmentation, circular ROI rasterization,
// and per-ROI colorimetry/chromophore summary statistics.
import {
  ITA_BANDS,
  ITA_UNAVAILABLE_BAND,
  ITA_UNAVAILABLE_LABEL,
  ciede2000,
  classifyIta,
  computeIta,
  isItaValidB,
  itaBandIndex,
} from "./colorimetry.js";

export const METRIC_KEYS = Object.freeze(["L", "a", "b", "ita", "ei", "mi", "melanin", "hemoglobin"]);

/**
 * Computes Otsu threshold over finite values in `values` at `indices`.
 * Uses identical bin edges `min + (b / bins) * span` for histogram binning and the
 * returned threshold `min + ((bestBin + 1) / bins) * span` so `v >= threshold` partitions
 * bins `bestBin + 1 .. bins - 1` identically to the Otsu objective.
 */
export function otsuThreshold(values, indices, bins = 256) {
  const n = indices.length;
  if (n === 0) return { threshold: 0, min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < n; k++) {
    const v = values[indices[k]];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span <= 1e-9) return { threshold: min, min, max };

  const hist = new Uint32Array(bins);
  for (let k = 0; k < n; k++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(((values[indices[k]] - min) / span) * bins)));
    hist[b]++;
  }

  let totalSum = 0;
  for (let b = 0; b < bins; b++) totalSum += b * hist[b];

  let wB = 0;
  let sumB = 0;
  let maxVar = -1;
  let bestBin = 0;

  for (let b = 0; b < bins - 1; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (totalSum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestBin = b;
    }
  }
  return { threshold: min + ((bestBin + 1) / bins) * span, min, max };
}

function validGeometry(validMask, width, height) {
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (validMask[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) {
    return { cx: width / 2, cy: height / 2, radius: Math.min(width, height) / 2 };
  }
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    radius: Math.max(1, Math.min(maxX - minX + 1, maxY - minY + 1) / 2),
  };
}

/** Keeps the largest 4-connected component in a binary mask (preferring components near center). */
function largestCentralComponent(mask, width, height, cx, cy, maxCenterDist) {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const compPixels = new Int32Array(total);
  let bestPixels = null;
  let bestScore = -1;

  for (let start = 0; start < total; start++) {
    if (!mask[start] || visited[start]) continue;
    let sp = 0;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    visited[start] = 1;
    stack[sp++] = start;

    while (sp > 0) {
      const idx = stack[--sp];
      compPixels[count++] = idx;
      const x = idx % width;
      const y = (idx - x) / width;
      sumX += x;
      sumY += y;
      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) {
        visited[idx - 1] = 1;
        stack[sp++] = idx - 1;
      }
      if (x + 1 < width && mask[idx + 1] && !visited[idx + 1]) {
        visited[idx + 1] = 1;
        stack[sp++] = idx + 1;
      }
      if (y > 0 && mask[idx - width] && !visited[idx - width]) {
        visited[idx - width] = 1;
        stack[sp++] = idx - width;
      }
      if (y + 1 < height && mask[idx + width] && !visited[idx + width]) {
        visited[idx + width] = 1;
        stack[sp++] = idx + width;
      }
    }

    const dist = Math.hypot(sumX / count - cx, sumY / count - cy);
    const centrality = dist <= maxCenterDist ? 1 : 0.25;
    const score = count * centrality;
    if (score > bestScore) {
      bestScore = score;
      bestPixels = compPixels.slice(0, count);
    }
  }

  const out = new Uint8Array(total);
  if (bestPixels) {
    for (let k = 0; k < bestPixels.length; k++) out[bestPixels[k]] = 1;
  }
  return { mask: out, count: bestPixels ? bestPixels.length : 0 };
}

/**
 * Rasterizes a circular ROI { cx, cy, r } intersected with validMask.
 * Never fabricates or reinserts masked pixels when the circle falls entirely in excluded pixels.
 */
export function rasterizeCircleMask(width, height, circle, validMask = null) {
  const mask = new Uint8Array(width * height);
  if (width <= 0 || height <= 0) return { mask, count: 0 };
  const cx = circle.cx;
  const cy = circle.cy;
  const r = Math.max(1, circle.r);
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      if (dx * dx + dy2 <= r2) {
        const idx = row + x;
        if (!validMask || validMask[idx]) {
          mask[idx] = 1;
          count++;
        }
      }
    }
  }
  return { mask, count };
}

/**
 * Builds a morphological-dilation perilesional reference ring strictly outside `targetMask`
 * within `validMask` using a multi-source BFS distance transform from the lesion boundary.
 * Never overlaps `targetMask`.
 */
export function buildPerilesionalRing(targetMask, targetCount, validMask, width, height, geom) {
  const total = width * height;
  const referenceMask = new Uint8Array(total);
  if (total === 0 || targetCount === 0) {
    return { mask: referenceMask, count: 0 };
  }

  let remainingValid = 0;
  for (let i = 0; i < total; i++) {
    if (validMask[i] && !targetMask[i]) remainingValid++;
  }
  if (remainingValid === 0) {
    return { mask: referenceMask, count: 0 };
  }

  const tRad = Math.max(2, Math.sqrt(targetCount / Math.PI));
  const innerMargin = Math.max(2, Math.round(tRad * 0.15));
  const outerMargin = Math.max(
    innerMargin + 4,
    Math.min(Math.max(8, Math.round(geom.radius)), Math.round(Math.max(tRad * 0.85, 0.18 * geom.radius))),
  );
  const minRequired = Math.min(16, Math.max(1, Math.floor(remainingValid * 0.05)));

  const dist = new Int32Array(total);
  dist.fill(-1);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  // Seed BFS with target boundary pixels (distance 0)
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!targetMask[idx]) continue;
      const onEdge = (x > 0 && !targetMask[idx - 1])
        || (x + 1 < width && !targetMask[idx + 1])
        || (y > 0 && !targetMask[idx - width])
        || (y + 1 < height && !targetMask[idx + width]);
      if (onEdge) {
        dist[idx] = 0;
        queue[tail++] = idx;
      }
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const nextDist = dist[idx] + 1;
    if (nextDist > outerMargin) continue;
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) {
      const n = idx - 1;
      if (!targetMask[n] && dist[n] === -1) {
        dist[n] = nextDist;
        queue[tail++] = n;
      }
    }
    if (x + 1 < width) {
      const n = idx + 1;
      if (!targetMask[n] && dist[n] === -1) {
        dist[n] = nextDist;
        queue[tail++] = n;
      }
    }
    if (y > 0) {
      const n = idx - width;
      if (!targetMask[n] && dist[n] === -1) {
        dist[n] = nextDist;
        queue[tail++] = n;
      }
    }
    if (y + 1 < height) {
      const n = idx + width;
      if (!targetMask[n] && dist[n] === -1) {
        dist[n] = nextDist;
        queue[tail++] = n;
      }
    }
  }

  let refCount = 0;
  for (let i = 0; i < total; i++) {
    if (validMask[i] && !targetMask[i] && dist[i] >= innerMargin && dist[i] <= outerMargin) {
      referenceMask[i] = 1;
      refCount++;
    }
  }

  // If buffer margin leaves too few pixels, relax inner gap to 1 px (still strictly outside target).
  if (refCount < minRequired) {
    referenceMask.fill(0);
    refCount = 0;
    for (let i = 0; i < total; i++) {
      if (validMask[i] && !targetMask[i] && dist[i] >= 1 && dist[i] <= outerMargin) {
        referenceMask[i] = 1;
        refCount++;
      }
    }
  }

  // Final fallback: all remaining valid non-target pixels (still never overlapping targetMask).
  if (refCount < minRequired) {
    referenceMask.fill(0);
    refCount = 0;
    for (let i = 0; i < total; i++) {
      if (validMask[i] && !targetMask[i]) {
        referenceMask[i] = 1;
        refCount++;
      }
    }
  }
  return { mask: referenceMask, count: refCount };
}

/**
 * Detects a single central lesion candidate via Otsu CIE L*a*b* contrast against the outer valid ring.
 * Returns `{ mask, count }` when a clear lesion component exists, or `null` otherwise.
 */
function detectAutoLesion(width, height, validMask, validCount, maps, geom) {
  const total = width * height;
  const rOuterLow = 0.65 * geom.radius;
  const rOuterHigh = 0.96 * geom.radius;
  let bgL = 0;
  let bgA = 0;
  let bgB = 0;
  let bgN = 0;

  for (let y = 0; y < height; y++) {
    const dy = y - geom.cy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!validMask[idx]) continue;
      const d = Math.hypot(x - geom.cx, dy);
      if (d >= rOuterLow && d <= rOuterHigh) {
        bgL += maps.L[idx];
        bgA += maps.a[idx];
        bgB += maps.b[idx];
        bgN++;
      }
    }
  }
  if (bgN < 8) {
    bgL = 0;
    bgA = 0;
    bgB = 0;
    bgN = 0;
    for (let i = 0; i < total; i++) {
      if (!validMask[i]) continue;
      bgL += maps.L[i];
      bgA += maps.a[i];
      bgB += maps.b[i];
      bgN++;
    }
  }
  if (bgN > 0) {
    bgL /= bgN;
    bgA /= bgN;
    bgB /= bgN;
  }

  const contrast = new Float32Array(total);
  const candidateIndices = [];
  const centralLimit = 0.75 * geom.radius;
  for (let y = 0; y < height; y++) {
    const dy = y - geom.cy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!validMask[idx]) continue;
      if (Math.hypot(x - geom.cx, dy) <= centralLimit) {
        const distLab = Math.hypot(maps.L[idx] - bgL, maps.a[idx] - bgA, maps.b[idx] - bgB);
        contrast[idx] = distLab;
        candidateIndices.push(idx);
      }
    }
  }

  const { threshold, min, max } = otsuThreshold(contrast, candidateIndices);
  const minArea = Math.max(4, Math.floor(validCount * 0.02));
  const maxArea = Math.floor(validCount * 0.65);

  if (max - min >= 4.0 && candidateIndices.length >= minArea) {
    const candidateMask = new Uint8Array(total);
    for (let k = 0; k < candidateIndices.length; k++) {
      const idx = candidateIndices[k];
      if (contrast[idx] >= threshold) candidateMask[idx] = 1;
    }
    const comp = largestCentralComponent(candidateMask, width, height, geom.cx, geom.cy, 0.55 * geom.radius);
    if (comp.count >= minArea && comp.count <= maxArea) {
      return { mask: comp.mask, count: comp.count };
    }
  }
  return null;
}

/**
 * Generates Target and Perilesional Reference masks automatically (`auto` or `central`)
 * or from optional manual circular ROIs `{ cx, cy, r }`.
 */
export function buildRoiMasks({
  width,
  height,
  validMask,
  validCount,
  maps,
  roiMode = "auto",
  customTarget = null,
  customReference = null,
}) {
  const total = width * height;
  const geom = validGeometry(validMask, width, height);
  const centralRadius = Math.max(1, 0.5 * geom.radius);

  let targetMask;
  let targetCount;
  let strategy;
  let autoFallback = false;

  if (customTarget) {
    const raster = rasterizeCircleMask(width, height, customTarget, validMask);
    targetMask = raster.mask;
    targetCount = raster.count;
    strategy = customReference ? "manual" : "manual-target";
  } else if (roiMode === "central") {
    const raster = rasterizeCircleMask(width, height, { cx: geom.cx, cy: geom.cy, r: centralRadius }, validMask);
    targetMask = raster.mask;
    targetCount = raster.count;
    strategy = "central-disk";
  } else {
    // Otsu CIE Lab contrast against the outer valid ring, falling back to a central 25% disk.
    const autoLesion = detectAutoLesion(width, height, validMask, validCount, maps, geom);
    if (autoLesion) {
      targetMask = autoLesion.mask;
      targetCount = autoLesion.count;
      strategy = "auto-otsu";
    } else {
      const raster = rasterizeCircleMask(width, height, { cx: geom.cx, cy: geom.cy, r: centralRadius }, validMask);
      targetMask = raster.mask;
      targetCount = raster.count;
      strategy = "auto-central-fallback";
      autoFallback = true;
    }
  }

  let referenceMask;
  let referenceCount;
  if (customReference) {
    const raster = rasterizeCircleMask(width, height, customReference, validMask);
    referenceMask = raster.mask;
    referenceCount = raster.count;
    if (!customTarget) strategy = "manual-reference";
  } else {
    let ringSeedMask = targetMask;
    let ringSeedCount = targetCount;
    // When a manual target sits inside a detected lesion, place the automatic perilesional
    // reference ring outside the entire lesion rather than sampling lesion tissue inside it.
    if (customTarget && targetCount > 0) {
      const autoLesion = detectAutoLesion(width, height, validMask, validCount, maps, geom);
      if (autoLesion) {
        let overlapsLesion = false;
        for (let i = 0; i < total; i++) {
          if (targetMask[i] && autoLesion.mask[i]) {
            overlapsLesion = true;
            break;
          }
        }
        if (overlapsLesion) {
          const unionMask = new Uint8Array(total);
          let unionCount = 0;
          for (let i = 0; i < total; i++) {
            if (targetMask[i] || autoLesion.mask[i]) {
              unionMask[i] = 1;
              unionCount++;
            }
          }
          ringSeedMask = unionMask;
          ringSeedCount = unionCount;
        }
      }
    }
    const ring = buildPerilesionalRing(ringSeedMask, ringSeedCount, validMask, width, height, geom);
    referenceMask = ring.mask;
    referenceCount = ring.count;
  }

  let overlapPixels = 0;
  for (let i = 0; i < total; i++) {
    if (targetMask[i] && referenceMask[i]) overlapPixels++;
  }

  return {
    targetMask,
    targetCount,
    referenceMask,
    referenceCount,
    strategy,
    autoFallback,
    overlapPixels,
  };
}

function emptySeries() {
  return { mean: null, sd: null, median: null };
}

function summarizeSeries(values, indices) {
  const n = indices.length;
  if (n === 0) return emptySeries();
  let sum = 0;
  const sample = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = values[indices[k]];
    sum += v;
    sample[k] = v;
  }
  const mean = sum / n;
  let sq = 0;
  for (let k = 0; k < n; k++) {
    const d = sample[k] - mean;
    sq += d * d;
  }
  const sd = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  sample.sort();
  const mid = n >>> 1;
  const median = (n & 1) === 1 ? sample[mid] : 0.5 * (sample[mid - 1] + sample[mid]);
  return { mean, sd, median };
}

/**
 * Computes mean, SD, median for every metric and dominant ITA° band inside `mask`.
 * Returns null statistics (never fabricated zeros or bands) when `mask` has 0 pixels,
 * and excludes pixels outside the valid ITA° skin domain (b* <= 1) from ITA° statistics.
 */
export function summarizeRoi(maps, mask, width, height, validCount) {
  const total = width * height;
  let count = 0;
  for (let i = 0; i < total; i++) if (mask[i]) count++;

  if (count === 0) {
    const empty = {
      pixelCount: 0,
      areaFraction: validCount > 0 ? 0 : null,
      centroid: null,
      equivalentRadius: null,
      itaValidPixels: 0,
      itaValidFraction: null,
      meanCoordIta: null,
      meanCoordItaBand: null,
      dominantItaBand: null,
      itaBandFractions: null,
    };
    for (const key of METRIC_KEYS) empty[key] = emptySeries();
    return empty;
  }

  const indices = new Int32Array(count);
  const itaValidList = [];
  const bandCounts = new Uint32Array(ITA_BANDS.length);
  let sumX = 0;
  let sumY = 0;
  let pos = 0;
  for (let i = 0; i < total; i++) {
    if (!mask[i]) continue;
    indices[pos++] = i;
    const x = i % width;
    const y = (i - x) / width;
    sumX += x;
    sumY += y;
    const band = itaBandIndex(maps.ita[i], maps.b[i]);
    if (band !== ITA_UNAVAILABLE_BAND) {
      itaValidList.push(i);
      bandCounts[band]++;
    }
  }

  const itaValidPixels = itaValidList.length;
  const stats = {
    pixelCount: count,
    areaFraction: validCount > 0 ? count / validCount : null,
    centroid: { x: sumX / count, y: sumY / count },
    equivalentRadius: Math.sqrt(count / Math.PI),
    itaValidPixels,
    itaValidFraction: itaValidPixels / count,
  };

  for (const key of METRIC_KEYS) {
    if (key === "ita") {
      stats.ita = summarizeSeries(maps.ita, itaValidList);
    } else {
      stats[key] = summarizeSeries(maps[key], indices);
    }
  }

  if (isItaValidB(stats.b.mean)) {
    stats.meanCoordIta = computeIta(stats.L.mean, stats.b.mean);
    stats.meanCoordItaBand = classifyIta(stats.meanCoordIta);
  } else {
    stats.meanCoordIta = null;
    stats.meanCoordItaBand = ITA_UNAVAILABLE_LABEL;
  }

  if (itaValidPixels > 0) {
    let bestBand = 0;
    let bestCount = -1;
    for (let b = 0; b < bandCounts.length; b++) {
      if (bandCounts[b] > bestCount) {
        bestCount = bandCounts[b];
        bestBand = b;
      }
    }
    stats.dominantItaBand = ITA_BANDS[bestBand].label;
  } else {
    stats.dominantItaBand = ITA_UNAVAILABLE_LABEL;
  }

  const fractions = Object.fromEntries(
    ITA_BANDS.map((band, b) => [band.label, bandCounts[b] / count]),
  );
  fractions[ITA_UNAVAILABLE_LABEL] = (count - itaValidPixels) / count;
  stats.itaBandFractions = fractions;
  return stats;
}

function diffFinite(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

/** Computes Target minus Reference deltas and exact CIEDE2000 between mean Lab colors. */
export function compareRois(target, reference) {
  if (
    !target
    || !reference
    || target.pixelCount === 0
    || reference.pixelCount === 0
    || !Number.isFinite(target.L.mean)
    || !Number.isFinite(reference.L.mean)
  ) {
    return {
      deltaE2000: null,
      deltaL: null,
      deltaA: null,
      deltaB: null,
      deltaITA: null,
      deltaMeanCoordITA: null,
      deltaEI: null,
      deltaMI: null,
      deltaHemoglobin: null,
      deltaMelanin: null,
    };
  }
  const deltaE2000 = ciede2000(
    [target.L.mean, target.a.mean, target.b.mean],
    [reference.L.mean, reference.a.mean, reference.b.mean],
  );
  return {
    deltaE2000,
    deltaL: diffFinite(target.L.mean, reference.L.mean),
    deltaA: diffFinite(target.a.mean, reference.a.mean),
    deltaB: diffFinite(target.b.mean, reference.b.mean),
    deltaITA: diffFinite(target.ita.mean, reference.ita.mean),
    deltaMeanCoordITA: diffFinite(target.meanCoordIta, reference.meanCoordIta),
    deltaEI: diffFinite(target.ei.mean, reference.ei.mean),
    deltaMI: diffFinite(target.mi.mean, reference.mi.mean),
    deltaHemoglobin: diffFinite(target.hemoglobin.mean, reference.hemoglobin.mean),
    deltaMelanin: diffFinite(target.melanin.mean, reference.melanin.mean),
  };
}
