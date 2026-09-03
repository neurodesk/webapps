// Frame resampling: the upscale option and the preview stretch tool share
// resizeFrame, so its four kernels are checked here for size, edge handling,
// channel independence, and the properties each kernel is supposed to have.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resizeFrame, INTERPOLATIONS } from '../../web/js/pipeline.js';

// A frame with a distinct value per pixel so any axis swap or channel mixup shows.
function ramp(w, h, channels = 1) {
  const f = new Uint8ClampedArray(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        f[(y * w + x) * channels + c] = (x * 17 + y * 43 + c * 80) % 256;
      }
    }
  }
  return f;
}

test('every method returns the requested size', () => {
  const f = ramp(6, 4);
  for (const m of INTERPOLATIONS) {
    for (const [w, h] of [[12, 8], [3, 2], [17, 5], [1, 1]]) {
      const r = resizeFrame(f, 6, 4, 1, w, h, m);
      assert.equal(r.fW, w, `${m} width`);
      assert.equal(r.fH, h, `${m} height`);
      assert.equal(r.frame.length, w * h, `${m} length`);
    }
  }
});

test('resizing to the same size is a no-op that reuses the frame', () => {
  const f = ramp(6, 4);
  for (const m of INTERPOLATIONS) {
    const r = resizeFrame(f, 6, 4, 1, 6, 4, m);
    assert.equal(r.frame, f, `${m} should pass the frame through untouched`);
  }
});

test('a constant frame stays constant (no edge darkening, no ringing)', () => {
  // Weights must sum to 1 everywhere, including at the borders where the kernel
  // hangs off the edge. If they did not, borders would fade toward black.
  const w = 5, h = 5;
  const f = new Uint8ClampedArray(w * h).fill(200);
  for (const m of INTERPOLATIONS) {
    for (const [nw, nh] of [[13, 11], [3, 2]]) {
      const r = resizeFrame(f, w, h, 1, nw, nh, m);
      for (let i = 0; i < r.frame.length; i++) {
        assert.equal(r.frame[i], 200, `${m} ${nw}x${nh} at ${i}`);
      }
    }
  }
});

test('nearest neighbour replicates pixels exactly on an integer upscale', () => {
  const src = new Uint8ClampedArray([10, 20, 30, 40]); // 2x2
  const r = resizeFrame(src, 2, 2, 1, 4, 4, 'nearest');
  assert.deepEqual(Array.from(r.frame), [
    10, 10, 20, 20,
    10, 10, 20, 20,
    30, 30, 40, 40,
    30, 30, 40, 40,
  ]);
});

test('nearest introduces no new values; the smooth kernels do', () => {
  const f = ramp(8, 8);
  const src = new Set(Array.from(f));
  const near = resizeFrame(f, 8, 8, 1, 16, 16, 'nearest');
  for (const v of near.frame) assert.ok(src.has(v), `nearest invented value ${v}`);

  const bil = resizeFrame(f, 8, 8, 1, 16, 16, 'bilinear');
  assert.ok(Array.from(bil.frame).some((v) => !src.has(v)), 'bilinear should interpolate');
});

test('bilinear halves a two-pixel ramp at the midpoint', () => {
  // 1x2 source [0, 100] upscaled to 1x3. The middle output sample lands exactly
  // between the two source pixels.
  const r = resizeFrame(new Uint8ClampedArray([0, 100]), 2, 1, 1, 3, 1, 'bilinear');
  assert.equal(r.frame[0], 0);
  assert.equal(r.frame[1], 50);
  assert.equal(r.frame[2], 100);
});

test('channels are resampled independently', () => {
  const w = 4, h = 4;
  const f = new Uint8ClampedArray(w * h * 3);
  for (let p = 0; p < w * h; p++) {
    f[p * 3] = 0;        // R flat
    f[p * 3 + 1] = 255;  // G flat
    f[p * 3 + 2] = (p % 2) * 255; // B alternating
  }
  for (const m of INTERPOLATIONS) {
    const r = resizeFrame(f, w, h, 3, 8, 8, m);
    assert.equal(r.frame.length, 8 * 8 * 3, `${m} length`);
    for (let p = 0; p < 64; p++) {
      assert.equal(r.frame[p * 3], 0, `${m} R bled at ${p}`);
      assert.equal(r.frame[p * 3 + 1], 255, `${m} G bled at ${p}`);
    }
  }
});

test('the sharper kernels stay in range on a hard edge', () => {
  // Bicubic and Lanczos overshoot at a step edge; the output is a clamped array,
  // so the result must still be valid 8-bit.
  const w = 8, h = 1;
  const f = new Uint8ClampedArray(w);
  for (let x = 0; x < w; x++) f[x] = x < 4 ? 0 : 255;
  for (const m of ['bicubic', 'lanczos']) {
    const r = resizeFrame(f, w, h, 1, 32, 1, m);
    for (const v of r.frame) {
      assert.ok(v >= 0 && v <= 255 && Number.isInteger(v), `${m} produced ${v}`);
    }
  }
});

test('an unknown method falls back to bilinear', () => {
  const f = ramp(6, 4);
  const fallback = resizeFrame(f, 6, 4, 1, 12, 8, 'no-such-kernel');
  const bilinear = resizeFrame(f, 6, 4, 1, 12, 8, 'bilinear');
  assert.deepEqual(Array.from(fallback.frame), Array.from(bilinear.frame));
});

test('downsampling averages rather than point-sampling', () => {
  // A 1-pixel-wide bright line must still show in a 4x shrink for the wide
  // kernels, which is the point of widening the filter when minifying.
  const w = 16, h = 1;
  const f = new Uint8ClampedArray(w);
  f[7] = 255;
  for (const m of ['bicubic', 'lanczos']) {
    const r = resizeFrame(f, w, h, 1, 4, 1, m);
    assert.ok(Array.from(r.frame).some((v) => v > 0), `${m} dropped the line entirely`);
  }
});
