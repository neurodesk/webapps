// Pure-JS InstanSeg brightfield_nuclei (v0.1.1 / instanseg 0.1.2) preprocessing,
// embedding/seediness pixel-classifier instance decoder, and overlap-tile stitching.
// No DOM and no ONNX Runtime import so unit tests stay fast and network-free.

export const MODEL_PIXEL_SIZE = 0.5; // micrometres per pixel
export const PIXEL_SIZE_PRECISION = 0.01;
export const MAX_WORKING_PIXELS = 4096 * 4096;
export const DEFAULT_TILE_SIZE = 512;
export const DEFAULT_TILE_OVERLAP = 80;
export const DEFAULT_MAX_CELL_SIZE = 20;

export const DEFAULTS = Object.freeze({
  maskThreshold: 0.53,
  seedThreshold: 0.7,
  peakDistance: 5,
  overlapThreshold: 0.3,
  windowSize: 32,
  cleanupFragments: true,
  tileSize: DEFAULT_TILE_SIZE,
});

// Exact 61-parameter ProbabilityNet weights extracted from brightfield_nuclei/instanseg.pt
// (instanseg_models_v0.1.1, Apache-2.0): Linear(4->5) + ReLU -> Linear(5->5) + ReLU -> Linear(5->1).
export const BRIGHTFIELD_PIXEL_CLASSIFIER = Object.freeze({
  fc1Weight: Object.freeze([
    Object.freeze([0.6487612128257751, -0.016741739585995674, -0.18466758728027344, -0.915859580039978]),
    Object.freeze([0.025155020877718925, 0.6039507985115051, 0.012711224146187305, -1.0109223127365112]),
    Object.freeze([-0.08504602313041687, -0.020345225930213928, -1.187080979347229, -0.20928554236888885]),
    Object.freeze([-0.52534019947052, 0.026480674743652344, -0.4198344051837921, -0.6574712991714478]),
    Object.freeze([-0.04887311905622482, -0.5106481313705444, -0.1349620223045349, -0.7415645718574524]),
  ]),
  fc1Bias: Object.freeze([0.15820136666297913, 0.12558309733867645, 0.3660874664783478, 0.15194883942604065, 0.10183895379304886]),
  fc2Weight: Object.freeze([
    Object.freeze([-0.02276771329343319, 0.06289727985858917, 0.18648864328861237, -0.08288724720478058, -0.005153483245521784]),
    Object.freeze([0.017695071175694466, -0.010745770297944546, -0.07589132338762283, -0.006128785200417042, 0.08387839049100876]),
    Object.freeze([0.0032874117605388165, -0.03632994368672371, -0.05597102642059326, 0.10007338225841522, -0.08095696568489075]),
    Object.freeze([-7.628407001495361, -7.800091743469238, -6.7009077072143555, -8.3454008102417, -8.72232437133789]),
    Object.freeze([-0.16747349500656128, -0.6652701497077942, -0.008667980320751667, -0.11785545200109482, 0.0002442756376694888]),
  ]),
  fc2Bias: Object.freeze([0.8289174437522888, 0.9263208508491516, 0.8784584999084473, 1.044798731803894, -0.004714024253189564]),
  fc3Weight: Object.freeze([-0.20001940429210663, -0.28617292642593384, -0.22026625275611877, 1.9143308401107788, -0.022454459220170975]),
  fc3Bias: -0.37384501099586487,
});

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Exact NumPy linear-interpolation percentile on an ascending sorted array. */
export function percentileLinear(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = (p / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Match upstream `instanseg.utils.utils.percentile_normalize(img, percentile=0.1, epsilon=1e-3)`.
 * Input is CHW Float32Array `[3, height, width]`. Returns a normalized Float32Array of the same shape.
 */
export function percentileNormalize(chw, width, height, percentile = 0.1, epsilon = 1e-3) {
  const planeSize = width * height;
  const channels = Math.round(chw.length / planeSize);
  const out = new Float32Array(chw.length);
  const scratch = new Float32Array(planeSize);
  for (let c = 0; c < channels; c++) {
    const off = c * planeSize;
    for (let i = 0; i < planeSize; i++) {
      const v = chw[off + i];
      scratch[i] = Number.isFinite(v) ? v : 0;
    }
    scratch.sort();
    const pMin = percentileLinear(scratch, percentile);
    const pMax = percentileLinear(scratch, 100 - percentile);
    const denom = Math.max(epsilon, pMax - pMin);
    for (let i = 0; i < planeSize; i++) {
      const v = chw[off + i];
      out[off + i] = ((Number.isFinite(v) ? v : 0) - pMin) / denom;
    }
  }
  return out;
}

/**
 * Match PyTorch `F.interpolate(..., scale_factor=requested/model, mode='bilinear', align_corners=False)`.
 * Only resizes when `|scale - 1| > PIXEL_SIZE_PRECISION` (0.01), matching `_rescale_to_pixel_size`.
 */
export function rescaleChwBilinear(chw, width, height, requestedPixelSize, modelPixelSize = MODEL_PIXEL_SIZE) {
  if (!requestedPixelSize || !Number.isFinite(requestedPixelSize) || requestedPixelSize <= 0) {
    return { data: chw, width, height, rescaled: false };
  }
  const scale = requestedPixelSize / modelPixelSize;
  if (Math.abs(scale - 1) <= PIXEL_SIZE_PRECISION) {
    return { data: chw, width, height, rescaled: false };
  }
  const outW = Math.max(16, Math.floor(width * scale));
  const outH = Math.max(16, Math.floor(height * scale));
  if (outW * outH > MAX_WORKING_PIXELS) {
    throw new Error(
      `Resampling ${width} × ${height} from ${requestedPixelSize} µm/px to ${modelPixelSize} µm/px would produce ${outW} × ${outH} (${(outW * outH / 1e6).toFixed(1)} MP), exceeding the 16 MP browser limit. Crop the image, verify pixel size, or use the Standalone container.`,
    );
  }
  if (outW === width && outH === height) {
    return { data: chw, width, height, rescaled: false };
  }
  const planeIn = width * height;
  const planeOut = outW * outH;
  const channels = Math.round(chw.length / planeIn);
  const out = new Float32Array(channels * planeOut);
  // Match PyTorch F.interpolate(scale_factor=s, mode='bilinear', align_corners=False, recompute_scale_factor=False),
  // which maps output index i to source position (i + 0.5) / s - 0.5 rather than using width / outW.
  const scaleY = 1 / scale;
  const scaleX = 1 / scale;

  const x0s = new Int32Array(outW);
  const x1s = new Int32Array(outW);
  const wxs = new Float32Array(outW);
  for (let x = 0; x < outW; x++) {
    const sx = clamp((x + 0.5) * scaleX - 0.5, 0, width - 1);
    const x0 = Math.floor(sx);
    const x1 = Math.min(x0 + 1, width - 1);
    x0s[x] = x0;
    x1s[x] = x1;
    wxs[x] = sx - x0;
  }

  for (let c = 0; c < channels; c++) {
    const inOff = c * planeIn;
    const outOff = c * planeOut;
    for (let y = 0; y < outH; y++) {
      const sy = clamp((y + 0.5) * scaleY - 0.5, 0, height - 1);
      const y0 = Math.floor(sy);
      const y1 = Math.min(y0 + 1, height - 1);
      const wy = sy - y0;
      const row0 = inOff + y0 * width;
      const row1 = inOff + y1 * width;
      const dstRow = outOff + y * outW;
      for (let x = 0; x < outW; x++) {
        const x0 = x0s[x];
        const x1 = x1s[x];
        const wx = wxs[x];
        const top = chw[row0 + x0] * (1 - wx) + chw[row0 + x1] * wx;
        const bot = chw[row1 + x0] * (1 - wx) + chw[row1 + x1] * wx;
        out[dstRow + x] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { data: out, width: outW, height: outH, rescaled: true };
}

/** Match PyTorch `F.interpolate(labels, size=(targetH, targetW), mode='nearest')`. */
export function rescaleLabelsNearest(labels, srcW, srcH, dstW, dstH) {
  if (srcW === dstW && srcH === dstH) return labels;
  const out = new Int32Array(dstW * dstH);
  const scaleY = srcH / dstH;
  const scaleX = srcW / dstW;
  const xMap = new Int32Array(dstW);
  for (let x = 0; x < dstW; x++) xMap[x] = Math.min(Math.floor(x * scaleX), srcW - 1);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(Math.floor(y * scaleY), srcH - 1);
    const srcRow = sy * srcW;
    const dstRow = y * dstW;
    for (let x = 0; x < dstW; x++) {
      out[dstRow + x] = labels[srcRow + xMap[x]];
    }
  }
  return out;
}

/** Reflect index matching PyTorch `F.pad(..., mode='reflect')` (edge pixel is not repeated). */
function reflectIndex(i, size) {
  if (size <= 1) return 0;
  let idx = i;
  while (idx < 0 || idx >= size) {
    if (idx < 0) idx = -idx;
    if (idx >= size) idx = 2 * (size - 1) - idx;
  }
  return idx;
}

/**
 * Clamp normalized CHW input to `[-2, 3]` and reflect-pad bottom/right to a multiple of 16,
 * matching `InstanSeg_Torchscript.forward` + `_instanseg_padding(x, extra_pad=0, min_dim=16)`.
 */
export function clampAndPadReflect16(chw, width, height, channels = 3) {
  const padH = (16 - (height % 16)) % 16;
  const padW = (16 - (width % 16)) % 16;
  const outH = height + padH;
  const outW = width + padW;
  const planeIn = width * height;
  const planeOut = outW * outH;
  const out = new Float32Array(channels * planeOut);
  const rx = new Int32Array(outW);
  for (let x = 0; x < outW; x++) rx[x] = x < width ? x : reflectIndex(x, width);
  for (let c = 0; c < channels; c++) {
    const inOff = c * planeIn;
    const outOff = c * planeOut;
    for (let y = 0; y < outH; y++) {
      const sy = y < height ? y : reflectIndex(y, height);
      const srcRow = inOff + sy * width;
      const dstRow = outOff + y * outW;
      for (let x = 0; x < outW; x++) {
        out[dstRow + x] = clamp(chw[srcRow + rx[x]], -2, 3);
      }
    }
  }
  return { data: out, width: outW, height: outH, padW, padH };
}

/** Reject constant or non-finite FCN outputs (guards against broken WebGPU adapters). */
export function checkFeatures(features) {
  const first = features[0];
  let varies = false;
  for (let i = 0; i < features.length; i++) {
    const v = features[i];
    if (!Number.isFinite(v)) throw new Error('The InstanSeg network returned non-finite features.');
    if (v !== first) varies = true;
  }
  if (!varies) throw new Error('The InstanSeg network returned constant features.');
}

/**
 * Match `torch_peak_local_max(maskMap, neighbourhood_size=peakDistance, minimum_value=seedThreshold)`:
 * pixel (y, x) is a peak iff maskMap[y, x] > minimumValue and it is the first row-major maximum
 * inside the `(2*d + 1) x (2*d + 1)` neighbourhood.
 */
export function peakLocalMax(maskMap, width, height, peakDistance = DEFAULTS.peakDistance, seedThreshold = DEFAULTS.seedThreshold) {
  const peaks = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const yLo = Math.max(0, y - peakDistance);
    const yHi = Math.min(height - 1, y + peakDistance);
    for (let x = 0; x < width; x++) {
      const val = maskMap[row + x];
      if (!(val > seedThreshold)) continue;
      const xLo = Math.max(0, x - peakDistance);
      const xHi = Math.min(width - 1, x + peakDistance);
      let isPeak = true;
      for (let ny = yLo; ny <= yHi && isPeak; ny++) {
        const nRow = ny * width;
        for (let nx = xLo; nx <= xHi; nx++) {
          const nv = maskMap[nRow + nx];
          if (ny < y || (ny === y && nx < x)) {
            if (nv >= val) {
              isPeak = false;
              break;
            }
          } else if (ny > y || nx > x) {
            if (nv > val) {
              isPeak = false;
              break;
            }
          }
        }
      }
      if (isPeak) peaks.push([y, x]);
    }
  }
  return peaks;
}

/** 8-connected flood fill matching `pytorch_utils.flood_fill(bw_mask, bw_seed)` (max_pool2d 3x3). */
function floodFill8(mask, seedMask, w, h, visited, queue) {
  visited.fill(0);
  let head = 0;
  let tail = 0;
  // First step of upstream flood_fill dilates bw_seed by 3x3 and intersects with bw_mask.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!mask[idx]) continue;
      let touchesSeed = false;
      const yLo = y > 0 ? y - 1 : 0;
      const yHi = y + 1 < h ? y + 1 : h - 1;
      const xLo = x > 0 ? x - 1 : 0;
      const xHi = x + 1 < w ? x + 1 : w - 1;
      for (let ny = yLo; ny <= yHi && !touchesSeed; ny++) {
        const nRow = ny * w;
        for (let nx = xLo; nx <= xHi; nx++) {
          if (seedMask[nRow + nx]) {
            touchesSeed = true;
            break;
          }
        }
      }
      if (touchesSeed) {
        visited[idx] = 1;
        queue[tail++] = idx;
      }
    }
  }
  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;
    const yLo = y > 0 ? y - 1 : 0;
    const yHi = y + 1 < h ? y + 1 : h - 1;
    const xLo = x > 0 ? x - 1 : 0;
    const xHi = x + 1 < w ? x + 1 : w - 1;
    for (let ny = yLo; ny <= yHi; ny++) {
      const nRow = ny * w;
      for (let nx = xLo; nx <= xHi; nx++) {
        const nIdx = nRow + nx;
        if (!visited[nIdx] && mask[nIdx]) {
          visited[nIdx] = 1;
          queue[tail++] = nIdx;
        }
      }
    }
  }
}

/** 3x3 8-connected binary dilation, repeated `iterations` times. */
function dilate3x3(src, dst, w, h, iterations) {
  let cur = src;
  let nxt = dst;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      const yLo = y > 0 ? y - 1 : 0;
      const yHi = y + 1 < h ? y + 1 : h - 1;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const xLo = x > 0 ? x - 1 : 0;
        const xHi = x + 1 < w ? x + 1 : w - 1;
        let on = 0;
        for (let ny = yLo; ny <= yHi && !on; ny++) {
          const nRow = ny * w;
          for (let nx = xLo; nx <= xHi; nx++) {
            if (cur[nRow + nx]) {
              on = 1;
              break;
            }
          }
        }
        nxt[row + x] = on;
      }
    }
    const tmp = cur;
    cur = nxt;
    nxt = tmp;
  }
  return cur;
}

/**
 * Decode 5-channel FCN output `[5, padH, padW]` cropped to `[height, width]` into an Int32Array
 * instance label map (0 = background, 1..K = contiguous nuclei IDs), matching `InstanSeg_Torchscript`.
 */
export function decodeInstanSeg(featuresPadded, width, height, paddedWidth, paddedHeight, options = {}) {
  const {
    maskThreshold = DEFAULTS.maskThreshold,
    seedThreshold = DEFAULTS.seedThreshold,
    peakDistance = DEFAULTS.peakDistance,
    overlapThreshold = DEFAULTS.overlapThreshold,
    windowSize: requestedWin = DEFAULTS.windowSize,
    cleanupFragments = DEFAULTS.cleanupFragments,
    classifier = BRIGHTFIELD_PIXEL_CLASSIFIER,
  } = options;
  // Match PyTorch float32 threshold comparisons so Float32Array hole-fill values pass >= maskThresholdF.
  const maskThresholdF = Math.fround(maskThreshold);

  const padPlane = paddedWidth * paddedHeight;
  const plane = width * height;

  // Unpack coordinate map, fields, sigma, and mask_map on the unpadded [height, width] grid.
  const fields0 = new Float32Array(plane);
  const fields1 = new Float32Array(plane);
  const sigma0 = new Float32Array(plane);
  const sigma1 = new Float32Array(plane);
  const maskMap = new Float32Array(plane);

  const xx = new Float32Array(width);
  const yy = new Float32Array(height);
  const xStep = width > 1 ? (width * 0.25) / (width - 1) : 0;
  const yStep = height > 1 ? (height * 0.25) / (height - 1) : 0;
  for (let x = 0; x < width; x++) xx[x] = x * xStep;
  for (let y = 0; y < height; y++) yy[y] = y * yStep;

  const off1 = padPlane;
  const off2 = 2 * padPlane;
  const off3 = 3 * padPlane;
  const off4 = 4 * padPlane;
  for (let y = 0; y < height; y++) {
    const srcRow = y * paddedWidth;
    const dstRow = y * width;
    const yCoord = yy[y];
    for (let x = 0; x < width; x++) {
      const s = srcRow + x;
      const d = dstRow + x;
      fields0[d] = (sigmoid(featuresPadded[s]) - 0.5) * 8 + xx[x];
      fields1[d] = (sigmoid(featuresPadded[off1 + s]) - 0.5) * 8 + yCoord;
      sigma0[d] = featuresPadded[off2 + s];
      sigma1[d] = featuresPadded[off3 + s];
      maskMap[d] = featuresPadded[off4 + s] / 15 + 0.5;
    }
  }

  const peaks = peakLocalMax(maskMap, width, height, peakDistance, seedThreshold);
  const numSeeds = peaks.length;
  const labels = new Int32Array(plane);
  if (numSeeds === 0) return labels;

  // Keep the 2*win square window inside [height, width] without padding (upstream uses min(32, h, w) with pad).
  const win = Math.max(1, Math.min(requestedWin, Math.floor(height / 2), Math.floor(width / 2)));
  const sliceSize = 2 * win;
  const slicePixels = sliceSize * sliceSize;

  // Unpack 61-parameter MLP weights into flat scalars for tight inner-loop performance.
  const w1 = classifier.fc1Weight;
  const b1 = classifier.fc1Bias;
  const w2 = classifier.fc2Weight;
  const b2 = classifier.fc2Bias;
  const w3 = classifier.fc3Weight;
  const b3 = classifier.fc3Bias;

  const bestProb = new Float32Array(plane);
  bestProb.fill(-1);

  // Scratch buffers reused across every seed window (zero per-seed allocation).
  const winProb = new Float32Array(slicePixels);
  const winMask = new Uint8Array(slicePixels);
  const seedBuf = new Uint8Array(slicePixels);
  const filledBuf = new Uint8Array(slicePixels);
  const dilA = new Uint8Array(slicePixels);
  const dilB = new Uint8Array(slicePixels);
  const invMask = new Uint8Array(slicePixels);
  const extSeeds = new Uint8Array(slicePixels);
  const extFill = new Uint8Array(slicePixels);
  const bfsQueue = new Int32Array(slicePixels);

  // Sparse pixel membership for exact IoMA (`fast_sparse_intersection_over_minimum_area`):
  // seedAreas[s] = count of foreground pixels for seed s; pixelHead/pixelNext store linked list
  // of seeds claiming each global pixel (O(total_fg_pixels) memory, zero GC churn).
  const seedAreas = new Int32Array(numSeeds);
  const pixelHead = new Int32Array(plane);
  pixelHead.fill(-1);
  let edgeCap = Math.max(4096, numSeeds * 256);
  let edgeSeed = new Int32Array(edgeCap);
  let edgeNext = new Int32Array(edgeCap);
  let edgeLen = 0;

  const appendMembership = (gIdx, s) => {
    if (edgeLen === edgeCap) {
      edgeCap *= 2;
      const ns = new Int32Array(edgeCap);
      const nn = new Int32Array(edgeCap);
      ns.set(edgeSeed);
      nn.set(edgeNext);
      edgeSeed = ns;
      edgeNext = nn;
    }
    edgeSeed[edgeLen] = s;
    edgeNext[edgeLen] = pixelHead[gIdx];
    pixelHead[gIdx] = edgeLen++;
  };

  for (let s = 0; s < numSeeds; s++) {
    const [cy, cx] = peaks[s];
    const centerIdx = cy * width + cx;
    const c0 = fields0[centerIdx];
    const c1 = fields1[centerIdx];
    const y0 = clamp(cy, win, height - win) - win;
    const x0 = clamp(cx, win, width - win) - win;

    let anyFg = false;
    for (let dy = 0; dy < sliceSize; dy++) {
      const gRow = (y0 + dy) * width + x0;
      const wRow = dy * sliceSize;
      for (let dx = 0; dx < sliceSize; dx++) {
        const gIdx = gRow + dx;
        const d0 = fields0[gIdx] - c0;
        const d1 = fields1[gIdx] - c1;
        const s0 = sigma0[gIdx];
        const s1 = sigma1[gIdx];

        let h0 = w1[0][0] * d0 + w1[0][1] * d1 + w1[0][2] * s0 + w1[0][3] * s1 + b1[0];
        let h1 = w1[1][0] * d0 + w1[1][1] * d1 + w1[1][2] * s0 + w1[1][3] * s1 + b1[1];
        let h2 = w1[2][0] * d0 + w1[2][1] * d1 + w1[2][2] * s0 + w1[2][3] * s1 + b1[2];
        let h3 = w1[3][0] * d0 + w1[3][1] * d1 + w1[3][2] * s0 + w1[3][3] * s1 + b1[3];
        let h4 = w1[4][0] * d0 + w1[4][1] * d1 + w1[4][2] * s0 + w1[4][3] * s1 + b1[4];
        if (h0 < 0) h0 = 0;
        if (h1 < 0) h1 = 0;
        if (h2 < 0) h2 = 0;
        if (h3 < 0) h3 = 0;
        if (h4 < 0) h4 = 0;

        let k0 = w2[0][0] * h0 + w2[0][1] * h1 + w2[0][2] * h2 + w2[0][3] * h3 + w2[0][4] * h4 + b2[0];
        let k1 = w2[1][0] * h0 + w2[1][1] * h1 + w2[1][2] * h2 + w2[1][3] * h3 + w2[1][4] * h4 + b2[1];
        let k2 = w2[2][0] * h0 + w2[2][1] * h1 + w2[2][2] * h2 + w2[2][3] * h3 + w2[2][4] * h4 + b2[2];
        let k3 = w2[3][0] * h0 + w2[3][1] * h1 + w2[3][2] * h2 + w2[3][3] * h3 + w2[3][4] * h4 + b2[3];
        let k4 = w2[4][0] * h0 + w2[4][1] * h1 + w2[4][2] * h2 + w2[4][3] * h3 + w2[4][4] * h4 + b2[4];
        if (k0 < 0) k0 = 0;
        if (k1 < 0) k1 = 0;
        if (k2 < 0) k2 = 0;
        if (k3 < 0) k3 = 0;
        if (k4 < 0) k4 = 0;

        const logit = w3[0] * k0 + w3[1] * k1 + w3[2] * k2 + w3[3] * k3 + w3[4] * k4 + b3;
        const p = sigmoid(logit);
        const wIdx = wRow + dx;
        winProb[wIdx] = p;
        const fg = Math.fround(p) >= maskThresholdF ? 1 : 0;
        winMask[wIdx] = fg;
        if (fg) anyFg = true;
      }
    }

    if (!anyFg) continue;

    if (cleanupFragments) {
      seedBuf.fill(0);
      seedBuf[(cy - y0) * sliceSize + (cx - x0)] = 1;
      floodFill8(winMask, seedBuf, sliceSize, sliceSize, filledBuf, bfsQueue);

      // fill_holes(filled): dilate filled 3x3 (3 times), invert to exterior seeds, 8-flood ~filled.
      dilA.set(filledBuf);
      const dilated = dilate3x3(dilA, dilB, sliceSize, sliceSize, 3);
      for (let i = 0; i < slicePixels; i++) {
        invMask[i] = filledBuf[i] ? 0 : 1;
        extSeeds[i] = dilated[i] ? 0 : 1;
      }
      floodFill8(invMask, extSeeds, sliceSize, sliceSize, extFill, bfsQueue);

      for (let i = 0; i < slicePixels; i++) {
        if (!filledBuf[i]) {
          if (!extFill[i]) {
            // Interior hole: set probability to maskThresholdF (matching upstream `x[holes] = mask_threshold` in float32).
            winProb[i] = maskThresholdF;
          } else {
            winProb[i] = 0;
          }
        }
      }
    }

    // Winner-takes-all `convert` + sparse membership recording for IoMA merging.
    let area = 0;
    const seedLabel = s + 1;
    for (let dy = 0; dy < sliceSize; dy++) {
      const gRow = (y0 + dy) * width + x0;
      const wRow = dy * sliceSize;
      for (let dx = 0; dx < sliceSize; dx++) {
        const p = winProb[wRow + dx];
        if (p >= maskThresholdF) {
          const gIdx = gRow + dx;
          area++;
          appendMembership(gIdx, s);
          if (p > bestProb[gIdx]) {
            bestProb[gIdx] = p;
            labels[gIdx] = seedLabel;
          }
        }
      }
    }
    seedAreas[s] = area;
  }

  // Exact sparse IoMA (`intersection / min(area_i, area_j) > overlapThreshold`) + connected components.
  const pairInter = new Map();
  const claimed = [];
  for (let gIdx = 0; gIdx < plane; gIdx++) {
    let e = pixelHead[gIdx];
    if (e === -1 || edgeNext[e] === -1) continue; // 0 or 1 seed at this pixel -> no overlap
    claimed.length = 0;
    while (e !== -1) {
      claimed.push(edgeSeed[e]);
      e = edgeNext[e];
    }
    for (let a = 0; a < claimed.length; a++) {
      const sa = claimed[a];
      for (let b = a + 1; b < claimed.length; b++) {
        const sb = claimed[b];
        const lo = sa < sb ? sa : sb;
        const hi = sa < sb ? sb : sa;
        const key = lo * numSeeds + hi;
        pairInter.set(key, (pairInter.get(key) || 0) + 1);
      }
    }
  }

  const parent = new Int32Array(numSeeds);
  for (let i = 0; i < numSeeds; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (parent[c] !== r) {
      const p = parent[c];
      parent[c] = r;
      c = p;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
  };

  for (const [key, inter] of pairInter.entries()) {
    const lo = Math.floor(key / numSeeds);
    const hi = key - lo * numSeeds;
    const minArea = Math.min(seedAreas[lo], seedAreas[hi]);
    if (minArea > 0 && inter / minArea > overlapThreshold) {
      union(lo, hi);
    }
  }

  // Remap merged labels and compact IDs cleanly to 1..K.
  const rootToCompact = new Int32Array(numSeeds);
  let nextId = 0;
  for (let i = 0; i < plane; i++) {
    const lab = labels[i];
    if (lab === 0) continue;
    const r = find(lab - 1);
    let compact = rootToCompact[r];
    if (compact === 0) {
      compact = ++nextId;
      rootToCompact[r] = compact;
    }
    labels[i] = compact;
  }

  return labels;
}

/** Match `instanseg.utils.tiling._chops(img_shape, shape, overlap)`. */
export function chopIndices(height, width, tileH = DEFAULT_TILE_SIZE, tileW = DEFAULT_TILE_SIZE, overlap = 2 * (DEFAULT_TILE_OVERLAP + DEFAULT_MAX_CELL_SIZE)) {
  const effH = Math.min(tileH, height);
  const effW = Math.min(tileW, width);
  const axisChops = (size, win) => {
    if (size <= win) return [0];
    const stride = win - overlap;
    if (stride <= 0) return [0];
    const maxStart = size - win;
    const set = new Set();
    const count = Math.floor(size / stride);
    for (let i = 0; i < count; i++) {
      const s = i * stride;
      if (s <= maxStart) set.add(s);
    }
    set.add(maxStart);
    return Array.from(set).sort((a, b) => a - b);
  };
  return {
    yStarts: axisChops(height, effH),
    xStarts: axisChops(width, effW),
    tileH: effH,
    tileW: effW,
  };
}

/** Match `instanseg.utils.tiling._remove_edge_labels` on a cropped 2D Int32Array tile. */
function removeEdgeLabels(tile, w, h, ignoreTop, ignoreBottom, ignoreLeft, ignoreRight) {
  const edgeIds = new Set();
  if (!ignoreTop) {
    for (let x = 0; x < w; x++) if (tile[x] > 0) edgeIds.add(tile[x]);
  }
  if (!ignoreBottom) {
    const row = (h - 1) * w;
    for (let x = 0; x < w; x++) if (tile[row + x] > 0) edgeIds.add(tile[row + x]);
  }
  if (!ignoreLeft) {
    for (let y = 0; y < h; y++) if (tile[y * w] > 0) edgeIds.add(tile[y * w]);
  }
  if (!ignoreRight) {
    for (let y = 0; y < h; y++) if (tile[y * w + w - 1] > 0) edgeIds.add(tile[y * w + w - 1]);
  }
  if (edgeIds.size === 0) return;
  for (let i = 0; i < tile.length; i++) {
    if (edgeIds.has(tile[i])) tile[i] = 0;
  }
}

/**
 * Match `instanseg.utils.tiling._stitch` with `match_labels(tile1, tile2, threshold=0.1)` (dual IoU).
 * Each tile is an Int32Array of size `tileW * tileH`.
 */
export function stitchTiles(tiles, { yStarts, xStarts, tileH, tileW }, height, width, offset = DEFAULT_TILE_OVERLAP) {
  const canvas = new Int32Array(width * height);
  let runningMax = 0;

  const nY = yStarts.length;
  const nX = xStarts.length;

  for (let i = 0; i < nY; i++) {
    for (let j = 0; j < nX; j++) {
      const tileOrg = tiles[i * nX + j];
      const wy = yStarts[i];
      const wx = xStarts[j];
      const ignoreTop = i === 0;
      const ignoreLeft = j === 0;
      const ignoreBottom = i === nY - 1;
      const ignoreRight = j === nX - 1;

      const yStart = ignoreTop ? 0 : offset;
      const yEnd = ignoreBottom ? tileH : (ignoreTop ? tileH : tileH - offset);
      const xStart = ignoreLeft ? 0 : offset;
      const xEnd = ignoreRight ? tileW : (ignoreLeft ? tileW : tileW - offset);

      // Note: match exact upstream branches in tiling.py lines 110-137!
      const cropY0 = ignoreTop ? 0 : offset;
      const cropY1 = !ignoreTop && !ignoreBottom && !ignoreLeft && !ignoreRight ? tileH - offset : tileH;
      const cropX0 = ignoreLeft ? 0 : offset;
      const cropX1 = !ignoreTop && !ignoreBottom && !ignoreLeft && !ignoreRight ? tileW - offset : tileW;
      void yStart; void yEnd; void xStart; void xEnd;

      const cw = cropX1 - cropX0;
      const ch = cropY1 - cropY0;
      const tile2 = new Int32Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const srcRow = (cropY0 + y) * tileW + cropX0;
        const dstRow = y * cw;
        for (let x = 0; x < cw; x++) tile2[dstRow + x] = tileOrg[srcRow + x];
      }

      removeEdgeLabels(tile2, cw, ch, ignoreTop, ignoreBottom, ignoreLeft, ignoreRight);

      // Compact tile2 labels sequentially and offset by runningMax.
      const remapCompact = new Map();
      let localMax = 0;
      for (let k = 0; k < tile2.length; k++) {
        const v = tile2[k];
        if (v === 0) continue;
        let m = remapCompact.get(v);
        if (m === undefined) {
          m = ++localMax;
          remapCompact.set(v, m);
        }
        tile2[k] = m + runningMax;
      }

      // Compute dual IoU between existing canvas region (tile1) and tile2; remap matches > 0.1.
      const area1 = new Map();
      const area2 = new Map();
      const inter = new Map();
      for (let y = 0; y < ch; y++) {
        const cRow = (wy + cropY0 + y) * width + (wx + cropX0);
        const tRow = y * cw;
        for (let x = 0; x < cw; x++) {
          const l1 = canvas[cRow + x];
          const l2 = tile2[tRow + x];
          if (l1 > 0) area1.set(l1, (area1.get(l1) || 0) + 1);
          if (l2 > 0) area2.set(l2, (area2.get(l2) || 0) + 1);
          if (l1 > 0 && l2 > 0) {
            const key = `${l1}:${l2}`;
            inter.set(key, (inter.get(key) || 0) + 1);
          }
        }
      }

      const matchMap = new Map();
      for (const [key, cnt] of inter.entries()) {
        const sep = key.indexOf(':');
        const l1 = Number(key.slice(0, sep));
        const l2 = Number(key.slice(sep + 1));
        const unionArea = area1.get(l1) + area2.get(l2) - cnt;
        if (unionArea > 0 && cnt / unionArea > 0.1) {
          // Match upstream remap_values / bucketize tie-breaking: keep the lowest existing canvas label.
          if (!matchMap.has(l2) || l1 < matchMap.get(l2)) matchMap.set(l2, l1);
        }
      }

      for (let y = 0; y < ch; y++) {
        const cRow = (wy + cropY0 + y) * width + (wx + cropX0);
        const tRow = y * cw;
        for (let x = 0; x < cw; x++) {
          const l2 = tile2[tRow + x];
          if (l2 > 0) {
            const outLab = matchMap.get(l2) ?? l2;
            canvas[cRow + x] = outLab;
            if (outLab > runningMax) runningMax = outLab;
          }
        }
      }
    }
  }

  // Final sequential relabeling 1..K for clean output IDs.
  const finalMap = new Map();
  let nextId = 0;
  for (let i = 0; i < canvas.length; i++) {
    const v = canvas[i];
    if (v === 0) continue;
    let id = finalMap.get(v);
    if (id === undefined) {
      id = ++nextId;
      finalMap.set(v, id);
    }
    canvas[i] = id;
  }
  return canvas;
}

/**
 * End-to-end InstanSeg brightfield_nuclei 2D RGB segmentation pipeline over an injected ONNX FCN runner.
 * `rgbChw`: Float32Array of shape `[3, height, width]`.
 * `runFcn(paddedData, paddedHeight, paddedWidth)` -> Promise<Float32Array> `[5, paddedHeight, paddedWidth]`.
 */
export async function segmentBrightfieldNuclei({
  rgbChw,
  width,
  height,
  pixelSize = null,
  maskThreshold = DEFAULTS.maskThreshold,
  seedThreshold = DEFAULTS.seedThreshold,
  peakDistance = DEFAULTS.peakDistance,
  overlapThreshold = DEFAULTS.overlapThreshold,
  windowSize = DEFAULTS.windowSize,
  cleanupFragments = DEFAULTS.cleanupFragments,
  tileSize = DEFAULTS.tileSize,
  classifier = BRIGHTFIELD_PIXEL_CLASSIFIER,
  runFcn,
  onTile = () => {},
  signal,
}) {
  if (!Number.isFinite(maskThreshold) || maskThreshold < 0.05 || maskThreshold > 0.95) {
    throw new Error('Mask threshold must be between 0.05 and 0.95.');
  }
  if (!Number.isFinite(seedThreshold) || seedThreshold < 0.05 || seedThreshold > 0.95) {
    throw new Error('Seed threshold must be between 0.05 and 0.95.');
  }
  if (!Number.isFinite(overlapThreshold) || overlapThreshold < 0.05 || overlapThreshold > 0.95) {
    throw new Error('Overlap threshold must be between 0.05 and 0.95.');
  }
  if (width < 16 || height < 16) {
    throw new Error(`Image is ${width} × ${height}; InstanSeg needs at least 16 × 16 pixels.`);
  }
  if (rgbChw.length !== 3 * width * height) {
    throw new Error('Expected a 3-channel RGB planar CHW buffer.');
  }

  signal?.throwIfAborted();
  const scaled = rescaleChwBilinear(rgbChw, width, height, pixelSize, MODEL_PIXEL_SIZE);
  const norm = percentileNormalize(scaled.data, scaled.width, scaled.height, 0.1, 1e-3);

  const runSingle = async (tileData, tw, th) => {
    signal?.throwIfAborted();
    const padded = clampAndPadReflect16(tileData, tw, th, 3);
    const features = await runFcn(padded.data, padded.height, padded.width);
    signal?.throwIfAborted();
    checkFeatures(features);
    return decodeInstanSeg(features, tw, th, padded.width, padded.height, {
      maskThreshold,
      seedThreshold,
      peakDistance,
      overlapThreshold,
      windowSize,
      cleanupFragments,
      classifier,
    });
  };

  let labelsScaled;
  let tilesRun = 1;
  const effTile = Math.max(256, Math.trunc(tileSize || DEFAULT_TILE_SIZE));
  if (scaled.width <= effTile && scaled.height <= effTile) {
    labelsScaled = await runSingle(norm, scaled.width, scaled.height);
    onTile(1, 1);
  } else {
    let overlap = DEFAULT_TILE_OVERLAP;
    let maxCell = DEFAULT_MAX_CELL_SIZE;
    if (2 * (overlap + maxCell) >= Math.min(scaled.width, scaled.height)) {
      overlap = 0;
      maxCell = 0;
    }
    const chops = chopIndices(scaled.height, scaled.width, effTile, effTile, 2 * (overlap + maxCell));
    const total = chops.yStarts.length * chops.xStarts.length;
    tilesRun = total;
    const tileResults = [];
    const tileBuf = new Float32Array(3 * chops.tileH * chops.tileW);
    const planeScaled = scaled.width * scaled.height;
    const planeTile = chops.tileW * chops.tileH;
    let done = 0;

    for (const y0 of chops.yStarts) {
      for (const x0 of chops.xStarts) {
        signal?.throwIfAborted();
        for (let c = 0; c < 3; c++) {
          const srcBase = c * planeScaled;
          const dstBase = c * planeTile;
          for (let y = 0; y < chops.tileH; y++) {
            const srcRow = srcBase + (y0 + y) * scaled.width + x0;
            tileBuf.set(norm.subarray(srcRow, srcRow + chops.tileW), dstBase + y * chops.tileW);
          }
        }
        tileResults.push(await runSingle(tileBuf, chops.tileW, chops.tileH));
        onTile(++done, total);
      }
    }
    labelsScaled = stitchTiles(tileResults, chops, scaled.height, scaled.width, overlap);
  }

  const labels = scaled.rescaled
    ? rescaleLabelsNearest(labelsScaled, scaled.width, scaled.height, width, height)
    : labelsScaled;

  return {
    labels,
    width,
    height,
    scaledWidth: scaled.width,
    scaledHeight: scaled.height,
    rescaled: scaled.rescaled,
    tiles: tilesRun,
  };
}
