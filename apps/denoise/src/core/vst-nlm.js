// Variance-Stabilized Non-Local Means (Anscombe VST + Fast Integral-Image NLM):
// - Smooth-region Poisson-Gaussian noise estimation (Foi et al., IEEE TIP 2008)
// - Forward Generalized Anscombe Transform & continuous, monotone unbiased inverse
//   (Makitalo & Foi, IEEE TIP 2011 / 2013, Eq. 21)
// - O(N)-per-offset integral-image Non-Local Means (Buades et al. 2005; Darbon et al. 2008)
//   with strict in-bounds candidate centers and independent mirror-padded patch comparisons.

import { mirrorIndex } from "./features.js";
import { estimateNoiseSigma, estimatePoissonGaussian } from "./metrics.js";

const SQRT_3_OVER_2 = Math.sqrt(1.5);

/**
 * Forward Generalized Anscombe Transform: stabilizes `Var(y) = alpha * max(x - offset, 0) + sigma^2`
 * to approximately unit variance.
 */
export function forwardGat(value, alpha, sigma, offset = 0) {
  const shifted = value - offset;
  const inner = alpha * shifted + 0.375 * alpha * alpha + sigma * sigma;
  return inner > 0 ? (2 / alpha) * Math.sqrt(inner) : 0;
}

/**
 * Evaluates the raw Makitalo & Foi (2013, Eq. 21) asymptotic unbiased inverse in standardized
 * units (`alpha = 1`, `sigmaStd = sigma / alpha`) for `t > 0`.
 */
function rawStandardizedInverse(t, sigmaStdSq) {
  const invT = 1 / t;
  const invT2 = invT * invT;
  const invT3 = invT2 * invT;
  return 0.25 * t * t
    + 0.25 * SQRT_3_OVER_2 * invT
    - 1.375 * invT2
    + 0.625 * SQRT_3_OVER_2 * invT3
    - 0.125
    - sigmaStdSq;
}

/**
 * Computes the transition parameters for the continuous, monotone, nonnegative closed-form
 * unbiased inverse Generalized Anscombe Transform (Makitalo & Foi, IEEE TIP 2013, Eq. 21):
 * - When `rawStandardizedInverse` crosses zero on its monotone asymptotic branch (`t >= 1.75`),
 *   bisects the exact root `tZero` (`ramp: false`).
 * - In the low-readout-noise pure-Poisson regime where Eq. 21 stays positive at `t = 1.75`,
 *   joins `0` at `tLow = 2 * sqrt(3/8 + sigmaStd^2)` to Eq. 21 at `tMatch = 2.2` with a continuous
 *   monotone quadratic ramp (`ramp: true`) so there is never a dark-intensity jump.
 */
export function gatInverseZeroRoot(alpha, sigma) {
  const sigmaStd = sigma / alpha;
  const sigmaStdSq = sigmaStd * sigmaStd;
  const tBranch = 1.75;
  if (rawStandardizedInverse(tBranch, sigmaStdSq) > 0) {
    const tLow = 2 * Math.sqrt(0.375 + sigmaStdSq);
    const tMatch = Math.max(2.2, tLow + 0.5);
    return { tZero: tLow, tMatch, matchVal: rawStandardizedInverse(tMatch, sigmaStdSq), ramp: true };
  }
  let lo = tBranch;
  let hi = Math.max(4.0, 2 * Math.sqrt(1 + sigmaStdSq) + 2);
  while (rawStandardizedInverse(hi, sigmaStdSq) < 0) hi *= 2;
  for (let i = 0; i < 40; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (rawStandardizedInverse(mid, sigmaStdSq) < 0) lo = mid;
    else hi = mid;
  }
  return { tZero: hi, tMatch: hi, matchVal: 0, ramp: false };
}

/**
 * Continuous, monotone, nonnegative closed-form approximation to the unbiased inverse
 * Generalized Anscombe Transform (Makitalo & Foi, IEEE TIP 2013, Eq. 21, with a continuous
 * low-count quadratic ramp below the asymptotic branch). Pass a precomputed `invSpec`
 * from `gatInverseZeroRoot` when mapping many voxels.
 */
export function inverseGat(t, alpha, sigma, offset = 0, invSpec = gatInverseZeroRoot(alpha, sigma)) {
  if (!(t > invSpec.tZero)) return offset;
  if (invSpec.ramp && t < invSpec.tMatch) {
    const u = (t - invSpec.tZero) / (invSpec.tMatch - invSpec.tZero);
    return alpha * invSpec.matchVal * u * u + offset;
  }
  const sigmaStd = sigma / alpha;
  const z = rawStandardizedInverse(t, sigmaStd * sigmaStd);
  return (z > 0 ? alpha * z : 0) + offset;
}

/**
 * Mirror-pads a `[ny, nx]` slice by `r` pixels on every side into a `[(ny + 2r), (nx + 2r)]` buffer.
 */
function mirrorPadSlice(slice, ny, nx, r) {
  const py = ny + 2 * r;
  const px = nx + 2 * r;
  const padded = new Float32Array(py * px);
  for (let y = 0; y < py; y += 1) {
    const sy = mirrorIndex(y - r, ny);
    const srcRow = sy * nx;
    const dstRow = y * px;
    for (let x = 0; x < px; x += 1) {
      const sx = mirrorIndex(x - r, nx);
      padded[dstRow + x] = slice[srcRow + sx];
    }
  }
  return padded;
}

/**
 * Computes exact `(2r+1) x (2r+1)` box averages over valid interior rows `[r .. h - r - 1]`
 * and cols `[r .. w - r - 1]` of a padded `[h, w]` array, writing into `dst` (`[h - 2r, w - 2r]`).
 */
function validBoxAverage2d(src, h, w, r, tmp, dst) {
  const diam = 2 * r + 1;
  const outH = h - 2 * r;
  const outW = w - 2 * r;
  // Horizontal sliding sum: [h, outW]
  for (let y = 0; y < h; y += 1) {
    const sRow = y * w;
    const tRow = y * outW;
    let sum = 0;
    for (let x = 0; x < diam; x += 1) sum += src[sRow + x];
    tmp[tRow] = sum / diam;
    for (let x = 1; x < outW; x += 1) {
      sum += src[sRow + x + diam - 1] - src[sRow + x - 1];
      tmp[tRow + x] = sum / diam;
    }
  }
  // Vertical sliding sum: [outH, outW]
  for (let x = 0; x < outW; x += 1) {
    let sum = 0;
    for (let y = 0; y < diam; y += 1) sum += tmp[y * outW + x];
    dst[x] = sum / diam;
    for (let y = 1; y < outH; y += 1) {
      sum += tmp[(y + diam - 1) * outW + x] - tmp[(y - 1) * outW + x];
      dst[y * outW + x] = sum / diam;
    }
  }
}

/**
 * Runs Variance-Stabilized (or Gaussian) Fast Integral-Image Non-Local Means on a 2D or 3D
 * `[nz, ny, nx]` Float32 volume.
 *
 * Candidate neighbour centres `(z + dz, y + dy, x + dx)` are restricted strictly to in-bounds
 * voxels so boundary pixels are never duplicated and the centre voxel is never included before
 * its explicit maximum-neighbour self-weight. Both patches are mirror-padded independently before
 * computing the O(N) sliding-sum patch distance.
 *
 * @param {Float32Array} data
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @param {{
 *   noiseModel?: 'poisson-gaussian' | 'gaussian',
 *   use3d?: boolean,
 *   strength?: number,
 *   patchRadius?: number,
 *   searchRadius?: number,
 *   onProgress?: (fraction: number, stage: string) => void
 * }} [options]
 */
export function denoiseVstNlm(data, dims, options = {}) {
  const {
    noiseModel = "poisson-gaussian",
    use3d = dims[0] > 1,
    strength = 1.0,
    patchRadius = 2,
    searchRadius = 5,
    onProgress,
  } = options;

  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const effective3d = Boolean(use3d && nz > 1);

  onProgress?.(0.02, "Estimating noise model…");
  let working;
  let sigma;
  let gatParams = null;

  if (noiseModel === "poisson-gaussian") {
    const pg = estimatePoissonGaussian(data, dims);
    if (pg.isPoisson && pg.alpha > 1e-8) {
      gatParams = pg;
      working = new Float32Array(data.length);
      for (let i = 0; i < data.length; i += 1) {
        working[i] = forwardGat(data[i], pg.alpha, pg.sigma, pg.offset);
      }
      const estPost = estimateNoiseSigma(working, dims);
      sigma = estPost > 0.25 && estPost < 4 ? estPost : 1.0;
    } else {
      working = Float32Array.from(data);
      sigma = pg.sigma;
    }
  } else {
    working = Float32Array.from(data);
    sigma = estimateNoiseSigma(data, dims);
  }

  if (!(sigma > 1e-9)) {
    onProgress?.(1, "Zero estimated noise — returned unchanged");
    return {
      denoised: Float32Array.from(data),
      details: {
        noiseModel: gatParams ? "poisson-gaussian" : "gaussian",
        use3d: effective3d,
        estimatedSigma: 0,
        poissonGain: gatParams ? gatParams.alpha : 0,
      },
    };
  }

  const h = Math.max(1e-6, strength * sigma);
  const invH2 = 1 / (h * h);
  const twoSigma2 = 2 * sigma * sigma;

  const r = patchRadius;
  const py = ny + 2 * r;
  const px = nx + 2 * r;
  const paddedSlices = new Array(nz);
  for (let z = 0; z < nz; z += 1) {
    paddedSlices[z] = mirrorPadSlice(working.subarray(z * plane, (z + 1) * plane), ny, nx, r);
  }

  const dzRange = effective3d ? [-1, 0, 1] : [0];
  const offsets = [];
  for (const dz of dzRange) {
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
      for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
        if (dz === 0 && dy === 0 && dx === 0) continue;
        if (Math.abs(dy) >= ny || Math.abs(dx) >= nx) continue;
        offsets.push([dz, dy, dx]);
      }
    }
  }

  const outWorking = new Float32Array(data.length);
  const sqDiff = new Float32Array(py * px);
  const boxTmp = new Float32Array(py * nx);
  const patchDist = new Float32Array(plane);
  const num = new Float64Array(plane);
  const den = new Float64Array(plane);
  const maxW = new Float64Array(plane);

  for (let z = 0; z < nz; z += 1) {
    const srcSlice = working.subarray(z * plane, (z + 1) * plane);
    const padA = paddedSlices[z];
    num.fill(0);
    den.fill(0);
    maxW.fill(0);

    for (let oi = 0; oi < offsets.length; oi += 1) {
      const [dz, dy, dx] = offsets[oi];
      const nzIdx = z + dz;
      if (nzIdx < 0 || nzIdx >= nz) continue;
      const nbSlice = working.subarray(nzIdx * plane, (nzIdx + 1) * plane);
      const padB = paddedSlices[nzIdx];

      // Valid in-bounds centre coordinates y in [y0..y1], x in [x0..x1].
      const y0 = dy < 0 ? -dy : 0;
      const y1 = dy > 0 ? ny - 1 - dy : ny - 1;
      const x0 = dx < 0 ? -dx : 0;
      const x1 = dx > 0 ? nx - 1 - dx : nx - 1;
      if (y0 > y1 || x0 > x1) continue;

      const subH = y1 - y0 + 1;
      const subW = x1 - x0 + 1;
      const padSubH = subH + 2 * r;
      const padSubW = subW + 2 * r;

      // Compute pixelwise squared differences between independently mirror-padded patches
      // around valid centre pairs (y, x) and (y + dy, x + dx).
      for (let ry = 0; ry < padSubH; ry += 1) {
        const aRow = (y0 + ry) * px + x0;
        const bRow = (y0 + dy + ry) * px + (x0 + dx);
        const dRow = ry * padSubW;
        for (let rx = 0; rx < padSubW; rx += 1) {
          const diff = padA[aRow + rx] - padB[bRow + rx];
          sqDiff[dRow + rx] = diff * diff;
        }
      }

      validBoxAverage2d(sqDiff, padSubH, padSubW, r, boxTmp, patchDist);

      for (let ly = 0; ly < subH; ly += 1) {
        const y = y0 + ly;
        const sy = y + dy;
        const rowA = y * nx;
        const rowB = sy * nx;
        const dRow = ly * subW;
        for (let lx = 0; lx < subW; lx += 1) {
          const x = x0 + lx;
          const sx = x + dx;
          const p = rowA + x;
          const d = patchDist[dRow + lx] - twoSigma2;
          const w = d <= 0 ? 1 : Math.exp(-d * invH2);
          if (w > maxW[p]) maxW[p] = w;
          num[p] += w * nbSlice[rowB + sx];
          den[p] += w;
        }
      }
    }

    // Centre pixel receives actual maximum positive neighbour weight (Buades et al. 2005).
    const outBase = z * plane;
    for (let p = 0; p < plane; p += 1) {
      const wSelf = maxW[p] > 0 ? maxW[p] : 1;
      outWorking[outBase + p] = (num[p] + wSelf * srcSlice[p]) / (den[p] + wSelf);
    }

    onProgress?.(0.05 + 0.9 * ((z + 1) / nz), `Filtering slice ${z + 1} of ${nz}…`);
  }

  let denoised;
  if (gatParams) {
    const tZero = gatInverseZeroRoot(gatParams.alpha, gatParams.sigma);
    denoised = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
      denoised[i] = inverseGat(outWorking[i], gatParams.alpha, gatParams.sigma, gatParams.offset, tZero);
    }
  } else {
    denoised = outWorking;
  }

  onProgress?.(1, "Done");
  return {
    denoised,
    details: {
      noiseModel: gatParams ? "poisson-gaussian" : "gaussian",
      use3d: effective3d,
      estimatedSigma: Number(sigma.toPrecision(4)),
      poissonGain: gatParams ? Number(gatParams.alpha.toPrecision(4)) : 0,
      readoutSigma: gatParams ? Number(gatParams.sigma.toPrecision(4)) : Number(sigma.toPrecision(4)),
      strength,
      patchRadius,
      searchRadius,
    },
  };
}
