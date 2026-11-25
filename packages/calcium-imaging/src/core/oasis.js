// AR(1) spike deconvolution, written from Friedrich, Zhou & Paninski (2017) PLoS Comput Biol
// 13:e1005423 ("Fast online deconvolution of calcium imaging data", OASIS). The OASIS
// reference implementation is GPL-3; it is used only to validate this one (validation/).
//
// Model: y_t = b + c_t + noise, c_t = g c_{t-1} + s_t, s_t ≥ 0 (c_0 = 0).
// oasisAR1 solves  min ½‖c − (y − b)‖² + λ Σ s_t  by the pool-adjacent-violators scheme of the
// paper's Algorithm 1. The L1 penalty is folded into the data, y′_t = y_t − λ(1 − g) for t < T
// and y′_T = y_T − λ, because Σ s_t = (1 − g) Σ_{t<T} c_t + c_T.
// constrainedOasisAR1 picks λ so that the residual meets the noise constraint ‖y − b − c‖² = σ²T.
import { fft1d } from '@neurodesk/webapp-components/fft';

/** Pool-based solution for fixed g and λ; `sMin` is the minimum spike size (0 for the L1 problem). */
export function oasisAR1(y, g, lambda = 0, sMin = 0) {
  const T = y.length;
  const v = new Float64Array(T);
  const w = new Float64Array(T);
  const start = new Int32Array(T);
  const length = new Int32Array(T);
  // g^k and g^{2k} up to T, so a merge costs no pow().
  const power = new Float64Array(T + 1);
  power[0] = 1;
  for (let k = 1; k <= T; k++) power[k] = power[k - 1] * g;
  let pools = 0;
  for (let t = 0; t < T; t++) {
    const target = y[t] - lambda * (t === T - 1 ? 1 : 1 - g);
    v[pools] = target;
    w[pools] = 1;
    start[pools] = t;
    length[pools] = 1;
    pools++;
    while (pools > 1) {
      const i = pools - 1;
      const decay = power[length[i - 1]];
      if (v[i] - decay * v[i - 1] >= sMin) break;
      const weight = decay * decay;
      v[i - 1] = (w[i - 1] * v[i - 1] + decay * w[i] * v[i]) / (w[i - 1] + weight * w[i]);
      w[i - 1] += weight * w[i];
      length[i - 1] += length[i];
      pools--;
    }
  }
  const c = new Float64Array(T);
  const s = new Float64Array(T);
  for (let i = 0; i < pools; i++) {
    const value = Math.max(0, v[i]);
    for (let k = 0; k < length[i]; k++) c[start[i] + k] = value * power[k];
    // Within a pool c decays exactly, so the only spike is at its start.
    const t = start[i];
    s[t] = t === 0 ? c[0] : c[t] - g * c[t - 1];
  }
  return { c, s };
}

function residual(y, c, b) {
  let sum = 0;
  for (let t = 0; t < y.length; t++) {
    const d = y[t] - b - c[t];
    sum += d * d;
  }
  return sum;
}

/**
 * The noise-constrained problem for fixed g and baseline b: the smallest λ ≥ 0 whose fit leaves
 * a residual of σ²T, found by bisection (the residual grows with λ).
 */
export function constrainedOasisAR1(y, g, sn, { baseline = 0, tolerance = 1e-9 } = {}) {
  const T = y.length;
  const target = sn * sn * T;
  const shifted = Float64Array.from(y, (value) => value - baseline);
  let fit = oasisAR1(shifted, g, 0);
  if (residual(y, fit.c, baseline) >= target) return { ...fit, lambda: 0 };
  let low = 0;
  let high = 1;
  for (let i = 0; i < 200; i++) {
    fit = oasisAR1(shifted, g, high);
    if (residual(y, fit.c, baseline) >= target) break;
    low = high;
    high *= 2;
  }
  for (let i = 0; i < 200 && high - low > tolerance * Math.max(1, high); i++) {
    const middle = (low + high) / 2;
    const r = residual(y, oasisAR1(shifted, g, middle).c, baseline);
    if (r < target) low = middle;
    else high = middle;
  }
  return { ...oasisAR1(shifted, g, high), lambda: high };
}

/**
 * Noise standard deviation from the high-frequency power spectral density (Pnevmatikakis et al.
 * 2016 Neuron 89:285): Welch's estimate (Hann window, 256-sample segments, half overlap, mean
 * removed per segment), then σ = √exp(mean log(P(f)/2)) over 0.25 < f < 0.5 cycles per sample.
 */
export function noiseLevel(y) {
  const T = y.length;
  const n = Math.min(256, T);
  const overlap = Math.floor(n / 2);
  const step = n - overlap;
  const segments = Math.floor((T - overlap) / step);
  const window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  let windowPower = 0;
  for (const value of window) windowPower += value * value;
  const bins = Math.floor(n / 2) + 1;
  const power = new Float64Array(bins);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let segment = 0; segment < segments; segment++) {
    const offset = segment * step;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += y[offset + i];
    mean /= n;
    for (let i = 0; i < n; i++) {
      re[i] = (y[offset + i] - mean) * window[i];
      im[i] = 0;
    }
    fft1d(re, im);
    for (let k = 0; k < bins; k++) {
      const one = (re[k] * re[k] + im[k] * im[k]) / windowPower;
      power[k] += k === 0 || (n % 2 === 0 && k === n / 2) ? one : 2 * one;
    }
  }
  let sum = 0;
  let count = 0;
  for (let k = 0; k < bins; k++) {
    const f = k / n;
    if (f > 0.25 && f < 0.5) {
      sum += Math.log(power[k] / segments / 2);
      count++;
    }
  }
  return Math.sqrt(Math.exp(sum / count));
}

/** Autocovariance (1/T normalisation, mean removed) at lags 0…maxLag. */
export function autocovariance(y, maxLag) {
  const T = y.length;
  let mean = 0;
  for (const value of y) mean += value;
  mean /= T;
  const out = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let t = 0; t + lag < T; t++) sum += (y[t] - mean) * (y[t + lag] - mean);
    out[lag] = sum / T;
  }
  return out;
}

/**
 * The AR(1) coefficient from the autocovariance with the noise variance removed from lag 0
 * (Pnevmatikakis et al. 2016): least squares of γ(k + 1) = g · (γ(k) − σ² δ_k), k = 0…lags − 1.
 */
export function arCoefficient(y, sn, lags = 6) {
  const gamma = autocovariance(y, lags);
  let numerator = 0;
  let denominator = 0;
  for (let k = 0; k < lags; k++) {
    const a = gamma[k] - (k === 0 ? sn * sn : 0);
    numerator += a * gamma[k + 1];
    denominator += a * a;
  }
  const g = denominator > 0 ? numerator / denominator : 0;
  return Math.min(Math.max(g, 0), 0.999);
}

/**
 * Deconvolves one trace. Unknown σ and g are estimated as above; the baseline b is estimated by
 * alternating the constrained fit with b = mean(y − c), starting from the 15th percentile.
 */
export function deconvolve(y, { g = null, sn = null, baseline = null, iterations = 5 } = {}) {
  const noise = sn ?? noiseLevel(y);
  const decay = g ?? arCoefficient(y, noise);
  if (baseline !== null) return { ...constrainedOasisAR1(y, decay, noise, { baseline }), g: decay, sn: noise, baseline };
  let b = percentile(y, 15);
  let fit = constrainedOasisAR1(y, decay, noise, { baseline: b });
  for (let i = 1; i < iterations; i++) {
    let sum = 0;
    for (let t = 0; t < y.length; t++) sum += y[t] - fit.c[t];
    const next = sum / y.length;
    if (Math.abs(next - b) <= 1e-6 * noise) break;
    b = next;
    fit = constrainedOasisAR1(y, decay, noise, { baseline: b });
  }
  return { ...fit, g: decay, sn: noise, baseline: b };
}

/** Linear-interpolated percentile (the NumPy default). */
export function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const position = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
