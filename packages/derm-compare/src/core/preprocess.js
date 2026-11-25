// Pure DOM-free dermoscopy preprocessing:
// - Shades of Gray (Minkowski p = 6) color constancy (Finlayson & Trezzi 2004; Barata et al. 2015)
// - Directional morphological closing hair suppression with elongation/anisotropy filtering (Lee et al. 1997)
// - Vignette & alpha-transparency FOV detection, luminance conversion, and fractional box downsampling.

export const ALPHA_VALID_THRESHOLD = 128;

/** Convert RGBA bytes to float32 Rec.601 luminance in [0, 255]. */
export function rgbaToLuminance(rgba, width, height) {
  const n = width * height;
  const out = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }
  return out;
}

/**
 * Detect valid field-of-view pixels:
 * - Excludes ALL transparent pixels (alpha < 128), both interior and border.
 * - Excludes dark circular dermoscope vignette borders by flood-filling near-black
 *   (or transparent) pixels connected to the image edges.
 * Returns 1 for valid opaque FOV pixels and 0 for excluded pixels.
 */
export function detectValidFov(rgba, width, height, darkThreshold = 10) {
  const n = width * height;
  const valid = new Uint8Array(n).fill(1);
  const visited = new Uint8Array(n);

  const isTransparent = (idx) => rgba[idx * 4 + 3] < ALPHA_VALID_THRESHOLD;
  const isBorderExcluded = (idx) => {
    const p = idx * 4;
    if (rgba[p + 3] < ALPHA_VALID_THRESHOLD) return true;
    return rgba[p] < darkThreshold && rgba[p + 1] < darkThreshold && rgba[p + 2] < darkThreshold;
  };

  // Exclude all transparent pixels everywhere (including interior cutouts).
  for (let i = 0; i < n; i++) {
    if (isTransparent(i)) valid[i] = 0;
  }

  // Flood-fill border-connected dark vignette (passing across any transparent border margin).
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (idx) => {
    if (!visited[idx] && isBorderExcluded(idx)) {
      visited[idx] = 1;
      valid[idx] = 0;
      queue[tail++] = idx;
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(y * width);
    seed(y * width + (width - 1));
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % width;
    const y = (idx - x) / width;
    if (x > 0) seed(idx - 1);
    if (x + 1 < width) seed(idx + 1);
    if (y > 0) seed(idx - width);
    if (y + 1 < height) seed(idx + width);
  }
  return valid;
}

/**
 * Area-averaged (fractional box-filter) downsampling of a grayscale float32 image and its valid mask.
 * Returns exact per-axis pitch ratios (`pitchX = width / outW`, `pitchY = height / outH`) so
 * multi-scale registration carries exact full-resolution coordinates without aspect distortion.
 */
export function downsampleGray(gray, valid, width, height, targetWidth, targetHeight) {
  const outW = Math.max(8, Math.round(targetWidth));
  const outH = Math.max(8, Math.round(targetHeight));
  if (outW >= width && outH >= height) {
    return {
      data: new Float32Array(gray),
      valid: new Uint8Array(valid),
      width,
      height,
      pitchX: 1,
      pitchY: 1,
    };
  }
  const data = new Float32Array(outW * outH);
  const outValid = new Uint8Array(outW * outH);
  const pitchX = width / outW;
  const pitchY = height / outH;

  for (let y = 0; y < outH; y++) {
    const srcY0 = y * pitchY;
    const srcY1 = (y + 1) * pitchY;
    const y0 = Math.floor(srcY0);
    const y1 = Math.min(height, Math.ceil(srcY1));
    for (let x = 0; x < outW; x++) {
      const srcX0 = x * pitchX;
      const srcX1 = (x + 1) * pitchX;
      const x0 = Math.floor(srcX0);
      const x1 = Math.min(width, Math.ceil(srcX1));
      let sum = 0;
      let totalWeight = 0;
      let validWeight = 0;
      for (let sy = y0; sy < y1; sy++) {
        const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
        if (wy <= 0) continue;
        const row = sy * width;
        for (let sx = x0; sx < x1; sx++) {
          const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
          if (wx <= 0) continue;
          const w = wx * wy;
          totalWeight += w;
          const idx = row + sx;
          if (valid[idx]) {
            sum += gray[idx] * w;
            validWeight += w;
          }
        }
      }
      const dst = y * outW + x;
      if (validWeight * 2 >= totalWeight && validWeight > 0) {
        data[dst] = sum / validWeight;
        outValid[dst] = 1;
      } else {
        data[dst] = 0;
        outValid[dst] = 0;
      }
    }
  }
  return { data, valid: outValid, width: outW, height: outH, pitchX, pitchY };
}

/**
 * Area-averaged (fractional box-filter) downsampling of an RGBA image with alpha-weighted
 * RGB averaging so transparent pixels never bleed dark fringes into adjacent opaque pixels.
 */
export function downsampleRgba(rgba, width, height, targetWidth, targetHeight) {
  const outW = Math.max(1, Math.round(targetWidth));
  const outH = Math.max(1, Math.round(targetHeight));
  if (outW >= width && outH >= height) {
    return { rgba, width, height };
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  const scaleX = width / outW;
  const scaleY = height / outH;

  for (let y = 0; y < outH; y++) {
    const srcY0 = y * scaleY;
    const srcY1 = (y + 1) * scaleY;
    const y0 = Math.floor(srcY0);
    const y1 = Math.min(height, Math.ceil(srcY1));
    for (let x = 0; x < outW; x++) {
      const srcX0 = x * scaleX;
      const srcX1 = (x + 1) * scaleX;
      const x0 = Math.floor(srcX0);
      const x1 = Math.min(width, Math.ceil(srcX1));
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let sumAlphaW = 0;
      let totalW = 0;
      for (let sy = y0; sy < y1; sy++) {
        const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
        if (wy <= 0) continue;
        const row = sy * width;
        for (let sx = x0; sx < x1; sx++) {
          const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const p = (row + sx) * 4;
          const a = rgba[p + 3];
          totalW += w;
          sumA += a * w;
          if (a > 0) {
            const aw = w * a;
            sumR += rgba[p] * aw;
            sumG += rgba[p + 1] * aw;
            sumB += rgba[p + 2] * aw;
            sumAlphaW += aw;
          }
        }
      }
      const dst = (y * outW + x) * 4;
      const outA = totalW > 0 ? Math.round(sumA / totalW) : 0;
      if (outA > 0 && sumAlphaW > 0) {
        out[dst] = Math.round(sumR / sumAlphaW);
        out[dst + 1] = Math.round(sumG / sumAlphaW);
        out[dst + 2] = Math.round(sumB / sumAlphaW);
        out[dst + 3] = outA;
      }
    }
  }
  return { rgba: out, width: outW, height: outH };
}

/**
 * Shades of Gray (Minkowski p = 6) color constancy normalization.
 * Reduces white-balance drift between sequential dermoscopy captures while respecting valid FOV/alpha.
 */
export function shadesOfGray(rgba, width, height, { p = 6, valid = null } = {}) {
  const n = width * height;
  const mask = valid ?? detectValidFov(rgba, width, height);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  let validTotal = 0;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (!mask[i] || rgba[o + 3] < ALPHA_VALID_THRESHOLD) continue;
    validTotal++;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    if (r + g + b < 15) continue;
    if (r > 250 && g > 250 && b > 250) continue;
    sumR += (r / 255) ** p;
    sumG += (g / 255) ** p;
    sumB += (b / 255) ** p;
    count++;
  }
  // Fall back to all valid pixels if aggressive highlight/shadow filtering left too few pixels.
  if (count < validTotal * 0.05) {
    sumR = 0;
    sumG = 0;
    sumB = 0;
    count = 0;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      if (!mask[i] || rgba[o + 3] < ALPHA_VALID_THRESHOLD) continue;
      sumR += (rgba[o] / 255) ** p;
      sumG += (rgba[o + 1] / 255) ** p;
      sumB += (rgba[o + 2] / 255) ** p;
      count++;
    }
  }
  if (count === 0) {
    return { rgba: new Uint8ClampedArray(rgba), gains: [1, 1, 1] };
  }
  const eR = (sumR / count) ** (1 / p);
  const eG = (sumG / count) ** (1 / p);
  const eB = (sumB / count) ** (1 / p);
  const eNorm = Math.sqrt((eR * eR + eG * eG + eB * eB) / 3);
  const clampGain = (e) => (e > 1e-4 ? Math.min(2.0, Math.max(0.5, eNorm / e)) : 1);
  const gR = clampGain(eR);
  const gG = clampGain(eG);
  const gB = clampGain(eB);

  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    if (rgba[o + 3] < ALPHA_VALID_THRESHOLD) {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
      out[o + 3] = rgba[o + 3];
      continue;
    }
    out[o] = Math.min(255, Math.round(rgba[o] * gR));
    out[o + 1] = Math.min(255, Math.round(rgba[o + 1] * gG));
    out[o + 2] = Math.min(255, Math.round(rgba[o + 2] * gB));
    out[o + 3] = rgba[o + 3];
  }
  return { rgba: out, gains: [gR, gG, gB] };
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

// 8 unit directions (every 22.5°) used to distinguish elongated hairs from isotropic pigment dots.
const ANISO_DIRECTIONS = Array.from({ length: 8 }, (_, k) => {
  const theta = (k * Math.PI) / 8;
  return [Math.cos(theta), Math.sin(theta)];
});

/**
 * Mask-aware 1D morphological closing (dilation followed by erosion) of `src` along `(dx, dy)`
 * with structuring-element half-length `radius`. Invalid/transparent neighbors are skipped so
 * dark vignette or transparent borders never bleed into valid skin pixels.
 */
function directionalClose1D(src, mask, width, height, dx, dy, radius, temp, out) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) {
        temp[idx] = src[idx];
        continue;
      }
      let maxVal = src[idx];
      for (let k = -radius; k <= radius; k++) {
        if (k === 0) continue;
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          if (!mask[nIdx]) continue;
          const val = src[nIdx];
          if (val > maxVal) maxVal = val;
        }
      }
      temp[idx] = maxVal;
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) {
        out[idx] = src[idx];
        continue;
      }
      let minVal = temp[idx];
      for (let k = -radius; k <= radius; k++) {
        if (k === 0) continue;
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = ny * width + nx;
          if (!mask[nIdx]) continue;
          const val = temp[nIdx];
          if (val < minVal) minVal = val;
        }
      }
      out[idx] = minVal;
    }
  }
}

/**
 * Directional morphological hair suppression with local elongation/anisotropy filtering.
 * Uses 4-orientation 1D morphological closing (black-hat) to find candidate dark pixels,
 * then requires strong 8-orientation directional anisotropy and elongated connected-component
 * span so isolated dark pigment dots/globules are preserved while thin dark hairs are detected
 * and inpainted for registration/segmentation.
 */
export function suppressHairs(rgba, width, height, { radius = null, threshold = 18, valid = null } = {}) {
  const n = width * height;
  const mask = valid ?? detectValidFov(rgba, width, height);
  const lum = rgbaToLuminance(rgba, width, height);
  const r = radius ?? Math.max(2, Math.min(5, Math.round(Math.min(width, height) / 180)));
  const temp = new Float32Array(n);
  const closed = new Float32Array(n);
  const maxBlackHat = new Float32Array(n);
  const bestDir = new Uint8Array(n);

  for (let d = 0; d < DIRECTIONS.length; d++) {
    const [dx, dy] = DIRECTIONS[d];
    directionalClose1D(lum, mask, width, height, dx, dy, r, temp, closed);
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const diff = closed[i] - lum[i];
      if (diff > maxBlackHat[i]) {
        maxBlackHat[i] = diff;
        bestDir[i] = d;
      }
    }
  }

  // Require local directional elongation/anisotropy so isotropic dark pigment dots are preserved.
  const searchLen = Math.max(6, Math.round(r * 2.5));
  const minHairRun = Math.max(8, r * 2 + 2);
  const minAnisotropyRatio = 2.0;
  const candidateMask = new Uint8Array(n);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx] || maxBlackHat[idx] <= threshold) continue;
      const localBg = lum[idx] + maxBlackHat[idx];
      const darkCutoff = localBg - threshold * 0.45;
      let maxRun = 1;
      let minRun = searchLen * 2 + 1;
      for (let d = 0; d < ANISO_DIRECTIONS.length; d++) {
        const [ux, uy] = ANISO_DIRECTIONS[d];
        let run = 1;
        for (let sign = -1; sign <= 1; sign += 2) {
          for (let step = 1; step <= searchLen; step++) {
            const nx = Math.round(x + sign * step * ux);
            const ny = Math.round(y + sign * step * uy);
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
            const nIdx = ny * width + nx;
            if (!mask[nIdx] || lum[nIdx] >= darkCutoff) break;
            run++;
          }
        }
        if (run > maxRun) maxRun = run;
        if (run < minRun) minRun = run;
      }
      if (maxRun >= minHairRun && maxRun >= minRun * minAnisotropyRatio) {
        candidateMask[idx] = 1;
      }
    }
  }

  // Filter 8-connected components so small compact specks never enter the hair mask.
  const coreMask = new Uint8Array(n);
  const visited = new Uint8Array(n);
  const queue = new Int32Array(n);
  const minSpan = Math.max(8, r * 2.5);

  for (let i = 0; i < n; i++) {
    if (!candidateMask[i] || visited[i]) continue;
    let head = 0;
    let tail = 0;
    visited[i] = 1;
    queue[tail++] = i;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let oy = -1; oy <= 1; oy++) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        const nRow = ny * width;
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const nIdx = nRow + nx;
          if (candidateMask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue[tail++] = nIdx;
          }
        }
      }
    }
    const span = Math.hypot(maxX - minX, maxY - minY);
    if (span >= minSpan && tail >= 6) {
      for (let k = 0; k < tail; k++) coreMask[queue[k]] = 1;
    }
  }

  // Soft 1-pixel fringe expansion only around confirmed elongated hair pixels.
  const hairMask = new Uint8Array(coreMask);
  const fringeThreshold = threshold * 0.45;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (hairMask[idx] || !mask[idx] || maxBlackHat[idx] <= fringeThreshold) continue;
      if (coreMask[idx - 1] || coreMask[idx + 1] || coreMask[idx - width] || coreMask[idx + width]) {
        hairMask[idx] = 1;
      }
    }
  }

  const out = new Uint8ClampedArray(rgba);
  let hairPixels = 0;
  let validPixels = 0;
  const maxSearch = r + 3;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (mask[idx]) validPixels++;
      if (!hairMask[idx]) continue;
      hairPixels++;
      const [dx, dy] = DIRECTIONS[bestDir[idx]];
      let negIdx = -1;
      let negDist = 0;
      let posIdx = -1;
      let posDist = 0;
      for (let k = 1; k <= maxSearch; k++) {
        const nx = x - k * dx;
        const ny = y - k * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
        const cand = ny * width + nx;
        if (mask[cand] && !hairMask[cand]) {
          negIdx = cand;
          negDist = k;
          break;
        }
      }
      for (let k = 1; k <= maxSearch; k++) {
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) break;
        const cand = ny * width + nx;
        if (mask[cand] && !hairMask[cand]) {
          posIdx = cand;
          posDist = k;
          break;
        }
      }
      const dst = idx * 4;
      if (negIdx >= 0 && posIdx >= 0) {
        const wPos = negDist / (negDist + posDist);
        const wNeg = 1 - wPos;
        const pNeg = negIdx * 4;
        const pPos = posIdx * 4;
        out[dst] = Math.round(rgba[pNeg] * wNeg + rgba[pPos] * wPos);
        out[dst + 1] = Math.round(rgba[pNeg + 1] * wNeg + rgba[pPos + 1] * wPos);
        out[dst + 2] = Math.round(rgba[pNeg + 2] * wNeg + rgba[pPos + 2] * wPos);
      } else if (negIdx >= 0 || posIdx >= 0) {
        const srcIdx = (negIdx >= 0 ? negIdx : posIdx) * 4;
        out[dst] = rgba[srcIdx];
        out[dst + 1] = rgba[srcIdx + 1];
        out[dst + 2] = rgba[srcIdx + 2];
      } else {
        // Fallback: local 5x5 non-hair mean over valid pixels.
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        let cnt = 0;
        for (let oy = -2; oy <= 2; oy++) {
          const ny = y + oy;
          if (ny < 0 || ny >= height) continue;
          for (let ox = -2; ox <= 2; ox++) {
            const nx = x + ox;
            if (nx < 0 || nx >= width) continue;
            const cand = ny * width + nx;
            if (mask[cand] && !hairMask[cand]) {
              const p = cand * 4;
              rSum += rgba[p];
              gSum += rgba[p + 1];
              bSum += rgba[p + 2];
              cnt++;
            }
          }
        }
        if (cnt > 0) {
          out[dst] = Math.round(rSum / cnt);
          out[dst + 1] = Math.round(gSum / cnt);
          out[dst + 2] = Math.round(bSum / cnt);
        }
      }
    }
  }

  return {
    rgba: out,
    hairMask,
    hairFraction: validPixels > 0 ? hairPixels / validPixels : 0,
  };
}

/**
 * Run optional Shades of Gray color constancy and directional hair suppression.
 * Returns both `colorRgba` (non-inpainted, for honest ΔE2000 measurement) and `rgba`
 * (hair-suppressed when enabled, for registration and lesion segmentation), plus `hairMask`.
 */
export function preprocessImage(rgba, width, height, { normalizeColor = true, suppressHair = true } = {}) {
  const valid = detectValidFov(rgba, width, height);
  let colorRgba = rgba;
  let gains = [1, 1, 1];
  if (normalizeColor) {
    const color = shadesOfGray(rgba, width, height, { valid });
    colorRgba = color.rgba;
    gains = color.gains;
  } else {
    colorRgba = new Uint8ClampedArray(rgba);
  }

  let current = colorRgba;
  let hairMask = new Uint8Array(width * height);
  let hairFraction = 0;
  if (suppressHair) {
    const hair = suppressHairs(colorRgba, width, height, { valid });
    current = hair.rgba;
    hairMask = hair.hairMask;
    hairFraction = hair.hairFraction;
  }
  return {
    rgba: current,
    colorRgba,
    valid,
    hairMask,
    gains,
    hairFraction,
  };
}
