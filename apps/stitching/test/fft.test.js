import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fftn, nextPowerOfTwo } from '../src/core/fft.js';
import { random } from './synthetic.js';

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

for (const shape of [[8], [4, 8], [4, 2, 8]]) {
  test(`fftn matches the direct DFT on a ${shape.join(' × ')} array, forward and inverse`, () => {
    const rand = random(shape.length);
    const total = shape.reduce((a, b) => a * b, 1);
    for (const inverse of [false, true]) {
      const re = Float64Array.from({ length: total }, () => rand() - 0.5);
      const im = Float64Array.from({ length: total }, () => rand() - 0.5);
      const [expectRe, expectIm] = naiveDft(re, im, shape, inverse);
      fftn(re, im, shape, inverse);
      for (let i = 0; i < total; i++) {
        assert.ok(Math.abs(re[i] - expectRe[i]) < 1e-9 && Math.abs(im[i] - expectIm[i]) < 1e-9, `element ${i}`);
      }
    }
  });
}

test('lengths must be powers of two', () => {
  assert.equal(nextPowerOfTwo(1040), 2048);
  assert.equal(nextPowerOfTwo(512), 512);
  assert.throws(() => fftn(new Float64Array(6), new Float64Array(6), [6]), /power of two/);
});
