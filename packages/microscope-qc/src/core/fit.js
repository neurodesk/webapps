// One-dimensional Gaussian fit with an offset, in ImageJ's parameterisation (CurveFitter
// "Gaussian", the fit MetroloJ_QC uses for bead profiles):
//
//   y = a + (b - a) · exp(-(x - c)² / (2 d²))
//
// a is the baseline, b the peak, c the centre and d the standard deviation, so the full width
// at half maximum is 2·sqrt(2 ln 2)·d. Solved by Levenberg-Marquardt least squares from
// MetroloJ_QC's starting point (a = min, b = max, c = abscissa of the max, d = 2 samples).

export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.log(2));

const MAX_ITERATIONS = 500;

function model(x, [a, b, c, d]) {
  return a + (b - a) * Math.exp(-((x - c) ** 2) / (2 * d * d));
}

function sumSquares(x, y, p) {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (y[i] - model(x[i], p)) ** 2;
  return sum;
}

/** Solves the 4 × 4 system A·u = v by Gaussian elimination with partial pivoting; null if singular. */
function solve(A, v) {
  const n = v.length;
  const m = A.map((row, i) => [...row, v[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (!(Math.abs(m[pivot][col]) > 0)) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k++) m[row][k] -= factor * m[col][k];
    }
  }
  const u = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row][n];
    for (let k = row + 1; k < n; k++) sum -= m[row][k] * u[k];
    u[row] = sum / m[row][row];
  }
  return u;
}

/** MetroloJ_QC's starting parameters for a profile. */
function initialParameters(x, y) {
  let min = y[0];
  let max = y[0];
  let centre = x[0];
  for (let i = 1; i < y.length; i++) {
    min = Math.min(min, y[i]);
    if (y[i] > max) {
      max = y[i];
      centre = x[i];
    }
  }
  const step = x.length > 1 ? Math.abs(x[1] - x[0]) : 1;
  return [min, max, centre, 2 * step];
}

/**
 * ImageJ's goodness of fit: 1 − (SSE / Σ(y − ȳ)²) · n / (n − 4), an R² adjusted for the four
 * parameters.
 */
export function fitGoodness(y, sse, parameters = 4) {
  const n = y.length;
  let mean = 0;
  for (const value of y) mean += value;
  mean /= n;
  let total = 0;
  for (const value of y) total += (value - mean) ** 2;
  const freedom = n - parameters;
  return total > 0 && freedom > 0 ? 1 - (sse / total) * (n / freedom) : 0;
}

/**
 * Fits the Gaussian to samples (x, y).
 * @param {ArrayLike<number>} x abscissa (any unit; sigma comes back in it)
 * @param {ArrayLike<number>} y ordinate
 * @returns {{ baseline: number, peak: number, centre: number, sigma: number, fwhm: number, r2: number, sse: number, iterations: number }}
 */
export function fitGaussian(x, y) {
  if (x.length !== y.length) throw new Error('A profile needs as many positions as values.');
  if (x.length < 5) throw new Error('A Gaussian fit needs at least 5 samples.');
  let p = initialParameters(x, y);
  let sse = sumSquares(x, y, p);
  let lambda = 1e-3;
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    const JtJ = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const Jtr = [0, 0, 0, 0];
    const [a, b, c, d] = p;
    for (let i = 0; i < x.length; i++) {
      const offset = x[i] - c;
      const e = Math.exp(-(offset * offset) / (2 * d * d));
      const residual = y[i] - (a + (b - a) * e);
      const J = [1 - e, e, ((b - a) * e * offset) / (d * d), ((b - a) * e * offset * offset) / (d * d * d)];
      for (let r = 0; r < 4; r++) {
        Jtr[r] += J[r] * residual;
        for (let k = 0; k < 4; k++) JtJ[r][k] += J[r] * J[k];
      }
    }
    let improved = false;
    while (lambda < 1e12) {
      const A = JtJ.map((row, r) => row.map((value, k) => (r === k ? value * (1 + lambda) + 1e-300 : value)));
      const step = solve(A, Jtr);
      if (!step) {
        lambda *= 10;
        continue;
      }
      const trial = p.map((value, k) => value + step[k]);
      const trialSse = sumSquares(x, y, trial);
      if (Number.isFinite(trialSse) && trialSse <= sse) {
        const change = sse - trialSse;
        p = trial;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        const converged = change <= 1e-14 * Math.max(sse, 1e-300) || step.every((value, k) => Math.abs(value) <= 1e-12 * Math.max(Math.abs(p[k]), 1e-12));
        sse = trialSse;
        if (converged) return result(x, y, p, sse, iterations + 1);
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return result(x, y, p, sse, iterations);
}

function result(x, y, [a, b, c, d], sse, iterations) {
  const sigma = Math.abs(d);
  return { baseline: a, peak: b, centre: c, sigma, fwhm: FWHM_PER_SIGMA * sigma, r2: fitGoodness(y, sse), sse, iterations };
}
