/**
 * 2D Sliding Window Inference with Gaussian Weighting
 *
 * Tiles a 2D image with overlapping patches, runs inference on each,
 * and accumulates Gaussian-weighted predictions.
 */

/**
 * Precompute a 2D Gaussian importance weight map.
 *
 * @param {number} h - Patch height
 * @param {number} w - Patch width
 * @param {number} sigma - Gaussian sigma (default: 1/8 of size)
 * @returns {Float32Array} h*w weight map
 */
export function computeGaussianWeightMap(h, w, sigma) {
  if (!sigma) sigma = Math.min(h, w) / 8;
  const weights = new Float32Array(h * w);
  const cy = (h - 1) / 2;
  const cx = (w - 1) / 2;
  const s2 = 2 * sigma * sigma;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dy = y - cy;
      const dx = x - cx;
      weights[y * w + x] = Math.exp(-(dy * dy + dx * dx) / s2);
    }
  }

  return weights;
}

/**
 * Compute sliding window tile positions for a 2D image.
 *
 * @param {number} imgH - Image height
 * @param {number} imgW - Image width
 * @param {number} patchH - Patch height (ROI size)
 * @param {number} patchW - Patch width (ROI size)
 * @param {number} overlap - Overlap fraction (0-1)
 * @returns {Array<{y: number, x: number}>} Top-left corner of each tile
 */
export function computeTilePositions(imgH, imgW, patchH, patchW, overlap) {
  const stepH = Math.max(1, Math.round(patchH * (1 - overlap)));
  const stepW = Math.max(1, Math.round(patchW * (1 - overlap)));

  const positions = [];

  // Generate positions with overlap
  const numY = Math.max(1, Math.ceil((imgH - patchH) / stepH) + 1);
  const numX = Math.max(1, Math.ceil((imgW - patchW) / stepW) + 1);

  for (let iy = 0; iy < numY; iy++) {
    let y = iy * stepH;
    if (y + patchH > imgH) y = Math.max(0, imgH - patchH);

    for (let ix = 0; ix < numX; ix++) {
      let x = ix * stepW;
      if (x + patchW > imgW) x = Math.max(0, imgW - patchW);

      positions.push({ y, x });
    }
  }

  // Deduplicate positions
  const seen = new Set();
  return positions.filter(p => {
    const key = `${p.y},${p.x}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract a 2D patch from a slice.
 *
 * @param {Float32Array} slice - 2D slice data (H*W)
 * @param {number} sliceW - Slice width
 * @param {number} y - Top position
 * @param {number} x - Left position
 * @param {number} patchH - Patch height
 * @param {number} patchW - Patch width
 * @returns {Float32Array} Patch data (patchH * patchW)
 */
export function extractPatch(slice, sliceW, y, x, patchH, patchW) {
  const patch = new Float32Array(patchH * patchW);
  for (let py = 0; py < patchH; py++) {
    const srcOffset = (y + py) * sliceW + x;
    const dstOffset = py * patchW;
    patch.set(slice.subarray(srcOffset, srcOffset + patchW), dstOffset);
  }
  return patch;
}

/**
 * Run sliding window inference on a single 2D slice.
 * Returns the argmax label for each pixel.
 *
 * @param {Float32Array} slice - 2D normalized slice (H * W)
 * @param {number} sliceH - Slice height
 * @param {number} sliceW - Slice width
 * @param {number} patchH - Patch/ROI height
 * @param {number} patchW - Patch/ROI width
 * @param {number} numClasses - Number of output classes
 * @param {number} overlap - Overlap fraction
 * @param {Float32Array} gaussianWeights - Precomputed Gaussian weight map
 * @param {Function} runPatch - async (patchData) => Float32Array of numClasses*patchH*patchW
 * @returns {Promise<Uint8Array>} Argmax labels for the slice (H * W)
 */
export async function slidingWindowInference2D(
  slice, sliceH, sliceW,
  patchH, patchW, numClasses, overlap,
  gaussianWeights, runPatch
) {
  const tiles = computeTilePositions(sliceH, sliceW, patchH, patchW, overlap);

  // Accumulation buffers: we only track the winning class per pixel
  // For memory efficiency with 100 classes, we accumulate weighted logits
  // per-class only within the patch, then merge argmax

  // Actually, for correctness with Gaussian weighting, we need to accumulate
  // weighted probabilities. With 100 classes this is too much memory for full slice.
  // Instead, accumulate per-class weights at patch level and aggregate.

  // Use a sparse approach: for each pixel, track weighted sum per class
  // But 100 * H * W * 4 bytes can be large. For 512x512 with 100 classes = 100MB.
  // With typical cropped sizes ~300x200, this is ~24MB, which is acceptable.

  const pixelCount = sliceH * sliceW;
  const weightSum = new Float32Array(pixelCount);

  // For memory efficiency, accumulate weighted logits class-by-class
  // But we need all classes simultaneously for argmax...
  // Compromise: accumulate all classes, but use a compact approach

  // If slice is small enough, allocate full buffer
  const fullBufferSize = numClasses * pixelCount;
  if (fullBufferSize > 200_000_000) {
    // Fallback for very large slices: just use center patch, no sliding window
    const cy = Math.max(0, Math.floor((sliceH - patchH) / 2));
    const cx = Math.max(0, Math.floor((sliceW - patchW) / 2));
    const patch = extractPatch(slice, sliceW, cy, cx, patchH, patchW);
    const output = await runPatch(patch);
    return argmaxFromPatchOutput(output, patchH, patchW, numClasses, sliceH, sliceW, cy, cx);
  }

  const accum = new Float32Array(fullBufferSize); // numClasses * pixelCount

  for (const tile of tiles) {
    const patch = extractPatch(slice, sliceW, tile.y, tile.x, patchH, patchW);
    const output = await runPatch(patch);

    // output shape: [numClasses, patchH, patchW] (C-contiguous from ONNX)
    for (let c = 0; c < numClasses; c++) {
      for (let py = 0; py < patchH; py++) {
        for (let px = 0; px < patchW; px++) {
          const gw = gaussianWeights[py * patchW + px];
          const globalY = tile.y + py;
          const globalX = tile.x + px;
          const globalIdx = globalY * sliceW + globalX;
          const outputIdx = c * patchH * patchW + py * patchW + px;

          accum[c * pixelCount + globalIdx] += output[outputIdx] * gw;
        }
      }
    }

    // Track weight sum for normalization
    for (let py = 0; py < patchH; py++) {
      for (let px = 0; px < patchW; px++) {
        const globalY = tile.y + py;
        const globalX = tile.x + px;
        weightSum[globalY * sliceW + globalX] += gaussianWeights[py * patchW + px];
      }
    }
  }

  // Argmax over accumulated weighted logits
  const labels = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (weightSum[i] === 0) continue;
    let bestClass = 0;
    let bestVal = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const val = accum[c * pixelCount + i];
      if (val > bestVal) {
        bestVal = val;
        bestClass = c;
      }
    }
    labels[i] = bestClass;
  }

  return labels;
}

function argmaxFromPatchOutput(output, patchH, patchW, numClasses, sliceH, sliceW, offsetY, offsetX) {
  const labels = new Uint8Array(sliceH * sliceW);
  for (let py = 0; py < patchH; py++) {
    for (let px = 0; px < patchW; px++) {
      const globalY = offsetY + py;
      const globalX = offsetX + px;
      if (globalY >= sliceH || globalX >= sliceW) continue;

      let bestClass = 0;
      let bestVal = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const val = output[c * patchH * patchW + py * patchW + px];
        if (val > bestVal) {
          bestVal = val;
          bestClass = c;
        }
      }
      labels[globalY * sliceW + globalX] = bestClass;
    }
  }
  return labels;
}
