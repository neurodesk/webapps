// Pure DOM-free Vision Transformer preprocessing, softmax statistics, and
// 5x5 occlusion sensitivity mapping for HAM10000 dermoscopic classification.
import { MODEL, OCCLUSION_GRID } from "../config.js";

const PRECISION_BITS = 32 - 8 - 2;

/**
 * Enforces one consistent alpha policy across decode, display, preprocessing, and export:
 * - Rejects fully transparent images (`maxAlpha === 0`).
 * - Composites partially transparent RGBA images over neutral white [255, 255, 255].
 * - Returns opaque RGBA buffers unchanged when all alpha values are 255.
 */
export function normalizeInputRgba(rgba, width, height) {
  const pixelCount = width * height;
  if (!width || !height || pixelCount <= 0) {
    throw new Error("Image dimensions must be positive.");
  }
  const expectedLength = pixelCount * 4;
  if (!rgba || rgba.length < expectedLength) {
    throw new Error("Image pixel buffer is shorter than expected.");
  }
  let maxAlpha = 0;
  let hasTransparency = false;
  for (let i = 3; i < expectedLength; i += 4) {
    const a = rgba[i];
    if (a > maxAlpha) maxAlpha = a;
    if (a < 255) hasTransparency = true;
  }
  if (maxAlpha === 0) {
    throw new Error("Image is fully transparent and has no visible pixels.");
  }
  if (!hasTransparency) {
    const view = rgba.length === expectedLength ? rgba : rgba.subarray(0, expectedLength);
    return {
      rgba: view instanceof Uint8ClampedArray ? view : new Uint8ClampedArray(view),
      hadTransparency: false,
    };
  }
  const out = new Uint8ClampedArray(expectedLength);
  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    const a = rgba[base + 3];
    if (a === 255) {
      out[base] = rgba[base];
      out[base + 1] = rgba[base + 1];
      out[base + 2] = rgba[base + 2];
      out[base + 3] = 255;
    } else if (a === 0) {
      out[base] = 255;
      out[base + 1] = 255;
      out[base + 2] = 255;
      out[base + 3] = 255;
    } else {
      const alpha = a / 255;
      const inv = 1 - alpha;
      out[base] = Math.round(rgba[base] * alpha + 255 * inv);
      out[base + 1] = Math.round(rgba[base + 1] * alpha + 255 * inv);
      out[base + 2] = Math.round(rgba[base + 2] * alpha + 255 * inv);
      out[base + 3] = 255;
    }
  }
  return { rgba: out, hadTransparency: true };
}

/**
 * Shades of Gray color constancy (Finlayson & Trezzi, 2004) with Minkowski norm p=6.
 * Estimates the illuminant color from the p-norm of each RGB channel and scales channels
 * to a common grey reference, clamped to [0, 255].
 */
export function shadesOfGray(rgba, width, height, p = 6) {
  const pixelCount = width * height;
  if (pixelCount <= 0) {
    return { rgba: new Uint8ClampedArray(0), gains: { r: 1, g: 1, b: 1 } };
  }
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    const r = rgba[base] / 255;
    const g = rgba[base + 1] / 255;
    const b = rgba[base + 2] / 255;
    if (p === 6) {
      const r2 = r * r;
      const g2 = g * g;
      const b2 = b * b;
      sumR += r2 * r2 * r2;
      sumG += g2 * g2 * g2;
      sumB += b2 * b2 * b2;
    } else {
      sumR += Math.pow(r, p);
      sumG += Math.pow(g, p);
      sumB += Math.pow(b, p);
    }
  }
  const invP = 1 / p;
  const normR = Math.pow(sumR / pixelCount, invP);
  const normG = Math.pow(sumG / pixelCount, invP);
  const normB = Math.pow(sumB / pixelCount, invP);
  const avg = (normR + normG + normB) / 3;
  const eps = 1e-6;
  const clampGain = (value) => Math.max(0.25, Math.min(4, value));
  const rGain = avg > eps && normR > eps ? clampGain(avg / normR) : 1;
  const gGain = avg > eps && normG > eps ? clampGain(avg / normG) : 1;
  const bGain = avg > eps && normB > eps ? clampGain(avg / normB) : 1;

  const out = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const base = i * 4;
    out[base] = Math.round(rgba[base] * rGain);
    out[base + 1] = Math.round(rgba[base + 1] * gGain);
    out[base + 2] = Math.round(rgba[base + 2] * bGain);
    out[base + 3] = rgba[base + 3];
  }
  return {
    rgba: out,
    gains: {
      r: Number(rGain.toFixed(4)),
      g: Number(gGain.toFixed(4)),
      b: Number(bGain.toFixed(4)),
    },
  };
}

// Pillow's precompute_coeffs for the bilinear (triangle) filter, support = max(1, scale),
// normalized to PRECISION_BITS fixed point (Pillow src/libImaging/Resample.c).
function bilinearCoefficients(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const weights = new Int32Array(outSize * ksize);
  const raw = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    const xmin = Math.max(0, Math.trunc(center - support + 0.5));
    const xmax = Math.min(inSize, Math.trunc(center + support + 0.5)) - xmin;
    let sum = 0;
    for (let x = 0; x < xmax; x++) {
      const distance = Math.abs((x + xmin - center + 0.5) / filterScale);
      raw[x] = distance < 1 ? 1 - distance : 0;
      sum += raw[x];
    }
    for (let x = 0; x < xmax; x++) {
      const weight = sum !== 0 ? raw[x] / sum : raw[x];
      weights[xx * ksize + x] = Math.trunc((weight < 0 ? -0.5 : 0.5) + weight * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { ksize, bounds, weights };
}

function clip8(value) {
  const shifted = value >> PRECISION_BITS;
  return shifted < 0 ? 0 : shifted > 255 ? 255 : shifted;
}

function horizontalRgba(input, inWidth, rows, firstRow, outWidth, kernel) {
  const out = new Uint8ClampedArray(outWidth * rows * 4);
  const { ksize, bounds, weights } = kernel;
  const half = 1 << (PRECISION_BITS - 1);
  for (let y = 0; y < rows; y++) {
    const srcRowOffset = (y + firstRow) * inWidth;
    const dstRowOffset = y * outWidth;
    for (let xx = 0; xx < outWidth; xx++) {
      const xmin = bounds[xx * 2];
      const xmax = bounds[xx * 2 + 1];
      const wBase = xx * ksize;
      let sumR = half;
      let sumG = half;
      let sumB = half;
      for (let x = 0; x < xmax; x++) {
        const w = weights[wBase + x];
        const srcIdx = (srcRowOffset + xmin + x) * 4;
        sumR += input[srcIdx] * w;
        sumG += input[srcIdx + 1] * w;
        sumB += input[srcIdx + 2] * w;
      }
      const dstIdx = (dstRowOffset + xx) * 4;
      out[dstIdx] = clip8(sumR);
      out[dstIdx + 1] = clip8(sumG);
      out[dstIdx + 2] = clip8(sumB);
      out[dstIdx + 3] = 255;
    }
  }
  return out;
}

function verticalRgba(input, width, outHeight, kernel, offset = 0) {
  const out = new Uint8ClampedArray(width * outHeight * 4);
  const { ksize, bounds, weights } = kernel;
  const half = 1 << (PRECISION_BITS - 1);
  for (let yy = 0; yy < outHeight; yy++) {
    const ymin = bounds[yy * 2] - offset;
    const ymax = bounds[yy * 2 + 1];
    const wBase = yy * ksize;
    const dstRowOffset = yy * width;
    for (let x = 0; x < width; x++) {
      let sumR = half;
      let sumG = half;
      let sumB = half;
      for (let y = 0; y < ymax; y++) {
        const w = weights[wBase + y];
        const srcIdx = ((y + ymin) * width + x) * 4;
        sumR += input[srcIdx] * w;
        sumG += input[srcIdx + 1] * w;
        sumB += input[srcIdx + 2] * w;
      }
      const dstIdx = (dstRowOffset + x) * 4;
      out[dstIdx] = clip8(sumR);
      out[dstIdx + 1] = clip8(sumG);
      out[dstIdx + 2] = clip8(sumB);
      out[dstIdx + 3] = 255;
    }
  }
  return out;
}

/**
 * Pillow-equivalent antialiased separable bilinear resize (`Image.BILINEAR` / `resample=2`)
 * for opaque 8-bit RGBA images with 8-bit fixed-point rounding and clamping per pass.
 */
export function resizeRgbaPillowBilinear(input, width, height, outWidth, outHeight) {
  if (!width || !height || !outWidth || !outHeight) {
    throw new Error("Image dimensions must be positive.");
  }
  const needHorizontal = outWidth !== width;
  const needVertical = outHeight !== height;
  if (!needHorizontal && !needVertical) {
    return new Uint8ClampedArray(input.subarray(0, width * height * 4));
  }
  if (!needVertical) {
    return horizontalRgba(input, width, height, 0, outWidth, bilinearCoefficients(width, outWidth));
  }
  const verticalKernel = bilinearCoefficients(height, outHeight);
  if (!needHorizontal) {
    return verticalRgba(input, width, outHeight, verticalKernel);
  }
  const horizontalKernel = bilinearCoefficients(width, outWidth);
  const horizontalFirst = !(height - outHeight > 0 && height - outHeight > (width - outWidth) * 2);
  if (horizontalFirst) {
    const first = verticalKernel.bounds[0];
    const last = verticalKernel.bounds[outHeight * 2 - 2] + verticalKernel.bounds[outHeight * 2 - 1];
    const rows = horizontalRgba(input, width, last - first, first, outWidth, horizontalKernel);
    return verticalRgba(rows, outWidth, outHeight, verticalKernel, first);
  }
  const columns = verticalRgba(input, width, outHeight, verticalKernel);
  return horizontalRgba(columns, width, outHeight, 0, outWidth, horizontalKernel);
}

/**
 * Resizes RGBA pixels (width x height) to (size x size) using Pillow's antialiased bilinear
 * filter (resample=2) and packs into an NCHW Float32Array [1, 3, size, size] normalized via
 * (v / 255 - mean[c]) / std[c].
 */
export function preprocessToTensor(
  rgba,
  width,
  height,
  {
    size = MODEL.imageSize,
    mean = MODEL.mean,
    std = MODEL.std,
    colorConstancy = false,
  } = {},
) {
  if (!width || !height) throw new Error("Image dimensions must be positive.");
  const normalized = normalizeInputRgba(rgba, width, height);
  let source = normalized.rgba;
  let colorConstancyGains = null;
  if (colorConstancy) {
    const corrected = shadesOfGray(source, width, height, 6);
    source = corrected.rgba;
    colorConstancyGains = corrected.gains;
  }

  const resized = resizeRgbaPillowBilinear(source, width, height, size, size);
  const planeSize = size * size;
  const tensor = new Float32Array(3 * planeSize);
  const inv255 = 1 / 255;
  const invStdR = 1 / std[0];
  const invStdG = 1 / std[1];
  const invStdB = 1 / std[2];
  const meanR = mean[0];
  const meanG = mean[1];
  const meanB = mean[2];

  for (let i = 0; i < planeSize; i++) {
    const src = i * 4;
    tensor[i] = (resized[src] * inv255 - meanR) * invStdR;
    tensor[planeSize + i] = (resized[src + 1] * inv255 - meanG) * invStdG;
    tensor[2 * planeSize + i] = (resized[src + 2] * inv255 - meanB) * invStdB;
  }

  return {
    tensor,
    width: size,
    height: size,
    colorConstancyGains,
  };
}

/** Validates that a logit vector has the expected class count and only finite numeric values. */
export function validateLogits(logits, expectedLength = MODEL.classes.length) {
  if (!logits || typeof logits.length !== "number") {
    throw new Error("Model returned invalid logits output.");
  }
  if (logits.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} class logits, received ${logits.length}.`);
  }
  for (let i = 0; i < logits.length; i++) {
    if (!Number.isFinite(logits[i])) {
      throw new Error(`Model returned non-finite logit at class index ${i} (${logits[i]}).`);
    }
  }
  return logits;
}

/** Numerically stable softmax across a 1D finite logit vector. */
export function softmax(logits) {
  const n = logits.length;
  if (n === 0) return [];
  validateLogits(logits, n);
  let maxVal = -Infinity;
  for (let i = 0; i < n; i++) {
    if (logits[i] > maxVal) maxVal = logits[i];
  }
  const exps = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const val = Math.exp(logits[i] - maxVal);
    exps[i] = val;
    sum += val;
  }
  for (let i = 0; i < n; i++) {
    exps[i] = sum > 0 ? exps[i] / sum : 1 / n;
  }
  return exps;
}

/**
 * Converts 7 finite HAM10000 logits into ranked uncalibrated softmax scores, Shannon entropy
 * (bits and normalized [0, 1]), and top-1 vs top-2 score margin.
 */
export function summarizePredictions(logits, classes = MODEL.classes) {
  validateLogits(logits, classes.length);
  const probabilities = softmax(logits);
  const ranked = classes
    .map((entry, idx) => ({
      index: entry.index ?? idx,
      code: entry.code,
      label: entry.label,
      probability: probabilities[idx],
      logit: Number(logits[idx]),
    }))
    .sort((a, b) => b.probability - a.probability)
    .map((entry, idx) => ({ rank: idx + 1, ...entry }));

  let entropyBits = 0;
  for (const p of probabilities) {
    if (p > 0) entropyBits -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(classes.length);
  const normalizedEntropy = maxEntropy > 0 ? Math.max(0, Math.min(1, entropyBits / maxEntropy)) : 0;
  const margin = ranked.length >= 2 ? ranked[0].probability - ranked[1].probability : ranked[0]?.probability ?? 0;

  return {
    top: ranked[0],
    ranked,
    entropyBits,
    normalizedEntropy,
    margin,
    logits: Array.from(logits, Number),
    probabilities,
  };
}

/**
 * Writes a copy of `baseTensor` into `target` with cell (row, col) of a `grid x grid`
 * partition replaced by `fillValue` (0 = mean RGB in [-1, 1] normalized space).
 */
export function occludeCell(baseTensor, size, grid, row, col, fillValue = 0, target = null) {
  const out = target ?? new Float32Array(baseTensor.length);
  out.set(baseTensor);
  const planeSize = size * size;
  const y0 = Math.floor((row * size) / grid);
  const y1 = Math.floor(((row + 1) * size) / grid);
  const x0 = Math.floor((col * size) / grid);
  const x1 = Math.floor(((col + 1) * size) / grid);
  for (let c = 0; c < 3; c++) {
    const planeOffset = c * planeSize;
    for (let y = y0; y < y1; y++) {
      const rowOffset = planeOffset + y * size;
      out.fill(fillValue, rowOffset + x0, rowOffset + x1);
    }
  }
  return out;
}

/**
 * 5x5 Occlusion Sensitivity (Zeiler & Fergus, ECCV 2014): masks each cell on the
 * 224x224 normalized tensor with 0 (neutral mean RGB), runs the model, and measures
 * max(0, p_base[topIdx] - p_occ[topIdx]).
 */
export async function computeOcclusionSensitivity(
  baseTensor,
  baseSummary,
  runForward,
  { size = MODEL.imageSize, grid = OCCLUSION_GRID, onProgress = null, signal = null } = {},
) {
  const expectedClasses = baseSummary.logits?.length ?? baseSummary.ranked?.length ?? MODEL.classes.length;
  const topIdx = baseSummary.top.index;
  if (!Number.isInteger(topIdx) || topIdx < 0 || topIdx >= expectedClasses) {
    throw new Error(`Invalid top class index ${topIdx} for ${expectedClasses} classes.`);
  }
  const baseProb = baseSummary.top.probability;
  const total = grid * grid;
  const raw = new Float32Array(total);
  const workTensor = new Float32Array(baseTensor.length);

  let maxDrop = 0;
  let step = 0;
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      signal?.throwIfAborted();
      occludeCell(baseTensor, size, grid, row, col, 0, workTensor);
      const logits = await runForward(workTensor);
      validateLogits(logits, expectedClasses);
      const probs = softmax(logits);
      const drop = Math.max(0, baseProb - probs[topIdx]);
      raw[row * grid + col] = drop;
      if (drop > maxDrop) maxDrop = drop;
      step += 1;
      onProgress?.(step, total);
    }
  }

  const normalized = new Float32Array(total);
  if (maxDrop > 1e-12) {
    for (let i = 0; i < total; i++) {
      normalized[i] = raw[i] / maxDrop;
    }
  }

  return {
    grid,
    raw,
    normalized,
    maxDrop,
    topClassCode: baseSummary.top.code,
    topClassIndex: topIdx,
  };
}

/**
 * Bilinearly upsamples a `grid x grid` normalized saliency array [0, 1] to
 * `(targetWidth x targetHeight)` Float32Array [0, 1].
 */
export function upsampleSaliency(gridValues, grid, targetWidth, targetHeight) {
  const out = new Float32Array(targetWidth * targetHeight);
  if (grid <= 0 || targetWidth <= 0 || targetHeight <= 0) return out;
  for (let y = 0; y < targetHeight; y++) {
    const gy = Math.max(0, Math.min(grid - 1, ((y + 0.5) * grid) / targetHeight - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(grid - 1, y0 + 1);
    const fy = gy - y0;
    const wy0 = 1 - fy;
    const row0 = y0 * grid;
    const row1 = y1 * grid;
    const dstRow = y * targetWidth;

    for (let x = 0; x < targetWidth; x++) {
      const gx = Math.max(0, Math.min(grid - 1, ((x + 0.5) * grid) / targetWidth - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(grid - 1, x0 + 1);
      const fx = gx - x0;
      const wx0 = 1 - fx;

      const v00 = gridValues[row0 + x0];
      const v10 = gridValues[row0 + x1];
      const v01 = gridValues[row1 + x0];
      const v11 = gridValues[row1 + x1];
      const value = v00 * wx0 * wy0 + v10 * fx * wy0 + v01 * wx0 * fy + v11 * fx * fy;
      out[dstRow + x] = Math.max(0, Math.min(1, value));
    }
  }
  return out;
}
