// Noise level estimation (Donoho-Johnstone MAD on diagonal Haar detail subband and
// smooth-region Poisson-Gaussian variance-mean regression inspired by Foi et al. 2008)
// plus per-axis post-denoising residual diagnostics.

const MAD_TO_SIGMA = 0.6744897501960817;

/**
 * Returns the median of a Float64Array or Float32Array (sorts a copy).
 * @param {Float64Array | Float32Array} values
 * @returns {number}
 */
export function median(values) {
  if (!values.length) return 0;
  const copy = Float64Array.from(values);
  copy.sort();
  const mid = copy.length >>> 1;
  return copy.length % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

/**
 * Verifies every voxel in `data` is finite, throwing a clear error with the count if not.
 * @param {Float32Array | Float64Array} data
 * @param {string} [label='Image']
 */
export function assertFiniteVoxels(data, label = "Image") {
  let nonFinite = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (!Number.isFinite(data[i])) nonFinite += 1;
  }
  if (nonFinite > 0) {
    throw new Error(`${label} contains ${nonFinite} non-finite (NaN or Inf) voxel${nonFinite === 1 ? "" : "s"}; replace or mask them before denoising.`);
  }
}

/**
 * Robust noise standard deviation estimate via the 2D diagonal Haar wavelet detail subband
 * HH[y, x] = 0.5 * (I[y, x] - I[y, x+1] - I[y+1, x] + I[y+1, x+1]), which has unit L2 norm
 * so sigma_hat = median(|HH|) / 0.67448975 (Donoho & Johnstone 1994).
 * @param {Float32Array | Float64Array} data `[nz][ny][nx]`
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @returns {number}
 */
export function estimateNoiseSigma(data, dims) {
  const [nz, ny, nx] = dims;
  if (ny < 2 || nx < 2 || nz < 1) return 0;
  const planeSize = ny * nx;
  const maxSamples = 200000;
  const zStep = Math.max(1, Math.ceil(nz / 16));
  const pairsPerSlice = Math.floor(ny / 2) * Math.floor(nx / 2);
  const slicesUsed = Math.ceil(nz / zStep);
  const totalPairs = Math.max(1, pairsPerSlice * slicesUsed);
  const stride2d = Math.max(1, Math.ceil(Math.sqrt(totalPairs / maxSamples)));
  const hh = [];
  for (let z = 0; z < nz; z += zStep) {
    const base = z * planeSize;
    for (let y = 0; y < ny - 1; y += 2 * stride2d) {
      const row0 = base + y * nx;
      const row1 = row0 + nx;
      for (let x = 0; x < nx - 1; x += 2 * stride2d) {
        const detail = 0.5 * (data[row0 + x] - data[row0 + x + 1] - data[row1 + x] + data[row1 + x + 1]);
        if (Number.isFinite(detail)) hh.push(Math.abs(detail));
      }
    }
  }
  if (!hh.length) return 0;
  hh.sort((a, b) => a - b);
  const mid = hh.length >>> 1;
  const med = hh.length % 2 === 1 ? hh[mid] : 0.5 * (hh[mid - 1] + hh[mid]);
  return med / MAD_TO_SIGMA;
}

/**
 * Estimates Poisson-Gaussian noise parameters `Var(y) ≈ alpha * max(mu - offset, 0) + sigma^2`
 * on smooth blocks only:
 * 1. Filters out high-gradient/textured 2x2 blocks using horizontal/vertical Haar energy so
 *    deterministic fine structures (such as edges or checkerboards) do not masquerade as shot noise.
 * 2. Bins smooth blocks by local mean, computes robust MAD^2 variance per bin, and requires a
 *    statistically supported positive correlation (t-statistic > 3.5) and meaningful dynamic-range
 *    variance growth before activating Poisson-Gaussian mode; otherwise falls back cleanly to Gaussian.
 *
 * @param {Float32Array | Float64Array} data
 * @param {[number, number, number]} dims
 */
export function estimatePoissonGaussian(data, dims) {
  const [nz, ny, nx] = dims;
  const globalSigma = estimateNoiseSigma(data, dims);
  if (ny < 8 || nx < 8 || globalSigma <= 1e-8) {
    return { alpha: 0, sigma: globalSigma, offset: 0, isPoisson: false };
  }
  const planeSize = ny * nx;
  const zStep = Math.max(1, Math.ceil(nz / 16));
  const yStep = Math.max(2, 2 * Math.ceil(Math.sqrt((nz * ny * nx) / (4 * 120000))));
  const xStep = yStep;

  // Collect (mean, |HH|, smoothnessEnergy) on non-overlapping 2x2 blocks, checking a 4x4 window
  // around each block to reject structured textures and sharp edges.
  const means = [];
  const details = [];
  const gradEnergies = [];
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (let z = 0; z < nz; z += zStep) {
    const base = z * planeSize;
    for (let y = 1; y < ny - 2; y += yStep) {
      const rPrev = base + (y - 1) * nx;
      const r0 = base + y * nx;
      const r1 = r0 + nx;
      const rNext = r1 + nx;
      for (let x = 1; x < nx - 2; x += xStep) {
        const a = data[r0 + x];
        const b = data[r0 + x + 1];
        const c = data[r1 + x];
        const d = data[r1 + x + 1];
        if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) continue;
        const mean = 0.25 * (a + b + c + d);
        const hh = 0.5 * (a - b - c + d);
        // Compare outer 2x2 block averages (above/below/left/right) to reject step edges and grids.
        const mUp = 0.5 * (data[rPrev + x] + data[rPrev + x + 1]);
        const mDn = 0.5 * (data[rNext + x] + data[rNext + x + 1]);
        const mLt = 0.5 * (data[r0 + x - 1] + data[r1 + x - 1]);
        const mRt = 0.5 * (data[r0 + x + 2] + data[r1 + x + 2]);
        const grad = Math.abs(mUp - mDn) + Math.abs(mLt - mRt);
        // Reject deterministic alternating patterns where |a - b|, |a - c| match |hh| uniformly
        // while outer smoothness is zero (e.g. a noiseless checkerboard has constant |hh| > 0 and
        // zero variance of |hh| inside its bin — handled below via MAD dispersion check too).
        if (mean < minVal) minVal = mean;
        if (mean > maxVal) maxVal = mean;
        means.push(mean);
        details.push(Math.abs(hh));
        gradEnergies.push(grad);
      }
    }
  }

  const totalBlocks = means.length;
  if (totalBlocks < 240 || maxVal - minVal <= 1e-6) {
    return { alpha: 0, sigma: globalSigma, offset: minVal < 0 ? minVal : 0, isPoisson: false };
  }

  // Keep only the smoothest 60% of blocks (low outer local gradient).
  const gradSorted = Float64Array.from(gradEnergies).sort();
  const gradCutoff = gradSorted[Math.floor(totalBlocks * 0.6)];
  const kept = [];
  for (let i = 0; i < totalBlocks; i += 1) {
    if (gradEnergies[i] <= gradCutoff) kept.push(i);
  }
  if (kept.length < 160) {
    return { alpha: 0, sigma: globalSigma, offset: minVal < 0 ? minVal : 0, isPoisson: false };
  }

  kept.sort((i, j) => means[i] - means[j]);

  // Require meaningful intensity span across smooth blocks.
  const numBins = 12;
  const binMeans = [];
  const binVars = [];
  const binSize = Math.floor(kept.length / numBins);
  for (let b = 0; b < numBins; b += 1) {
    const start = b * binSize;
    const end = b === numBins - 1 ? kept.length : (b + 1) * binSize;
    const n = end - start;
    if (n < 16) continue;
    const absDetails = new Float64Array(n);
    let sumMean = 0;
    for (let k = start; k < end; k += 1) {
      const idx = kept[k];
      sumMean += means[idx];
      absDetails[k - start] = details[idx];
    }
    absDetails.sort();
    const med = n % 2 === 1 ? absDetails[n >>> 1] : 0.5 * (absDetails[(n >>> 1) - 1] + absDetails[n >>> 1]);
    // For genuine Gaussian/Poisson-Gaussian noise, |HH| follows a half-normal distribution whose
    // IQR / median ratio is ~1.15; deterministic periodic textures (e.g. a noise-free checkerboard)
    // have collapsed dispersion (IQR / median ~ 0). Reject degenerate deterministic bins.
    const q25 = absDetails[Math.floor(0.25 * n)];
    const q75 = absDetails[Math.floor(0.75 * n)];
    if (med > 1e-9 && (q75 - q25) < 0.25 * med) continue;

    const binSigma = med / MAD_TO_SIGMA;
    binMeans.push(sumMean / n);
    binVars.push(binSigma * binSigma);
  }

  const m = binMeans.length;
  if (m < 6) {
    return { alpha: 0, sigma: globalSigma, offset: 0, isPoisson: false };
  }

  // Pearson correlation and Student-t test on bin (mean, variance) to prevent false positives
  // on flat homoscedastic Gaussian images.
  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < m; i += 1) {
    meanX += binMeans[i];
    meanY += binVars[i];
  }
  meanX /= m;
  meanY /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < m; i += 1) {
    const dx = binMeans[i] - meanX;
    const dy = binVars[i] - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (!(sxx > 1e-12 && syy > 1e-12)) {
    return { alpha: 0, sigma: globalSigma, offset: 0, isPoisson: false };
  }
  const r = sxy / Math.sqrt(sxx * syy);
  const tStat = r >= 0.9999 ? Infinity : (r * Math.sqrt(m - 2)) / Math.sqrt(Math.max(1e-12, 1 - r * r));
  if (!(r > 0.7 && tStat > 3.5)) {
    return { alpha: 0, sigma: globalSigma, offset: 0, isPoisson: false };
  }

  // Theil-Sen median slope for robustness against residual bright edge bins.
  const slopes = [];
  for (let i = 0; i < m; i += 1) {
    for (let j = i + 1; j < m; j += 1) {
      const dx = binMeans[j] - binMeans[i];
      if (dx > 1e-6) slopes.push((binVars[j] - binVars[i]) / dx);
    }
  }
  slopes.sort((a, b) => a - b);
  const slope = slopes.length ? slopes[slopes.length >>> 1] : 0;
  const intercepts = binMeans.map((mu, i) => binVars[i] - slope * mu);
  intercepts.sort((a, b) => a - b);
  const intercept = intercepts[intercepts.length >>> 1];

  const dynamicRange = binMeans[m - 1] - binMeans[0];
  const baseVar = Math.max(1e-12, binVars[0]);
  if (!(slope > 1e-6 && slope * dynamicRange > 0.3 * baseVar)) {
    return { alpha: 0, sigma: globalSigma, offset: 0, isPoisson: false };
  }

  const offset = minVal < 0 ? minVal : 0;
  const sigmaSq = Math.max(0, intercept + slope * offset);
  return {
    alpha: slope,
    sigma: Math.sqrt(sigmaSq),
    offset,
    isPoisson: true,
  };
}

/**
 * Computes image summary statistics (`mean`, `std`, `min`, `max`).
 * @param {Float32Array | Float64Array} data
 */
export function imageStats(data) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count += 1;
  }
  if (!count) return { mean: 0, std: 0, min: 0, max: 0 };
  const mean = sum / count;
  let sq = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    if (!Number.isFinite(v)) continue;
    const d = v - mean;
    sq += d * d;
  }
  return { mean, std: Math.sqrt(sq / count), min, max };
}

/**
 * Computes post-denoising residual quality diagnostics:
 * - `residual`: Float32Array `input - denoised`
 * - `inputNoiseSigma`, `denoisedNoiseSigma`: robust Haar MAD noise estimates
 * - `residualMean`, `residualStd`: residual bias and amplitude
 * - `residualAutocorrX`, `residualAutocorrY`, `residualAutocorrZ`: per-axis lag-1 autocorrelation
 * - `residualMaxAbsAutocorr`: max |autocorr| across all non-singleton axes (catches alternating
 *   stripes where X and Y correlations have opposite signs)
 * - `noiseFloorDropDb`: estimated Haar noise-floor reduction in dB
 * - `structureWarning`: true when `residualMaxAbsAutocorr > 0.35`
 * @param {Float32Array} input
 * @param {Float32Array} denoised
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 */
export function residualDiagnostics(input, denoised, dims) {
  const n = input.length;
  const residual = new Float32Array(n);
  let sum = 0;
  let finiteCount = 0;
  for (let i = 0; i < n; i += 1) {
    const r = input[i] - denoised[i];
    residual[i] = r;
    if (Number.isFinite(r)) {
      sum += r;
      finiteCount += 1;
    }
  }
  const residualMean = finiteCount ? sum / finiteCount : 0;
  let varSum = 0;
  for (let i = 0; i < n; i += 1) {
    const r = residual[i];
    if (!Number.isFinite(r)) continue;
    const d = r - residualMean;
    varSum += d * d;
  }
  const residualVar = finiteCount ? varSum / finiteCount : 0;
  const residualStd = Math.sqrt(residualVar);

  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  let covX = 0;
  let countX = 0;
  let covY = 0;
  let countY = 0;
  let covZ = 0;
  let countZ = 0;

  if (residualVar > 1e-12) {
    for (let z = 0; z < nz; z += 1) {
      const base = z * plane;
      for (let y = 0; y < ny; y += 1) {
        const row = base + y * nx;
        for (let x = 0; x < nx - 1; x += 1) {
          const a = residual[row + x];
          const b = residual[row + x + 1];
          if (Number.isFinite(a) && Number.isFinite(b)) {
            covX += (a - residualMean) * (b - residualMean);
            countX += 1;
          }
        }
      }
      for (let y = 0; y < ny - 1; y += 1) {
        const row0 = base + y * nx;
        const row1 = row0 + nx;
        for (let x = 0; x < nx; x += 1) {
          const a = residual[row0 + x];
          const b = residual[row1 + x];
          if (Number.isFinite(a) && Number.isFinite(b)) {
            covY += (a - residualMean) * (b - residualMean);
            countY += 1;
          }
        }
      }
    }
    if (nz > 1) {
      for (let z = 0; z < nz - 1; z += 1) {
        const base0 = z * plane;
        const base1 = base0 + plane;
        for (let p = 0; p < plane; p += 1) {
          const a = residual[base0 + p];
          const b = residual[base1 + p];
          if (Number.isFinite(a) && Number.isFinite(b)) {
            covZ += (a - residualMean) * (b - residualMean);
            countZ += 1;
          }
        }
      }
    }
  }

  const residualAutocorrX = countX > 0 && residualVar > 1e-12 ? covX / (countX * residualVar) : 0;
  const residualAutocorrY = countY > 0 && residualVar > 1e-12 ? covY / (countY * residualVar) : 0;
  const residualAutocorrZ = countZ > 0 && residualVar > 1e-12 ? covZ / (countZ * residualVar) : null;

  const axisMagnitudes = [];
  if (countX > 0) axisMagnitudes.push(Math.abs(residualAutocorrX));
  if (countY > 0) axisMagnitudes.push(Math.abs(residualAutocorrY));
  if (countZ > 0) axisMagnitudes.push(Math.abs(residualAutocorrZ));
  const residualMaxAbsAutocorr = axisMagnitudes.length ? Math.max(...axisMagnitudes) : 0;

  const inputNoiseSigma = estimateNoiseSigma(input, dims);
  const denoisedNoiseSigma = estimateNoiseSigma(denoised, dims);
  const noiseFloorDropDb = inputNoiseSigma > 1e-12
    ? 20 * Math.log10(inputNoiseSigma / Math.max(denoisedNoiseSigma, inputNoiseSigma * 1e-4))
    : 0;

  return {
    residual,
    inputNoiseSigma,
    denoisedNoiseSigma,
    residualMean,
    residualStd,
    residualAutocorrX,
    residualAutocorrY,
    residualAutocorrZ,
    residualMaxAbsAutocorr,
    noiseFloorDropDb,
    structureWarning: residualMaxAbsAutocorr > 0.35,
  };
}
