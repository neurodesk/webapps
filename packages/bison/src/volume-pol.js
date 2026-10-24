// EZminc volume_pol, as BISON calls it: `volume_pol <src> <target> --order 1 --noclamp`.
//
// A line-by-line port of minc-toolkit-v2 EZminc/tools/volume_pol.cpp with the parts it uses from
// image_proc/minc_histograms.h (histogram, build_histogram, find_percentile), image_proc/gsl_gauss.h
// (MNK_Gauss with the Polinom_Mod basis) and libminc/ezminc/minc_io_simple_volume.h
// (volume_min_max). Arithmetic keeps the C++ operation order, so each double is the binary's.
// docs/volume-pol.md states the algorithm and the measured agreement with the binary.
//
// Voxel order matters only for summation rounding and for the masked minimum quirk below. The
// binary reads MINC with x fastest, which is NIfTI order.

export const BUCKETS = 100;

// image_proc/gsl_gauss.h Polinom_Mod: index 0 is x, index 1 is the constant, then x^n.
function basis(n, x) {
  if (n === 0) return x;
  if (n === 1) return 1;
  let res = 1.0;
  for (let i = 0; i < n; i++) res *= x;
  return res;
}

const finite = (v) => Number.isFinite(v);

// minc_io_simple_volume.h volume_min_max, both overloads. The `else if` is upstream's: in the
// masked form the first in-mask voxel sets the maximum and never the minimum.
function volumeMinMax(data, mask) {
  let min;
  let max;
  if (mask) {
    min = 1e10;
    max = -1e10;
  } else {
    min = data[0];
    max = data[0];
  }
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask[i]) continue;
    const v = data[i];
    if (!finite(v)) continue;
    if (v > max) max = v;
    else if (v < min) min = v;
  }
  return { min, max };
}

// minc_histograms.h histogram<double> after set_limits(min, max).
function createHistogram(min, max) {
  const range = max - min;
  const k = BUCKETS / range;
  return { bins: new Float64Array(BUCKETS), min, max, k };
}

function bucketValue(hist, i) {
  return i / hist.k + hist.min + 0.5 / hist.k;
}

function bucketIndex(hist, value) {
  let i = Math.floor(hist.k * (value - hist.min - 0.5 / hist.k));
  if (i < 0) i = 0;
  if (i >= BUCKETS) i = BUCKETS - 1;
  return i;
}

// histogram::operator[](int): an index clamped to the buckets.
function bucketAt(hist, i) {
  if (i < 0) return hist.bins[0];
  if (i >= BUCKETS) return hist.bins[BUCKETS - 1];
  return hist.bins[i];
}

// histogram::seed with count 1: linear split between the two nearest bucket centres.
function seed(hist, value) {
  const i = bucketIndex(hist, value);
  if (i >= BUCKETS - 1) {
    hist.bins[BUCKETS - 1] += 1;
    return;
  }
  const d1 = Math.abs(bucketValue(hist, i) - value);
  const d2 = Math.abs(bucketValue(hist, i + 1) - value);
  hist.bins[i] += d2 / (d1 + d2);
  hist.bins[i + 1] += d1 / (d1 + d2);
}

// minc_histograms.h build_histogram, both overloads: range from volumeMinMax, finite voxels
// seeded, bins divided by their count.
function buildHistogram(data, mask, name) {
  if (mask && mask.length !== data.length) throw new Error(`The ${name} mask does not match the ${name} image.`);
  const { min, max } = volumeMinMax(data, mask);
  if (!(max > min)) throw new Error(`The ${name} image has no intensity range${mask ? ' inside its mask' : ''}.`);
  const hist = createHistogram(min, max);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask[i]) continue;
    const v = data[i];
    if (!finite(v)) continue;
    seed(hist, v);
    count++;
  }
  for (let i = 0; i < BUCKETS; i++) hist.bins[i] /= count;
  return hist;
}

// histogram::find_percentile. `j` is the last non-empty bucket before the one that crosses `pc`;
// value(i) is not clamped when the loop runs off the end, as upstream.
function findPercentile(hist, pc) {
  let acc = 0.0;
  let i;
  let j = 0;
  for (i = 0; i < BUCKETS; i++) {
    const prob = bucketAt(hist, i);
    acc += prob;
    if (acc >= pc) break;
    if (prob > 0.0) j = i;
  }
  if (i > 0) {
    const k = (acc - pc) / bucketAt(hist, i);
    return bucketValue(hist, i) * (1.0 - k) + bucketValue(hist, j) * k + 0.5 / hist.k;
  }
  const k = (acc - pc) / bucketAt(hist, 0);
  return (bucketValue(hist, 0) + 0.5 / hist.k) * (1.0 - k) + hist.min * k;
}

// GSL gsl_linalg_SV_decomp + gsl_linalg_SV_solve for one unknown: S = |a|, U = a * (1 / |a|),
// x = (1 / S) * (U * b). One Polinom_Mod term is the slope through the origin.
function solveOne(a, b) {
  const norm = Math.abs(a);
  if (norm === 0) return [0];
  const u = a * (1.0 / norm);
  return [(1.0 / norm) * (u * b)];
}

// Least-squares solution of the symmetric normal equations by Jacobi eigen decomposition, the
// pseudo-inverse GSL's SVD solve gives for a symmetric positive semidefinite matrix. It does not
// repeat GSL's Golub-Kahan rounding; orders 2 and up agree with the binary to the matrix's
// conditioning, not bit for bit.
function solveSymmetric(alpha, beta) {
  const n = beta.length;
  const a = alpha.map((row) => [...row]);
  const v = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => (r === c ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    }
    if (off === 0) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (a[p][q] === 0) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let r = 0; r < n; r++) {
          const arp = a[r][p];
          const arq = a[r][q];
          a[r][p] = c * arp - s * arq;
          a[r][q] = s * arp + c * arq;
        }
        for (let r = 0; r < n; r++) {
          const apr = a[p][r];
          const aqr = a[q][r];
          a[p][r] = c * apr - s * aqr;
          a[q][r] = s * apr + c * aqr;
        }
        for (let r = 0; r < n; r++) {
          const vrp = v[r][p];
          const vrq = v[r][q];
          v[r][p] = c * vrp - s * vrq;
          v[r][q] = s * vrp + c * vrq;
        }
      }
    }
  }
  const x = new Array(n).fill(0);
  for (let e = 0; e < n; e++) {
    const lambda = a[e][e];
    if (lambda === 0) continue;
    let w = 0;
    for (let r = 0; r < n; r++) w += v[r][e] * beta[r];
    w /= lambda;
    for (let r = 0; r < n; r++) x[r] += v[r][e] * w;
  }
  return x;
}

// C's `ostream << double` with the default precision: printf("%g"), 6 significant digits.
// toExponential rounds a decimal tie away from zero where glibc rounds it to even; a coefficient
// is never an exact 7-digit decimal tie in practice.
export function formatG(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === 0) return Object.is(x, -0) ? '-0' : '0';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const exponent = Number(x.toExponential(5).split('e')[1]);
  const strip = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, e] = x.toExponential(5).split('e');
    return `${strip(mantissa)}e${e.startsWith('-') ? '-' : '+'}${e.replace(/^[-+]/, '').padStart(2, '0')}`;
  }
  return strip(x.toFixed(Math.max(0, 5 - exponent)));
}

// volume_pol.cpp print_expression, without its trailing newline. The clamp limits are floats.
// For order 3 and up upstream prints c[i]*A[0]^i, which is not the Polinom_Mod polynomial it
// fitted; kept as upstream writes it.
function printExpression(coefficients, min, max, clamp) {
  const order = coefficients.length;
  let out = clamp ? 'clamp(' : '';
  if (order === 1) {
    out += `${formatG(coefficients[0])}*A[0]`;
  } else if (order === 2) {
    out += `${formatG(coefficients[0])}*A[0]+${formatG(coefficients[1])}`;
  } else {
    for (let i = 0; i < order; i++) {
      out += formatG(coefficients[i]);
      for (let j = 0; j < i; j++) out += '*A[0]';
      if (i !== order - 1) out += '+';
    }
  }
  if (clamp) out += `,${formatG(Math.fround(min))},${formatG(Math.fround(max))})`;
  return out;
}

/**
 * Fit the source intensity distribution to the target's, as volume_pol does.
 *
 * Both images are reduced to 100-bucket histograms over their own (masked) range; the 0.1 %,
 * 0.2 %, ... percentiles of the source are regressed onto the same percentiles of the target with
 * the Polinom_Mod basis (order 1: target = c0 * source; order 2: c0 * source + c1).
 *
 * @param {object} input
 * @param {ArrayLike<number>} input.source image to be mapped, any voxel order shared with its mask
 * @param {ArrayLike<number>} input.target reference image
 * @param {ArrayLike<number>} [input.sourceMask] nonzero voxels form the source histogram (--source_mask)
 * @param {ArrayLike<number>} [input.targetMask] nonzero voxels form the target histogram (--target_mask)
 * @param {number} [input.order] number of coefficients (--order), 1 in BISON
 * @param {boolean} [input.clamp] write the expression as volume_pol does without --noclamp
 * @returns {{coefficients: number[], expression: string, targetMin: number, targetMax: number}}
 */
export function fitVolumePol({ source, target, sourceMask, targetMask, order = 1, clamp = false }) {
  if (!Number.isInteger(order) || order < 1) throw new Error(`The polynomial order must be a positive integer, not ${order}.`);
  if (!source?.length) throw new Error('The source image is empty.');
  if (!target?.length) throw new Error('The target image is empty.');
  const hist1 = buildHistogram(source, sourceMask, 'source');
  const hist2 = buildHistogram(target, targetMask, 'target');
  const alpha = Array.from({ length: order }, () => new Array(order).fill(0));
  const beta = new Array(order).fill(0);
  for (let pc = 0.001; pc < 1.0; pc += 0.001) {
    const pnt = findPercentile(hist1, pc);
    const value = findPercentile(hist2, pc);
    for (let i = 0; i < order; i++) {
      for (let j = 0; j < order; j++) alpha[i][j] = alpha[i][j] + basis(i, pnt) * basis(j, pnt);
      beta[i] = beta[i] + basis(i, pnt) * value;
    }
  }
  const coefficients = order === 1 ? solveOne(alpha[0][0], beta[0]) : solveSymmetric(alpha, beta);
  return {
    coefficients,
    expression: printExpression(coefficients, hist2.min, hist2.max, clamp),
    targetMin: hist2.min,
    targetMax: hist2.max,
  };
}

/**
 * Apply fitted coefficients to every voxel, as volume_pol writes its output image: evaluated in
 * double, stored as float32 (a float MINC input gives a float output). Masks do not limit it.
 *
 * @param {ArrayLike<number>} data
 * @param {number[]} coefficients from fitVolumePol
 * @param {{clamp?: boolean, min?: number, max?: number}} [options] clamp to the target range
 *   (fitVolumePol's targetMin/targetMax), as volume_pol does without --noclamp
 * @returns {Float32Array}
 */
export function applyVolumePol(data, coefficients, { clamp = false, min, max } = {}) {
  if (clamp && !(Number.isFinite(min) && Number.isFinite(max))) throw new Error('Clamping needs the target min and max.');
  const order = coefficients.length;
  const out = new Float32Array(data.length);
  for (let v = 0; v < data.length; v++) {
    const x = data[v];
    let val = 0.0;
    for (let i = 0; i < order; i++) val += basis(i, x) * coefficients[i];
    if (clamp) {
      if (val > max) val = max;
      else if (val < min) val = min;
    }
    out[v] = val;
  }
  return out;
}
