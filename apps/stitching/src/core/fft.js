// Complex FFT for power-of-two lengths on split real/imaginary Float64Arrays, in one to three
// dimensions. Forward uses e^{-2πikn/N}; the inverse is unscaled, which is all phase
// correlation needs (only the position of a peak matters).

const plans = new Map();

function plan(n) {
  let cached = plans.get(n);
  if (cached) return cached;
  const bits = Math.round(Math.log2(n));
  if (2 ** bits !== n) throw new Error(`FFT length ${n} is not a power of two.`);
  const reverse = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    reverse[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  cached = { n, reverse, cos, sin };
  plans.set(n, cached);
  return cached;
}

/** The smallest power of two that is at least `n`. */
export function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** In-place radix-2 FFT of one complex line. */
export function fft1(re, im, inverse = false) {
  const { n, reverse, cos, sin } = plan(re.length);
  for (let i = 0; i < n; i++) {
    const j = reverse[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/**
 * In-place FFT of an array of `shape` (first axis fastest, every length a power of two).
 * @param {Float64Array} re
 * @param {Float64Array} im
 * @param {number[]} shape
 */
export function fftn(re, im, shape, inverse = false) {
  const total = shape.reduce((a, b) => a * b, 1);
  if (re.length !== total || im.length !== total) throw new Error('FFT buffers do not match the shape.');
  let stride = 1;
  for (const n of shape) {
    if (n > 1 && stride === 1) {
      for (let start = 0; start < total; start += n) fft1(re.subarray(start, start + n), im.subarray(start, start + n), inverse);
    } else if (n > 1) {
      const lineRe = new Float64Array(n);
      const lineIm = new Float64Array(n);
      const block = stride * n;
      for (let base = 0; base < total; base += block) {
        for (let offset = 0; offset < stride; offset++) {
          const start = base + offset;
          for (let k = 0; k < n; k++) {
            lineRe[k] = re[start + k * stride];
            lineIm[k] = im[start + k * stride];
          }
          fft1(lineRe, lineIm, inverse);
          for (let k = 0; k < n; k++) {
            re[start + k * stride] = lineRe[k];
            im[start + k * stride] = lineIm[k];
          }
        }
      }
    }
    stride *= n;
  }
}
