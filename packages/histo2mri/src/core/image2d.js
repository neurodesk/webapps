// 2-D image helpers: block averaging, Otsu's threshold, tissue moments, bilinear sampling.

/**
 * Block-averages an interleaved image (`channels` samples per pixel, values 0..maxValue) by an
 * integer `factor`, to channel-planar Float32 planes of [0, 1] values. Edge blocks average the
 * pixels they hold, so no row or column is dropped.
 */
export function blockAverage({ width, height, channels, data, maxValue }, factor) {
  if (!Number.isInteger(factor) || factor < 1) throw new Error('The block size must be a positive integer.');
  const w = Math.ceil(width / factor);
  const h = Math.ceil(height / factor);
  const sums = Array.from({ length: channels }, () => new Float64Array(w * h));
  const counts = new Uint32Array(w * h);
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / factor) * w;
    for (let x = 0; x < width; x++) {
      const target = row + Math.floor(x / factor);
      const source = (y * width + x) * channels;
      counts[target]++;
      for (let c = 0; c < channels; c++) sums[c][target] += data[source + c];
    }
  }
  const planes = sums.map((sum) => {
    const plane = new Float32Array(w * h);
    for (let i = 0; i < plane.length; i++) plane[i] = sum[i] / counts[i] / maxValue;
    return plane;
  });
  return { width: w, height: h, planes };
}

/** Otsu's threshold over the finite values of `data` where `mask` (if given) is set, from 256 bins. */
export function otsuThreshold(data, mask = null) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if ((mask && !mask[i]) || !Number.isFinite(data[i])) continue;
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  if (!(max > min)) return min;
  const bins = 256;
  const histogram = new Float64Array(bins);
  const scale = (bins - 1) / (max - min);
  let total = 0;
  for (let i = 0; i < data.length; i++) {
    if ((mask && !mask[i]) || !Number.isFinite(data[i])) continue;
    histogram[Math.round((data[i] - min) * scale)]++;
    total++;
  }
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * histogram[b];
  let weight = 0;
  let sum = 0;
  let best = 0;
  let bestVariance = -1;
  for (let b = 0; b < bins - 1; b++) {
    weight += histogram[b];
    sum += b * histogram[b];
    if (!weight || weight === total) continue;
    const meanLow = sum / weight;
    const meanHigh = (sumAll - sum) / (total - weight);
    const variance = weight * (total - weight) * (meanLow - meanHigh) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = b;
    }
  }
  return min + (best + 0.5) / scale;
}

/** Pixels above Otsu's threshold, as a 0/1 mask. */
export function foreground(data, mask = null) {
  const threshold = otsuThreshold(data, mask);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = (!mask || mask[i]) && data[i] > threshold ? 1 : 0;
  return out;
}

/** Area (pixels), centroid and second central moments of a mask's set pixels. */
export function maskMoments(mask, width, height) {
  let area = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      area++;
      sx += x;
      sy += y;
    }
  }
  if (!area) throw new Error('No tissue was found in the image.');
  const cx = sx / area;
  const cy = sy / area;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      xx += (x - cx) ** 2;
      yy += (y - cy) ** 2;
      xy += (x - cx) * (y - cy);
    }
  }
  return { area, cx, cy, xx: xx / area, yy: yy / area, xy: xy / area };
}

/** Bilinear sample at pixel coordinates (x, y), or `outside` beyond the outer pixel centres. */
export function bilinear(data, width, height, x, y, outside = 0) {
  if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return outside;
  const x0 = Math.min(Math.floor(x), width - 2 < 0 ? 0 : width - 2);
  const y0 = Math.min(Math.floor(y), height - 2 < 0 ? 0 : height - 2);
  const fx = width > 1 ? x - x0 : 0;
  const fy = height > 1 ? y - y0 : 0;
  const x1 = width > 1 ? x0 + 1 : x0;
  const y1 = height > 1 ? y0 + 1 : y0;
  const top = data[y0 * width + x0] * (1 - fx) + data[y0 * width + x1] * fx;
  const bottom = data[y1 * width + x0] * (1 - fx) + data[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}
