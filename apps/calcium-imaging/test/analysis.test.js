import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localCorrelationImage, meanMaxImages } from "../src/core/images.js";
import { addDiscRoi, detectRois, findSeeds, relabel, removeRoiAt, robustLevel, watershed } from "../src/core/rois.js";
import { deltaFOverF, meanTraces, neuropilMasks, roiPixels, runningPercentile } from "../src/core/traces.js";
import { analyse, borderMargin, motionCorrect, DEFAULTS } from "../src/core/pipeline.js";

// validation/unit_reference.py: CaImAn's four-neighbour local_correlations and a per-pixel
// numpy.corrcoef eight-neighbour image of a 17-frame 20 × 30 movie.
const reference = JSON.parse(readFileSync(new URL("./fixtures/caiman-reference.json", import.meta.url), "utf8")).localCorrelations;

test("the local correlation image equals CaImAn (4 neighbours) and per-pixel Pearson r (8)", () => {
  const movie = Float32Array.from(reference.movie);
  for (const [neighbours, expected] of [[4, reference.caimanFourNeighbours], [8, reference.pearsonEightNeighbours]]) {
    const image = localCorrelationImage(movie, reference.frames, reference.height, reference.width, { neighbours });
    image.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${neighbours} neighbours, pixel ${i}`));
  }
});

test("a constant pixel has zero correlation; mean and max are per pixel over time", () => {
  const movie = Float32Array.from([1, 5, 2, 7, 3, 5, 4, 9]);
  // Two frames of a 2 × 2 image; pixel 1 is constant.
  const { mean, max } = meanMaxImages(movie.subarray(0, 8), 2, 4);
  assert.deepEqual(Array.from(mean), [2, 5, 3, 8]);
  assert.deepEqual(Array.from(max), [3, 5, 4, 9]);
  const image = localCorrelationImage(movie, 2, 2, 2);
  assert.equal(image[1], 0);
});

/** A correlation-like image: background 0.1 with noise, and Gaussian bumps at the given centres. */
function bumps(height, width, centres, sigma = 2) {
  let state = 4;
  const image = new Float32Array(height * width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      let value = 0.1 + 0.02 * (state / 2 ** 32 - 0.5);
      for (const [cy, cx] of centres) value += 0.5 * Math.exp(-((y - cy) ** 2 + (x - cx) ** 2) / (2 * sigma * sigma));
      image[y * width + x] = value;
    }
  }
  return image;
}

test("ROI detection finds one ROI per cell, centred on it", () => {
  const centres = [[10, 10], [12, 40], [30, 22], [32, 50]];
  const image = bumps(48, 64, centres);
  const { labels, threshold } = detectRois(image, 48, 64, { z: 4, diameter: 8 });
  const level = robustLevel(image);
  assert.ok(Math.abs(threshold - (level.median + 4 * level.sigma)) < 1e-12);
  const rois = roiPixels(labels);
  assert.equal(rois.length, 4);
  for (const pixels of rois) {
    const cy = pixels.reduce((sum, i) => sum + Math.floor(i / 64), 0) / pixels.length;
    const cx = pixels.reduce((sum, i) => sum + (i % 64), 0) / pixels.length;
    assert.ok(centres.some(([y, x]) => Math.hypot(y - cy, x - cx) < 1), `centroid ${cy}, ${cx}`);
    assert.ok(pixels.length >= Math.PI * 4 && pixels.length <= Math.PI * 64);
  }
});

test("seeds are separated by the cell radius and the watershed splits touching cells", () => {
  const image = bumps(32, 48, [[16, 18], [16, 27]]);
  const seeds = findSeeds(image, 32, 48, { threshold: 0.3, radius: 4 });
  assert.equal(seeds.length, 2);
  const labels = watershed(image, 32, 48, seeds, { floor: 0.2, maxDistance: 8 });
  assert.equal(labels[16 * 48 + 18], 1);
  assert.equal(labels[16 * 48 + 27], 2);
  assert.equal(labels[0], 0);
});

test("adding a disc keeps existing labels; removing renumbers", () => {
  let labels = new Uint16Array(100);
  labels[55] = 1;
  const added = addDiscRoi(labels, 10, 10, { y: 5, x: 5, diameter: 4 });
  assert.equal(added.added, 2);
  assert.equal(added.labels[55], 1);
  assert.equal(added.labels[45], 2);
  labels = added.labels;
  const removed = removeRoiAt(labels, 10, { y: 5, x: 5 });
  assert.equal(removed.removed, 1);
  assert.equal(removed.labels[45], 1);
  assert.equal(removed.labels[55], 0);
  assert.equal(removeRoiAt(labels, 10, { y: 0, x: 0 }).removed, 0);
  assert.deepEqual(Array.from(relabel(Uint16Array.from([0, 7, 3, 7]))), [0, 1, 2, 1]);
});

test("neuropil rings leave a 2 px gap around every ROI and reach 200 pixels", () => {
  const width = 60;
  const height = 50;
  const labels = new Uint16Array(width * height);
  for (const [id, cy, cx] of [[1, 20, 20], [2, 20, 28]]) {
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) labels[y * width + x] = id;
  }
  const rois = roiPixels(labels);
  const rings = neuropilMasks(labels, height, width, rois);
  for (const ring of rings) {
    assert.ok(ring.length >= 200);
    for (const i of ring) {
      const y = Math.floor(i / width);
      const x = i % width;
      let nearest = Infinity;
      for (let j = 0; j < labels.length; j++) if (labels[j]) nearest = Math.min(nearest, Math.hypot(Math.floor(j / width) - y, (j % width) - x));
      assert.ok(nearest > 2, `ring pixel ${y},${x} is ${nearest} px from an ROI`);
    }
  }
});

test("neuropil rings leave out the border band that motion correction filled from the edge", () => {
  const width = 40;
  const height = 40;
  const margin = 4;
  const labels = new Uint16Array(width * height);
  // An ROI beside the band, whose ring would otherwise reach the replicated edge pixels.
  for (let y = 6; y <= 9; y++) for (let x = 6; x <= 9; x++) labels[y * width + x] = 1;
  const rois = roiPixels(labels);
  const [unbounded] = neuropilMasks(labels, height, width, rois);
  const inBand = (i) => {
    const y = Math.floor(i / width);
    const x = i % width;
    return y < margin || x < margin || y >= height - margin || x >= width - margin;
  };
  assert.ok(Array.from(unbounded).some(inBand));
  const [ring] = neuropilMasks(labels, height, width, rois, { margin });
  assert.ok(ring.length >= 200);
  assert.equal(Array.from(ring).filter(inBand).length, 0);
});

test("the running percentile matches a direct computation with truncated windows", () => {
  const x = Float64Array.from({ length: 37 }, (_, i) => Math.sin(i * 1.7) * 10 + i);
  const window = 9;
  const result = runningPercentile(x, window, 8);
  for (let t = 0; t < x.length; t++) {
    const lo = Math.max(0, t - Math.floor(window / 2));
    const hi = Math.min(x.length, t - Math.floor(window / 2) + window);
    const sorted = Array.from(x.slice(lo, hi)).sort((a, b) => a - b);
    const position = 0.08 * (sorted.length - 1);
    const lower = Math.floor(position);
    const expected = sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * (position - lower);
    assert.ok(Math.abs(result[t] - expected) < 1e-12, `t ${t}`);
  }
});

test("ΔF/F subtracts 0.7 of the neuropil and divides by the baseline; a non-positive baseline is flagged", () => {
  const F = Float64Array.from({ length: 50 }, (_, t) => (t === 25 ? 300 : 200));
  const Fneu = new Float64Array(50).fill(100);
  const { corrected, baseline, dff, undefinedSamples } = deltaFOverF(F, Fneu, { coefficient: 0.7, window: 20, percentile: 8 });
  assert.equal(corrected[0], 200 - 70);
  assert.equal(baseline[25], 130);
  assert.ok(Math.abs(dff[25] - 100 / 130) < 1e-12);
  assert.equal(dff[0], 0);
  assert.equal(undefinedSamples, 0);
  const dim = deltaFOverF(new Float64Array(50).fill(50), Fneu, { coefficient: 0.7, window: 20, percentile: 8 });
  assert.equal(dim.undefinedSamples, 50);
  assert.ok(Number.isNaN(dim.dff[0]));
});

test("mean traces average each pixel list per frame", () => {
  const movie = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const traces = meanTraces(movie, 2, 4, [Int32Array.from([0, 1]), Int32Array.from([3])]);
  assert.deepEqual(traces.map((trace) => Array.from(trace)), [[1.5, 5.5], [4, 8]]);
});

test("the whole pipeline finds the synthetic cells of a shifted movie and deconvolves them", () => {
  // Four blinking Gaussian cells on a textured background, every frame translated by a known shift.
  const width = 48;
  const height = 40;
  const frames = 80;
  const cells = [[10, 12], [12, 34], [28, 14], [30, 36]];
  let state = 77;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const calcium = cells.map(() => 0);
  const truth = [];
  const movie = new Float32Array(frames * width * height);
  for (let f = 0; f < frames; f++) {
    const shift = [Math.round(2 * Math.sin(f / 7) * 10) / 10, Math.round(1.5 * Math.cos(f / 5) * 10) / 10];
    truth.push(shift);
    cells.forEach((_, k) => {
      calcium[k] = 0.85 * calcium[k] + (random() < 0.08 ? 1 : 0);
    });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sy = y - shift[0];
        const sx = x - shift[1];
        let value = 100 + 20 * Math.sin(sy / 3) * Math.cos(sx / 4) + (random() - 0.5) * 6;
        cells.forEach(([cy, cx], k) => {
          value += Math.exp(-((sy - cy) ** 2 + (sx - cx) ** 2) / 6) * (60 + 200 * calcium[k]);
        });
        movie[f * width * height + y * width + x] = value;
      }
    }
  }
  const dims = { width, height, frames, frameRate: 10 };
  const options = { ...DEFAULTS, diameter: 6, baselineWindow: 4 };
  const corrected = motionCorrect(movie, dims, options);
  // The template drifts with the movie's mean shift, so compare shifts after removing their means.
  const mean = [0, 1].map((axis) => corrected.shifts.reduce((sum, s) => sum + s[axis], 0) / frames);
  const truthMean = [0, 1].map((axis) => truth.reduce((sum, s) => sum - s[axis], 0) / frames);
  corrected.shifts.forEach((shift, f) => {
    for (const axis of [0, 1]) assert.ok(Math.abs(shift[axis] - mean[axis] - (-truth[f][axis] - truthMean[axis])) < 0.35, `frame ${f} axis ${axis}`);
  });
  const margin = borderMargin(corrected.shifts);
  assert.equal(margin, Math.ceil(Math.max(...corrected.shifts.flat().map(Math.abs))) + 1);
  const analysis = analyse(corrected.registered, dims, options, null, { margin });
  assert.equal(analysis.cells.length, 4);
  for (const cell of analysis.cells) {
    assert.equal(cell.undefinedSamples, 0);
    assert.ok(cell.deconvolution.g > 0.5 && cell.deconvolution.g < 0.999);
    assert.ok(cell.deconvolution.s.some((value) => value > 0));
  }
});

test("a correlation image without contrast (a constant movie) yields no ROIs", () => {
  const height = 40;
  const width = 40;
  const { labels, seeds } = detectRois(new Float32Array(height * width), height, width, { z: 3, diameter: 8 });
  assert.equal(seeds, 0);
  assert.equal(labels.reduce((a, b) => Math.max(a, b), 0), 0);
});

test("a seed just inside the margin is not suppressed by brighter pixels in the border band", () => {
  const height = 20;
  const width = 20;
  const image = new Float32Array(height * width);
  // A bright replicated border column at x = 1 (inside the 3-pixel margin), a cell at x = 4.
  for (let y = 0; y < height; y++) image[y * width + 1] = 1;
  image[10 * width + 4] = 0.5;
  const seeds = findSeeds(image, height, width, { threshold: 0.2, radius: 4, margin: 3 });
  assert.deepEqual(seeds.map(({ y, x }) => [y, x]), [[10, 4]]);
});

test("with neuropil subtraction off, an ROI without a neuropil ring keeps its trace", () => {
  const F = Float64Array.from({ length: 50 }, (_, t) => 100 + (t % 10));
  const Fneu = new Float64Array(50).fill(Number.NaN);
  const { dff } = deltaFOverF(F, Fneu, { coefficient: 0, window: 20 });
  assert.ok(dff.every(Number.isFinite));
});
