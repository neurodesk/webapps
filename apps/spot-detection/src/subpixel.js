// Sub-pixel spot localisation: Big-FISH 0.6.2 detection.fit_subpixel (BSD-3-Clause,
// see ../LICENSE and ../NOTICE). Each spot's neighbourhood is fitted with Big-FISH's
// pixel-integrated Gaussian (gaussian_3d / gaussian_2d) from the same start point
// and with the same bounds, and the same rules keep or reject the fitted centre.
// Big-FISH calls SciPy's trust-region-reflective curve_fit on a float32 model with
// a finite-difference Jacobian; this port fits the float64 model with its analytic
// Jacobian by Levenberg-Marquardt (README.md, "Divergences from Big-FISH").

// erf translated from FreeBSD msun lib/msun/src/s_erf.c (fdlibm), whose notice follows:
/*
 * ====================================================
 * Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
 *
 * Developed at SunPro, a Sun Microsystems, Inc. business.
 * Permission to use, copy, modify, and distribute this
 * software is freely granted, provided that this notice
 * is preserved.
 * ====================================================
 */
const ERX = 8.45062911510467529297e-01;
const EFX = 1.28379167095512586316e-01;
const PP = [1.28379167095512558561e-01, -3.25042107247001499370e-01, -2.84817495755985104766e-02, -5.77027029648944159157e-03, -2.37630166566501626084e-05];
const QQ = [3.97917223959155352819e-01, 6.50222499887672944485e-02, 5.08130628187576562776e-03, 1.32494738004321644526e-04, -3.96022827877536812320e-06];
const PA = [-2.36211856075265944077e-03, 4.14856118683748331666e-01, -3.72207876035701323847e-01, 3.18346619901161753674e-01, -1.10894694282396677476e-01, 3.54783043256182359371e-02, -2.16637559486879084300e-03];
const QA = [1.06420880400844228286e-01, 5.40397917702171048937e-01, 7.18286544141962662868e-02, 1.26171219808761642112e-01, 1.36370839120290507362e-02, 1.19844998467991074170e-02];
const RA = [-9.86494403484714822705e-03, -6.93858572707181764372e-01, -1.05586262253232909814e01, -6.23753324503260060396e01, -1.62396669462573470355e02, -1.84605092906711035994e02, -8.12874355063065934246e01, -9.81432934416914548592e00];
const SA = [1.96512716674392571292e01, 1.37657754143519042600e02, 4.34565877475229228821e02, 6.45387271733267880336e02, 4.29008140027567833386e02, 1.08635005541779435134e02, 6.57024977031928170135e00, -6.04244152148580987438e-02];
const RB = [-9.86494292470009928597e-03, -7.99283237680523006574e-01, -1.77579549177547519889e01, -1.60636384855821916062e02, -6.37566443368389627722e02, -1.02509513161107724954e03, -4.83519191608651397019e02];
const SB = [3.03380607434824582924e01, 3.25792512996573918826e02, 1.53672958608443695994e03, 3.19985821950859553908e03, 2.55305040643316442583e03, 4.74528541206955367215e02, -2.24409524465858183362e01];

const poly = (c, x) => c.reduceRight((acc, v) => acc * x + v, 0);

export function erf(x) {
  if (Number.isNaN(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (ax < 0.84375) {
    if (ax < 2 ** -28) return x + EFX * x;
    const z = x * x;
    const r = poly(PP, z);
    const s = 1 + z * poly(QQ, z);
    return x + x * (r / s);
  }
  if (ax < 1.25) {
    const s = ax - 1;
    const p = poly(PA, s);
    const q = 1 + s * poly(QA, s);
    return sign * (ERX + p / q);
  }
  if (ax >= 6) return sign * (1 - 1e-300);
  const s = 1 / (ax * ax);
  let r;
  let q;
  if (ax < 1 / 0.35) {
    r = poly(RA, s);
    q = 1 + s * poly(SA, s);
  } else {
    r = poly(RB, s);
    q = 1 + s * poly(SB, s);
  }
  // Split ax so exp(-z*z) is formed without cancellation, as fdlibm does.
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, ax);
  buffer.setUint32(4, 0);
  const z = buffer.getFloat64(0);
  const value = Math.exp(-z * z - 0.5625) * Math.exp((z - ax) * (z + ax) + r / q);
  return sign * (1 - value / ax);
}

const SQRT2 = Math.SQRT2;
const SQRT_PI_2 = Math.sqrt(Math.PI / 2);

// _rescaled_erf and its derivatives with respect to mu and sigma, for one axis.
function axisIntegral(position, half, mu, sigma) {
  const scale = SQRT2 * sigma;
  const low = (position - half - mu) / scale;
  const high = (position + half - mu) / scale;
  const value = sigma * SQRT_PI_2 * (erf(high) - erf(low));
  const gHigh = Math.exp(-high * high);
  const gLow = Math.exp(-low * low);
  return {
    value,
    dMu: -(gHigh - gLow),
    dSigma: value / sigma - SQRT2 * (high * gHigh - low * gLow),
  };
}

// Big-FISH gaussian_3d / gaussian_2d with every parameter free
// (3D: mu_z, mu_y, mu_x, sigma_z, sigma_yx, amplitude, background;
//  2D: mu_y, mu_x, sigma_yx, amplitude, background), with the Jacobian, on the
// crop's grid (Big-FISH initialize_grid: float32 index × voxel size, C order).
export function gaussianModel(params, size, voxelSize) {
  const ndim = voxelSize.length;
  const sigmas = ndim === 3 ? [params[3], params[4], params[4]] : [params[2], params[2]];
  const amplitude = params[params.length - 2];
  const background = params[params.length - 1];
  const volume = ndim === 3 ? voxelSize[2] ** 2 * voxelSize[0] : voxelSize[1] ** 2;
  const factor = amplitude / volume;
  // The model is separable: one table of integrals and derivatives per axis.
  const axes = size.map((n, a) => Array.from({ length: n }, (_, i) => axisIntegral(Math.fround(i * voxelSize[a]), voxelSize[a] / 2, params[a], sigmas[a])));
  const count = size.reduce((p, n) => p * n, 1);
  const values = new Float64Array(count);
  const jacobian = Array.from({ length: params.length }, () => new Float64Array(count));
  const index = new Array(ndim).fill(0);
  for (let i = 0; i < count; i++) {
    const parts = index.map((v, a) => axes[a][v]);
    const product = parts.reduce((p, part) => p * part.value, 1);
    const others = (skip) => parts.reduce((p, part, a) => (a === skip ? p : p * part.value), 1);
    values[i] = background + factor * product;
    for (let a = 0; a < ndim; a++) jacobian[a][i] = factor * parts[a].dMu * others(a);
    const yx = ndim - 2;
    if (ndim === 3) jacobian[3][i] = factor * parts[0].dSigma * others(0);
    jacobian[ndim === 3 ? 4 : 2][i] = factor * (parts[yx].dSigma * parts[yx + 1].value + parts[yx].value * parts[yx + 1].dSigma) * (ndim === 3 ? parts[0].value : 1);
    jacobian[params.length - 2][i] = product / volume;
    jacobian[params.length - 1][i] = 1;
    for (let a = ndim - 1; a >= 0; a--) {
      if (++index[a] < size[a]) break;
      index[a] = 0;
    }
  }
  return { values, jacobian };
}

// Solve the symmetric positive system A x = b (Cholesky); null when not positive definite.
function solve(A, b) {
  const n = b.length;
  const L = A.map((row) => row.slice());
  for (let j = 0; j < n; j++) {
    let d = L[j][j];
    for (let k = 0; k < j; k++) d -= L[j][k] * L[j][k];
    if (!(d > 0)) return null;
    L[j][j] = Math.sqrt(d);
    for (let i = j + 1; i < n; i++) {
      let s = L[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = s / L[j][j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function cost(values, data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (values[i] - data[i]) ** 2;
  return sum / 2;
}

// Levenberg-Marquardt with Marquardt's diagonal scaling; `lower` bounds are kept by
// projection. It stops on curve_fit's default tolerances (ftol = xtol = 1e-8) and,
// like curve_fit, gives up after 100 model evaluations per parameter: null then,
// and Big-FISH keeps the integer coordinate.
export function levenbergMarquardt(start, size, data, voxelSize, lower) {
  const m = start.length;
  const maxEvaluations = 100 * m;
  let params = start.slice();
  let model = gaussianModel(params, size, voxelSize);
  let evaluations = 1;
  let current = cost(model.values, data);
  let lambda = 1e-3;
  while (evaluations < maxEvaluations) {
    const A = Array.from({ length: m }, () => new Array(m).fill(0));
    const g = new Array(m).fill(0);
    for (let i = 0; i < data.length; i++) {
      const r = data[i] - model.values[i];
      for (let a = 0; a < m; a++) {
        const ja = model.jacobian[a][i];
        g[a] += ja * r;
        for (let b = 0; b <= a; b++) A[a][b] += ja * model.jacobian[b][i];
      }
    }
    for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) A[b][a] = A[a][b];
    let accepted = false;
    while (!accepted && evaluations < maxEvaluations) {
      const damped = A.map((row, a) => row.map((v, b) => (a === b ? v + lambda * (v || 1) : v)));
      const step = solve(damped, g);
      if (!step) {
        lambda *= 10;
        if (lambda > 1e20) return null;
        continue;
      }
      const trial = params.map((p, a) => Math.max(lower[a], p + step[a]));
      const trialModel = gaussianModel(trial, size, voxelSize);
      evaluations++;
      const trialCost = cost(trialModel.values, data);
      const stepNorm = Math.hypot(...trial.map((p, a) => p - params[a]));
      const norm = Math.hypot(...params);
      if (Number.isFinite(trialCost) && trialCost <= current) {
        const reduction = current - trialCost;
        params = trial;
        model = trialModel;
        lambda = Math.max(lambda / 10, 1e-15);
        accepted = true;
        if (reduction <= 1e-8 * current || stepNorm <= 1e-8 * (1e-8 + norm)) return params;
        current = trialCost;
      } else {
        if (stepNorm <= 1e-8 * (1e-8 + norm)) return params;
        lambda *= 10;
      }
    }
  }
  return null;
}

// detection.utils.get_spot_volume / get_spot_surface: the crop around a spot.
function crop(image, coord, radius) {
  const { shape } = image;
  const low = coord.map((c, a) => Math.max(0, Math.trunc(c - radius[a])));
  const high = coord.map((c, a) => Math.min(shape[a] - 1, Math.trunc(c + radius[a])));
  return { low, size: high.map((h, a) => h - low[a] + 1) };
}

// detection.fit_subpixel: sub-pixel (z, y, x) or (y, x) for each integer spot, in pixels.
// onProgress(fitted, total) follows the spots, at most once per percent.
export function fitSubpixel(image, spots, { voxelSize, spotRadius, onProgress = () => {} }) {
  const ndim = image.shape.length;
  const stride = image.shape.map((_, a) => image.shape.slice(a + 1).reduce((p, s) => p * s, 1));
  const radius = spotRadius.map((r, a) => Math.sqrt(ndim) * (r / voxelSize[a]));
  const voxel = ndim === 3 ? [voxelSize[0], voxelSize[2], voxelSize[2]] : [voxelSize[1], voxelSize[1]];
  const sigmaStart = ndim === 3 ? [spotRadius[0], spotRadius[2]] : [spotRadius[1]];
  const every = Math.max(1, Math.ceil(spots.length / 100));
  return spots.map((coord, spot) => {
    if (spot % every === 0) onProgress(spot, spots.length);
    const { low, size } = crop(image, coord, radius);
    const count = size.reduce((a, b) => a * b, 1);
    const data = new Float64Array(count);
    const index = new Array(ndim).fill(0);
    let min = Infinity;
    let max = -Infinity;
    let area = 0;
    const weighted = new Array(ndim).fill(0);
    for (let i = 0; i < count; i++) {
      const offset = index.reduce((s, v, a) => s + (low[a] + v) * stride[a], 0);
      const value = image.data[offset];
      data[i] = value;
      for (let a = 0; a < ndim; a++) {
        weighted[a] += value * Math.fround(index[a] * voxel[a]);
      }
      area += value;
      if (value < min) min = value;
      if (value > max) max = value;
      for (let a = ndim - 1; a >= 0; a--) {
        if (++index[a] < size[a]) break;
        index[a] = 0;
      }
    }
    const centroid = weighted.map((w) => w / area);
    const start = [...centroid, ...sigmaStart, max - min, min];
    const lower = start.map((_, a) => (a === start.length - 1 ? 0 : -Infinity));
    const fitted = area > 0 ? levenbergMarquardt(start, size, data, voxel, lower) : null;
    if (!fitted) return coord.slice();
    return coord.map((c, a) => {
      const position = fitted[a] / voxel[a];
      return position < 0 || position > size[a] ? c : position + low[a];
    });
  });
}
