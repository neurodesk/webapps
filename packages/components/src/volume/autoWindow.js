/** Compute a histogram-based 2nd-to-99.8th percentile display window. */
export function computeAutoWindow(img) {
  const LOW_PCT = 0.02;
  const HIGH_PCT = 0.998;
  const N_BINS = 4096;
  if (!img?.length) return { low: 0, high: 1, min: 0, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  for (const value of img) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { low: 0, high: 1, min: 0, max: 1 };
  if (max <= min) return { low: min, high: min + 1, min, max: min + 1 };
  const bins = new Uint32Array(N_BINS);
  const scale = (N_BINS - 1) / (max - min);
  for (const value of img) bins[Math.round((value - min) * scale)]++;
  const lowTarget = Math.floor(img.length * LOW_PCT);
  const highTarget = Math.floor(img.length * HIGH_PCT);
  let cumulative = 0;
  let low = min;
  let high = max;
  for (let index = 0; index < N_BINS; index++) {
    cumulative += bins[index];
    if (low === min && cumulative >= lowTarget) low = min + index / scale;
    if (cumulative >= highTarget) {
      high = min + index / scale;
      break;
    }
  }
  return { low, high, min, max };
}
