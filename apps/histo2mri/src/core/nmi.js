// Normalized mutual information, (H(A) + H(B)) / H(A, B), as Greedy's NMI metric defines it,
// from a joint histogram of the pixels where both images are defined.

const BINS = 32;

function range(data, mask) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (mask && !mask[i]) continue;
    const value = data[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

function entropy(counts, total) {
  let h = 0;
  for (const count of counts) if (count) h -= (count / total) * Math.log(count / total);
  return h;
}

/** NMI of `a` and `b` over the pixels where `mask` is set (all pixels when it is null). */
export function nmi(a, b, mask = null) {
  const [aMin, aMax] = range(a, mask);
  const [bMin, bMax] = range(b, mask);
  if (!(aMax > aMin) || !(bMax > bMin)) return 0;
  const joint = new Float64Array(BINS * BINS);
  const aScale = (BINS - 1e-9) / (aMax - aMin);
  const bScale = (BINS - 1e-9) / (bMax - bMin);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    if ((mask && !mask[i]) || !Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    joint[Math.floor((a[i] - aMin) * aScale) * BINS + Math.floor((b[i] - bMin) * bScale)]++;
    total++;
  }
  if (!total) return 0;
  const marginalA = new Float64Array(BINS);
  const marginalB = new Float64Array(BINS);
  for (let i = 0; i < BINS; i++) {
    for (let j = 0; j < BINS; j++) {
      marginalA[i] += joint[i * BINS + j];
      marginalB[j] += joint[i * BINS + j];
    }
  }
  const hJoint = entropy(joint, total);
  return hJoint > 0 ? (entropy(marginalA, total) + entropy(marginalB, total)) / hJoint : 0;
}
