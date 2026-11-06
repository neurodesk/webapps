// ROI and neuropil fluorescence, neuropil subtraction and ΔF/F.
//
// F is the mean of an ROI's pixels in each frame. Its neuropil is the ring of pixels between
// `innerGap` and R pixels from the ROI, excluding every pixel within `innerGap` of any ROI, with
// the smallest whole R ≥ innerGap + 1 that gives at least `minPixels` pixels (R stops at
// `maxRadius`). Pixels in the border band of `margin` pixels, which motion correction filled by
// replicating the edge, are never neuropil. The corrected trace is Fc = F − r · Fneu with r = 0.7 by default (Chen et al.
// 2013 Nature 499:295; Suite2p and Kerlin et al. 2010 use the same 0.7). The baseline F0 is a
// running 8th percentile of Fc over a centred window (60 s by default, truncated at the ends of
// the recording) and ΔF/F = (Fc − F0) / F0. When F0 is not positive somewhere, the ROI's ΔF/F
// is not defined there: those samples are NaN and the ROI is flagged.

/** Pixel indices of labels 1…n. */
export function roiPixels(labels) {
  let count = 0;
  for (const label of labels) if (label > count) count = label;
  const lists = Array.from({ length: count }, () => []);
  for (let i = 0; i < labels.length; i++) if (labels[i]) lists[labels[i] - 1].push(i);
  return lists.map((list) => Int32Array.from(list));
}

function dilate(labels, height, width, radius) {
  const out = new Uint8Array(height * width);
  const r = Math.ceil(radius);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!labels[y * width + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width || dy * dy + dx * dx > radius * radius) continue;
          out[yy * width + xx] = 1;
        }
      }
    }
  }
  return out;
}

/** One neuropil ring per ROI (see the header). */
export function neuropilMasks(labels, height, width, rois, { innerGap = 2, minPixels = 200, maxRadius = 50, margin = 0 } = {}) {
  const excluded = dilate(labels, height, width, innerGap);
  return rois.map((pixels) => {
    let y0 = height;
    let y1 = 0;
    let x0 = width;
    let x1 = 0;
    for (const i of pixels) {
      const y = (i / width) | 0;
      const x = i - y * width;
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
    }
    const candidates = [];
    for (let y = Math.max(margin, y0 - maxRadius); y <= Math.min(height - 1 - margin, y1 + maxRadius); y++) {
      for (let x = Math.max(margin, x0 - maxRadius); x <= Math.min(width - 1 - margin, x1 + maxRadius); x++) {
        const i = y * width + x;
        if (excluded[i]) continue;
        let best = Infinity;
        for (const p of pixels) {
          const py = (p / width) | 0;
          const d = (py - y) ** 2 + (p - py * width - x) ** 2;
          if (d < best) best = d;
        }
        if (best <= maxRadius * maxRadius) candidates.push([best, i]);
      }
    }
    candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let radius = innerGap + 1;
    let count = 0;
    for (; radius <= maxRadius; radius++) {
      while (count < candidates.length && candidates[count][0] <= radius * radius) count++;
      if (count >= minPixels) break;
    }
    return Int32Array.from(candidates.slice(0, count).map(([, i]) => i).sort((a, b) => a - b));
  });
}

/** Mean of each pixel list in every frame: an array of Float64Array(frames). */
export function meanTraces(movie, frames, plane, lists) {
  const traces = lists.map(() => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    const offset = f * plane;
    lists.forEach((pixels, k) => {
      let sum = 0;
      for (const i of pixels) sum += movie[offset + i];
      traces[k][f] = pixels.length ? sum / pixels.length : NaN;
    });
  }
  return traces;
}

function insertSorted(sorted, length, value) {
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  sorted.copyWithin(low + 1, low, length);
  sorted[low] = value;
}

function removeSorted(sorted, length, value) {
  let low = 0;
  let high = length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  sorted.copyWithin(low, low + 1, length);
}

/**
 * Percentile p (linear interpolation) over a centred window of `window` samples, truncated at
 * the ends: sample t uses t − ⌊window/2⌋ … t + ⌈window/2⌉ − 1.
 */
export function runningPercentile(x, window, p) {
  const T = x.length;
  const half = Math.floor(window / 2);
  const out = new Float64Array(T);
  const sorted = new Float64Array(Math.min(window, T) + 1);
  let start = 0;
  let end = 0;
  let length = 0;
  for (let t = 0; t < T; t++) {
    const lo = Math.max(0, t - half);
    const hi = Math.min(T, t - half + window);
    while (end < hi) insertSorted(sorted, length++, x[end++]);
    while (start < lo) removeSorted(sorted, length--, x[start++]);
    const position = (p / 100) * (length - 1);
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, length - 1);
    out[t] = sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }
  return out;
}

/** Neuropil-corrected fluorescence, its running-percentile baseline and ΔF/F for one ROI. */
export function deltaFOverF(F, Fneu, { coefficient = 0.7, window, percentile = 8 }) {
  // With subtraction off, an ROI without a neuropil ring (NaN Fneu) keeps its trace.
  const corrected = Float64Array.from(F, (value, t) => (coefficient === 0 ? value : value - coefficient * Fneu[t]));
  const baseline = runningPercentile(corrected, window, percentile);
  let undefinedSamples = 0;
  const dff = Float64Array.from(corrected, (value, t) => {
    if (!(baseline[t] > 0)) {
      undefinedSamples++;
      return NaN;
    }
    return (value - baseline[t]) / baseline[t];
  });
  return { corrected, baseline, dff, undefinedSamples };
}
