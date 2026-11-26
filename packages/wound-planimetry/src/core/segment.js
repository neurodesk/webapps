// Pure DOM-free wound-bed segmentation in CIE L*a*b* colour space:
// border skin reference -> pure contrast gate -> spatial prominence score ->
// Otsu + sensitivity bias -> border-aware 3x3 morphological closing & guarded
// opening -> transparency-aware hole filling -> component selection.

const MIN_CONTRAST_PEAK = 0.15;
const MIN_CONTRAST_SEPARATION = 0.12;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function countForeground(mask) {
  let total = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) total++;
  }
  return total;
}

function normalizeSeed(seed, width, height) {
  if (!Array.isArray(seed) || seed.length !== 2) return null;
  if (!Number.isFinite(seed[0]) || !Number.isFinite(seed[1])) return null;
  return [
    clamp(Math.round(seed[0]), 0, width - 1),
    clamp(Math.round(seed[1]), 0, height - 1),
  ];
}

/**
 * Estimate surrounding intact skin / background CIE L*a*b* colour from opaque
 * pixels in the image border band (falling back to all opaque pixels when the
 * border band is transparent). Returns null when the image has no opaque pixels.
 */
export function estimateBorderLab(L, a, b, width, height, opaque = null) {
  const marginX = Math.max(1, Math.round(width * 0.08));
  const marginY = Math.max(1, Math.round(height * 0.08));
  const sampleL = [];
  const sampleA = [];
  const sampleB = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));

  for (let y = 0; y < height; y += stride) {
    const inYBand = y < marginY || y >= height - marginY;
    for (let x = 0; x < width; x += stride) {
      if (!inYBand && x >= marginX && x < width - marginX) continue;
      const idx = y * width + x;
      if (opaque && !opaque[idx]) continue;
      sampleL.push(L[idx]);
      sampleA.push(a[idx]);
      sampleB.push(b[idx]);
    }
  }

  // If the outer frame is completely transparent, sample all opaque pixels.
  if (!sampleL.length) {
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const idx = y * width + x;
        if (opaque && !opaque[idx]) continue;
        sampleL.push(L[idx]);
        sampleA.push(a[idx]);
        sampleB.push(b[idx]);
      }
    }
  }

  if (!sampleL.length) return null;
  sampleL.sort((u, v) => u - v);
  sampleA.sort((u, v) => u - v);
  sampleB.sort((u, v) => u - v);
  const mid = sampleL.length >> 1;
  return [sampleL[mid], sampleA[mid], sampleB[mid]];
}

/**
 * Compute Otsu threshold on a Float32Array with values in [0, 1], considering
 * only opaque pixels when an opacity mask is supplied. Uses midpoint tie-breaking
 * across equally optimal bins so clean bimodal fields split at their midpoint.
 * @param {Float32Array} values
 * @param {Uint8Array | null} [opaque]
 * @returns {number} threshold in [0, 1]
 */
export function otsuThreshold(values, opaque = null) {
  const bins = 256;
  const hist = new Uint32Array(bins);
  const len = values.length;
  let n = 0;

  for (let i = 0; i < len; i++) {
    if (opaque && !opaque[i]) continue;
    const bin = clamp(Math.floor(values[i] * 255 + 0.5), 0, 255);
    hist[bin]++;
    n++;
  }
  if (n === 0) return 0.5;

  let totalSum = 0;
  for (let i = 0; i < bins; i++) totalSum += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVariance = -1;
  let bestStart = 128;
  let bestEnd = 128;

  for (let i = 0; i < bins - 1; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (totalSum - sumB) / wF;
    const diff = mB - mF;
    const variance = wB * wF * diff * diff;
    if (variance > maxVariance * (1 + 1e-12)) {
      maxVariance = variance;
      bestStart = i;
      bestEnd = i;
    } else if (maxVariance > 0 && variance >= maxVariance * (1 - 1e-12)) {
      bestEnd = i;
    }
  }
  if (maxVariance <= 0) return 1;
  return (0.5 * (bestStart + bestEnd) + 0.5) / 255;
}

/**
 * Compute pure colour/intensity contrast evidence relative to surrounding skin
 * WITHOUT any spatial weighting or absolute-redness bias, and verify genuine
 * foreground-background separation before spatial weighting is ever applied.
 */
export function computeContrastEvidence(colors, width, height) {
  const { L, a, b, opaque = null } = colors;
  const count = width * height;
  const evidence = new Float32Array(count);
  const borderLab = estimateBorderLab(L, a, b, width, height, opaque);

  if (!borderLab) {
    return { evidence, borderLab: null, hasContrast: false, peakEvidence: 0, separation: 0 };
  }

  const [L0, a0, b0] = borderLab;
  let peakEvidence = 0;

  for (let i = 0; i < count; i++) {
    if (opaque && !opaque[i]) continue;
    const dL = L[i] - L0;
    const da = a[i] - a0;
    const db = b[i] - b0;
    const redRelative = clamp(da / 28, 0, 1);
    const contrast = clamp(Math.hypot(0.65 * dL, da, db) / 30, 0, 1);
    const ev = Math.max(contrast, 0.7 * redRelative + 0.3 * contrast);
    evidence[i] = ev;
    if (ev > peakEvidence) peakEvidence = ev;
  }

  if (peakEvidence < MIN_CONTRAST_PEAK) {
    return { evidence, borderLab, hasContrast: false, peakEvidence, separation: 0 };
  }

  const pureOtsu = otsuThreshold(evidence, opaque);
  let fgSum = 0;
  let fgCount = 0;
  let bgSum = 0;
  let bgCount = 0;
  for (let i = 0; i < count; i++) {
    if (opaque && !opaque[i]) continue;
    const ev = evidence[i];
    if (ev >= pureOtsu) {
      fgSum += ev;
      fgCount++;
    } else {
      bgSum += ev;
      bgCount++;
    }
  }

  const separation = fgCount > 0 && bgCount > 0 ? fgSum / fgCount - bgSum / bgCount : 0;
  const hasContrast = separation >= MIN_CONTRAST_SEPARATION;
  return { evidence, borderLab, hasContrast, peakEvidence, separation };
}

/**
 * Compute normalized [0, 1] wound-bed prominence score combining elevated redness (a*),
 * chromatic/lightness contrast against surrounding skin, and central (or seed) spatial weighting.
 * Transparent pixels always score 0.
 */
export function woundProminenceMap(colors, width, height, seed = null, borderLabOverride = undefined) {
  const { L, a, b, opaque = null } = colors;
  const count = width * height;
  const score = new Float32Array(count);
  const borderLab = borderLabOverride !== undefined
    ? borderLabOverride
    : estimateBorderLab(L, a, b, width, height, opaque);
  if (!borderLab) return score;
  const [L0, a0, b0] = borderLab;

  const hasSeed = Array.isArray(seed) && seed.length === 2 && Number.isFinite(seed[0]) && Number.isFinite(seed[1]);
  const cx = hasSeed ? clamp(seed[0], 0, width - 1) : (width - 1) * 0.5;
  const cy = hasSeed ? clamp(seed[1], 0, height - 1) : (height - 1) * 0.5;
  const invHalfW = 2 / Math.max(1, width);
  const invHalfH = 2 / Math.max(1, height);
  const sigma = hasSeed ? 0.75 : 0.9;
  const invTwoSigmaSq = 0.5 / (sigma * sigma);
  const spatialBase = hasSeed ? 0.35 : 0.55;
  const spatialGain = 1 - spatialBase;

  for (let y = 0; y < height; y++) {
    const dy = (y - cy) * invHalfH;
    const dy2 = dy * dy;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (opaque && !opaque[idx]) continue;
      const dx = (x - cx) * invHalfW;
      const spatial = spatialBase + spatialGain * Math.exp(-(dx * dx + dy2) * invTwoSigmaSq);

      const dL = L[idx] - L0;
      const da = a[idx] - a0;
      const db = b[idx] - b0;

      // Elevated redness relative to surrounding skin and absolute redness.
      const redRelative = clamp(da / 28, 0, 1);
      const redAbsolute = clamp((a[idx] - 14) / 36, 0, 1);
      const redScore = Math.max(redRelative, 0.75 * redAbsolute);

      // Chromatic and lightness contrast catches granulation, yellow slough and dark eschar.
      const contrast = clamp(Math.hypot(0.65 * dL, da, db) / 30, 0, 1);

      const tissueEvidence = Math.max(contrast, 0.7 * redScore + 0.3 * contrast);
      score[idx] = spatial * tissueEvidence;
    }
  }
  return score;
}

/** 3x3 binary dilation (never expands into transparent pixels). */
export function dilate3x3(mask, width, height, opaque = null) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (opaque && !opaque[idx]) continue;
      if (mask[idx]) {
        out[idx] = 1;
        continue;
      }
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let hit = 0;
      for (let ny = y0; ny <= y1 && !hit; ny++) {
        const nRow = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          if (mask[nRow + nx]) {
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

/**
 * Border-aware 3x3 binary erosion: out-of-bounds and transparent neighbours are
 * clamped/ignored rather than treated as 0, so foreground masks touching the
 * image frame are never clipped.
 */
export function erode3x3(mask, width, height, opaque = null) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx] || (opaque && !opaque[idx])) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let allSet = 1;
      for (let ny = y0; ny <= y1 && allSet; ny++) {
        const nRow = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const nIdx = nRow + nx;
          if (opaque && !opaque[nIdx]) continue;
          if (!mask[nIdx]) {
            allSet = 0;
            break;
          }
        }
      }
      out[idx] = allSet;
    }
  }
  return out;
}

/**
 * Border-aware 3x3 morphological closing (dilate then erode).
 * Border pixels that were foreground in `mask` clamp out-of-bounds neighbours
 * to 1 (no border clipping), while border pixels that were background in `mask`
 * clamp out-of-bounds neighbours to 0 so near-border noise specks are never
 * fused onto the image frame.
 */
export function morphClose3x3(mask, width, height, opaque = null) {
  const dilated = dilate3x3(mask, width, height, opaque);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const onYBorder = y === 0 || y === height - 1;
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!dilated[idx] || (opaque && !opaque[idx])) continue;
      if ((onYBorder || x === 0 || x === width - 1) && !mask[idx]) continue;
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      let allSet = 1;
      for (let ny = y0; ny <= y1 && allSet; ny++) {
        const nRow = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const nIdx = nRow + nx;
          if (opaque && !opaque[nIdx]) continue;
          if (!dilated[nIdx]) {
            allSet = 0;
            break;
          }
        }
      }
      out[idx] = allSet;
    }
  }
  return out;
}

/** 3x3 morphological opening (erode then dilate). */
export function morphOpen3x3(mask, width, height, opaque = null) {
  return dilate3x3(erode3x3(mask, width, height, opaque), width, height, opaque);
}

/**
 * Fill interior 4-connected opaque background holes not connected to the image
 * border or to any transparent pixel.
 */
export function fillHoles(mask, width, height, opaque = null) {
  const count = width * height;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const enqueue = (idx) => {
    if (!visited[idx] && (!mask[idx] || (opaque && !opaque[idx]))) {
      visited[idx] = 1;
      queue[tail++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    enqueue(y * width);
    enqueue(y * width + (width - 1));
  }
  if (opaque) {
    for (let i = 0; i < count; i++) {
      if (!opaque[i]) enqueue(i);
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) enqueue(idx - 1);
    if (x + 1 < width) enqueue(idx + 1);
    if (y > 0) enqueue(idx - width);
    if (y + 1 < height) enqueue(idx + width);
  }

  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (!visited[i] && (!opaque || opaque[i])) out[i] = 1;
  }
  return out;
}

/**
 * Select the single 4-connected component containing the seed (or closest to it,
 * recording seedFallback = true), or when unseeded the highest-scoring central
 * component.
 */
export function selectWoundComponent(mask, score, width, height, seed = null) {
  const count = width * height;
  const labels = new Int32Array(count);
  const queue = new Int32Array(count);
  const components = [];
  let nextLabel = 0;

  const seedPt = normalizeSeed(seed, width, height);
  const hasSeed = seedPt !== null;
  const sx = hasSeed ? seedPt[0] : (width - 1) * 0.5;
  const sy = hasSeed ? seedPt[1] : (height - 1) * 0.5;

  for (let start = 0; start < count; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = ++nextLabel;
    labels[start] = id;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumScore = 0;
    let borderTouch = 0;
    let minSeedDistSq = Infinity;
    let containsSeed = false;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      area++;
      sumX += x;
      sumY += y;
      sumScore += score ? score[idx] : 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) borderTouch++;
      if (hasSeed) {
        if (x === sx && y === sy) containsSeed = true;
        const d2 = (x - sx) * (x - sx) + (y - sy) * (y - sy);
        if (d2 < minSeedDistSq) minSeedDistSq = d2;
      }

      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) {
        labels[idx - 1] = id;
        queue[tail++] = idx - 1;
      }
      if (x + 1 < width && mask[idx + 1] && !labels[idx + 1]) {
        labels[idx + 1] = id;
        queue[tail++] = idx + 1;
      }
      if (y > 0 && mask[idx - width] && !labels[idx - width]) {
        labels[idx - width] = id;
        queue[tail++] = idx - width;
      }
      if (y + 1 < height && mask[idx + width] && !labels[idx + width]) {
        labels[idx + width] = id;
        queue[tail++] = idx + width;
      }
    }

    components.push({
      id,
      area,
      cx: sumX / area,
      cy: sumY / area,
      meanScore: sumScore / area,
      borderFraction: borderTouch / Math.max(1, 2 * (width + height)),
      containsSeed,
      minSeedDistSq,
    });
  }

  const out = new Uint8Array(count);
  if (!components.length) return { mask: out, seedFallback: false };

  let chosen = null;
  let seedFallback = false;
  if (hasSeed) {
    chosen = components.find((comp) => comp.containsSeed) ?? null;
    if (!chosen) {
      seedFallback = true;
      chosen = components.reduce((best, comp) => (comp.minSeedDistSq < best.minSeedDistSq ? comp : best));
    }
  } else {
    const centerX = (width - 1) * 0.5;
    const centerY = (height - 1) * 0.5;
    const scaleX = Math.max(1, width * 0.42);
    const scaleY = Math.max(1, height * 0.42);
    let bestRank = -Infinity;
    for (const comp of components) {
      const dx = (comp.cx - centerX) / scaleX;
      const dy = (comp.cy - centerY) / scaleY;
      const centerWeight = Math.exp(-0.5 * (dx * dx + dy * dy));
      // Penalise large frame-spanning border regions when an interior wound exists.
      const borderPenalty = comp.borderFraction > 0.35 ? 0.2 : 1;
      const rank = comp.meanScore * Math.sqrt(comp.area) * (0.25 + 0.75 * centerWeight) * borderPenalty;
      if (rank > bestRank) {
        bestRank = rank;
        chosen = comp;
      }
    }
  }

  const targetId = chosen.id;
  for (let i = 0; i < count; i++) {
    if (labels[i] === targetId) out[i] = 1;
  }
  return { mask: out, seedFallback };
}

/**
 * Full wound-bed segmentation pipeline from precomputed CIE L*a*b* + opacity arrays.
 * @param {{ L: Float32Array, a: Float32Array, b: Float32Array, opaque?: Uint8Array }} colors
 * @param {number} width
 * @param {number} height
 * @param {{ sensitivity?: number, seed?: [number, number] | null }} [options]
 */
export function segmentWound(colors, width, height, { sensitivity = 0, seed = null } = {}) {
  const count = width * height;
  const opaque = colors.opaque ?? null;
  const { borderLab, hasContrast } = computeContrastEvidence(colors, width, height);

  if (!hasContrast) {
    return {
      mask: new Uint8Array(count),
      score: new Float32Array(count),
      otsuThreshold: 0,
      threshold: 0,
      seedFallback: false,
      hasContrast: false,
    };
  }

  const score = woundProminenceMap(colors, width, height, seed, borderLab);
  const otsu = otsuThreshold(score, opaque);
  const threshold = clamp(otsu - sensitivity, 0.02, 0.98);
  const binary = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if ((!opaque || opaque[i]) && score[i] >= threshold) binary[i] = 1;
  }

  const closed = morphClose3x3(binary, width, height, opaque);
  const opened = morphOpen3x3(closed, width, height, opaque);

  // Preserve small or narrow high-contrast wounds if opening erases the mask or seeded pixel.
  const seedPt = normalizeSeed(seed, width, height);
  const seedErased = seedPt !== null && closed[seedPt[1] * width + seedPt[0]] === 1 && opened[seedPt[1] * width + seedPt[0]] === 0;
  const cleaned = countForeground(opened) > 0 && !seedErased ? opened : closed;

  const filled = fillHoles(cleaned, width, height, opaque);
  const { mask, seedFallback } = selectWoundComponent(filled, score, width, height, seed);
  return { mask, score, otsuThreshold: otsu, threshold, seedFallback, hasContrast: true };
}
