import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft1d, fftn, nextPowerOfTwo } from '../src/fft/index.js';

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** The direct n-dimensional DFT of an array of `shape`, first axis fastest. */
function naiveDft(re, im, shape, inverse) {
  const total = re.length;
  const outRe = new Float64Array(total);
  const outIm = new Float64Array(total);
  const coords = (i) => shape.map((_, d) => Math.floor(i / shape.slice(0, d).reduce((a, b) => a * b, 1)) % shape[d]);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < total; k++) {
    const kc = coords(k);
    for (let n = 0; n < total; n++) {
      const nc = coords(n);
      const angle = sign * 2 * Math.PI * kc.reduce((sum, v, d) => sum + (v * nc[d]) / shape[d], 0);
      outRe[k] += re[n] * Math.cos(angle) - im[n] * Math.sin(angle);
      outIm[k] += re[n] * Math.sin(angle) + im[n] * Math.cos(angle);
    }
  }
  return [outRe, outIm];
}

function assertMatchesDft(shape, transform) {
  const random = seeded(shape.reduce((a, b) => a * 31 + b, 7));
  const total = shape.reduce((a, b) => a * b, 1);
  for (const inverse of [false, true]) {
    const re = Float64Array.from({ length: total }, () => random() - 0.5);
    const im = Float64Array.from({ length: total }, () => random() - 0.5);
    const [expectedRe, expectedIm] = naiveDft(re, im, shape, inverse);
    transform(re, im, inverse);
    for (let i = 0; i < total; i++) {
      assert.ok(Math.abs(re[i] - expectedRe[i]) < 1e-9 * total, `re[${i}] ${inverse ? 'inverse' : 'forward'}`);
      assert.ok(Math.abs(im[i] - expectedIm[i]) < 1e-9 * total, `im[${i}] ${inverse ? 'inverse' : 'forward'}`);
    }
  }
}

// Calcium imaging's frames have any length (45 × 52 in its reference); stitching pads to powers of two.
for (const n of [1, 2, 3, 8, 45, 52, 64, 100]) {
  test(`fft1d of length ${n} equals the direct DFT, forward and inverse`, () => {
    assertMatchesDft([n], (re, im, inverse) => fft1d(re, im, inverse));
  });
}

for (const shape of [[8], [4, 8], [4, 2, 8], [12, 9], [5, 3, 4]]) {
  test(`fftn equals the direct DFT on a ${shape.join(' × ')} array, forward and inverse`, () => {
    assertMatchesDft(shape, (re, im, inverse) => fftn(re, im, shape, inverse));
  });
}

test('fftn followed by its unscaled inverse returns N times the input', () => {
  const random = seeded(7);
  const shape = [12, 9];
  const re = Float64Array.from({ length: 108 }, () => random());
  const im = new Float64Array(108);
  const copy = Float64Array.from(re);
  fftn(re, im, shape);
  fftn(re, im, shape, true);
  for (let i = 0; i < re.length; i++) {
    assert.ok(Math.abs(re[i] / 108 - copy[i]) < 1e-12, `re[${i}]`);
    assert.ok(Math.abs(im[i]) < 1e-12, `im[${i}]`);
  }
});

for (const shape of [[45, 52], [32, 16], [16, 8, 4]]) {
  test(`phase correlation of a circularly shifted ${shape.join(' × ')} array peaks at the shift`, () => {
    const random = seeded(shape.length);
    const total = shape.reduce((a, b) => a * b, 1);
    const shift = shape.map((n, d) => (d + 2) % n);
    const strides = shape.map((_, d) => shape.slice(0, d).reduce((a, b) => a * b, 1));
    const a = Float64Array.from({ length: total }, () => random());
    const b = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      const j = shape.reduce((sum, n, d) => sum + ((Math.floor(i / strides[d]) % n + shift[d]) % n) * strides[d], 0);
      b[j] = a[i];
    }
    const aIm = new Float64Array(total);
    const bIm = new Float64Array(total);
    fftn(a, aIm, shape);
    fftn(b, bIm, shape);
    // B · conj(A) / |B · conj(A)|
    for (let i = 0; i < total; i++) {
      const r = b[i] * a[i] + bIm[i] * aIm[i];
      const c = bIm[i] * a[i] - b[i] * aIm[i];
      const m = Math.hypot(r, c) || 1;
      a[i] = r / m;
      aIm[i] = c / m;
    }
    fftn(a, aIm, shape, true);
    let best = 0;
    for (let i = 1; i < total; i++) if (a[i] > a[best]) best = i;
    assert.deepEqual(shape.map((n, d) => Math.floor(best / strides[d]) % n), shift);
    assert.ok(Math.abs(a[best] / total - 1) < 1e-9);
  });
}

test('nextPowerOfTwo and mismatched buffers', () => {
  assert.equal(nextPowerOfTwo(1), 1);
  assert.equal(nextPowerOfTwo(512), 512);
  assert.equal(nextPowerOfTwo(1040), 2048);
  assert.throws(() => fftn(new Float64Array(6), new Float64Array(6), [4, 2]), /do not match/);
});
