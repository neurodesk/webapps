// Windowing histogram bin heights.
//
// The failure this guards against is a histogram that renders as a solid block:
// a medical image is mostly air, so one background bin holds far more voxels than
// any tissue bin. Normalizing to that bin, or compressing counts with log, lifts
// every small bin toward full height and hides the tissue detail the window
// handles are meant to be placed against.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { histogramBins } from '../../web/js/pipeline.js';

const MAX = 4095;
const NB = 128;

// A volume shaped like a real scan: a dominant air spike at zero, a bright
// tissue peak, a smaller one, and a low baseline in between. AIR_BIN is roughly
// 25x the tall tissue peak, which is the ratio that broke the old scaling.
const AIR_BIN = 0, PEAK_A = 50, PEAK_B = 90, BASELINE = 50;

function scanLike() {
  const counts = new Array(NB).fill(BASELINE);
  for (let b = 0; b < NB; b++) {
    counts[b] += Math.round(8000 * Math.exp(-(((b - PEAK_A) / 6) ** 2)));
    counts[b] += Math.round(2000 * Math.exp(-(((b - PEAK_B) / 6) ** 2)));
  }
  counts[AIR_BIN] += 200000;

  const total = counts.reduce((a, b) => a + b, 0);
  const data = new Float32Array(total);
  let p = 0;
  for (let b = 0; b < NB; b++) {
    const v = (MAX * (b + 0.5)) / NB; // bin centre, so it lands back in bin b
    for (let i = 0; i < counts[b]; i++) data[p++] = v;
  }
  return { data, channels: 1, dims: [total, 1, 1] };
}

function heights(h) {
  return Array.from(h.bins, (b) => Math.min(1, b / h.peak));
}

// The regression this file exists for. With the old log1p-over-max scaling these
// three came out at 0.74, 0.62 and 0.32: a bin with a quarter of the counts drew
// at 85% of its neighbour's height and the baseline sat a third of the way up,
// which is what made the histogram look like a solid block.
test('a smaller tissue peak draws clearly shorter than a larger one', () => {
  const h = histogramBins(scanLike(), { min: 0, max: MAX, nBins: NB, maxSamples: 1e9 });
  const bars = heights(h);
  const ratio = bars[PEAK_B] / bars[PEAK_A];
  assert.ok(bars[PEAK_A] > 0.8, `tall peak only reaches ${bars[PEAK_A].toFixed(2)}`);
  assert.ok(ratio < 0.7, `peak B/A height ratio ${ratio.toFixed(2)} is too flat to read`);
});

test('the baseline stays near the floor', () => {
  const h = histogramBins(scanLike(), { min: 0, max: MAX, nBins: NB, maxSamples: 1e9 });
  const bars = heights(h);
  // Bin 20 is baseline only: far from both peaks and from the air spike.
  assert.ok(bars[20] < 0.2, `baseline bar drew at ${bars[20].toFixed(2)}`);
});

test('the air spike clips instead of setting the scale', () => {
  const h = histogramBins(scanLike(), { min: 0, max: MAX, nBins: NB, maxSamples: 1e9 });
  assert.ok(h.bins[AIR_BIN] > h.peak, 'air bin should exceed the peak and clip');
  const over = Array.from(h.bins).filter((b) => b > h.peak).length;
  assert.ok(over <= 4, `${over} bins exceed the percentile peak`);
  assert.ok(h.peak > 0, 'peak must be positive');
});

test('a volume with few distinct values does not clip everything', () => {
  // A mask leaves most bins empty. Including empty bins in the percentile would
  // put the peak at zero and drive every bar to full height.
  const data = new Float32Array(11000);
  data.fill(0, 0, 10000);
  data.fill(MAX, 10000);
  const h = histogramBins({ data, channels: 1, dims: [11000, 1, 1] }, { min: 0, max: MAX, nBins: NB, maxSamples: 1e9 });
  const bars = heights(h);
  const full = bars.filter((v) => v >= 1).length;
  assert.ok(full <= 2, `${full} bars clipped to full height on a two-value volume`);
  assert.ok(h.peak > 0);
});

test('a flat volume produces finite heights and a positive peak', () => {
  const data = new Float32Array(1000).fill(7);
  const h = histogramBins({ data, channels: 1, dims: [1000, 1, 1] }, { min: 7, max: 7 });
  assert.ok(h.peak > 0, 'peak must be positive when min === max');
  assert.equal(h.max, 8, 'a degenerate range is widened so the divide is safe');
  for (const b of h.bins) assert.ok(Number.isFinite(b), 'bin must be finite');
});

test('an empty range does not divide by zero', () => {
  const data = new Float32Array([0, 0, 0, 0]);
  const h = histogramBins({ data, channels: 1, dims: [4, 1, 1] }, { min: 0, max: 0 });
  for (const b of h.bins) assert.ok(Number.isFinite(b));
  assert.ok(Number.isFinite(h.peak) && h.peak > 0);
});

test('every sample lands in a bin', () => {
  const data = new Float32Array([0, 25, 50, 75, 100]);
  const h = histogramBins({ data, channels: 1, dims: [5, 1, 1] }, { min: 0, max: 100, nBins: 4 });
  // Heights are sqrt of counts, so squaring recovers them.
  const counts = Array.from(h.bins, (b) => Math.round(b * b));
  assert.equal(counts.reduce((a, b) => a + b, 0), 5);
  // The top value clamps into the last bin rather than falling off the end.
  assert.ok(counts[counts.length - 1] >= 1);
});

test('subsampling keeps the distribution shape', () => {
  // maxSamples forces a stride; the histogram must still be built.
  const vol = scanLike({ air: 50000, tissue: 50000 });
  const full = histogramBins(vol, { min: 0, max: 4095, maxSamples: 1e9 });
  const sub = histogramBins(vol, { min: 0, max: 4095, maxSamples: 1000 });
  const a = heights(full);
  const b = heights(sub);
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  assert.ok(maxDiff < 0.25, `subsampled shape drifted by ${maxDiff}`);
});
