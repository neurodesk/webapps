// Pure DOM-free multi-scale rigid / similarity image registration optimizing
// Normalized Cross-Correlation (NCC) over mutually valid overlap pixels.
import { ALPHA_VALID_THRESHOLD, detectValidFov, downsampleGray, rgbaToLuminance } from "./preprocess.js";

const DEG_TO_RAD = Math.PI / 180;
const MIN_VARIANCE = 1e-4;
const MIN_ABS_SUPPORT = 256;
const DEFAULT_MIN_OVERLAP = 0.35;
const COVERAGE_PENALTY_START = 0.75;
const COVERAGE_PENALTY_WEIGHT = 0.15;
export const MIN_ALIGNED_NCC = 0.45;
export const MIN_GRADIENT_NCC = 0.2;
export const MIN_CHANNEL_NCC = 0.2;

export const REGISTRATION_FAILURE_REASON = "Insufficient image texture or overlap for registration";
export const LOW_CORRELATION_FAILURE_REASON = "Images could not be reliably aligned (low correlation)";

/**
 * Compute signed oriented luminance-gradient correlation over mutually valid interior pixels:
 *   sum(gx_b * gx_f + gy_b * gy_f) / sqrt(sum(|grad_b|^2) * sum(|grad_f|^2)).
 * Unlike unsigned gradient magnitude, signed vector correlation cancels random edge polarities
 * even when unrelated block textures share grid boundaries.
 */
function computeSignedGradientCorrelation(bGray, fGray, width, height, validMask) {
  let count = 0;
  let dot = 0;
  let normB = 0;
  let normF = 0;

  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = row + x;
      if (!validMask[idx] || !validMask[idx - 1] || !validMask[idx + 1] || !validMask[idx - width] || !validMask[idx + width]) {
        continue;
      }
      const bgx = bGray[idx + 1] - bGray[idx - 1];
      const bgy = bGray[idx + width] - bGray[idx - width];
      const fgx = fGray[idx + 1] - fGray[idx - 1];
      const fgy = fGray[idx + width] - fGray[idx - width];
      dot += bgx * fgx + bgy * fgy;
      normB += bgx * bgx + bgy * bgy;
      normF += fgx * fgx + fgy * fgy;
      count++;
    }
  }
  if (count < 16 || normB <= 1e-8 || normF <= 1e-8) return 0;
  return dot / Math.sqrt(normB * normF);
}

/**
 * Compute the minimum Pearson NCC across all RGB channels that carry non-trivial variance
 * in both aligned images. Rejects random color textures that accidentally align luminance
 * (dominated by G) while remaining uncorrelated or negatively correlated in R or B.
 */
function computeMinChannelNcc(bRgba, fRgba, width, height, validMask) {
  const total = width * height;
  let minNcc = Infinity;
  let evaluatedChannels = 0;

  for (let ch = 0; ch < 3; ch++) {
    let count = 0;
    let sumB = 0;
    let sumF = 0;
    for (let i = 0; i < total; i++) {
      if (!validMask[i]) continue;
      const p = i * 4 + ch;
      sumB += bRgba[p];
      sumF += fRgba[p];
      count++;
    }
    if (count < 16) return 0;
    const meanB = sumB / count;
    const meanF = sumF / count;
    let num = 0;
    let denB = 0;
    let denF = 0;
    for (let i = 0; i < total; i++) {
      if (!validMask[i]) continue;
      const p = i * 4 + ch;
      const db = bRgba[p] - meanB;
      const df = fRgba[p] - meanF;
      num += db * df;
      denB += db * db;
      denF += df * df;
    }
    if (denB <= 1e-6 || denF <= 1e-6) continue;
    const ncc = num / Math.sqrt(denB * denF);
    if (ncc < minNcc) minNcc = ncc;
    evaluatedChannels++;
  }
  return evaluatedChannels > 0 ? minNcc : 0;
}

function countValid(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) count++;
  }
  return count;
}

/**
 * Rank score used during search/finalist selection: preserves true NCC when mutual
 * coverage is strong (>= 75%) and gently penalizes low-overlap corner alignments
 * so partial ~37% matches cannot beat full-frame alignment.
 */
function candidateRankScore(cand) {
  return cand.ncc - COVERAGE_PENALTY_WEIGHT * Math.max(0, COVERAGE_PENALTY_START - cand.coverage);
}

function identityDistance(cand) {
  return Math.abs(cand.dx) + Math.abs(cand.dy) + Math.abs(cand.angleDeg) + Math.abs(cand.scale - 1);
}

/**
 * Deterministic comparator: higher rank score, then higher raw NCC, then higher
 * mutual overlap coverage, then larger absolute overlap support, then transform closest to identity.
 * Returns true iff valid candidate `a` is strictly preferred over `b`.
 */
export function isBetterCandidate(a, b) {
  if (!a) return false;
  if (!b) return true;
  const rankDiff = candidateRankScore(a) - candidateRankScore(b);
  if (Math.abs(rankDiff) > 1e-6) return rankDiff > 0;
  const nccDiff = a.ncc - b.ncc;
  if (Math.abs(nccDiff) > 1e-6) return nccDiff > 0;
  const covDiff = a.coverage - b.coverage;
  if (Math.abs(covDiff) > 1e-6) return covDiff > 0;
  const supportDiff = (a.support ?? 0) - (b.support ?? 0);
  if (supportDiff !== 0) return supportDiff > 0;
  return identityDistance(a) < identityDistance(b) - 1e-9;
}

function compareCandidatesDesc(a, b) {
  if (isBetterCandidate(a, b)) return -1;
  if (isBetterCandidate(b, a)) return 1;
  return 0;
}

/**
 * Evaluate Pearson Normalized Cross-Correlation between baseline and follow-up
 * grayscale images under transform `{ dx, dy, angleDeg, scale }` (in full-resolution pixels).
 *
 * Coordinate convention (unit scale = exact 1:1 pixel pitch regardless of dimensions):
 * For full-res baseline pixel `(x, y)` relative to baseline center `(cxB, cyB)`:
 *   u = cxF + scale * (cos(theta) * (x - cxB) - sin(theta) * (y - cyB)) + dx
 *   v = cyF + scale * (sin(theta) * (x - cxB) + cos(theta) * (y - cyB)) + dy
 * where `+angleDeg` rotates clockwise in image coordinates (+x right, +y down).
 *
 * Returns `{ ncc, coverage, baselineCoverage, followupCoverage, support }` when valid,
 * or `null` if support, mutual FOV coverage, or luminance variance is insufficient.
 */
export function evaluateNcc(
  bGray, bw, bh, bValid,
  fGray, fw, fh, fValid,
  { dx = 0, dy = 0, angleDeg = 0, scale = 1 },
  {
    stride = 1,
    bilinear = true,
    minOverlap = DEFAULT_MIN_OVERLAP,
    minSupport = MIN_ABS_SUPPORT,
    bValidTotal = null,
    fValidTotal = null,
    bPitchX = 1,
    bPitchY = 1,
    fPitchX = 1,
    fPitchY = 1,
  } = {},
) {
  const bTotalValid = bValidTotal ?? countValid(bValid);
  const fTotalValid = fValidTotal ?? countValid(fValid);
  if (bTotalValid === 0 || fTotalValid === 0) return null;

  const cxB = (bw - 1) * 0.5;
  const cyB = (bh - 1) * 0.5;
  const cxF = (fw - 1) * 0.5;
  const cyF = (fh - 1) * 0.5;
  const rad = angleDeg * DEG_TO_RAD;
  const cosS = Math.cos(rad) * scale;
  const sinS = Math.sin(rad) * scale;

  const a11 = (cosS * bPitchX) / fPitchX;
  const a12 = (-sinS * bPitchY) / fPitchX;
  const a21 = (sinS * bPitchX) / fPitchY;
  const a22 = (cosS * bPitchY) / fPitchY;
  const tx = cxF + dx / fPitchX;
  const ty = cyF + dy / fPitchY;
  const maxU = fw - 1;
  const maxV = fh - 1;

  let n = 0;
  let bSampledValid = 0;
  let bAnchor = 0;
  let fAnchor = 0;
  let sumB = 0;
  let sumF = 0;
  let sumBB = 0;
  let sumFF = 0;
  let sumBF = 0;

  if (bilinear) {
    for (let y = 0; y < bh; y += stride) {
      const ry = y - cyB;
      const row = y * bw;
      const uRow = tx + a12 * ry;
      const vRow = ty + a22 * ry;
      for (let x = 0; x < bw; x += stride) {
        const bIdx = row + x;
        if (!bValid[bIdx]) continue;
        bSampledValid++;
        const rx = x - cxB;
        const u = uRow + a11 * rx;
        const v = vRow + a21 * rx;
        if (u < 0 || u > maxU || v < 0 || v > maxV) continue;

        const u0 = Math.floor(u);
        const v0 = Math.floor(v);
        const u1 = u0 < maxU ? u0 + 1 : u0;
        const v1 = v0 < maxV ? v0 + 1 : v0;
        const fu = u - u0;
        const fv = v - v0;
        const idx00 = v0 * fw + u0;
        const idx10 = v0 * fw + u1;
        const idx01 = v1 * fw + u0;
        const idx11 = v1 * fw + u1;
        if (!fValid[idx00] || (fu > 0 && !fValid[idx10]) || (fv > 0 && !fValid[idx01]) || (fu > 0 && fv > 0 && !fValid[idx11])) {
          continue;
        }
        const top = fGray[idx00] + (fGray[idx10] - fGray[idx00]) * fu;
        const bot = fGray[idx01] + (fGray[idx11] - fGray[idx01]) * fu;
        const fVal = top + (bot - top) * fv;
        const bVal = bGray[bIdx];

        if (n === 0) {
          bAnchor = bVal;
          fAnchor = fVal;
        }
        const db = bVal - bAnchor;
        const df = fVal - fAnchor;
        n++;
        sumB += db;
        sumF += df;
        sumBB += db * db;
        sumFF += df * df;
        sumBF += db * df;
      }
    }
  } else {
    for (let y = 0; y < bh; y += stride) {
      const ry = y - cyB;
      const row = y * bw;
      const uRow = tx + a12 * ry + 0.5;
      const vRow = ty + a22 * ry + 0.5;
      for (let x = 0; x < bw; x += stride) {
        const bIdx = row + x;
        if (!bValid[bIdx]) continue;
        bSampledValid++;
        const rx = x - cxB;
        const ui = Math.floor(uRow + a11 * rx);
        const vi = Math.floor(vRow + a21 * rx);
        if (ui < 0 || ui > maxU || vi < 0 || vi > maxV) continue;
        const fIdx = vi * fw + ui;
        if (!fValid[fIdx]) continue;

        const bVal = bGray[bIdx];
        const fVal = fGray[fIdx];
        if (n === 0) {
          bAnchor = bVal;
          fAnchor = fVal;
        }
        const db = bVal - bAnchor;
        const df = fVal - fAnchor;
        n++;
        sumB += db;
        sumF += df;
        sumBB += db * db;
        sumFF += df * df;
        sumBF += db * df;
      }
    }
  }

  if (bSampledValid === 0 || n < 16) return null;

  const bFullArea = bTotalValid * bPitchX * bPitchY;
  const fFullArea = fTotalValid * fPitchX * fPitchY;
  const minValidFullArea = Math.min(bFullArea, fFullArea);
  const matchedFullArea = n * stride * stride * bPitchX * bPitchY;
  const requiredSupport = Math.max(minSupport, 0.25 * minValidFullArea);
  if (matchedFullArea < requiredSupport) return null;

  const baselineCoverage = n / bSampledValid;
  const jacDet = (scale * scale * bPitchX * bPitchY) / (fPitchX * fPitchY);
  const followupCoverage = Math.min(1, (n * stride * stride * jacDet) / fTotalValid);
  // Normalize coverage against the maximum achievable overlap ratio for unequal crop areas
  // (equals 1 for equal-sized images; preserves full overlap when a smaller crop sits inside a larger frame).
  const sizeRatioB = Math.min(1, fFullArea / bFullArea);
  const sizeRatioF = Math.min(1, bFullArea / fFullArea);
  const effBaselineCoverage = Math.min(1, baselineCoverage / sizeRatioB);
  const effFollowupCoverage = Math.min(1, followupCoverage / sizeRatioF);
  if (effBaselineCoverage < minOverlap || effFollowupCoverage < minOverlap) return null;

  const varBSum = sumBB - (sumB * sumB) / n;
  const varFSum = sumFF - (sumF * sumF) / n;
  const varianceB = varBSum / n;
  const varianceF = varFSum / n;
  if (varianceB < MIN_VARIANCE || varianceF < MIN_VARIANCE) return null;

  const covSum = sumBF - (sumB * sumF) / n;
  const ncc = Math.max(-1, Math.min(1, covSum / Math.sqrt(varBSum * varFSum)));
  return {
    ncc,
    coverage: Math.min(effBaselineCoverage, effFollowupCoverage),
    baselineCoverage,
    followupCoverage,
    support: n,
  };
}

/**
 * Estimate dark-lesion centroid relative to image center (in full-res pixel units)
 * to seed coarse translation search.
 */
function estimateLesionCentroidOffset(gray, valid, width, height, pitchX = 1, pitchY = 1) {
  const sample = [];
  const step = Math.max(1, Math.floor((width * height) / 4096));
  for (let i = 0; i < gray.length; i += step) {
    if (valid[i]) sample.push(gray[i]);
  }
  if (!sample.length) return { x: 0, y: 0 };
  sample.sort((a, b) => a - b);
  const skinRef = sample[Math.floor(sample.length * 0.75)];
  const marginX = Math.floor(width * 0.08);
  const marginY = Math.floor(height * 0.08);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  let wSum = 0;
  let wx = 0;
  let wy = 0;
  for (let y = marginY; y < height - marginY; y++) {
    const row = y * width;
    for (let x = marginX; x < width - marginX; x++) {
      const idx = row + x;
      if (!valid[idx]) continue;
      const contrast = skinRef - gray[idx];
      if (contrast > 5) {
        const w = contrast * contrast;
        wSum += w;
        wx += (x - cx) * pitchX * w;
        wy += (y - cy) * pitchY * w;
      }
    }
  }
  if (wSum <= 0) return { x: 0, y: 0 };
  return { x: wx / wSum, y: wy / wSum };
}

/**
 * Coordinate-descent refinement of `(dx, dy, angleDeg[, scale])` in full-resolution units.
 * Returns the best valid candidate or `null` if no evaluated candidate is valid.
 */
function coordinateDescent(
  bGray, bw, bh, bValid,
  fGray, fw, fh, fValid,
  initial,
  {
    dxySteps,
    angleSteps,
    scaleSteps = [],
    allowScale = false,
    maxAngle = 25,
    stride = 1,
    minOverlap = DEFAULT_MIN_OVERLAP,
    bValidTotal,
    fValidTotal,
    bPitchX = 1,
    bPitchY = 1,
    fPitchX = 1,
    fPitchY = 1,
  },
) {
  const clampAngle = (a) => Math.max(-maxAngle, Math.min(maxAngle, a));
  const clampScale = (s) => Math.max(0.85, Math.min(1.15, s));
  const evalOpts = { stride, bilinear: true, minOverlap, bValidTotal, fValidTotal, bPitchX, bPitchY, fPitchX, fPitchY };

  const evalCandidate = (params) => {
    const res = evaluateNcc(bGray, bw, bh, bValid, fGray, fw, fh, fValid, params, evalOpts);
    return res ? { ...params, ...res } : null;
  };

  let best = evalCandidate(initial);
  const tryCandidate = (params) => {
    const res = evalCandidate(params);
    if (res && isBetterCandidate(res, best)) {
      best = res;
      return true;
    }
    return false;
  };

  if (!best) return null;

  const levels = Math.max(dxySteps.length, angleSteps.length, scaleSteps.length);
  for (let lvl = 0; lvl < levels; lvl++) {
    const stepXY = dxySteps[Math.min(lvl, dxySteps.length - 1)] ?? 0;
    const stepA = angleSteps[Math.min(lvl, angleSteps.length - 1)] ?? 0;
    const stepS = allowScale ? (scaleSteps[Math.min(lvl, scaleSteps.length - 1)] ?? 0) : 0;

    for (let iter = 0; iter < 8; iter++) {
      let improved = false;
      if (stepXY > 0) {
        if (tryCandidate({ dx: best.dx + stepXY, dy: best.dy, angleDeg: best.angleDeg, scale: best.scale })) improved = true;
        else if (tryCandidate({ dx: best.dx - stepXY, dy: best.dy, angleDeg: best.angleDeg, scale: best.scale })) improved = true;

        if (tryCandidate({ dx: best.dx, dy: best.dy + stepXY, angleDeg: best.angleDeg, scale: best.scale })) improved = true;
        else if (tryCandidate({ dx: best.dx, dy: best.dy - stepXY, angleDeg: best.angleDeg, scale: best.scale })) improved = true;

        // Diagonal probes accelerate convergence along slanted valleys.
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (tryCandidate({ dx: best.dx + sx * stepXY, dy: best.dy + sy * stepXY, angleDeg: best.angleDeg, scale: best.scale })) {
            improved = true;
            break;
          }
        }
      }
      if (stepA > 0 && maxAngle > 0) {
        const up = clampAngle(best.angleDeg + stepA);
        const dn = clampAngle(best.angleDeg - stepA);
        if (up !== best.angleDeg && tryCandidate({ dx: best.dx, dy: best.dy, angleDeg: up, scale: best.scale })) improved = true;
        else if (dn !== best.angleDeg && tryCandidate({ dx: best.dx, dy: best.dy, angleDeg: dn, scale: best.scale })) improved = true;
      }
      if (stepS > 0 && allowScale) {
        const up = clampScale(best.scale + stepS);
        const dn = clampScale(best.scale - stepS);
        if (up !== best.scale && tryCandidate({ dx: best.dx, dy: best.dy, angleDeg: best.angleDeg, scale: up })) improved = true;
        else if (dn !== best.scale && tryCandidate({ dx: best.dx, dy: best.dy, angleDeg: best.angleDeg, scale: dn })) improved = true;
      }
      if (!improved) break;
    }
  }
  return best;
}

/**
 * Bilinearly warp follow-up RGBA image onto the baseline frame `(bw × bh)` at exact pixel pitch
 * (`scale = 1.0` means true 1:1 pixel pitch regardless of baseline vs follow-up dimensions).
 * Warps the follow-up's original FOV+alpha validity mask along with the image and rejects any
 * bilinear footprint touching an excluded/transparent pixel to prevent straight-alpha bleed.
 */
export function warpRgba(
  followupRgba, fw, fh, bw, bh,
  { dx = 0, dy = 0, angleDeg = 0, scale = 1 },
  { followupValid = null } = {},
) {
  const n = bw * bh;
  const out = new Uint8ClampedArray(n * 4);
  const overlapMask = new Uint8Array(n);
  const fValid = followupValid ?? detectValidFov(followupRgba, fw, fh);
  const cxB = (bw - 1) * 0.5;
  const cyB = (bh - 1) * 0.5;
  const cxF = (fw - 1) * 0.5;
  const cyF = (fh - 1) * 0.5;
  const rad = angleDeg * DEG_TO_RAD;
  const cos = Math.cos(rad) * scale;
  const sin = Math.sin(rad) * scale;
  const maxU = fw - 1;
  const maxV = fh - 1;
  let overlapCount = 0;

  for (let y = 0; y < bh; y++) {
    const ry = y - cyB;
    const row = y * bw;
    const uRow = cxF - sin * ry + dx;
    const vRow = cyF + cos * ry + dy;
    for (let x = 0; x < bw; x++) {
      const rx = x - cxB;
      const u = uRow + cos * rx;
      const v = vRow + sin * rx;
      if (u < 0 || u > maxU || v < 0 || v > maxV) continue;

      const u0 = Math.floor(u);
      const v0 = Math.floor(v);
      const u1 = u0 < maxU ? u0 + 1 : u0;
      const v1 = v0 < maxV ? v0 + 1 : v0;
      const fu = u - u0;
      const fv = v - v0;
      const w00 = (1 - fu) * (1 - fv);
      const w10 = fu * (1 - fv);
      const w01 = (1 - fu) * fv;
      const w11 = fu * fv;

      const i00 = v0 * fw + u0;
      const i10 = v0 * fw + u1;
      const i01 = v1 * fw + u0;
      const i11 = v1 * fw + u1;

      const p00 = i00 * 4;
      const p10 = i10 * 4;
      const p01 = i01 * 4;
      const p11 = i11 * 4;

      // Reject any bilinear footprint that touches an excluded FOV or transparent pixel.
      if (
        (w00 > 0 && (!fValid[i00] || followupRgba[p00 + 3] < ALPHA_VALID_THRESHOLD))
        || (w10 > 0 && (!fValid[i10] || followupRgba[p10 + 3] < ALPHA_VALID_THRESHOLD))
        || (w01 > 0 && (!fValid[i01] || followupRgba[p01 + 3] < ALPHA_VALID_THRESHOLD))
        || (w11 > 0 && (!fValid[i11] || followupRgba[p11 + 3] < ALPHA_VALID_THRESHOLD))
      ) {
        continue;
      }

      const a = followupRgba[p00 + 3] * w00 + followupRgba[p10 + 3] * w10 + followupRgba[p01 + 3] * w01 + followupRgba[p11 + 3] * w11;
      if (a < ALPHA_VALID_THRESHOLD) continue;

      const idx = row + x;
      const dst = idx * 4;
      out[dst] = Math.round(followupRgba[p00] * w00 + followupRgba[p10] * w10 + followupRgba[p01] * w01 + followupRgba[p11] * w11);
      out[dst + 1] = Math.round(followupRgba[p00 + 1] * w00 + followupRgba[p10 + 1] * w10 + followupRgba[p01 + 1] * w01 + followupRgba[p11 + 1] * w11);
      out[dst + 2] = Math.round(followupRgba[p00 + 2] * w00 + followupRgba[p10 + 2] * w10 + followupRgba[p01 + 2] * w01 + followupRgba[p11 + 2] * w11);
      out[dst + 3] = Math.round(a);
      overlapMask[idx] = 1;
      overlapCount++;
    }
  }

  return {
    rgba: out,
    overlapMask,
    overlapCount,
    overlapPct: n > 0 ? (overlapCount / n) * 100 : 0,
  };
}

/**
 * Conservatively warp a binary mask (e.g. detected follow-up hair mask) onto the baseline frame:
 * marks a baseline pixel 1 if any contributing corner of its bilinear footprint in follow-up is 1.
 */
export function warpMaskAny(mask, fw, fh, bw, bh, { dx = 0, dy = 0, angleDeg = 0, scale = 1 }) {
  const out = new Uint8Array(bw * bh);
  if (!mask) return out;
  const cxB = (bw - 1) * 0.5;
  const cyB = (bh - 1) * 0.5;
  const cxF = (fw - 1) * 0.5;
  const cyF = (fh - 1) * 0.5;
  const rad = angleDeg * DEG_TO_RAD;
  const cos = Math.cos(rad) * scale;
  const sin = Math.sin(rad) * scale;
  const maxU = fw - 1;
  const maxV = fh - 1;

  for (let y = 0; y < bh; y++) {
    const ry = y - cyB;
    const row = y * bw;
    const uRow = cxF - sin * ry + dx;
    const vRow = cyF + cos * ry + dy;
    for (let x = 0; x < bw; x++) {
      const rx = x - cxB;
      const u = uRow + cos * rx;
      const v = vRow + sin * rx;
      if (u < 0 || u > maxU || v < 0 || v > maxV) continue;
      const u0 = Math.floor(u);
      const v0 = Math.floor(v);
      const u1 = u0 < maxU ? u0 + 1 : u0;
      const v1 = v0 < maxV ? v0 + 1 : v0;
      const fu = u - u0;
      const fv = v - v0;
      if (
        mask[v0 * fw + u0]
        || (fu > 0 && mask[v0 * fw + u1])
        || (fv > 0 && mask[v1 * fw + u0])
        || (fu > 0 && fv > 0 && mask[v1 * fw + u1])
      ) {
        out[row + x] = 1;
      }
    }
  }
  return out;
}

/**
 * Multi-scale rigid / similarity registration of follow-up onto baseline.
 *
 * Stage 1 (~128 px wide): coarse rotation sweep in [-maxAngle, +maxAngle] (step 2.5°)
 * and translation grid search centered around zero and the lesion centroid offset.
 * Stage 2 (~256 px wide + final full-resolution polish): coordinate-descent refinement
 * down to 0.25 px and 0.25° (plus optional scale in [0.85, 1.15]).
 *
 * Returns `{ registered: false, reason }` if no candidate achieves valid overlap support
 * and luminance variance (e.g., uniform/flat or all-black images).
 */
export function registerImages(
  baselineRgba, bw, bh,
  followupRgba, fw, fh,
  {
    maxAngle = 25,
    allowScale = false,
    baselineValid = null,
    followupValid = null,
    minAlignedNcc = MIN_ALIGNED_NCC,
    minGradientNcc = MIN_GRADIENT_NCC,
    minChannelNcc = MIN_CHANNEL_NCC,
    onProgress = null,
  } = {},
) {
  const bValid = baselineValid ?? detectValidFov(baselineRgba, bw, bh);
  const fValid = followupValid ?? detectValidFov(followupRgba, fw, fh);
  const bValidTotal = countValid(bValid);
  const fValidTotal = countValid(fValid);

  const fail = (reason = REGISTRATION_FAILURE_REASON) => ({
    registered: false,
    reason,
    dx: null,
    dy: null,
    angleDeg: null,
    scale: null,
    initialNcc: null,
    alignedNcc: null,
    overlapPct: 0,
    overlapCount: 0,
    warpedRgba: null,
    overlapMask: null,
  });

  if (bValidTotal < MIN_ABS_SUPPORT || fValidTotal < MIN_ABS_SUPPORT) {
    onProgress?.(1.0);
    return fail();
  }

  const bGray = rgbaToLuminance(baselineRgba, bw, bh);
  const fGray = rgbaToLuminance(followupRgba, fw, fh);

  // Use a single shared target factor so unequal dimensions keep true 1:1 physical pitch,
  // while never crushing a small crop below usable coarse/fine pyramid dimensions.
  const refMaxW = Math.max(bw, fw);
  const minDim = Math.min(Math.max(bw, bh), Math.max(fw, fh));
  const coarseFactor = Math.min(1, Math.max(128 / refMaxW, Math.min(1, 32 / Math.max(1, minDim))));
  const fineFactor = Math.min(1, Math.max(256 / refMaxW, Math.min(1, 64 / Math.max(1, minDim))));

  const bCoarse = downsampleGray(bGray, bValid, bw, bh, bw * coarseFactor, bh * coarseFactor);
  const fCoarse = downsampleGray(fGray, fValid, fw, fh, fw * coarseFactor, fh * coarseFactor);
  const bFine = downsampleGray(bGray, bValid, bw, bh, bw * fineFactor, bh * fineFactor);
  const fFine = downsampleGray(fGray, fValid, fw, fh, fw * fineFactor, fh * fineFactor);

  const bCoarseValidTotal = countValid(bCoarse.valid);
  const fCoarseValidTotal = countValid(fCoarse.valid);
  const bFineValidTotal = countValid(bFine.valid);
  const fFineValidTotal = countValid(fFine.valid);

  // Evaluate identity transform at full resolution with the same mutual support & variance rules.
  const fullStride = Math.max(1, Math.floor(Math.max(bw, bh) / 512));
  const identityParams = { dx: 0, dy: 0, angleDeg: 0, scale: 1 };
  const initialEvalRaw = evaluateNcc(
    bGray, bw, bh, bValid,
    fGray, fw, fh, fValid,
    identityParams,
    {
      stride: fullStride,
      bilinear: true,
      minOverlap: DEFAULT_MIN_OVERLAP,
      bValidTotal,
      fValidTotal,
    },
  );
  const initialEval = initialEvalRaw ? { ...identityParams, ...initialEvalRaw } : null;

  // Coarse lesion centroid offset guess in full-resolution pixels.
  const bCent = estimateLesionCentroidOffset(bCoarse.data, bCoarse.valid, bCoarse.width, bCoarse.height, bCoarse.pitchX, bCoarse.pitchY);
  const fCent = estimateLesionCentroidOffset(fCoarse.data, fCoarse.valid, fCoarse.width, fCoarse.height, fCoarse.pitchX, fCoarse.pitchY);
  const maxDimX = Math.max(bw, fw);
  const maxDimY = Math.max(bh, fh);
  const maxHintX = Math.round(maxDimX * 0.35);
  const maxHintY = Math.round(maxDimY * 0.35);
  const hintDx = Math.max(-maxHintX, Math.min(maxHintX, Math.round(fCent.x - bCent.x)));
  const hintDy = Math.max(-maxHintY, Math.min(maxHintY, Math.round(fCent.y - bCent.y)));

  // Build coarse angle schedule in [-maxAngle, +maxAngle], step 2.5°.
  const angles = [];
  if (maxAngle <= 0) {
    angles.push(0);
  } else {
    const step = 2.5;
    const count = Math.ceil(maxAngle / step);
    for (let k = -count; k <= count; k++) {
      const a = Math.max(-maxAngle, Math.min(maxAngle, Number((k * step).toFixed(4))));
      if (!angles.length || angles[angles.length - 1] !== a) angles.push(a);
    }
  }

  // Build coarse translation search points in full-resolution pixel units.
  const coarseStepX = Math.max(3 * bCoarse.pitchX, bw / 24);
  const coarseStepY = Math.max(3 * bCoarse.pitchY, bh / 24);
  const maxShiftX = maxDimX * 0.28;
  const maxShiftY = maxDimY * 0.28;
  const shiftSet = new Map();
  const addGrid = (cx, cy, rx, ry) => {
    for (let dy = cy - ry; dy <= cy + ry + 1e-6; dy += coarseStepY) {
      if (dy < -maxHintY || dy > maxHintY) continue;
      for (let dx = cx - rx; dx <= cx + rx + 1e-6; dx += coarseStepX) {
        if (dx < -maxHintX || dx > maxHintX) continue;
        const rdx = Math.round(dx);
        const rdy = Math.round(dy);
        shiftSet.set(`${rdx},${rdy}`, [rdx, rdy]);
      }
    }
  };
  addGrid(0, 0, maxShiftX, maxShiftY);
  if (Math.hypot(hintDx, hintDy) > Math.min(coarseStepX, coarseStepY)) {
    addGrid(hintDx, hintDy, fw * 0.16, fh * 0.16);
  }
  const coarseShifts = [...shiftSet.values()];
  const coarseStride = Math.max(1, Math.ceil(Math.sqrt((bCoarse.width * bCoarse.height) / (64 * 64))));

  // Stage 1: Coarse angle + translation search.
  const topCandidates = [];
  const pushTop = (cand) => {
    if (!cand) return;
    topCandidates.push(cand);
    topCandidates.sort(compareCandidatesDesc);
    if (topCandidates.length > 6) topCandidates.length = 6;
  };

  for (let ai = 0; ai < angles.length; ai++) {
    const angleDeg = angles[ai];
    let bestForAngle = null;
    for (let si = 0; si < coarseShifts.length; si++) {
      const [dx, dy] = coarseShifts[si];
      const res = evaluateNcc(
        bCoarse.data, bCoarse.width, bCoarse.height, bCoarse.valid,
        fCoarse.data, fCoarse.width, fCoarse.height, fCoarse.valid,
        { dx, dy, angleDeg, scale: 1 },
        {
          stride: coarseStride,
          bilinear: false,
          minOverlap: DEFAULT_MIN_OVERLAP,
          bValidTotal: bCoarseValidTotal,
          fValidTotal: fCoarseValidTotal,
          bPitchX: bCoarse.pitchX,
          bPitchY: bCoarse.pitchY,
          fPitchX: fCoarse.pitchX,
          fPitchY: fCoarse.pitchY,
        },
      );
      if (res) {
        const cand = { dx, dy, angleDeg, scale: 1, ...res };
        if (isBetterCandidate(cand, bestForAngle)) {
          bestForAngle = cand;
        }
      }
    }
    pushTop(bestForAngle);
    onProgress?.(0.05 + 0.45 * ((ai + 1) / angles.length));
  }

  // Always include identity as a seed so registration never worsens an already aligned pair.
  const coarseSeeds = [
    ...topCandidates.map((c) => ({ dx: c.dx, dy: c.dy, angleDeg: c.angleDeg, scale: c.scale })),
    { ...identityParams },
  ];

  // Refine top coarse peaks at full coarse resolution (~128 px) and test coarse scales if enabled.
  const coarseScales = allowScale ? [0.88, 0.94, 1.0, 1.06, 1.12] : [1.0];
  const coarseRefined = [];
  const coarsePitch = Math.max(bCoarse.pitchX, bCoarse.pitchY);

  for (const seed of coarseSeeds) {
    let bestScaleSeed = seed;
    if (allowScale) {
      let bestScaleEval = null;
      for (const s of coarseScales) {
        const params = { ...seed, scale: s };
        const res = evaluateNcc(
          bCoarse.data, bCoarse.width, bCoarse.height, bCoarse.valid,
          fCoarse.data, fCoarse.width, fCoarse.height, fCoarse.valid,
          params,
          {
            stride: 1,
            bilinear: true,
            minOverlap: DEFAULT_MIN_OVERLAP,
            bValidTotal: bCoarseValidTotal,
            fValidTotal: fCoarseValidTotal,
            bPitchX: bCoarse.pitchX,
            bPitchY: bCoarse.pitchY,
            fPitchX: fCoarse.pitchX,
            fPitchY: fCoarse.pitchY,
          },
        );
        if (res) {
          const cand = { ...params, ...res };
          if (isBetterCandidate(cand, bestScaleEval)) {
            bestScaleEval = cand;
            bestScaleSeed = params;
          }
        }
      }
    }
    const refined = coordinateDescent(
      bCoarse.data, bCoarse.width, bCoarse.height, bCoarse.valid,
      fCoarse.data, fCoarse.width, fCoarse.height, fCoarse.valid,
      bestScaleSeed,
      {
        dxySteps: [Math.max(coarsePitch, coarseStepX * 0.5), coarsePitch],
        angleSteps: [1.5, 0.75],
        scaleSteps: allowScale ? [0.03, 0.015] : [],
        allowScale,
        maxAngle,
        stride: 1,
        bValidTotal: bCoarseValidTotal,
        fValidTotal: fCoarseValidTotal,
        bPitchX: bCoarse.pitchX,
        bPitchY: bCoarse.pitchY,
        fPitchX: fCoarse.pitchX,
        fPitchY: fCoarse.pitchY,
      },
    );
    if (refined) coarseRefined.push(refined);
  }
  coarseRefined.sort(compareCandidatesDesc);
  onProgress?.(0.65);

  // Stage 2: Fine coordinate-descent refinement (~256 px wide) on top 2 peaks + identity.
  const fineSeeds = coarseRefined.slice(0, 2).map((c) => ({
    dx: c.dx,
    dy: c.dy,
    angleDeg: c.angleDeg,
    scale: c.scale,
  }));
  fineSeeds.push({ ...identityParams });

  const finePitch = Math.max(bFine.pitchX, bFine.pitchY);
  let bestFine = null;
  for (let i = 0; i < fineSeeds.length; i++) {
    const refined = coordinateDescent(
      bFine.data, bFine.width, bFine.height, bFine.valid,
      fFine.data, fFine.width, fFine.height, fFine.valid,
      fineSeeds[i],
      {
        dxySteps: [2.0 * finePitch, 1.0 * finePitch, 0.5 * finePitch, 0.25 * finePitch],
        angleSteps: [1.5, 0.75, 0.5, 0.25],
        scaleSteps: allowScale ? [0.03, 0.015, 0.008, 0.004] : [],
        allowScale,
        maxAngle,
        stride: 1,
        bValidTotal: bFineValidTotal,
        fValidTotal: fFineValidTotal,
        bPitchX: bFine.pitchX,
        bPitchY: bFine.pitchY,
        fPitchX: fFine.pitchX,
        fPitchY: fFine.pitchY,
      },
    );
    if (refined && isBetterCandidate(refined, bestFine)) bestFine = refined;
    onProgress?.(0.65 + 0.2 * ((i + 1) / fineSeeds.length));
  }

  // Final sub-pixel polish at full resolution down to 0.25 px and 0.25°.
  const fullSeeds = [];
  if (bestFine) {
    fullSeeds.push({ dx: bestFine.dx, dy: bestFine.dy, angleDeg: bestFine.angleDeg, scale: bestFine.scale });
  }
  fullSeeds.push({ ...identityParams });

  const polishStepsXY = bw > 256 ? [Math.max(1, finePitch * 0.5), 0.5, 0.25] : [0.5, 0.25];
  let bestFull = null;
  for (const seed of fullSeeds) {
    const polished = coordinateDescent(
      bGray, bw, bh, bValid,
      fGray, fw, fh, fValid,
      seed,
      {
        dxySteps: polishStepsXY,
        angleSteps: [0.5, 0.25],
        scaleSteps: allowScale ? [0.005, 0.0025] : [],
        allowScale,
        maxAngle,
        stride: fullStride,
        bValidTotal,
        fValidTotal,
      },
    );
    if (polished && isBetterCandidate(polished, bestFull)) {
      bestFull = polished;
    }
  }

  // Guarantee we never return a transform worse than identity when identity is valid.
  if (initialEval && isBetterCandidate(initialEval, bestFull)) {
    bestFull = initialEval;
  }

  if (!bestFull) {
    onProgress?.(1.0);
    return fail();
  }

  if (bestFull.ncc < minAlignedNcc) {
    onProgress?.(1.0);
    return fail(LOW_CORRELATION_FAILURE_REASON);
  }

  // Keep full floating-point precision for warping; round only when formatting for display.
  const transform = {
    dx: bestFull.dx,
    dy: bestFull.dy,
    angleDeg: bestFull.angleDeg,
    scale: allowScale ? bestFull.scale : 1,
  };

  onProgress?.(0.95);
  const warped = warpRgba(followupRgba, fw, fh, bw, bh, transform, { followupValid: fValid });
  const warpedGray = rgbaToLuminance(warped.rgba, bw, bh);
  const mutualValid = new Uint8Array(bw * bh);
  for (let i = 0; i < mutualValid.length; i++) {
    if (bValid[i] && warped.overlapMask[i]) mutualValid[i] = 1;
  }
  const gradientNcc = computeSignedGradientCorrelation(bGray, warpedGray, bw, bh, mutualValid);
  const minChNcc = computeMinChannelNcc(baselineRgba, warped.rgba, bw, bh, mutualValid);
  if (gradientNcc < minGradientNcc || minChNcc < minChannelNcc) {
    onProgress?.(1.0);
    return fail(LOW_CORRELATION_FAILURE_REASON);
  }
  onProgress?.(1.0);

  return {
    registered: true,
    reason: null,
    dx: transform.dx,
    dy: transform.dy,
    angleDeg: transform.angleDeg,
    scale: transform.scale,
    initialNcc: initialEval ? initialEval.ncc : null,
    alignedNcc: bestFull.ncc,
    gradientNcc: Number(gradientNcc.toFixed(4)),
    minChannelNcc: Number(minChNcc.toFixed(4)),
    mutualCoveragePct: Number((bestFull.coverage * 100).toFixed(2)),
    overlapPct: Number(warped.overlapPct.toFixed(2)),
    overlapCount: warped.overlapCount,
    warpedRgba: warped.rgba,
    overlapMask: warped.overlapMask,
  };
}
