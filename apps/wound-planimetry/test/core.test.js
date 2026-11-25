// DOM-independent unit tests for wound-planimetry core numerics:
// colour space conversion, transparency exclusion, contrast gating, border-aware
// morphology, consistent area/perimeter planimetry (circularity <= 1), color-based
// RYB tissue estimation, seed fallback, and CSV/PNG/SVG output builders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "fast-png";
import { rgbToHue, rgbToHsv, rgbToLab, rgbaToColorArrays } from "../src/core/color.js";
import { erode3x3, fillHoles, morphClose3x3, morphOpen3x3, segmentWound } from "../src/core/segment.js";
import { calibrationFromRuler, measurePlanimetry, traceContourPerimeter } from "../src/core/planimetry.js";
import { classifyRyb } from "../src/core/ryb.js";
import { buildProvenance, encodeMaskPng, encodeRybOverlayPng, planimetryCsv, rybStackedBarSvg } from "../src/outputs.js";

function parseCsvMap(csvText) {
  const lines = csvText.trim().split("\n");
  assert.equal(lines[0], "metric,value,unit");
  const map = new Map();
  for (const line of lines.slice(1)) {
    // Simple RFC-4180 split for 3-column rows.
    const cells = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === "\"" && line[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else if (ch === "\"") {
          inQuotes = false;
        } else {
          cur += ch;
        }
      } else if (ch === "\"") {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    map.set(cells[0], { value: cells[1], unit: cells[2] });
  }
  return map;
}

test("rgbToLab, rgbToHue, rgbToHsv and rgbaToColorArrays handle reference colours and transparency", () => {
  const [lW, aW, bW] = rgbToLab(255, 255, 255);
  assert.ok(Math.abs(lW - 100) < 0.05);
  assert.ok(Math.abs(aW) < 0.05 && Math.abs(bW) < 0.05);

  const [lK, aK, bK] = rgbToLab(0, 0, 0);
  assert.ok(Math.abs(lK) < 0.05 && Math.abs(aK) < 0.05 && Math.abs(bK) < 0.05);

  const [lR, aR, bR] = rgbToLab(255, 0, 0);
  assert.ok(Math.abs(lR - 53.23) < 0.2);
  assert.ok(Math.abs(aR - 80.11) < 0.3);
  assert.ok(Math.abs(bR - 67.22) < 0.3);

  const [hR, sR, vR] = rgbToHsv(255, 0, 0);
  assert.equal(hR, 0);
  assert.equal(sR, 1);
  assert.equal(vR, 1);
  assert.equal(rgbToHue(255, 0, 0), 0);
  assert.equal(rgbToHue(0, 255, 0), 120);

  const [hY, sY, vY] = rgbToHsv(255, 255, 0);
  assert.equal(hY, 60);
  assert.equal(sY, 1);
  assert.equal(vY, 1);

  // rgbaToColorArrays drops unused H/S/V arrays and tracks opacity (alpha >= 128).
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 0, 0,
    0, 0, 0, 127,
    255, 255, 0, 128,
  ]);
  const colors = rgbaToColorArrays(rgba, 2, 2);
  assert.equal("H" in colors, false);
  assert.equal("S" in colors, false);
  assert.equal("V" in colors, false);
  assert.deepEqual(Array.from(colors.opaque), [1, 0, 0, 1]);
  assert.equal(colors.L[1], 0);
  assert.equal(colors.L[2], 0);
  assert.ok(colors.L[3] > 90);
});

test("calibrationFromRuler computes pixelsPerMm accurately and rejects degenerate input", () => {
  const cal = calibrationFromRuler([10, 20], [110, 20], 10);
  assert.equal(cal.pixelDist, 100);
  assert.equal(cal.pixelsPerMm, 10);

  const diag = calibrationFromRuler([0, 0], [30, 40], 5);
  assert.equal(diag.pixelDist, 50);
  assert.equal(diag.pixelsPerMm, 10);

  assert.throws(() => calibrationFromRuler([10, 10], [10, 10], 10));
  assert.throws(() => calibrationFromRuler([0, 0], [20, 0], 0));
});

test("consistent area and perimeter geometry guarantees circularity <= 1 across primitive and composite masks", () => {
  const makeMask = (w, h, fn) => {
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (fn(x, y)) mask[y * w + x] = 1;
      }
    }
    return mask;
  };

  // 1x1 pixel: area = 1, perimeter = 4, circularity = pi/4 <= 1.
  const px1 = measurePlanimetry(makeMask(5, 5, (x, y) => x === 2 && y === 2), 5, 5);
  assert.equal(px1.areaPx, 1);
  assert.equal(px1.perimeterPx, 4);
  assert.ok(Math.abs(px1.circularity - Math.PI / 4) < 1e-6);
  assert.ok(px1.circularity <= 1);
  assert.equal(px1.lengthPx, 1);
  assert.equal(px1.widthPx, 1);

  // 3x3 square: area = 9, perimeter = 12, circularity = pi/4 <= 1.
  const sq3 = measurePlanimetry(makeMask(9, 9, (x, y) => x >= 3 && x <= 5 && y >= 3 && y <= 5), 9, 9);
  assert.equal(sq3.areaPx, 9);
  assert.equal(sq3.perimeterPx, 12);
  assert.ok(Math.abs(sq3.circularity - Math.PI / 4) < 1e-6);
  assert.ok(sq3.circularity <= 1);
  assert.equal(sq3.lengthPx, 3);
  assert.equal(sq3.widthPx, 3);

  // 10x4 rectangle: area = 40, perimeter = 28, circularity = 4*pi*40/784 <= 1.
  const rect = measurePlanimetry(makeMask(20, 12, (x, y) => x >= 3 && x < 13 && y >= 4 && y < 8), 20, 12);
  assert.equal(rect.areaPx, 40);
  assert.equal(rect.perimeterPx, 28);
  assert.ok(Math.abs(rect.circularity - (4 * Math.PI * 40) / (28 * 28)) < 1e-6);
  assert.ok(rect.circularity <= 1);
  assert.equal(rect.lengthPx, 10);
  assert.equal(rect.widthPx, 4);

  // 10-pixel 8-connected diagonal: oblique pixel extent and circularity <= 1.
  const diag = measurePlanimetry(makeMask(16, 16, (x, y) => x === y && x >= 2 && x < 12), 16, 16);
  assert.equal(diag.areaPx, 10);
  assert.equal(diag.perimeterPx, 40);
  assert.ok(diag.circularity <= 1);
  assert.ok(Math.abs(diag.lengthPx - 10 * Math.SQRT2) < 1e-6);
  assert.ok(Math.abs(diag.widthPx - Math.SQRT2) < 1e-6);
  const majorDist = Math.hypot(diag.axes.major[1][0] - diag.axes.major[0][0], diag.axes.major[1][1] - diag.axes.major[0][1]);
  const minorDist = Math.hypot(diag.axes.minor[1][0] - diag.axes.minor[0][0], diag.axes.minor[1][1] - diag.axes.minor[0][1]);
  assert.ok(Math.abs(majorDist - diag.lengthPx) < 1e-6);
  assert.ok(Math.abs(minorDist - diag.widthPx) < 1e-6);

  // 4-connected thick diagonal staircase: circularity <= 1.
  const stair = measurePlanimetry(
    makeMask(20, 20, (x, y) => Math.abs(x - y) <= 1 && x >= 2 && x < 12 && y >= 2 && y < 12),
    20,
    20,
  );
  assert.equal(stair.areaPx, 28);
  assert.ok(stair.perimeterPx < 40 && stair.perimeterPx > 28);
  assert.ok(stair.circularity <= 1);

  // Circle radius 25: circularity <= 1 and close to 1.
  const circle = measurePlanimetry(
    makeMask(80, 80, (x, y) => (x - 40) ** 2 + (y - 40) ** 2 <= 25 ** 2),
    80,
    80,
  );
  assert.ok(circle.circularity > 0.8 && circle.circularity <= 1, `circle circularity ${circle.circularity}`);
  assert.ok(Math.abs(circle.perimeterPx - 2 * Math.PI * 25) / (2 * Math.PI * 25) < 0.08);

  // Disconnected mask (two 3x3 squares): perimeter sums both components cleanly.
  const discMask = makeMask(20, 10, (x, y) => ((x >= 1 && x <= 3) || (x >= 12 && x <= 14)) && y >= 2 && y <= 4);
  const discTrace = traceContourPerimeter(discMask, 20, 10);
  assert.equal(discTrace.loopCount, 2);
  assert.equal(discTrace.perimeterPx, 24);
  const disc = measurePlanimetry(discMask, 20, 10);
  assert.equal(disc.areaPx, 18);
  assert.equal(disc.perimeterPx, 24);
  assert.ok(disc.circularity <= 1);

  // Mask with 1x1 interior hole: perimeter sums outer + inner boundaries.
  const holeMask = makeMask(10, 10, (x, y) => x >= 2 && x <= 6 && y >= 2 && y <= 6 && !(x === 4 && y === 4));
  const hole = measurePlanimetry(holeMask, 10, 10);
  assert.equal(hole.areaPx, 24);
  assert.equal(hole.perimeterPx, 24);
  assert.ok(hole.circularity <= 1);
});

test("principal-axis 90-degree swap preserves minor-axis sign and exact caliper distances", () => {
  // Asymmetric shape whose second moment slightly favours x, while perpendicular y-extent is wider.
  const w = 30;
  const h = 30;
  const mask = new Uint8Array(w * h);
  // Thick horizontal core (y = 14..16, x = 5..24) + tall thin vertical spike on right (x = 24, y = 2..27).
  for (let y = 14; y <= 16; y++) {
    for (let x = 5; x <= 24; x++) mask[y * w + x] = 1;
  }
  for (let y = 2; y <= 27; y++) mask[y * w + 24] = 1;

  const geom = measurePlanimetry(mask, w, h);
  assert.ok(geom.lengthPx >= geom.widthPx);

  const majorLen = Math.hypot(geom.axes.major[1][0] - geom.axes.major[0][0], geom.axes.major[1][1] - geom.axes.major[0][1]);
  const minorLen = Math.hypot(geom.axes.minor[1][0] - geom.axes.minor[0][0], geom.axes.minor[1][1] - geom.axes.minor[0][1]);
  assert.ok(Math.abs(majorLen - geom.lengthPx) < 1e-6, `major ${majorLen} vs ${geom.lengthPx}`);
  assert.ok(Math.abs(minorLen - geom.widthPx) < 1e-6, `minor ${minorLen} vs ${geom.widthPx}`);

  // Every foreground pixel centre must lie within the bounding box defined by the drawn caliper endpoints.
  const [m0, m1] = geom.axes.major;
  const [n0, n1] = geom.axes.minor;
  const ux = (m1[0] - m0[0]) / majorLen;
  const uy = (m1[1] - m0[1]) / majorLen;
  const vx = (n1[0] - n0[0]) / minorLen;
  const vy = (n1[1] - n0[1]) / minorLen;
  const u0 = m0[0] * ux + m0[1] * uy;
  const u1 = m1[0] * ux + m1[1] * uy;
  const v0 = n0[0] * vx + n0[1] * vy;
  const v1 = n1[0] * vx + n1[1] * vy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const px = x + 0.5;
      const py = y + 0.5;
      const pu = px * ux + py * uy;
      const pv = px * vx + py * vy;
      assert.ok(pu >= Math.min(u0, u1) - 1e-5 && pu <= Math.max(u0, u1) + 1e-5);
      assert.ok(pv >= Math.min(v0, v1) - 1e-5 && pv <= Math.max(v0, v1) + 1e-5);
    }
  }
});

test("calibrated geometry on a rotated synthetic ellipse matches analytical values", () => {
  const width = 240;
  const height = 240;
  const cx = 120;
  const cy = 120;
  const semiMajor = 50; // full length = 100 px -> 10.0 mm at 10 px/mm
  const semiMinor = 30; // full width = 60 px -> 6.0 mm at 10 px/mm
  const theta = (25 * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const u = dx * cosT + dy * sinT;
      const v = -dx * sinT + dy * cosT;
      if ((u * u) / (semiMajor * semiMajor) + (v * v) / (semiMinor * semiMinor) <= 1) {
        mask[y * width + x] = 1;
      }
    }
  }

  const pxPerMm = 10;
  const geom = measurePlanimetry(mask, width, height, pxPerMm);
  const expectedAreaPx = Math.PI * semiMajor * semiMinor; // 4712.39
  const expectedAreaMm2 = expectedAreaPx / (pxPerMm * pxPerMm); // 47.1239
  const expectedAreaCm2 = expectedAreaMm2 / 100; // 0.4712
  const h = ((semiMajor - semiMinor) ** 2) / ((semiMajor + semiMinor) ** 2);
  const expectedPerimPx = Math.PI * (semiMajor + semiMinor) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));

  assert.equal(geom.calibrated, true);
  assert.ok(Math.abs(geom.areaPx - expectedAreaPx) / expectedAreaPx < 0.01, `areaPx ${geom.areaPx} vs ${expectedAreaPx}`);
  assert.ok(Math.abs(geom.areaMm2 - expectedAreaMm2) / expectedAreaMm2 < 0.01);
  assert.ok(Math.abs(geom.areaCm2 - expectedAreaCm2) / expectedAreaCm2 < 0.01);
  assert.ok(Math.abs(geom.lengthPx - 2 * semiMajor) <= 2.5, `lengthPx ${geom.lengthPx}`);
  assert.ok(Math.abs(geom.widthPx - 2 * semiMinor) <= 2.5, `widthPx ${geom.widthPx}`);
  assert.ok(Math.abs(geom.lengthMm - 10) <= 0.25, `lengthMm ${geom.lengthMm}`);
  assert.ok(Math.abs(geom.widthMm - 6) <= 0.25, `widthMm ${geom.widthMm}`);
  assert.ok(Math.abs(geom.kundinAreaMm2 - expectedAreaMm2) / expectedAreaMm2 < 0.05);
  assert.ok(Math.abs(geom.perimeterPx - expectedPerimPx) / expectedPerimPx < 0.08, `perimPx ${geom.perimeterPx} vs ${expectedPerimPx}`);
  assert.ok(Math.abs(geom.perimeterMm - geom.perimeterPx / pxPerMm) < 1e-6);
  assert.ok(geom.circularity > 0.7 && geom.circularity <= 1, `circularity ${geom.circularity}`);
  assert.ok(Math.abs(geom.circularity * geom.compactness - 1) < 1e-6);
  assert.ok(Math.abs(geom.orientationDeg - 25) < 2, `orientationDeg ${geom.orientationDeg}`);

  const uncal = measurePlanimetry(mask, width, height, 0);
  assert.equal(uncal.calibrated, false);
  assert.equal(uncal.areaMm2, null);
  assert.equal(uncal.areaCm2, null);
  assert.equal(uncal.perimeterMm, null);
  assert.equal(uncal.areaPx, geom.areaPx);
});

test("border-aware morphological ops and hole filling clean interior holes without clipping frame borders", () => {
  const w = 15;
  const h = 15;
  const mask = new Uint8Array(w * h);
  for (let y = 3; y <= 11; y++) {
    for (let x = 3; x <= 11; x++) mask[y * w + x] = 1;
  }
  mask[7 * w + 7] = 0; // 1-px interior hole
  mask[1 * w + 1] = 1; // isolated noise speck

  const cleaned = fillHoles(morphOpen3x3(morphClose3x3(mask, w, h), w, h), w, h);
  assert.equal(cleaned[7 * w + 7], 1);
  assert.equal(cleaned[1 * w + 1], 0);

  // Foreground block touching top-left border (0..4, 0..4) must NOT be clipped on row 0 / col 0.
  const borderMask = new Uint8Array(10 * 10);
  for (let y = 0; y <= 4; y++) {
    for (let x = 0; x <= 4; x++) borderMask[y * 10 + x] = 1;
  }
  const eroded = erode3x3(borderMask, 10, 10);
  assert.equal(eroded[0], 1);
  assert.equal(eroded[0 * 10 + 3], 1);
  assert.equal(eroded[3 * 10 + 0], 1);
  assert.equal(eroded[0 * 10 + 4], 0); // exposed to background at x=5
});

test("uniform fields and fully transparent images return empty masks and unavailable RYB fractions", () => {
  const w = 64;
  const h = 64;

  for (const [label, r, g, b, a] of [
    ["uniform skin", 216, 178, 150, 255],
    ["uniform red", 190, 40, 44, 255],
    ["uniform black", 20, 20, 20, 255],
    ["fully transparent", 0, 0, 0, 0],
  ]) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = a;
    }
    const colors = rgbaToColorArrays(rgba, w, h);
    const seg = segmentWound(colors, w, h);
    const geom = measurePlanimetry(seg.mask, w, h, 10, colors.opaque);
    const ryb = classifyRyb(colors, seg.mask, { pixelsPerMm: 10 });
    assert.equal(geom.areaPx, 0, `${label}: expected 0 area, got ${geom.areaPx}`);
    assert.equal(seg.hasContrast, false, `${label}: expected hasContrast=false`);
    assert.equal(ryb.totalPx, 0);
    assert.equal(ryb.classes.red.percent, null);
    assert.equal(ryb.classes.yellow.percent, null);
    assert.equal(ryb.classes.black.percent, null);
    assert.equal(ryb.classes.unclassified.percent, null);
    assert.equal(ryb.devitalizedPercent, null);
    assert.equal(ryb.granulationToDevitalizedRatio, null);
  }
});

test("transparent pixels are never treated as black eschar or included in wound mask", () => {
  const w = 80;
  const h = 80;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const inCenterHole = Math.hypot(x - 40, y - 40) <= 6;
      const inWound = Math.hypot(x - 40, y - 40) <= 20;
      const inCornerCutout = x < 12 && y < 12;
      if (inCenterHole || inCornerCutout) {
        // Transparent black pixels (RGBA 0,0,0,0) must be completely excluded!
        rgba[p] = 0;
        rgba[p + 1] = 0;
        rgba[p + 2] = 0;
        rgba[p + 3] = 0;
      } else if (inWound) {
        rgba[p] = 190;
        rgba[p + 1] = 42;
        rgba[p + 2] = 46;
        rgba[p + 3] = 255;
      } else {
        rgba[p] = 216;
        rgba[p + 1] = 178;
        rgba[p + 2] = 150;
        rgba[p + 3] = 255;
      }
    }
  }
  const colors = rgbaToColorArrays(rgba, w, h);
  const seg = segmentWound(colors, w, h);
  const ryb = classifyRyb(colors, seg.mask);
  const geom = measurePlanimetry(seg.mask, w, h, 0, colors.opaque);

  assert.ok(geom.areaPx > 500);
  // Every transparent pixel must be 0 in both mask and RYB labels.
  for (let i = 0; i < w * h; i++) {
    if (!colors.opaque[i]) {
      assert.equal(seg.mask[i], 0);
      assert.equal(ryb.labels[i], 0);
    }
  }
  assert.equal(ryb.classes.black.pixels, 0, "transparent black pixels must not classify as black eschar");
  assert.ok(ryb.classes.red.percent > 95);
});

test("small high-contrast wounds (2x2 square) are preserved instead of erased by opening", () => {
  const w = 40;
  const h = 40;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const isSmallWound = x >= 19 && x <= 20 && y >= 19 && y <= 20;
      rgba[p] = isSmallWound ? 190 : 216;
      rgba[p + 1] = isSmallWound ? 38 : 178;
      rgba[p + 2] = isSmallWound ? 42 : 150;
      rgba[p + 3] = 255;
    }
  }
  const colors = rgbaToColorArrays(rgba, w, h);
  const seg = segmentWound(colors, w, h);
  const geom = measurePlanimetry(seg.mask, w, h);
  assert.equal(geom.areaPx, 4);
  assert.equal(geom.perimeterPx, 8);
  assert.ok(geom.circularity <= 1);
});

test("RYB hue constraint excludes green pixels from yellow slough and maps them to Unclassified", () => {
  const w = 4;
  const h = 1;
  // Pixel 0: red granulation, Pixel 1: yellow slough, Pixel 2: pure green, Pixel 3: surgical green.
  const rgba = new Uint8ClampedArray([
    188, 42, 46, 255,
    224, 198, 64, 255,
    0, 255, 0, 255,
    60, 140, 70, 255,
  ]);
  const colors = rgbaToColorArrays(rgba, w, h);
  const mask = new Uint8Array([1, 1, 1, 1]);
  const ryb = classifyRyb(colors, mask);

  assert.equal(ryb.labels[0], 1);
  assert.equal(ryb.labels[1], 2);
  assert.equal(ryb.labels[2], 4, "pure green must never classify as yellow slough");
  assert.equal(ryb.labels[3], 4, "surgical green must never classify as yellow slough");
  assert.equal(ryb.classes.yellow.pixels, 1);
  assert.equal(ryb.classes.unclassified.pixels, 2);
  assert.equal(ryb.classes.unclassified.label, "Unclassified");
});

test("end-to-end segmentation, RYB fractions, PNG decoding, CSV parsing and formula guard", () => {
  const width = 180;
  const height = 180;
  const cx = 90;
  const cy = 90;
  const rx = 45;
  const ry = 35;
  const rgba = new Uint8ClampedArray(width * height * 4);

  let trueWound = 0;
  let trueRed = 0;
  let trueYellow = 0;
  let trueBlack = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      let r = 216;
      let g = 178;
      let b = 150;
      if (dx * dx + dy * dy <= 1) {
        trueWound++;
        if (x < cx) {
          r = 188;
          g = 42;
          b = 46;
          trueRed++;
        } else if (y < cy) {
          r = 224;
          g = 198;
          b = 64;
          trueYellow++;
        } else {
          r = 28;
          g = 26;
          b = 26;
          trueBlack++;
        }
      }
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }

  const colors = rgbaToColorArrays(rgba, width, height);
  const seg = segmentWound(colors, width, height, { sensitivity: 0 });
  const geom = measurePlanimetry(seg.mask, width, height, 5, colors.opaque);
  const ryb = classifyRyb(colors, seg.mask, { escharL: 28, granulationA: 22, sloughB: 18, pixelsPerMm: 5 });

  assert.ok(Math.abs(geom.areaPx - trueWound) / trueWound < 0.05, `segmented ${geom.areaPx} vs true ${trueWound}`);
  assert.ok(Math.abs(ryb.classes.red.percent - (trueRed / trueWound) * 100) < 4, `red ${ryb.classes.red.percent}%`);
  assert.ok(Math.abs(ryb.classes.yellow.percent - (trueYellow / trueWound) * 100) < 4, `yellow ${ryb.classes.yellow.percent}%`);
  assert.ok(Math.abs(ryb.classes.black.percent - (trueBlack / trueWound) * 100) < 4, `black ${ryb.classes.black.percent}%`);
  assert.ok(ryb.classes.unclassified.percent < 2, `unclassified ${ryb.classes.unclassified.percent}%`);
  assert.ok(Math.abs(ryb.granulationToDevitalizedRatio - 1) < 0.12, `ratio ${ryb.granulationToDevitalizedRatio}`);
  assert.ok(ryb.classes.red.areaCm2 > 0);

  // Verify decoded overlay and binary mask PNG pixel contents.
  const overlayPng = decode(encodeRybOverlayPng(rgba, ryb.labels, geom.boundary, width, height));
  assert.equal(overlayPng.width, width);
  assert.equal(overlayPng.height, height);

  const maskPng = decode(encodeMaskPng(seg.mask, width, height));
  assert.equal(maskPng.width, width);
  assert.equal(maskPng.height, height);
  let whitePixels = 0;
  for (let i = 0; i < maskPng.data.length; i++) {
    assert.ok(maskPng.data[i] === 0 || maskPng.data[i] === 255);
    if (maskPng.data[i] === 255) whitePixels++;
  }
  assert.equal(whitePixels, geom.areaPx);

  // Verify CSV values, px² units, and spreadsheet formula injection guard.
  const csv = planimetryCsv({
    filename: "=CMD('calc').png",
    width,
    height,
    planimetry: geom,
    ryb,
    settings: { pixelsPerMm: 5, sensitivity: -0.05, escharL: 28, granulationA: 22, sloughB: 18 },
    seed: null,
    seedFallback: false,
  });
  const rows = parseCsvMap(csv);
  assert.equal(rows.get("image_file").value, "'=CMD('calc').png");
  assert.equal(rows.get("sensitivity_bias").value, "-0.05");
  assert.equal(rows.get("wound_detected").value, "true");
  assert.equal(rows.get("wound_area_px").value, String(geom.areaPx));
  assert.equal(rows.get("wound_area_px").unit, "px²");
  assert.ok(Number(rows.get("ryb_red_granulation_pct").value) > 45);
  assert.ok(rows.has("ryb_unclassified_pct"));
  assert.equal(rows.has("ryb_epithelializing_other_pct"), false);

  // Verify all formula trigger prefixes are guarded on filename.
  for (const dangerous of ["+1+1.png", "-2+3.png", "@SUM(A1).png", "\t=1.png", "\r=1.png"]) {
    const guarded = parseCsvMap(
      planimetryCsv({
        filename: dangerous,
        width,
        height,
        planimetry: geom,
        ryb,
        settings: { pixelsPerMm: 5, sensitivity: 0, escharL: 28, granulationA: 22, sloughB: 18 },
        seed: null,
      }),
    );
    assert.equal(guarded.get("image_file").value, `'${dangerous}`);
  }

  const prov = buildProvenance({
    app: { id: "wound-planimetry", title: "Wound Planimetry", version: "0.1.20261124" },
    input: { file: { name: "synthetic.png", size: 123 }, format: "png", width, height },
    settings: { pixelsPerMm: 5, sensitivity: 0, escharL: 28, granulationA: 22, sloughB: 18 },
    seed: null,
    seedFallback: false,
    ruler: null,
    threshold: seg.threshold,
    otsuThreshold: seg.otsuThreshold,
    planimetry: geom,
    ryb,
    elapsedMs: 12.3,
  });
  assert.equal(prov.woundDetected, true);
  assert.match(prov.method, /color-based RYB/i);
  assert.match(prov.method, /not trained clinical tissue classification/i);

  const svg = rybStackedBarSvg(ryb);
  assert.match(svg, /^<svg /);
  assert.match(svg, /Red \(granulation\)/);
  assert.doesNotMatch(svg, /Epithelializing/);
});

test("seed placement selects seeded component and records seedFallback when outside all components", () => {
  const width = 160;
  const height = 100;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const inLeft = Math.hypot(x - 36, y - 50) <= 16;
      const inRight = Math.hypot(x - 122, y - 50) <= 16;
      const [r, g, b] = inLeft || inRight ? [190, 40, 44] : [218, 180, 152];
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  const colors = rgbaToColorArrays(rgba, width, height);
  const leftSeg = segmentWound(colors, width, height, { seed: [36, 50] });
  const rightSeg = segmentWound(colors, width, height, { seed: [122, 50] });
  const fallbackSeg = segmentWound(colors, width, height, { seed: [5, 5] });

  assert.equal(leftSeg.seedFallback, false);
  assert.equal(rightSeg.seedFallback, false);
  assert.equal(fallbackSeg.seedFallback, true);

  const left = measurePlanimetry(leftSeg.mask, width, height);
  const right = measurePlanimetry(rightSeg.mask, width, height);
  const fallback = measurePlanimetry(fallbackSeg.mask, width, height);
  assert.ok(left.centroid[0] < 50, `left centroid x=${left.centroid[0]}`);
  assert.ok(right.centroid[0] > 110, `right centroid x=${right.centroid[0]}`);
  assert.ok(fallback.centroid[0] < 50, `fallback should choose closer left component, x=${fallback.centroid[0]}`);
});
