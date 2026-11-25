// Integer-only synthetic smFISH image; validation/synthetic.py makes the same bytes.
const BINOMIAL = [1, 6, 15, 20, 15, 6, 1];

function* xorshift32(seed) {
  let state = seed >>> 0;
  for (;;) {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    yield state;
  }
}

export function syntheticImage(shape, spots, seed) {
  const rng = xorshift32(seed);
  const next = () => rng.next().value;
  const size = shape.reduce((a, b) => a * b, 1);
  const values = new Float64Array(size);
  for (let i = 0; i < size; i++) values[i] = 200 + (next() % 64);
  const ndim = shape.length;
  const norm = 20 ** ndim;
  const strides = shape.map((_, a) => shape.slice(a + 1).reduce((p, s) => p * s, 1));
  for (let s = 0; s < spots; s++) {
    const centre = shape.map((n) => next() % n);
    const amplitude = 200 + (next() % 800);
    for (let k = 0; k < 7 ** ndim; k++) {
      const offset = [];
      let rest = k;
      for (let a = 0; a < ndim; a++) {
        offset.unshift(rest % 7);
        rest = Math.floor(rest / 7);
      }
      const point = centre.map((c, a) => c + offset[a] - 3);
      if (point.some((p, a) => p < 0 || p >= shape[a])) continue;
      const weight = offset.reduce((w, o) => w * BINOMIAL[o], 1);
      values[point.reduce((i, p, a) => i + p * strides[a], 0)] += Math.floor((amplitude * weight) / norm);
    }
  }
  return { data: Uint16Array.from(values, (v) => Math.min(65535, v)), shape: [...shape], dtype: "uint16" };
}
