export function zScoreNormalize(data, options = {}) {
  const nonzeroOnly = options.nonzeroOnly ?? false;
  let sum = 0;
  let count = 0;
  for (const value of data) {
    if (nonzeroOnly && value === 0) continue;
    sum += value;
    count += 1;
  }
  if (!count) return new Float32Array(data.length);
  const mean = sum / count;
  let sumSq = 0;
  for (const value of data) {
    if (nonzeroOnly && value === 0) continue;
    sumSq += (value - mean) ** 2;
  }
  const std = Math.sqrt(sumSq / count) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (nonzeroOnly && data[i] === 0) continue;
    out[i] = (data[i] - mean) / std;
  }
  return out;
}

export function p99Normalize(data) {
  let min = Infinity;
  for (const value of data) if (value < min) min = value;
  if (!Number.isFinite(min)) min = 0;
  const shifted = new Float32Array(data.length);
  let count = 0;
  for (let i = 0; i < data.length; i++) {
    shifted[i] = data[i] - min;
    if (shifted[i] > 0) count += 1;
  }
  let p99 = 0;
  if (count) {
    const nonzero = new Float32Array(count);
    let cursor = 0;
    for (const value of shifted) if (value > 0) nonzero[cursor++] = value;
    nonzero.sort();
    p99 = nonzero[Math.floor(count * 0.99)];
  }
  const denom = p99 || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Math.min(1, Math.max(0, shifted[i] / denom));
  return { data: out, min, p99 };
}

export function computeOtsuThreshold(data, bins = 256) {
  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const value of data) {
    if (value < minVal) minVal = value;
    if (value > maxVal) maxVal = value;
  }
  if (maxVal - minVal < 1e-10) {
    return { thresholdValue: minVal, thresholdPercent: 0, minVal, maxVal, error: 'constant image' };
  }
  const histogram = new Array(bins).fill(0);
  const binWidth = (maxVal - minVal) / bins;
  for (const value of data) {
    const bin = Math.min(bins - 1, Math.floor((value - minVal) / binWidth));
    histogram[bin] += 1;
  }
  const total = data.length;
  let sumTotal = 0;
  for (let i = 0; i < bins; i++) sumTotal += i * histogram[i];
  let sumBackground = 0;
  let weightBackground = 0;
  let bestVariance = -Infinity;
  let bestBin = 0;
  for (let threshold = 0; threshold < bins; threshold++) {
    weightBackground += histogram[threshold];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;
    sumBackground += threshold * histogram[threshold];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumTotal - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestBin = threshold;
    }
  }
  const thresholdValue = minVal + (bestBin + 0.5) * binWidth;
  const thresholdPercent = Math.round((thresholdValue / maxVal) * 100);
  return { thresholdValue, thresholdPercent: Math.max(1, Math.min(100, thresholdPercent)), minVal, maxVal };
}

export function createThresholdMask(data, thresholdPercent, maxValue = null, OutputCtor = Float32Array) {
  const max = maxValue ?? Math.max(...data);
  const threshold = (thresholdPercent / 100) * max;
  const mask = new OutputCtor(data.length);
  for (let i = 0; i < data.length; i++) mask[i] = data[i] >= threshold ? 1 : 0;
  return mask;
}
