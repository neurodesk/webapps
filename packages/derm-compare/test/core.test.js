// DOM-independent unit tests for preprocessing, CIEDE2000, multi-scale registration,
// transparency/FOV masks, hair anisotropy, failure modes, and change metrics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng } from "fast-png";
import { detectValidFov, shadesOfGray, suppressHairs } from "../src/core/preprocess.js";
import {
  LOW_CORRELATION_FAILURE_REASON,
  MIN_ALIGNED_NCC,
  REGISTRATION_FAILURE_REASON,
  evaluateNcc,
  isBetterCandidate,
  registerImages,
  warpRgba,
} from "../src/core/register.js";
import { analyzeChange, ciede2000, rgbToLab } from "../src/core/change.js";
import { computeSharedWorkingScale, runComparison } from "../src/core/pipeline.js";
import { buildChangeMapRgba, buildCheckerRgba } from "../src/display.js";
import { encodeRgbaPng } from "../src/outputs.js";

/**
 * Generate a synthetic dermoscopy RGBA image with warm skin background, subtle texture,
 * and an asymmetric pigmented lesion (main ellipse + off-center dark globule + eccentric rim)
 * so both translation and rotation are uniquely identifiable.
 */
function makeSyntheticDermoscopy({
  width = 256,
  height = 256,
  centerOffsetX = 0,
  centerOffsetY = 0,
  radiusX = 44,
  radiusY = 30,
  lesionRgb = [102, 62, 46],
  globuleRgb = [56, 32, 24],
  skinRgb = [224, 184, 158],
  colorGain = [1, 1, 1],
  addHair = false,
  pigmentDot = null, // { x, y, radius }
  includeLesion = true,
} = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const cx = (width - 1) * 0.5 + centerOffsetX;
  const cy = (height - 1) * 0.5 + centerOffsetY;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // Subtle skin pigment network texture.
      const tex = 4 * Math.sin(dx * 0.22) * Math.cos(dy * 0.19) + 3 * Math.sin((dx + dy) * 0.11);
      let r = skinRgb[0] + tex;
      let g = skinRgb[1] + tex * 0.85;
      let b = skinRgb[2] + tex * 0.7;

      if (includeLesion) {
        const eDist = Math.hypot(dx / radiusX, dy / radiusY);
        const lobeDist = Math.hypot((dx - radiusX * 0.52) / (radiusX * 0.42), (dy + radiusY * 0.35) / (radiusY * 0.42));
        const d = Math.min(eDist, lobeDist);
        const lesionWeight = 1 / (1 + Math.exp((d - 1.0) * 14));
        r = r * (1 - lesionWeight) + (lesionRgb[0] + tex * 0.6) * lesionWeight;
        g = g * (1 - lesionWeight) + (lesionRgb[1] + tex * 0.5) * lesionWeight;
        b = b * (1 - lesionWeight) + (lesionRgb[2] + tex * 0.4) * lesionWeight;

        const gDist = Math.hypot(dx + radiusX * 0.38, dy - radiusY * 0.22);
        const gWeight = 1 / (1 + Math.exp((gDist - radiusY * 0.3) * 0.8));
        r = r * (1 - gWeight) + globuleRgb[0] * gWeight;
        g = g * (1 - gWeight) + globuleRgb[1] * gWeight;
        b = b * (1 - gWeight) + globuleRgb[2] * gWeight;
      }

      if (pigmentDot) {
        const dotDist = Math.hypot(x - pigmentDot.x, y - pigmentDot.y);
        if (dotDist <= pigmentDot.radius) {
          r = 36;
          g = 22;
          b = 18;
        }
      }

      if (addHair) {
        // Crisp 2-pixel-wide diagonal hair across the frame.
        const hairDist = Math.abs(dy - (dx * 0.55 - 12));
        if (hairDist < 1.2) {
          r = 22;
          g = 18;
          b = 16;
        }
      }

      const p = (y * width + x) * 4;
      rgba[p] = Math.max(0, Math.min(255, Math.round(r * colorGain[0])));
      rgba[p + 1] = Math.max(0, Math.min(255, Math.round(g * colorGain[1])));
      rgba[p + 2] = Math.max(0, Math.min(255, Math.round(b * colorGain[2])));
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

/**
 * Forward-transform an image so that applying `warpRgba(followup, ..., { dx, dy, angleDeg, scale })`
 * maps follow-up back onto baseline.
 */
function transformImage(srcRgba, width, height, { dx = 0, dy = 0, angleDeg = 0, scale = 1 }, outW = width, outH = height) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const cxB = (width - 1) * 0.5;
  const cyB = (height - 1) * 0.5;
  const cxF = (outW - 1) * 0.5;
  const cyF = (outH - 1) * 0.5;
  const rad = (-angleDeg * Math.PI) / 180;
  const invScale = 1 / scale;
  const cos = Math.cos(rad) * invScale;
  const sin = Math.sin(rad) * invScale;
  const maxX = width - 1;
  const maxY = height - 1;

  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const du = u - cxF - dx;
      const dv = v - cyF - dy;
      const x = cxB + cos * du - sin * dv;
      const y = cyB + sin * du + cos * dv;
      const dst = (v * outW + u) * 4;
      const sx = Math.max(0, Math.min(maxX, x));
      const sy = Math.max(0, Math.min(maxY, y));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(maxX, x0 + 1);
      const y1 = Math.min(maxY, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const p00 = (y0 * width + x0) * 4;
      const p10 = (y0 * width + x1) * 4;
      const p01 = (y1 * width + x0) * 4;
      const p11 = (y1 * width + x1) * 4;
      out[dst] = Math.round(srcRgba[p00] * w00 + srcRgba[p10] * w10 + srcRgba[p01] * w01 + srcRgba[p11] * w11);
      out[dst + 1] = Math.round(srcRgba[p00 + 1] * w00 + srcRgba[p10 + 1] * w10 + srcRgba[p01 + 1] * w01 + srcRgba[p11 + 1] * w11);
      out[dst + 2] = Math.round(srcRgba[p00 + 2] * w00 + srcRgba[p10 + 2] * w10 + srcRgba[p01 + 2] * w01 + srcRgba[p11 + 2] * w11);
      out[dst + 3] = 255;
    }
  }
  return out;
}

test("CIEDE2000 matches all 34 Sharma, Wu & Dalal (2005) Table 1 reference pairs", () => {
  // Complete 34 reference pairs (kL = kC = kH = 1) from Sharma, Wu & Dalal (2005),
  // Color Research & Application 30(1):21-30, Table 1.
  const pairs = [
    [[50.0000, 2.6772, -79.7751], [50.0000, 0.0000, -82.7485], 2.0425],
    [[50.0000, 3.1571, -77.2803], [50.0000, 0.0000, -82.7485], 2.8615],
    [[50.0000, 2.8361, -74.0200], [50.0000, 0.0000, -82.7485], 3.4412],
    [[50.0000, -1.3802, -84.2814], [50.0000, 0.0000, -82.7485], 1.0000],
    [[50.0000, -1.1848, -84.8006], [50.0000, 0.0000, -82.7485], 1.0000],
    [[50.0000, -0.9009, -85.5211], [50.0000, 0.0000, -82.7485], 1.0000],
    [[50.0000, 0.0000, 0.0000], [50.0000, -1.0000, 2.0000], 2.3669],
    [[50.0000, -1.0000, 2.0000], [50.0000, 0.0000, 0.0000], 2.3669],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0009], 7.1792],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0010], 7.1792],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0011], 7.2195],
    [[50.0000, 2.4900, -0.0010], [50.0000, -2.4900, 0.0012], 7.2195],
    [[50.0000, -0.0010, 2.4900], [50.0000, 0.0009, -2.4900], 4.8045],
    [[50.0000, -0.0010, 2.4900], [50.0000, 0.0010, -2.4900], 4.8045],
    [[50.0000, -0.0010, 2.4900], [50.0000, 0.0011, -2.4900], 4.7461],
    [[50.0000, 2.5000, 0.0000], [50.0000, 0.0000, -2.5000], 4.3065],
    [[50.0000, 2.5000, 0.0000], [73.0000, 25.0000, -18.0000], 27.1492],
    [[50.0000, 2.5000, 0.0000], [61.0000, -5.0000, 29.0000], 22.8977],
    [[50.0000, 2.5000, 0.0000], [56.0000, -27.0000, -3.0000], 31.9030],
    [[50.0000, 2.5000, 0.0000], [58.0000, 24.0000, 15.0000], 19.4535],
    [[50.0000, 2.5000, 0.0000], [50.0000, 3.1736, 0.5854], 1.0000],
    [[50.0000, 2.5000, 0.0000], [50.0000, 3.2972, 0.0000], 1.0000],
    [[50.0000, 2.5000, 0.0000], [50.0000, 1.8634, 0.5757], 1.0000],
    [[50.0000, 2.5000, 0.0000], [50.0000, 3.2592, 0.3350], 1.0000],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
    [[61.2901, 3.7196, -5.3901], [61.4292, 2.2480, -4.9620], 1.8731],
    [[35.0831, -44.1164, 3.7933], [35.0232, -40.0716, 1.5901], 1.8645],
    [[22.7233, 20.0904, -46.6940], [23.0331, 14.9730, -42.5619], 2.0373],
    [[36.4612, 47.8580, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
    [[90.8027, -2.0831, 1.4410], [91.1528, -1.6435, 0.0447], 1.4441],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
    [[6.7747, -0.2908, -2.4247], [5.8714, -0.0985, -2.2286], 0.6377],
    [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  assert.equal(pairs.length, 34);
  pairs.forEach(([lab1, lab2, expected], index) => {
    const actual = ciede2000(...lab1, ...lab2);
    assert.ok(Math.abs(actual - expected) < 1e-4, `pair #${index + 1}: expected ${expected}, got ${actual}`);
  });
  assert.equal(ciede2000(50, 0, 0, 50, 0, 0), 0);
  const [L, a, b] = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(L - 100) < 0.05 && Math.abs(a) < 0.05 && Math.abs(b) < 0.05);
});

test("Shades of Gray (p=6) reduces white-balance color drift", () => {
  const width = 128;
  const height = 128;
  const clean = makeSyntheticDermoscopy({ width, height, radiusX: 24, radiusY: 18, skinRgb: [195, 160, 138] });
  const warmCast = makeSyntheticDermoscopy({ width, height, radiusX: 24, radiusY: 18, skinRgb: [195, 160, 138], colorGain: [1.12, 1.0, 0.84] });

  const normClean = shadesOfGray(clean, width, height);
  const normWarm = shadesOfGray(warmCast, width, height);

  let diffBefore = 0;
  let diffAfter = 0;
  const meanRgb = (buf) => {
    let r = 0;
    let g = 0;
    let b = 0;
    const n = buf.length / 4;
    for (let i = 0; i < buf.length; i += 4) {
      r += buf[i];
      g += buf[i + 1];
      b += buf[i + 2];
    }
    return [r / n, g / n, b / n];
  };
  for (let i = 0; i < clean.length; i += 4) {
    diffBefore += Math.abs(clean[i] - warmCast[i]) + Math.abs(clean[i + 1] - warmCast[i + 1]) + Math.abs(clean[i + 2] - warmCast[i + 2]);
    diffAfter += Math.abs(normClean.rgba[i] - normWarm.rgba[i]) + Math.abs(normClean.rgba[i + 1] - normWarm.rgba[i + 1]) + Math.abs(normClean.rgba[i + 2] - normWarm.rgba[i + 2]);
  }
  const mClean = meanRgb(normClean.rgba);
  const mWarm = meanRgb(normWarm.rgba);
  const rbBefore = Math.abs((meanRgb(clean)[0] / meanRgb(clean)[2]) - (meanRgb(warmCast)[0] / meanRgb(warmCast)[2]));
  const rbAfter = Math.abs((mClean[0] / mClean[2]) - (mWarm[0] / mWarm[2]));
  assert.ok(diffAfter < diffBefore * 0.35, `expected strong white-balance reduction: before=${diffBefore}, after=${diffAfter}`);
  assert.ok(rbAfter < 0.01 && rbAfter < rbBefore * 0.05, `expected R/B chromaticity match: before=${rbBefore}, after=${rbAfter}`);
});

test("anisotropic hair suppression removes dark hair while preserving isolated 5-px pigment dots", () => {
  const width = 160;
  const height = 160;
  const dot = { x: 34, y: 124, radius: 2.5 }; // 5-px diameter isolated dark pigment dot
  const clean = makeSyntheticDermoscopy({ width, height, radiusX: 28, radiusY: 20, addHair: false, pigmentDot: dot });
  const hairy = makeSyntheticDermoscopy({ width, height, radiusX: 28, radiusY: 20, addHair: true, pigmentDot: dot });

  const suppressed = suppressHairs(hairy, width, height);
  assert.ok(suppressed.hairFraction > 0.005 && suppressed.hairFraction < 0.08, `unexpected hairFraction ${suppressed.hairFraction}`);

  // Verify the isolated 5-px dark pigment dot is NOT masked or erased.
  const dotCenterIdx = dot.y * width + dot.x;
  assert.equal(suppressed.hairMask[dotCenterIdx], 0, "isolated 5-px pigment dot center must not be flagged as hair");
  assert.equal(suppressed.rgba[dotCenterIdx * 4], hairy[dotCenterIdx * 4], "isolated 5-px pigment dot RGB must be preserved");

  // Verify the hair itself was strongly suppressed compared to the clean image.
  let errHairy = 0;
  let errSuppressed = 0;
  for (let i = 0; i < clean.length; i += 4) {
    errHairy += Math.abs(clean[i] - hairy[i]);
    errSuppressed += Math.abs(clean[i] - suppressed.rgba[i]);
  }
  assert.ok(errSuppressed < errHairy * 0.45, `hair suppression should cut error vs clean image: before=${errHairy}, after=${errSuppressed}`);
});

test("multi-scale rigid registration recovers known (dx, dy, angle) and improves NCC", () => {
  const width = 256;
  const height = 256;
  const baseline = makeSyntheticDermoscopy({ width, height });
  const truth = { dx: 11.5, dy: -8.25, angleDeg: 13.5, scale: 1 };
  const followup = transformImage(baseline, width, height, truth);

  const reg = registerImages(baseline, width, height, followup, width, height, {
    maxAngle: 25,
    allowScale: false,
  });

  assert.equal(reg.registered, true);
  assert.ok(reg.alignedNcc > reg.initialNcc + 0.15, `expected NCC jump: initial=${reg.initialNcc}, aligned=${reg.alignedNcc}`);
  assert.ok(reg.alignedNcc > 0.96, `expected high aligned NCC, got ${reg.alignedNcc}`);
  assert.ok(Math.abs(reg.dx - truth.dx) < 1.0, `dx mismatch: got ${reg.dx}, expected ${truth.dx}`);
  assert.ok(Math.abs(reg.dy - truth.dy) < 1.0, `dy mismatch: got ${reg.dy}, expected ${truth.dy}`);
  assert.ok(Math.abs(reg.angleDeg - truth.angleDeg) < 0.75, `angle mismatch: got ${reg.angleDeg}, expected ${truth.angleDeg}`);
  assert.equal(reg.scale, 1);
  assert.ok(reg.overlapPct > 75);
});

test("unequal-dimension rigid registration (1024x672 vs 1024x685) keeps exact 1.0x pixel pitch", () => {
  const bw = 1024;
  const bh = 672;
  const fw = 1024;
  const fh = 685;
  const baseline = makeSyntheticDermoscopy({ width: bw, height: bh, radiusX: 150, radiusY: 105 });
  const truth = { dx: 14, dy: -9, angleDeg: 5, scale: 1 };
  const followup = transformImage(baseline, bw, bh, truth, fw, fh);

  const reg = registerImages(baseline, bw, bh, followup, fw, fh, {
    maxAngle: 15,
    allowScale: false,
  });

  assert.equal(reg.registered, true);
  assert.equal(reg.scale, 1);
  assert.ok(reg.alignedNcc > 0.96, `expected high unit-scale NCC on unequal dims, got ${reg.alignedNcc}`);
  assert.ok(Math.abs(reg.dx - truth.dx) < 1.5, `dx mismatch: got ${reg.dx}, expected ${truth.dx}`);
  assert.ok(Math.abs(reg.dy - truth.dy) < 1.5, `dy mismatch: got ${reg.dy}, expected ${truth.dy}`);
  assert.ok(Math.abs(reg.angleDeg - truth.angleDeg) < 0.75, `angle mismatch: got ${reg.angleDeg}, expected ${truth.angleDeg}`);
});

test("similarity registration recovers scale and marks physical growth indeterminate", () => {
  const width = 224;
  const height = 224;
  const baseline = makeSyntheticDermoscopy({ width, height, radiusX: 38, radiusY: 26 });
  const truth = { dx: -7, dy: 6, angleDeg: -9, scale: 1.08 };
  const followup = transformImage(baseline, width, height, truth);

  const result = runComparison({
    baselineRgba: baseline,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: followup,
    followupWidth: width,
    followupHeight: height,
    settings: { normalizeColor: false, suppressHair: false, allowScale: true, maxAngle: 25 },
  });

  assert.equal(result.registered, true);
  assert.ok(result.registration.alignedNcc > result.registration.initialNcc + 0.1);
  assert.ok(result.registration.alignedNcc > 0.95);
  assert.ok(Math.abs(result.registration.scale - truth.scale) < 0.03, `scale mismatch: got ${result.registration.scale}`);
  assert.ok(Math.abs(result.registration.angleDeg - truth.angleDeg) < 1.25);
  assert.equal(result.metrics.growthStatus, "indeterminate-scale-fitted");
});

test("flat uniform and all-black images return explicit registration failure and suppress metrics", () => {
  const width = 128;
  const height = 128;

  // All-black opaque pair.
  const black = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < black.length; i += 4) black[i] = 255;
  const blackRes = runComparison({
    baselineRgba: black,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: black,
    followupWidth: width,
    followupHeight: height,
  });
  assert.equal(blackRes.registered, false);
  assert.equal(blackRes.reason, REGISTRATION_FAILURE_REASON);
  assert.equal(blackRes.metrics, null);
  assert.equal(blackRes.warpedFollowupRgba, null);

  // Uniform mid-gray opaque pair (zero luminance variance).
  const flat = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = 140;
    flat[i + 1] = 140;
    flat[i + 2] = 140;
    flat[i + 3] = 255;
  }
  const flatRes = runComparison({
    baselineRgba: flat,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: flat,
    followupWidth: width,
    followupHeight: height,
  });
  assert.equal(flatRes.registered, false);
  assert.equal(flatRes.reason, REGISTRATION_FAILURE_REASON);
  assert.equal(flatRes.metrics, null);

  // Direct evaluateNcc returns null for zero variance and insufficient overlap.
  const gray = new Float32Array(width * height).fill(128);
  const valid = new Uint8Array(width * height).fill(1);
  assert.equal(evaluateNcc(gray, width, height, valid, gray, width, height, valid, { dx: 0, dy: 0 }), null);

  // Tie-breaking prefers higher coverage, then transform closest to identity.
  assert.equal(
    isBetterCandidate({ ncc: 0.9, coverage: 0.95, dx: 5, dy: 0, angleDeg: 0, scale: 1 }, { ncc: 0.9, coverage: 0.8, dx: 0, dy: 0, angleDeg: 0, scale: 1 }),
    true,
  );
  assert.equal(
    isBetterCandidate({ ncc: 0.9, coverage: 0.95, dx: 0, dy: 0, angleDeg: 0, scale: 1 }, { ncc: 0.9, coverage: 0.95, dx: 2, dy: 0, angleDeg: 0, scale: 1 }),
    true,
  );
});

test("empty lesion segmentation reports null morphometry (never 0%) and explicit status", () => {
  const width = 128;
  const height = 128;
  // Flat uniform warm skin (no lesion contrast -> Otsu returns null -> empty mask).
  const skinOnly = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < skinOnly.length; i += 4) {
    skinOnly[i] = 210;
    skinOnly[i + 1] = 175;
    skinOnly[i + 2] = 152;
    skinOnly[i + 3] = 255;
  }
  const lesionImg = makeSyntheticDermoscopy({ width, height, radiusX: 24, radiusY: 18 });
  const overlapMask = new Uint8Array(width * height).fill(1);

  const change = analyzeChange({
    baselineRgba: skinOnly,
    warpedFollowupRgba: lesionImg,
    overlapMask,
    width,
    height,
  });
  assert.equal(change.metrics.baselineAreaPx, 0);
  assert.ok(change.metrics.followupAreaPx > 0);
  assert.equal(change.metrics.segmentationStatus, "baseline-empty");
  assert.equal(change.metrics.growthStatus, "unavailable-empty-segmentation");
  assert.equal(change.metrics.areaChangePct, null);
  assert.equal(change.metrics.dice, null);
  assert.equal(change.metrics.jaccard, null);
  assert.equal(change.metrics.centroidShiftPx, null);
});

test("transparent pixels (alpha < 128) are excluded everywhere and alpha is preserved in checkerboard", () => {
  const width = 128;
  const height = 128;
  const base = makeSyntheticDermoscopy({ width, height, radiusX: 28, radiusY: 22 });
  const foll = new Uint8ClampedArray(base);

  // Carve an interior transparent hole inside the lesion (alpha = 0, RGB = 0).
  for (let y = 58; y <= 68; y++) {
    for (let x = 58; x <= 68; x++) {
      const p = (y * width + x) * 4;
      base[p] = 0;
      base[p + 1] = 0;
      base[p + 2] = 0;
      base[p + 3] = 0;
      foll[p] = 0;
      foll[p + 1] = 0;
      foll[p + 2] = 0;
      foll[p + 3] = 0;
    }
  }

  const fov = detectValidFov(base, width, height);
  const holeIdx = 63 * width + 63;
  assert.equal(fov[holeIdx], 0, "interior transparent pixel must be excluded by detectValidFov");

  const warped = warpRgba(foll, width, height, width, height, { dx: 0.5, dy: 0.5, angleDeg: 0, scale: 1 }, { followupValid: fov });
  assert.equal(warped.overlapMask[holeIdx], 0, "warped overlap must exclude transparent pixels");
  assert.equal(warped.rgba[holeIdx * 4 + 3], 0, "warped RGBA must remain transparent over excluded footprint");

  const change = analyzeChange({
    baselineRgba: base,
    warpedFollowupRgba: warped.rgba,
    baselineValid: fov,
    overlapMask: warped.overlapMask,
    width,
    height,
  });
  assert.equal(change.validMask[holeIdx], 0, "analysis validMask must exclude transparent pixels");
  assert.equal(change.baselineMask[holeIdx], 0, "hole filling must not fill interior transparent pixels");
  assert.equal(change.followupMask[holeIdx], 0, "hole filling must not fill interior transparent pixels");
  assert.equal(change.metrics.clippedByFov, true, "lesion bordering an interior invalid hole touches valid FOV boundary");

  const checker = buildCheckerRgba({
    baselineRgba: base,
    warpedFollowupRgba: warped.rgba,
    validMask: change.validMask,
    width,
    height,
  });
  assert.equal(checker[holeIdx * 4 + 3], 0, "checkerboard must preserve transparency");

  // All-transparent pair must never fall back to raw geometric overlapMask.
  const allTransparent = new Uint8ClampedArray(width * height * 4);
  const fullGeo = new Uint8Array(width * height).fill(1);
  const emptyChange = analyzeChange({
    baselineRgba: allTransparent,
    warpedFollowupRgba: allTransparent,
    overlapMask: fullGeo,
    width,
    height,
  });
  assert.equal(emptyChange.metrics.validOverlapPx, 0);
  assert.equal(emptyChange.metrics.areaChangePct, null);
});

test("full comparison pipeline measures stable vs growing/darkening lesions and excludes hair from ΔE2000", () => {
  const width = 224;
  const height = 224;
  const baseline = makeSyntheticDermoscopy({ width, height, radiusX: 34, radiusY: 24, lesionRgb: [118, 76, 58] });

  // Stable follow-up: identical lesion shifted and rotated, plus a hair on follow-up only.
  const stableFollowupWithHair = transformImage(
    makeSyntheticDermoscopy({ width, height, radiusX: 34, radiusY: 24, lesionRgb: [118, 76, 58], addHair: true }),
    width,
    height,
    { dx: 8, dy: -6, angleDeg: 10, scale: 1 },
  );
  const stable = runComparison({
    baselineRgba: baseline,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: stableFollowupWithHair,
    followupWidth: width,
    followupHeight: height,
    settings: { normalizeColor: true, suppressHair: true, allowScale: false, maxAngle: 25 },
  });
  assert.equal(stable.registered, true);
  assert.ok(stable.registration.alignedNcc > 0.94);
  assert.ok(stable.metrics.hairExcludedPx > 100, `expected detected hair pixels excluded from ΔE2000, got ${stable.metrics.hairExcludedPx}`);
  assert.ok(Math.abs(stable.metrics.areaChangePct) < 6, `stable area change should be near 0%, got ${stable.metrics.areaChangePct}%`);
  assert.ok(stable.metrics.dice > 0.93, `expected high Dice for stable lesion, got ${stable.metrics.dice}`);
  assert.ok(stable.metrics.lesionMeanDeltaE < 3.0, `expected low hair-excluded ΔE2000 for stable lesion, got ${stable.metrics.lesionMeanDeltaE}`);
  assert.equal(stable.metrics.growthStatus, "measured");

  // Evolving follow-up: lesion expands ~35% in area and darkens noticeably, plus shift/rotation.
  const grownRaw = makeSyntheticDermoscopy({
    width,
    height,
    radiusX: 40,
    radiusY: 28,
    lesionRgb: [64, 34, 28],
    globuleRgb: [32, 18, 16],
  });
  const grownFollowup = transformImage(grownRaw, width, height, { dx: -7, dy: 5, angleDeg: -8, scale: 1 });
  const evolving = runComparison({
    baselineRgba: baseline,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: grownFollowup,
    followupWidth: width,
    followupHeight: height,
    settings: { normalizeColor: false, suppressHair: false, allowScale: false, maxAngle: 25 },
  });
  assert.equal(evolving.registered, true);
  assert.ok(evolving.registration.alignedNcc > evolving.registration.initialNcc);
  assert.ok(evolving.metrics.areaChangePct > 20 && evolving.metrics.areaChangePct < 60, `expected ~36% area growth, got ${evolving.metrics.areaChangePct}%`);
  assert.ok(evolving.metrics.lesionMeanDeltaE > 8, `expected large lesion ΔE2000, got ${evolving.metrics.lesionMeanDeltaE}`);
  assert.equal(evolving.metrics.rawLesionMeanDeltaE, evolving.metrics.lesionMeanDeltaE);
  assert.ok(evolving.metrics.lesionP95DeltaE > evolving.metrics.lesionMeanDeltaE);
  assert.ok(evolving.metrics.lesionDeltaEOver10Pct > 30, `expected high ΔE>10 fraction, got ${evolving.metrics.lesionDeltaEOver10Pct}%`);
  assert.ok(evolving.metrics.lesionMeanDeltaE > evolving.metrics.skinMeanDeltaE + 5);

  // Verify buildChangeMapRgba respects opacity === 0 cleanly (no heatmap blend).
  const zeroOpacity = buildChangeMapRgba({
    baselineRgba: baseline,
    deltaEMap: evolving.deltaEMap,
    validMask: evolving.validMask,
    deltaEMask: evolving.deltaEMask,
    width,
    height,
    opacity: 0,
    showContours: false,
  });
  const centerIdx = Math.floor(height / 2) * width + Math.floor(width / 2);
  assert.equal(zeroOpacity[centerIdx * 4], baseline[centerIdx * 4]);
  assert.equal(zeroOpacity[centerIdx * 4 + 1], baseline[centerIdx * 4 + 1]);
  assert.equal(zeroOpacity[centerIdx * 4 + 2], baseline[centerIdx * 4 + 2]);
});

function makeNoiseRgba(width, height, seed) {
  let state = seed >>> 0;
  const nextByte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 24) & 255;
  };
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = nextByte();
    rgba[i + 1] = nextByte();
    rgba[i + 2] = nextByte();
    rgba[i + 3] = 255;
  }
  return rgba;
}

test("uncorrelated noise images fail minimum NCC quality floor and isBetterCandidate breaks ties by support", () => {
  assert.equal(MIN_ALIGNED_NCC, 0.45);

  // Larger absolute support wins before identity distance when NCC and coverage tie.
  assert.equal(
    isBetterCandidate(
      { ncc: 0.9, coverage: 0.95, support: 20000, dx: 5, dy: 0, angleDeg: 0, scale: 1 },
      { ncc: 0.9, coverage: 0.95, support: 12000, dx: 0, dy: 0, angleDeg: 0, scale: 1 },
    ),
    true,
  );
  assert.equal(
    isBetterCandidate(
      { ncc: 0.9, coverage: 0.95, support: 12000, dx: 0, dy: 0, angleDeg: 0, scale: 1 },
      { ncc: 0.9, coverage: 0.95, support: 20000, dx: 5, dy: 0, angleDeg: 0, scale: 1 },
    ),
    false,
  );

  const noiseA = makeNoiseRgba(160, 160, 0x12345678);
  const noiseB = makeNoiseRgba(160, 160, 0x9e3779b9);
  const res = runComparison({
    baselineRgba: noiseA,
    baselineWidth: 160,
    baselineHeight: 160,
    followupRgba: noiseB,
    followupWidth: 160,
    followupHeight: 160,
    settings: { normalizeColor: false, suppressHair: false, allowScale: false, maxAngle: 15 },
  });
  assert.equal(res.registered, false);
  assert.equal(res.reason, LOW_CORRELATION_FAILURE_REASON);
  assert.equal(res.metrics, null);
  assert.equal(res.warpedFollowupRgba, null);
});

test("shared uniform downscale on 1024x672 vs 2048x1344 crop preserves ~0% area change in rigid mode", () => {
  const fw = 2048;
  const fh = 1344;
  const bw = 1024;
  const bh = 672;
  assert.equal(computeSharedWorkingScale(bw, bh, fw, fh), 0.5);

  const followup = makeSyntheticDermoscopy({ width: fw, height: fh, radiusX: 160, radiusY: 110 });
  // Extract the centered 1024x672 crop with identical source-pixel lesion size.
  const baseline = new Uint8ClampedArray(bw * bh * 4);
  const xOff = Math.floor((fw - bw) / 2);
  const yOff = Math.floor((fh - bh) / 2);
  for (let y = 0; y < bh; y++) {
    const srcStart = ((y + yOff) * fw + xOff) * 4;
    baseline.set(followup.subarray(srcStart, srcStart + bw * 4), y * bw * 4);
  }

  const res = runComparison({
    baselineRgba: baseline,
    baselineWidth: bw,
    baselineHeight: bh,
    followupRgba: followup,
    followupWidth: fw,
    followupHeight: fh,
    settings: { normalizeColor: false, suppressHair: false, allowScale: false, maxAngle: 10 },
  });

  assert.equal(res.registered, true);
  assert.equal(res.workingScale, 0.5);
  assert.equal(res.width, 512);
  assert.equal(res.height, 336);
  assert.equal(res.followupWidth, 1024);
  assert.equal(res.followupHeight, 672);
  assert.equal(res.registration.scale, 1);
  assert.ok(res.registration.alignedNcc > 0.94, `expected high aligned NCC, got ${res.registration.alignedNcc}`);
  assert.ok(Math.abs(res.metrics.areaChangePct) < 5, `expected ~0% area change, got ${res.metrics.areaChangePct}%`);
});

test("transparent baseline hole zeros alpha in aligned follow-up RGBA and encoded PNG", () => {
  const width = 160;
  const height = 160;
  const baseline = makeSyntheticDermoscopy({ width, height, radiusX: 30, radiusY: 22 });
  // Follow-up is completely opaque everywhere, including over the baseline hole.
  const followup = transformImage(baseline, width, height, { dx: 4, dy: -3, angleDeg: 5, scale: 1 });

  for (let y = 74; y <= 84; y++) {
    for (let x = 74; x <= 84; x++) {
      const p = (y * width + x) * 4;
      baseline[p] = 0;
      baseline[p + 1] = 0;
      baseline[p + 2] = 0;
      baseline[p + 3] = 0;
    }
  }

  const res = runComparison({
    baselineRgba: baseline,
    baselineWidth: width,
    baselineHeight: height,
    followupRgba: followup,
    followupWidth: width,
    followupHeight: height,
    settings: { normalizeColor: false, suppressHair: false, allowScale: false, maxAngle: 15 },
  });

  assert.equal(res.registered, true);
  const holeIdx = 79 * width + 79;
  const validIdx = 20 * width + 20;
  assert.equal(res.validMask[holeIdx], 0);
  assert.equal(res.warpedFollowupRgba[holeIdx * 4 + 3], 0, "aligned RGBA alpha must be 0 over transparent baseline hole");
  assert.equal(res.validMask[validIdx], 1);
  assert.equal(res.warpedFollowupRgba[validIdx * 4 + 3], 255);

  const decodedAligned = decodePng(encodeRgbaPng(res.warpedFollowupRgba, res.width, res.height));
  assert.equal(decodedAligned.data[holeIdx * 4 + 3], 0, "encoded aligned PNG must have alpha=0 over transparent baseline hole");
  assert.equal(decodedAligned.data[validIdx * 4 + 3], 255);
});

test("independently generated 160x160 coarse block-noise pairs are rejected by NCC + gradient verification", () => {
  const makeBlockNoise = (size, block, seed) => {
    let s = seed >>> 0;
    const next = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) >>> 24) & 255;
    const gw = Math.ceil(size / block);
    const grid = new Uint8Array(gw * gw * 3);
    for (let i = 0; i < grid.length; i++) grid[i] = next();
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const g = (Math.floor(y / block) * gw + Math.floor(x / block)) * 3;
        const p = (y * size + x) * 4;
        rgba[p] = grid[g];
        rgba[p + 1] = grid[g + 1];
        rgba[p + 2] = grid[g + 2];
        rgba[p + 3] = 255;
      }
    }
    return rgba;
  };

  for (const [block, seedA, seedB] of [
    [12, 1012, 9012],
    [16, 1016, 9016],
    [16, 1045, 9049],
    [24, 1024, 9024],
    [24, 1090, 9098],
    [32, 1032, 9032],
    [32, 1045, 9049],
  ]) {
    const a = makeBlockNoise(160, block, seedA);
    const b = makeBlockNoise(160, block, seedB);
    const res = runComparison({
      baselineRgba: a,
      baselineWidth: 160,
      baselineHeight: 160,
      followupRgba: b,
      followupWidth: 160,
      followupHeight: 160,
      settings: { normalizeColor: true, suppressHair: true, allowScale: false, maxAngle: 25 },
    });
    assert.equal(res.registered, false, `${block}px random block noise (${seedA}/${seedB}) must be rejected`);
    assert.equal(res.reason, LOW_CORRELATION_FAILURE_REASON);
    assert.equal(res.metrics, null);
    assert.equal(res.warpedFollowupRgba, null);
  }
});

test("exact 63x63 crop from a 4096x512 frame stays at source pitch and reports 0% area change", () => {
  const fw = 4096;
  const fh = 512;
  const bw = 63;
  const bh = 63;
  assert.equal(computeSharedWorkingScale(bw, bh, fw, fh), 1);

  const followup = makeSyntheticDermoscopy({ width: fw, height: fh, radiusX: 16, radiusY: 12 });
  const baseline = new Uint8ClampedArray(bw * bh * 4);
  const xOff = Math.floor((fw - bw) / 2);
  const yOff = Math.floor((fh - bh) / 2);
  for (let y = 0; y < bh; y++) {
    const srcStart = ((y + yOff) * fw + xOff) * 4;
    baseline.set(followup.subarray(srcStart, srcStart + bw * 4), y * bw * 4);
  }

  const res = runComparison({
    baselineRgba: baseline,
    baselineWidth: bw,
    baselineHeight: bh,
    followupRgba: followup,
    followupWidth: fw,
    followupHeight: fh,
    settings: { normalizeColor: false, suppressHair: false, allowScale: false, maxAngle: 10 },
  });

  assert.equal(res.registered, true);
  assert.equal(res.workingScale, 1);
  assert.equal(res.width, bw);
  assert.equal(res.height, bh);
  assert.ok(Math.abs(res.metrics.areaChangePct) < 1, `expected ~0% area change, got ${res.metrics.areaChangePct}%`);
});
