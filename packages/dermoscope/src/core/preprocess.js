// Dermoscopic preprocessing:
// 1. Bilinear downsampling to working resolution (capped at maxDimension, default 512 px)
// 2. Dark-corner / circular dermoscope vignette & alpha masking (morphologically guarded flood-fill from 4 corners + 2px dilation)
// 3. DullRazor hair detection with anisotropy + thin-and-long verification and bilinear inpainting (Lee et al., Comput. Biol. Med. 1997)
// 4. Shades of Gray illuminant color constancy (Finlayson & Trezzi 2004; Barata et al. 2015)

import { applyShadesOfGray, rgbaToLuminance } from "./color.js";

const HAIR_DIRECTIONS = [
  [1, 0, 1],            // 0°
  [1, 1, Math.SQRT2],   // 45°
  [0, 1, 1],            // 90°
  [1, -1, Math.SQRT2],  // 135°
];

const RAY_ANGLES = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [Math.cos(Math.PI / 8), Math.sin(Math.PI / 8)],
  [Math.cos((3 * Math.PI) / 8), Math.sin((3 * Math.PI) / 8)],
  [Math.cos((5 * Math.PI) / 8), Math.sin((5 * Math.PI) / 8)],
  [Math.cos((7 * Math.PI) / 8), Math.sin((7 * Math.PI) / 8)],
];

const ALPHA_VALID_THRESHOLD = 128;

/** Bilinearly downsample RGBA image when max(width, height) exceeds maxDimension, preserving per-axis scale and alpha. */
export function resizeToWorkingResolution(rgba, width, height, maxDimension = 512) {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) {
    return {
      rgba: new Uint8ClampedArray(rgba),
      width,
      height,
      scaleX: 1,
      scaleY: 1,
      scaleFactor: 1,
    };
  }
  const ratio = maxDimension / longest;
  const targetW = Math.max(1, Math.round(width * ratio));
  const targetH = Math.max(1, Math.round(height * ratio));
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  const srcStepX = width / targetW;
  const srcStepY = height / targetH;

  for (let y = 0; y < targetH; y++) {
    const sy = Math.max(0, Math.min(height - 1, (y + 0.5) * srcStepY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < targetW; x++) {
      const sx = Math.max(0, Math.min(width - 1, (x + 0.5) * srcStepX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = sx - x0;

      const i00 = (y0 * width + x0) * 4;
      const i10 = (y0 * width + x1) * 4;
      const i01 = (y1 * width + x0) * 4;
      const i11 = (y1 * width + x1) * 4;
      const o = (y * targetW + x) * 4;

      const w00 = (1 - wx) * (1 - wy);
      const w10 = wx * (1 - wy);
      const w01 = (1 - wx) * wy;
      const w11 = wx * wy;

      const a00 = rgba[i00 + 3];
      const a10 = rgba[i10 + 3];
      const a01 = rgba[i01 + 3];
      const a11 = rgba[i11 + 3];
      const wa00 = w00 * a00;
      const wa10 = w10 * a10;
      const wa01 = w01 * a01;
      const wa11 = w11 * a11;
      const sumWA = wa00 + wa10 + wa01 + wa11;

      if (sumWA > 0) {
        out[o] = Math.round((rgba[i00] * wa00 + rgba[i10] * wa10 + rgba[i01] * wa01 + rgba[i11] * wa11) / sumWA);
        out[o + 1] = Math.round(
          (rgba[i00 + 1] * wa00 + rgba[i10 + 1] * wa10 + rgba[i01 + 1] * wa01 + rgba[i11 + 1] * wa11) / sumWA,
        );
        out[o + 2] = Math.round(
          (rgba[i00 + 2] * wa00 + rgba[i10 + 2] * wa10 + rgba[i01 + 2] * wa01 + rgba[i11 + 2] * wa11) / sumWA,
        );
      } else {
        out[o] = 0;
        out[o + 1] = 0;
        out[o + 2] = 0;
      }
      out[o + 3] = Math.round(sumWA);
    }
  }
  const scaleX = targetW / width;
  const scaleY = targetH / height;
  return {
    rgba: out,
    width: targetW,
    height: targetH,
    scaleX,
    scaleY,
    scaleFactor: Math.sqrt(scaleX * scaleY),
  };
}

function dilateBinary3x3(mask, width, height, restrictMask = null) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (restrictMask && restrictMask[idx] === 0) continue;
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

/** 3x3 erosion treating out-of-bounds neighbors as foreground so image-corner rims survive while thin bridges sever. */
function erodeBinary3x3PadOnes(mask, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
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

/**
 * Detect dark dermoscope corners / circular vignettes and transparent (alpha < 128) pixels.
 * Uses morphological erosion before 4-corner flood-fill plus a central radial guard so a thin
 * dark hair or scratch connecting a corner cannot leak into and erase a central dark lesion.
 */
export function detectVignetteMask(rgba, width, height, { threshold = 22, dilationPx = 2 } = {}) {
  const count = width * height;
  const lum = rgbaToLuminance(rgba, width, height);
  const transparentMask = new Uint8Array(count);
  const dark = new Uint8Array(count);
  let transparentCount = 0;

  for (let i = 0; i < count; i++) {
    if (rgba[i * 4 + 3] < ALPHA_VALID_THRESHOLD) {
      transparentMask[i] = 1;
      transparentCount++;
    } else if (lum[i] < threshold) {
      dark[i] = 1;
    }
  }

  // Erode dark mask before flood-fill to sever thin dark paths (e.g. 1-4 px hairs) from corners.
  const guardRadius = Math.min(width, height) >= 32 ? 2 : 1;
  let eroded = dark;
  for (let step = 0; step < guardRadius; step++) {
    eroded = erodeBinary3x3PadOnes(eroded, width, height);
  }

  const cxImg = (width - 1) / 2;
  const cyImg = (height - 1) / 2;
  const rx = Math.max(1, width / 2);
  const ry = Math.max(1, height / 2);
  const isPeripheral = (x, y) => {
    const nx = (x - cxImg) / rx;
    const ny = (y - cyImg) / ry;
    return nx * nx + ny * ny >= 0.04; // outside inner 20% radius
  };

  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];

  for (const [cx, cy] of corners) {
    const idx = cy * width + cx;
    if (!visited[idx] && eroded[idx] && isPeripheral(cx, cy)) {
      visited[idx] = 1;
      queue[tail++] = idx;
    }
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;

    if (x > 0) {
      const left = idx - 1;
      if (!visited[left] && eroded[left] && isPeripheral(x - 1, y)) {
        visited[left] = 1;
        queue[tail++] = left;
      }
    }
    if (x + 1 < width) {
      const right = idx + 1;
      if (!visited[right] && eroded[right] && isPeripheral(x + 1, y)) {
        visited[right] = 1;
        queue[tail++] = right;
      }
    }
    if (y > 0) {
      const up = idx - width;
      if (!visited[up] && eroded[up] && isPeripheral(x, y - 1)) {
        visited[up] = 1;
        queue[tail++] = up;
      }
    }
    if (y + 1 < height) {
      const down = idx + width;
      if (!visited[down] && eroded[down] && isPeripheral(x, y + 1)) {
        visited[down] = 1;
        queue[tail++] = down;
      }
    }
  }

  let vignetteMask = visited;
  if (tail > 0) {
    // Reconstruct back to the dark vignette edge without walking down severed thin hairs.
    for (let step = 0; step < guardRadius; step++) {
      vignetteMask = dilateBinary3x3(vignetteMask, width, height, dark);
    }
    for (let step = 0; step < dilationPx; step++) {
      vignetteMask = dilateBinary3x3(vignetteMask, width, height);
    }
  }

  let maskedCount = 0;
  for (let i = 0; i < count; i++) maskedCount += vignetteMask[i];

  // Safety guard: never mask out almost the entire frame (e.g. a very dark synthetic image).
  if (maskedCount > count * 0.85) {
    vignetteMask = new Uint8Array(count);
    maskedCount = 0;
  }

  const validMask = new Uint8Array(count);
  let validCount = 0;
  for (let i = 0; i < count; i++) {
    if (!vignetteMask[i] && !transparentMask[i]) {
      validMask[i] = 1;
      validCount++;
    }
  }

  return {
    vignetteMask,
    transparentMask,
    validMask,
    vignetteCoveragePct: (maskedCount / count) * 100,
    transparentCoveragePct: (transparentCount / count) * 100,
    validCount,
  };
}

/**
 * Directional grayscale morphological closing along one orientation (dx, dy)
 * with structuring element half-length `halfLen`.
 */
function directionalClose(lum, validMask, width, height, dx, dy, halfLen) {
  const count = width * height;
  const dilated = new Float32Array(count);
  const closed = new Float32Array(count);

  // 1. Directional dilation (max over valid neighbors along line segment)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (validMask[idx] === 0) {
        dilated[idx] = lum[idx];
        continue;
      }
      let best = lum[idx];
      for (let k = -halfLen; k <= halfLen; k++) {
        if (k === 0) continue;
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (validMask[nIdx] === 0) continue;
        if (lum[nIdx] > best) best = lum[nIdx];
      }
      dilated[idx] = best;
    }
  }

  // 2. Directional erosion (min over valid neighbors along line segment)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (validMask[idx] === 0) {
        closed[idx] = lum[idx];
        continue;
      }
      let best = dilated[idx];
      for (let k = -halfLen; k <= halfLen; k++) {
        if (k === 0) continue;
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = ny * width + nx;
        if (validMask[nIdx] === 0) continue;
        if (dilated[nIdx] < best) best = dilated[nIdx];
      }
      closed[idx] = best;
    }
  }

  return closed;
}

/**
 * Measure contiguous Euclidean run length of candidate hair pixels through (x, y) along grid step (dx, dy).
 */
function gridRunLength(mask, width, height, x, y, dx, dy, stepLen, limitSteps) {
  let steps = 1;
  for (const sign of [-1, 1]) {
    for (let k = 1; k <= limitSteps; k++) {
      const nx = x + sign * k * dx;
      const ny = y + sign * k * dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
      if (!mask[ny * width + nx]) break;
      steps++;
      if (steps > limitSteps) break;
    }
  }
  return 1 + (steps - 1) * stepLen;
}

/**
 * Measure contiguous Euclidean run length through (x, y) along unit vector (ux, uy).
 */
function rayRunLength(mask, width, height, x, y, ux, uy, maxDist) {
  let pos = 0;
  for (let t = 1; t <= maxDist; t++) {
    const nx = Math.round(x + t * ux);
    const ny = Math.round(y + t * uy);
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
    if (!mask[ny * width + nx]) break;
    pos = t;
  }
  let neg = 0;
  for (let t = 1; t <= maxDist; t++) {
    const nx = Math.round(x - t * ux);
    const ny = Math.round(y - t * uy);
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
    if (!mask[ny * width + nx]) break;
    neg = t;
  }
  return 1 + pos + neg;
}

/**
 * DullRazor hair detection and 4-axis bilinear inpainting (Lee et al., 1997).
 * Verifies genuine elongation (length >= 2.5x perpendicular width) and directional closing
 * anisotropy so compact circular dark pigment dots/globules and solid dark lesion cores are preserved.
 */
export function dullRazorRemoveHair(
  rgba,
  width,
  height,
  validMask,
  { hairThreshold = 18, halfLength = null } = {},
) {
  const count = width * height;
  const effectiveValid = validMask ?? new Uint8Array(count).fill(1);
  const lum = rgbaToLuminance(rgba, width, height);
  const halfLen =
    halfLength ?? Math.max(3, Math.min(6, Math.round((Math.max(width, height) / 512) * 5)));

  const dirDiffs = HAIR_DIRECTIONS.map(([dx, dy]) => {
    const closed = directionalClose(lum, effectiveValid, width, height, dx, dy, halfLen);
    const diff = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      if (effectiveValid[i]) {
        const d = closed[i] - lum[i];
        diff[i] = d > 0 ? d : 0;
      }
    }
    return diff;
  });

  const candidate = new Uint8Array(count);
  const anisotropy = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    if (!effectiveValid[i]) continue;
    let bestDir = 0;
    let maxDiff = dirDiffs[0][i];
    for (let d = 1; d < 4; d++) {
      if (dirDiffs[d][i] > maxDiff) {
        maxDiff = dirDiffs[d][i];
        bestDir = d;
      }
    }
    if (maxDiff > hairThreshold) {
      const orthoDiff = dirDiffs[(bestDir + 2) & 3][i];
      anisotropy[i] = maxDiff - orthoDiff;
      candidate[i] = 1;
    }
  }

  // Step 1: Measure local perpendicular width and longest ray run on candidate pixels.
  const maxHairWidth = Math.max(4, Math.round(halfLen * 1.5));
  const minHairLength = Math.max(8, halfLen * 2);
  const maxRayDist = Math.max(16, Math.ceil(maxHairWidth * 3));
  const minWidth = new Float32Array(count);
  const maxRayRun = new Float32Array(count);
  const thinCandidate = new Uint8Array(count);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!candidate[idx]) continue;

      let shortest = Infinity;
      for (const [dx, dy, stepLen] of HAIR_DIRECTIONS) {
        const len = gridRunLength(candidate, width, height, x, y, dx, dy, stepLen, maxHairWidth + 2);
        if (len < shortest) shortest = len;
      }
      minWidth[idx] = shortest;
      if (shortest > maxHairWidth) continue;

      let longest = shortest;
      for (const [ux, uy] of RAY_ANGLES) {
        const len = rayRunLength(candidate, width, height, x, y, ux, uy, maxRayDist);
        if (len > longest) longest = len;
      }
      maxRayRun[idx] = longest;
      thinCandidate[idx] = 1;
    }
  }

  // Step 2: Connected-component elongation + directional anisotropy verification (Lee et al. 1997).
  // Compact dark pigment dots/globules (e.g. 5 px circular spots) have diameter < minHairLength,
  // elongation < 2.5, and near-zero directional anisotropy, so they are preserved.
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  const verified = new Uint8Array(count);
  const anisoMinComp = hairThreshold * 0.4;
  const anisoMinPixel = hairThreshold * 0.45;

  for (let start = 0; start < count; start++) {
    if (!thinCandidate[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    visited[start] = 1;
    queue[tail++] = start;

    let sumX = 0;
    let sumY = 0;
    let widthSum = 0;
    let anisoSum = 0;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      sumX += x;
      sumY += y;
      widthSum += minWidth[idx];
      anisoSum += anisotropy[idx];

      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      for (let ny = y0; ny <= y1; ny++) {
        const r = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const nIdx = r + nx;
          if (thinCandidate[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }

    const compCount = tail;
    const cx = sumX / compCount;
    const cy = sumY / compCount;
    let maxDist = 0;
    for (let k = 0; k < compCount; k++) {
      const idx = queue[k];
      const x = idx % width;
      const y = (idx - x) / width;
      const d = Math.hypot(x - cx, y - cy);
      if (d > maxDist) maxDist = d;
    }

    const diameter = 2 * maxDist + 1;
    const meanWidth = widthSum / compCount;
    const meanAniso = anisoSum / compCount;
    const elongation = meanWidth > 0 ? diameter / meanWidth : 0;

    if (
      diameter < minHairLength ||
      elongation < 2.5 ||
      (meanAniso < anisoMinComp && elongation < 4.0)
    ) {
      continue;
    }

    // Keep pixels on the elongated strand while rejecting compact globules attached to a hair.
    for (let k = 0; k < compCount; k++) {
      const idx = queue[k];
      const localElongated = maxRayRun[idx] >= 2.5 * minWidth[idx] && maxRayRun[idx] >= 6;
      const strongAniso = anisotropy[idx] >= anisoMinPixel;
      const thinObliqueStrand = minWidth[idx] <= 2.5 && elongation >= 3.5;
      if (localElongated || strongAniso || thinObliqueStrand) {
        verified[idx] = 1;
      }
    }
  }

  // Dilate verified hair mask by 1 px within valid pixels to cover blurred hair fringes.
  const repairTarget = dilateBinary3x3(verified, width, height, effectiveValid);

  let validCount = 0;
  for (let i = 0; i < count; i++) {
    if (effectiveValid[i]) validCount++;
  }

  // Bilinear inpainting along 4 axes (0°, 45°, 90°, 135°).
  const cleanedRgba = new Uint8ClampedArray(rgba);
  const hairMask = new Uint8Array(count);
  const maxSearch = Math.max(12, halfLen * 3);
  let repairedPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!repairTarget[idx]) continue;

      let wSum = 0;
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;

      for (const [dx, dy] of HAIR_DIRECTIONS) {
        let posIdx = -1;
        let posDist = 0;
        for (let k = 1; k <= maxSearch; k++) {
          const nx = x + k * dx;
          const ny = y + k * dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
          const nIdx = ny * width + nx;
          if (effectiveValid[nIdx] && !repairTarget[nIdx]) {
            posIdx = nIdx;
            posDist = k;
            break;
          }
        }

        let negIdx = -1;
        let negDist = 0;
        for (let k = 1; k <= maxSearch; k++) {
          const nx = x - k * dx;
          const ny = y - k * dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
          const nIdx = ny * width + nx;
          if (effectiveValid[nIdx] && !repairTarget[nIdx]) {
            negIdx = nIdx;
            negDist = k;
            break;
          }
        }

        if (posIdx !== -1 && negIdx !== -1) {
          const span = posDist + negDist;
          const axisWeight = 1 / span;
          const wp = negDist / span;
          const wn = posDist / span;
          const po = posIdx * 4;
          const no = negIdx * 4;
          rAcc += axisWeight * (wp * rgba[po] + wn * rgba[no]);
          gAcc += axisWeight * (wp * rgba[po + 1] + wn * rgba[no + 1]);
          bAcc += axisWeight * (wp * rgba[po + 2] + wn * rgba[no + 2]);
          wSum += axisWeight;
        } else if (posIdx !== -1) {
          const axisWeight = 0.5 / posDist;
          const po = posIdx * 4;
          rAcc += axisWeight * rgba[po];
          gAcc += axisWeight * rgba[po + 1];
          bAcc += axisWeight * rgba[po + 2];
          wSum += axisWeight;
        } else if (negIdx !== -1) {
          const axisWeight = 0.5 / negDist;
          const no = negIdx * 4;
          rAcc += axisWeight * rgba[no];
          gAcc += axisWeight * rgba[no + 1];
          bAcc += axisWeight * rgba[no + 2];
          wSum += axisWeight;
        }
      }

      if (wSum > 0) {
        const o = idx * 4;
        cleanedRgba[o] = Math.round(rAcc / wSum);
        cleanedRgba[o + 1] = Math.round(gAcc / wSum);
        cleanedRgba[o + 2] = Math.round(bAcc / wSum);
        cleanedRgba[o + 3] = rgba[o + 3];
        hairMask[idx] = 1;
        repairedPixels++;
      }
    }
  }

  return {
    cleanedRgba,
    hairMask,
    hairCoveragePct: validCount > 0 ? (repairedPixels / validCount) * 100 : 0,
    repairedPixels,
    hairPixelCount: repairedPixels,
    kernelHalfLength: halfLen,
  };
}

/**
 * Full dermoscopic preprocessing stage:
 * working-res downsampling -> dark-corner & alpha mask -> optional DullRazor hair removal
 * -> optional Shades of Gray color constancy.
 */
export function preprocessDermoscopyImage(
  rgba,
  width,
  height,
  {
    maxWorkingDimension = 512,
    removeHair = true,
    colorConstancy = true,
    vignetteThreshold = 22,
    hairThreshold = 18,
    minkowskiP = 6,
  } = {},
) {
  const working = resizeToWorkingResolution(rgba, width, height, maxWorkingDimension);
  const vignette = detectVignetteMask(working.rgba, working.width, working.height, {
    threshold: vignetteThreshold,
    dilationPx: 2,
  });

  let currentRgba = working.rgba;
  let hairMask = new Uint8Array(working.width * working.height);
  let hairCoveragePct = 0;
  let repairedPixels = 0;
  let kernelHalfLength = 0;

  if (removeHair) {
    const hair = dullRazorRemoveHair(currentRgba, working.width, working.height, vignette.validMask, {
      hairThreshold,
    });
    currentRgba = hair.cleanedRgba;
    hairMask = hair.hairMask;
    hairCoveragePct = hair.hairCoveragePct;
    repairedPixels = hair.repairedPixels;
    kernelHalfLength = hair.kernelHalfLength;
  }

  let illuminant = [1, 1, 1];
  let gains = [1, 1, 1];
  if (colorConstancy) {
    const balanced = applyShadesOfGray(currentRgba, working.width, working.height, vignette.validMask, {
      p: minkowskiP,
    });
    currentRgba = balanced.rgba;
    illuminant = balanced.illuminant;
    gains = balanced.gains;
  }

  // Always return a distinct buffer from workingOriginalRgba so worker transfer lists never alias.
  const preprocessedRgba =
    currentRgba === working.rgba ? new Uint8ClampedArray(working.rgba) : currentRgba;

  return {
    originalWidth: width,
    originalHeight: height,
    width: working.width,
    height: working.height,
    scaleX: working.scaleX,
    scaleY: working.scaleY,
    scaleFactor: working.scaleFactor,
    workingOriginalRgba: working.rgba,
    preprocessedRgba,
    vignetteMask: vignette.vignetteMask,
    transparentMask: vignette.transparentMask,
    validMask: vignette.validMask,
    vignetteCoveragePct: vignette.vignetteCoveragePct,
    transparentCoveragePct: vignette.transparentCoveragePct,
    hairMask,
    hairCoveragePct,
    repairedPixels,
    hairPixelCount: repairedPixels,
    kernelHalfLength,
    illuminant,
    gains,
  };
}
