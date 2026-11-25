// Unit tests for the pure DOM-free Dermoscope ABCD scientific core, display layers, and output encoders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "fast-png";
import {
  DERMOSCOPIC_COLORS,
  applyShadesOfGray,
  classifyDermoscopicColor,
  rgbToLab,
  rgbaToLabPlanes,
  rgbaToLuminance,
} from "../src/core/color.js";
import {
  detectVignetteMask,
  dullRazorRemoveHair,
  resizeToWorkingResolution,
} from "../src/core/preprocess.js";
import { extractBoundaryContour, segmentLesion } from "../src/core/segment.js";
import * as abcdModule from "../src/core/abcd.js";
import { runDermoscopyPipeline } from "../src/core/pipeline.js";
import { buildColorMapPixels, buildOverlayPixels } from "../src/display.js";
import { buildOutputFiles, metricsCsv, outputStem, provenanceRecord } from "../src/outputs.js";

function makeCanvas(width, height, fillRgb = [212, 174, 152]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    rgba[o] = fillRgb[0];
    rgba[o + 1] = fillRgb[1];
    rgba[o + 2] = fillRgb[2];
    rgba[o + 3] = 255;
  }
  return rgba;
}

function paintDisk(rgba, width, height, cx, cy, radius, rgb, alpha = 255) {
  const r2 = radius * radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const o = (y * width + x) * 4;
        rgba[o] = rgb[0];
        rgba[o + 1] = rgb[1];
        rgba[o + 2] = rgb[2];
        rgba[o + 3] = alpha;
      }
    }
  }
}

function paintVignetteCorners(rgba, width, height, innerRadius) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const r2 = innerRadius * innerRadius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) {
        const o = (y * width + x) * 4;
        rgba[o] = 5;
        rgba[o + 1] = 5;
        rgba[o + 2] = 6;
      }
    }
  }
}

function paintLine(rgba, width, height, x0, y0, x1, y1, halfThickness, rgb) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = steps === 0 ? 0 : s / steps;
    const px = Math.round(x0 + (x1 - x0) * t);
    const py = Math.round(y0 + (y1 - y0) * t);
    for (let dy = -halfThickness; dy <= halfThickness; dy++) {
      for (let dx = -halfThickness; dx <= halfThickness; dx++) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const o = (ny * width + nx) * 4;
          rgba[o] = rgb[0];
          rgba[o + 1] = rgb[1];
          rgba[o + 2] = rgb[2];
        }
      }
    }
  }
}

test("rgbToLab maps D65 white and black accurately and classifies all 6 Stolz color prototypes", () => {
  const white = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(white[0] - 100) < 0.05);
  assert.ok(Math.abs(white[1]) < 0.05);
  assert.ok(Math.abs(white[2]) < 0.05);

  const black = rgbToLab(0, 0, 0);
  assert.ok(Math.abs(black[0]) < 0.05);

  for (const proto of DERMOSCOPIC_COLORS) {
    const lab = rgbToLab(proto.rgb[0], proto.rgb[1], proto.rgb[2]);
    assert.equal(classifyDermoscopicColor(lab[0], lab[1], lab[2]), proto.id, proto.label);
  }
});

test("abcd module exports no clinical risk-band classifier and emits no risk-band labels", () => {
  assert.equal("classifyTdsBand" in abcdModule, false, "classifyTdsBand must be removed");

  const w = 160;
  const h = 160;
  const rgba = makeCanvas(w, h, [218, 182, 160]);
  paintDisk(rgba, w, h, 80, 80, 32, [105, 55, 28]);

  const defaultRun = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
  });
  assert.equal(defaultRun.segmented, true);
  assert.equal("band" in defaultRun.abcd, false);
  assert.equal(defaultRun.abcd.scores.D, null);
  assert.equal(defaultRun.abcd.scores.weightedD, null);
  assert.equal(defaultRun.abcd.scores.tds, null);

  const csv = metricsCsv(defaultRun, "nevus.png");
  const prov = JSON.stringify(provenanceRecord(defaultRun, { name: "nevus.png", size: 100, format: "png" }));
  for (const text of [csv, prov]) {
    assert.doesNotMatch(text, /benign-range|suspicious-range|high-risk-range|high suspicion/i);
  }
  assert.match(csv, /tds_total_dermoscopy_score,,score,not computed \(enter D to calculate\)/);

  const withD = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
    differentialStructures: 3,
  });
  assert.equal(withD.abcd.scores.D, 3);
  assert.equal(withD.abcd.scores.weightedD, 1.5);
  assert.equal(
    withD.abcd.scores.tds,
    Number(
      (
        1.3 * withD.abcd.scores.A +
        0.1 * withD.abcd.scores.B +
        0.5 * withD.abcd.scores.C +
        0.5 * 3
      ).toFixed(4),
    ),
  );
  assert.equal("band" in withD.abcd, false);
});

test("detectVignetteMask excludes dark corners and resists 2-px dark hair leaks into central lesions", () => {
  const w = 128;
  const h = 128;
  const rgba = makeCanvas(w, h, [215, 178, 155]);
  paintVignetteCorners(rgba, w, h, 58);
  // Central dark lesion (luminance < 15) connected to top-left dark corner by a 2-px dark hair.
  paintDisk(rgba, w, h, 64, 64, 18, [12, 10, 10]);
  paintLine(rgba, w, h, 0, 0, 64, 64, 0, [8, 8, 8]);
  paintLine(rgba, w, h, 1, 0, 65, 64, 0, [8, 8, 8]);

  const { vignetteMask, validMask, vignetteCoveragePct } = detectVignetteMask(rgba, w, h);
  assert.equal(vignetteMask[0], 1);
  assert.equal(vignetteMask[w - 1], 1);
  assert.equal(vignetteMask[(h - 1) * w], 1);
  assert.equal(vignetteMask[h * w - 1], 1);
  assert.equal(validMask[64 * w + 64], 1, "central dark lesion remains valid despite 2-px dark bridge");
  assert.equal(validMask[60 * w + 64], 1);
  assert.ok(vignetteCoveragePct > 10 && vignetteCoveragePct < 45);
});

test("transparent pixels (alpha < 128) stay excluded through vignette masking, hole-filling, and morphometry", () => {
  const w = 160;
  const h = 160;
  const rgba = makeCanvas(w, h, [215, 178, 155]);
  paintDisk(rgba, w, h, 80, 80, 36, [95, 50, 26]);
  // Punch a transparent 6-px hole inside the lesion.
  paintDisk(rgba, w, h, 80, 80, 6, [0, 0, 0], 0);

  const run = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
  });
  assert.equal(run.segmented, true);
  assert.equal(run.transparentMask[80 * w + 80], 1);
  assert.equal(run.validMask[80 * w + 80], 0);
  assert.equal(run.mask[80 * w + 80], 0, "transparent hole is NOT filled into lesion mask");
  assert.equal(run.abcd.color.colorMap[80 * w + 80], 0, "transparent pixel excluded from color map");
  assert.ok(run.transparentCoveragePct > 0);
});

test("dullRazorRemoveHair removes 0°, 45°, 90°, 135° hairs and lesion-crossing hairs while preserving 5-px dark pigment dots", () => {
  const w = 180;
  const h = 180;
  const skin = [214, 176, 154];
  const rgba = makeCanvas(w, h, skin);

  // Dark lesion centered at (90, 90)
  paintDisk(rgba, w, h, 90, 90, 28, [88, 52, 32]);
  // Compact 5-px diameter dark pigment dot (radius 2.5) on skin — MUST BE PRESERVED.
  paintDisk(rgba, w, h, 35, 140, 2.5, [22, 16, 14]);

  // Thin dark hairs at 0°, 90°, 45°, 135°, and crossing the lesion edge.
  paintLine(rgba, w, h, 20, 22, 160, 22, 0, [22, 18, 16]);      // 0°
  paintLine(rgba, w, h, 155, 40, 155, 160, 0, [22, 18, 16]);    // 90°
  paintLine(rgba, w, h, 18, 45, 70, 97, 0, [22, 18, 16]);       // 45° crossing lesion edge
  paintLine(rgba, w, h, 130, 50, 75, 105, 0, [22, 18, 16]);     // 135° crossing lesion edge

  const validMask = new Uint8Array(w * h).fill(1);
  const res = dullRazorRemoveHair(rgba, w, h, validMask);

  assert.equal(res.repairedPixels, res.hairPixelCount);
  assert.ok(res.repairedPixels > 100, `expected repaired hair pixels, got ${res.repairedPixels}`);
  assert.ok(res.hairCoveragePct > 0.3 && res.hairCoveragePct < 15, `hair coverage ${res.hairCoveragePct}%`);

  // Verify hairs at all 4 orientations are repaired toward background skin.
  assert.equal(res.hairMask[22 * w + 90], 1, "0° hair detected");
  assert.ok(res.cleanedRgba[(22 * w + 90) * 4] > 170, "0° hair inpainted");

  assert.equal(res.hairMask[100 * w + 155], 1, "90° hair detected");
  assert.ok(res.cleanedRgba[(100 * w + 155) * 4] > 170, "90° hair inpainted");

  assert.equal(res.hairMask[67 * w + 40], 1, "45° hair detected");
  assert.ok(res.cleanedRgba[(67 * w + 40) * 4] > 170, "45° hair inpainted");

  assert.equal(res.hairMask[60 * w + 120], 1, "135° hair detected");
  assert.ok(res.cleanedRgba[(60 * w + 120) * 4] > 170, "135° hair inpainted");

  // Hair crossing lesion edge (just outside & at border) is detected.
  assert.equal(res.hairMask[80 * w + 53], 1, "lesion-crossing hair detected");

  // 5-px dark pigment dot MUST be preserved intact.
  const dotCenter = 140 * w + 35;
  assert.equal(res.hairMask[dotCenter], 0, "5-px circular dark pigment dot must NOT be masked as hair");
  assert.ok(res.cleanedRgba[dotCenter * 4] < 40, `dot center R=${res.cleanedRgba[dotCenter * 4]} preserved`);

  // Solid dark lesion core (away from hairs) remains preserved.
  const coreIdx = 96 * w + 96;
  assert.equal(res.hairMask[coreIdx], 0, "solid dark lesion core is preserved");
  assert.ok(res.cleanedRgba[coreIdx * 4] < 105);
});

test("applyShadesOfGray neutralizes an amber illuminant cast over valid pixels", () => {
  const w = 96;
  const h = 96;
  const rgba = makeCanvas(w, h, [210, 160, 110]);
  paintVignetteCorners(rgba, w, h, 44);
  const { validMask } = detectVignetteMask(rgba, w, h);

  const balanced = applyShadesOfGray(rgba, w, h, validMask, { p: 6 });
  const centerO = (48 * w + 48) * 4;
  const r = balanced.rgba[centerO];
  const g = balanced.rgba[centerO + 1];
  const b = balanced.rgba[centerO + 2];

  assert.ok(Math.abs(r - b) < 10, `expected balanced R=${r} and B=${b}`);
  assert.ok(Math.abs(g - b) < 10);
  assert.ok(rgbaToLuminance(balanced.rgba, w, h)[0] < 15);
});

test("segmentLesion preserves small high-contrast lesions (< 1% frame area) on 512x512 images", () => {
  const w = 512;
  const h = 512;
  const rgba = makeCanvas(w, h, [218, 182, 160]);
  // 24-px radius disk occupies ~1810 / 262144 = 0.69% of the frame (< 1%!).
  paintDisk(rgba, w, h, 256, 256, 24, [72, 38, 22]);

  const validMask = new Uint8Array(w * h).fill(1);
  const seg = segmentLesion(rgba, w, h, validMask);

  assert.equal(seg.segmented, true, "small <1% lesion must not be erased by p99 normalization");
  assert.equal(seg.mask[256 * w + 256], 1);
  assert.ok(Math.abs(seg.areaPx - Math.PI * 24 * 24) < 120, `areaPx=${seg.areaPx}`);
});

test("segmentLesion and pipeline return explicit segmentation failure on uniform or tiny-speckle images", () => {
  const w = 128;
  const h = 128;
  const uniform = makeCanvas(w, h, [210, 175, 155]);

  const runUniform = runDermoscopyPipeline(uniform, w, h, {
    removeHair: false,
    colorConstancy: false,
  });
  assert.equal(runUniform.segmented, false);
  assert.match(runUniform.failureReason, /No lesion detected/i);
  assert.equal(runUniform.abcd.scores.A, null);
  assert.equal(runUniform.abcd.scores.B, null);
  assert.equal(runUniform.abcd.scores.C, null);
  assert.equal(runUniform.abcd.scores.tds, null);
  assert.equal(runUniform.abcd.geometry.areaPx, 0);

  // Tiny 2x2 speckle (< 16 px) must also fail cleanly.
  const speckle = makeCanvas(w, h, [210, 175, 155]);
  paintDisk(speckle, w, h, 64, 64, 1, [20, 15, 12]);
  const runSpeckle = runDermoscopyPipeline(speckle, w, h, {
    removeHair: false,
    colorConstancy: false,
  });
  assert.equal(runSpeckle.segmented, false);
  assert.match(runSpeckle.failureReason, /No lesion detected/i);
  assert.equal(runSpeckle.abcd.scores.A, null);
});

test("extractBoundaryContour traces diagonal branches, isolated 1x1 pixels, and frame-touching masks cleanly", () => {
  // 1. Diagonal branch: 0110 / 1000 / 0000 / 0000
  const diagMask = new Uint8Array([
    0, 1, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  const diag = extractBoundaryContour(diagMask, 4, 4);
  assert.equal(diag.contourComplete, true);
  const visitedKeys = new Set(diag.contour.map(([x, y]) => `${x},${y}`));
  assert.deepEqual([...visitedKeys].sort(), ["0,1", "1,0", "2,0"]);

  // 2. Isolated 1x1 pixel
  const singleMask = new Uint8Array(25);
  singleMask[2 * 5 + 3] = 1;
  const single = extractBoundaryContour(singleMask, 5, 5);
  assert.equal(single.contourComplete, true);
  assert.deepEqual(single.contour, [[3, 2]]);

  // 3. Frame-touching mask (entire 4x4 frame)
  const fullMask = new Uint8Array(16).fill(1);
  const full = extractBoundaryContour(fullMask, 4, 4);
  assert.equal(full.contourComplete, true);
  assert.equal(full.contour.length, 12);
});

test("segmentLesion fills internal specular holes and responds monotonically to thresholdBias", () => {
  const w = 160;
  const h = 160;
  const rgba = makeCanvas(w, h, [215, 178, 155]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dist = Math.hypot(x - 80, y - 80);
      const t = Math.max(0, Math.min(1, (36 - dist) / 10));
      const o = (y * w + x) * 4;
      rgba[o] = Math.round(215 * (1 - t) + 85 * t);
      rgba[o + 1] = Math.round(178 * (1 - t) + 45 * t);
      rgba[o + 2] = Math.round(155 * (1 - t) + 28 * t);
    }
  }
  paintDisk(rgba, w, h, 80, 80, 5, [240, 235, 230]);

  const validMask = new Uint8Array(w * h).fill(1);
  const neutral = segmentLesion(rgba, w, h, validMask, { thresholdBias: 0 });
  const wider = segmentLesion(rgba, w, h, validMask, { thresholdBias: -0.2 });
  const tighter = segmentLesion(rgba, w, h, validMask, { thresholdBias: 0.2 });

  assert.equal(neutral.segmented, true);
  assert.equal(neutral.mask[80 * w + 80], 1, "internal specular hole is flood-filled");
  assert.ok(neutral.contour.length > 80);
  assert.ok(wider.areaPx > neutral.areaPx, "negative bias expands mask");
  assert.ok(tighter.areaPx < neutral.areaPx, "positive bias tightens mask");
});

test("symmetric odd-sized lesion with radial color rings scores exact A=0 with zero halfLabDeltaE", () => {
  const size = 101;
  const c = 50;
  const rgba = makeCanvas(size, size, [220, 185, 165]);
  const mask = new Uint8Array(size * size);

  // Perfectly symmetric bullseye on odd 101x101 grid: dark core (r <= 12) inside light-brown ring (r <= 30).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      if (d <= 30) {
        mask[y * size + x] = 1;
        const o = (y * size + x) * 4;
        if (d <= 12) {
          rgba[o] = 15;
          rgba[o + 1] = 15;
          rgba[o + 2] = 18;
        } else {
          rgba[o] = 190;
          rgba[o + 1] = 132;
          rgba[o + 2] = 74;
        }
      }
    }
  }

  const lab = rgbaToLabPlanes(rgba, size, size);
  const { contour } = extractBoundaryContour(mask, size, size);
  const geometry = abcdModule.computeGeometry(mask, contour, size, size);
  const asym = abcdModule.computeAsymmetry(mask, lab, geometry, size, size);

  assert.equal(asym.score, 0, "odd-sized symmetric bullseye must score A = 0");
  assert.equal(asym.major.halfLabDeltaE, 0);
  assert.equal(asym.minor.halfLabDeltaE, 0);
  assert.equal(asym.major.shapeXorRatio, 0);
  assert.equal(asym.minor.shapeXorRatio, 0);
});

test("computeBorderAbruptness verifies inner/outer mask membership and marks clipped sectors unavailable (null)", () => {
  const w = 120;
  const h = 120;
  const rgba = makeCanvas(w, h, [220, 185, 165]);
  const mask = new Uint8Array(w * h);

  // Lesion touching the right image edge so right-side sectors have no outer skin samples.
  const cx = 104;
  const cy = 60;
  const radius = 26;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        mask[y * w + x] = 1;
        const o = (y * w + x) * 4;
        rgba[o] = 70;
        rgba[o + 1] = 35;
        rgba[o + 2] = 20;
      }
    }
  }

  const validMask = new Uint8Array(w * h).fill(1);
  const lab = rgbaToLabPlanes(rgba, w, h);
  const { contour } = extractBoundaryContour(mask, w, h);
  const geometry = abcdModule.computeGeometry(mask, contour, w, h);
  const border = abcdModule.computeBorderAbruptness(contour, lab, validMask, geometry, w, h, { mask });

  assert.ok(border.unavailableSectors >= 1, "frame-clipped sectors must be marked unavailable");
  assert.ok(border.availableSectors >= 4, "unclipped sectors remain measurable");
  assert.ok(border.sectorGradients.some((g) => g === null));
  assert.ok(border.abruptSectors.some((a) => a === null));
  assert.ok(border.abruptSectors.some((a) => a === true));
  assert.equal(border.availableSectors + border.unavailableSectors, 8);
});

test("all 4 (removeHair, colorConstancy) toggle combinations run cleanly with distinct output buffers", () => {
  const w = 128;
  const h = 128;
  const rgba = makeCanvas(w, h, [215, 178, 155]);
  paintDisk(rgba, w, h, 64, 64, 28, [96, 50, 26]);
  paintLine(rgba, w, h, 10, 25, 118, 25, 0, [20, 16, 14]);

  for (const removeHair of [false, true]) {
    for (const colorConstancy of [false, true]) {
      const run = runDermoscopyPipeline(rgba, w, h, { removeHair, colorConstancy });
      assert.equal(run.segmented, true, `removeHair=${removeHair} colorConstancy=${colorConstancy}`);
      assert.notEqual(
        run.workingOriginalRgba.buffer,
        run.preprocessedRgba.buffer,
        `distinct RGBA buffers required when removeHair=${removeHair} colorConstancy=${colorConstancy}`,
      );
      assert.equal(run.abcd.scores.A, 0);
      assert.equal(run.abcd.scores.tds, null);
    }
  }
});

test("extreme aspect ratio downsampling carries exact per-axis (scaleX, scaleY) into physical calibration", () => {
  const w = 14;
  const h = 2048;
  const rgba = makeCanvas(w, h, [216, 180, 158]);
  // Paint a vertical rectangle: 10 px wide (x=2..11) x 1000 px tall (y=524..1523).
  for (let y = 524; y < 1524; y++) {
    for (let x = 2; x < 12; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = 80;
      rgba[o + 1] = 40;
      rgba[o + 2] = 24;
    }
  }

  const resized = resizeToWorkingResolution(rgba, w, h, 512);
  assert.equal(resized.width, 4);
  assert.equal(resized.height, 512);
  assert.equal(resized.scaleX, 4 / 14);
  assert.equal(resized.scaleY, 512 / 2048);

  // Build exact resized mask matching the 2x250 interior block to verify computeGeometry physical units.
  const mask = new Uint8Array(resized.width * resized.height);
  for (let y = 131; y < 381; y++) {
    for (let x = 1; x < 3; x++) {
      mask[y * resized.width + x] = 1;
    }
  }
  const { contour } = extractBoundaryContour(mask, resized.width, resized.height);
  // At 10 px/mm: width in original px = 2 / (4/14) = 7 px = 0.7 mm; height = 250 / 0.25 = 1000 px = 100 mm; area = 70 mm^2.
  const geom = abcdModule.computeGeometry(mask, contour, resized.width, resized.height, {
    pixelsPerMm: 10,
    scaleX: resized.scaleX,
    scaleY: resized.scaleY,
    scaleFactor: resized.scaleFactor,
  });

  assert.ok(Math.abs(geom.areaMm2 - 70) < 0.5, `areaMm2=${geom.areaMm2} expected ~70`);
  assert.ok(Math.abs(geom.equivalentDiameterMm - 2 * Math.sqrt(70 / Math.PI)) < 0.1);
  // Uniform bar of height 100 mm has major axis 4 * sqrt(100^2 / 12) = 115.47 mm.
  assert.ok(Math.abs(geom.majorAxisMm - 115.47) < 2, `majorAxisMm=${geom.majorAxisMm}`);
});

test("buildOverlayPixels and buildColorMapPixels respect opacity === 0 cleanly", () => {
  const mask = new Uint8Array(16).fill(1);
  const boundary = new Uint8Array(16).fill(1);
  const colorMap = new Uint8Array(16).fill(3);

  const overlayZero = buildOverlayPixels(mask, boundary, 4, 4, 0);
  const colorsZero = buildColorMapPixels(colorMap, 4, 4, 0);
  for (let i = 0; i < 16; i++) {
    assert.equal(overlayZero[i * 4 + 3], 0, "overlay alpha must be 0 when opacity === 0");
    assert.equal(colorsZero[i * 4 + 3], 0, "color map alpha must be 0 when opacity === 0");
  }
});

test("pipeline scores an asymmetric multi-color lesion with A=2, C>=3 and optional TDS when D is given", () => {
  const w = 220;
  const h = 220;
  const rgba = makeCanvas(w, h, [216, 182, 160]);
  paintDisk(rgba, w, h, 95, 100, 38, [102, 52, 26]);
  paintDisk(rgba, w, h, 138, 122, 26, [24, 24, 28]);
  paintDisk(rgba, w, h, 82, 74, 20, [205, 55, 52]);
  paintDisk(rgba, w, h, 118, 88, 19, [88, 120, 152]);

  const run = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
    differentialStructures: 3,
  });

  const { scores } = run.abcd;
  assert.equal(scores.A, 2, "biaxially asymmetric multi-color lesion scores A = 2");
  assert.ok(scores.C >= 3, `expected >= 3 colors, got C = ${scores.C}`);
  assert.ok(scores.B >= 4, `sharp borders yield high B score, got B = ${scores.B}`);
  assert.equal(
    scores.tds,
    Number((1.3 * scores.A + 0.1 * scores.B + 0.5 * scores.C + 0.5 * 3).toFixed(4)),
  );
});

test("working resolution downsampling preserves physical mm calibration and outputs encode valid PNG/CSV/JSON", async () => {
  const w = 1024;
  const h = 768;
  const rgba = makeCanvas(w, h, [214, 178, 156]);
  paintDisk(rgba, w, h, 512, 384, 120, [98, 52, 28]);

  const resized = resizeToWorkingResolution(rgba, w, h, 512);
  assert.equal(resized.width, 512);
  assert.equal(resized.height, 384);
  assert.equal(resized.scaleFactor, 0.5);

  const run = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
    pixelsPerMm: 40,
    differentialStructures: 2,
  });

  // Diameter in original pixels is 240 px -> at 40 px/mm, physical diameter is 6.0 mm.
  assert.ok(
    Math.abs(run.abcd.geometry.equivalentDiameterMm - 6.0) < 0.4,
    `calibrated eq diameter ${run.abcd.geometry.equivalentDiameterMm} mm`,
  );

  assert.equal(outputStem("ISIC_0000022.jpg"), "ISIC_0000022");
  const { record, files } = buildOutputFiles(run, { name: "ISIC_0000022.jpg", size: 1000, format: "jpeg" });
  assert.equal(record.app, "dermoscope");
  assert.match(record.assumptions.colorSpace, /sRGB/);
  assert.match(record.assumptions.alphaHandling, /alpha < 128/);
  assert.equal(files.preprocessed.file.name, "ISIC_0000022_preprocessed.png");
  assert.equal(files.mask.file.name, "ISIC_0000022_mask.png");
  assert.equal(files.metrics.file.name, "ISIC_0000022_abcd_metrics.csv");
  assert.equal(files.provenance.file.name, "ISIC_0000022_provenance.json");

  const prePng = decode(new Uint8Array(await files.preprocessed.file.arrayBuffer()));
  assert.equal(prePng.width, 512);
  assert.equal(prePng.height, 384);
  assert.equal(prePng.channels, 4);

  const maskPng = decode(new Uint8Array(await files.mask.file.arrayBuffer()));
  assert.equal(maskPng.width, 512);
  assert.equal(maskPng.height, 384);
  assert.equal(maskPng.channels, 1);

  const csv = metricsCsv(run, "ISIC_0000022.jpg");
  assert.match(csv, /^metric,value,unit,notes\n/);
  assert.match(csv, /tds_total_dermoscopy_score,/);
  assert.match(csv, /weighted_Lab_contrast/);
  assert.match(csv, /Experimental automated morphometry only/);
});

test("premultiplied-alpha resize avoids dark halos around transparent cutouts on uniform skin", () => {
  const w = 1024;
  const h = 1024;
  const rgba = makeCanvas(w, h, [215, 178, 155]);
  // Transparent central cutout with black (0,0,0,0) RGB payload.
  paintDisk(rgba, w, h, 512, 512, 160, [0, 0, 0], 0);

  const resized = resizeToWorkingResolution(rgba, w, h, 512);
  for (let i = 0; i < resized.width * resized.height; i++) {
    const o = i * 4;
    if (resized.rgba[o + 3] >= 128) {
      assert.ok(
        Math.abs(resized.rgba[o] - 215) <= 1
          && Math.abs(resized.rgba[o + 1] - 178) <= 1
          && Math.abs(resized.rgba[o + 2] - 155) <= 1,
        `opaque pixel RGB(${resized.rgba[o]},${resized.rgba[o + 1]},${resized.rgba[o + 2]}) must stay uniform skin`,
      );
    }
  }

  const run = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
  });
  assert.equal(run.segmented, false, "transparent cutout on uniform skin must not fabricate a lesion");
});

test("composite TDS stays null when border sectors are unavailable due to frame clipping", () => {
  const w = 160;
  const h = 160;
  const rgba = makeCanvas(w, h, [218, 182, 160]);
  // Lesion clipped cleanly by the left frame edge so some radial sectors have no valid outside skin.
  paintDisk(rgba, w, h, 18, 80, 36, [92, 46, 24]);

  const run = runDermoscopyPipeline(rgba, w, h, {
    removeHair: false,
    colorConstancy: false,
    differentialStructures: 3,
  });
  assert.equal(run.segmented, true);
  assert.ok(run.abcd.border.unavailableSectors > 0, "clipped lesion must report unavailable border sectors");
  assert.equal(run.abcd.scores.D, 3);
  assert.equal(run.abcd.scores.tds, null, "composite TDS must remain null when border sectors are incomplete");
  const csv = metricsCsv(run, "clipped.png");
  assert.match(csv, /tds_total_dermoscopy_score,,score,not computed \(\d+\/8 border sectors unavailable\)/);
  assert.doesNotMatch(csv, /enter D to calculate/);
});
