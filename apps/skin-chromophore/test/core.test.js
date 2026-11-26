// Pure DOM-free unit tests for Skin Chromophore colorimetry, chromophores, ROI, and outputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode as decodePng, hasPngSignature } from "fast-png";
import {
  ITA_UNAVAILABLE_BAND,
  ITA_UNAVAILABLE_LABEL,
  ciede2000,
  classifyIta,
  computeIta,
  computeShadesOfGrayGains,
  itaBandIndex,
  linearRgbToLab,
  linearToSrgb,
  srgbToLab,
  srgbToLinear,
} from "@neurodesk/skin-chromophore/core/colorimetry";
import {
  TSUMURA_INVERSE,
  TSUMURA_MATRIX,
  buildAlphaMask,
  detectVignetteMask,
  erythemaIndex,
  melaninIndex,
  separateChromophores,
} from "@neurodesk/skin-chromophore/core/chromophores";
import { otsuThreshold } from "@neurodesk/skin-chromophore/core/roi";
import { analyzeSkinImage, evaluateRois } from "@neurodesk/skin-chromophore/core/analyze";
import { ITA_UNAVAILABLE_RGB, renderMapRgba } from "../src/display.js";
import { colorimetryCsv, encodeMapPng, itaDiagramSvg } from "../src/outputs.js";

function approx(actual, expected, tol = 1e-4, message = "") {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${message ? `${message}: ` : ""}expected ${actual} to be within ${tol} of ${expected}`,
  );
}

test("IEC 61966-2-1 sRGB linearization and CIE L*a*b* (D65) primaries", () => {
  for (const v of [0, 0.01, 0.04045, 0.25, 0.5, 0.85, 1]) {
    approx(linearToSrgb(srgbToLinear(v)), v, 1e-6, `roundtrip ${v}`);
  }
  const black = srgbToLab(0, 0, 0);
  approx(black[0], 0, 1e-6);
  approx(black[1], 0, 1e-6);
  approx(black[2], 0, 1e-6);

  const white = srgbToLab(255, 255, 255);
  approx(white[0], 100, 1e-4);
  approx(white[1], 0, 1e-4);
  approx(white[2], 0, 1e-4);

  // Standard sRGB D65 CIE L*a*b* primary reference values
  const red = srgbToLab(255, 0, 0);
  approx(red[0], 53.2329, 0.02, "red L*");
  approx(red[1], 80.1093, 0.05, "red a*");
  approx(red[2], 67.2201, 0.05, "red b*");

  const green = srgbToLab(0, 255, 0);
  approx(green[0], 87.7370, 0.02, "green L*");
  approx(green[1], -86.1846, 0.05, "green a*");
  approx(green[2], 83.1812, 0.05, "green b*");

  const blue = srgbToLab(0, 0, 255);
  approx(blue[0], 32.3026, 0.02, "blue L*");
  approx(blue[1], 79.1967, 0.05, "blue a*");
  approx(blue[2], -107.8637, 0.05, "blue b*");
});

test("CIEDE2000 matches Sharma, Wu & Dalal (2005) Table 1 reference pairs", () => {
  // Reference pairs from Sharma, Wu & Dalal (2005), Color Res. Appl. 30(1):21-30, Table 1.
  const referencePairs = [
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
    [[50.0000, -0.0010, 2.4900], [50.0000, 0.0011, -2.4900], 4.7461],
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

  for (let i = 0; i < referencePairs.length; i++) {
    const [lab1, lab2, expected] = referencePairs[i];
    const dE = ciede2000(lab1, lab2);
    approx(dE, expected, 0.0005, `Sharma pair #${i + 1}`);
    approx(ciede2000(lab2, lab1), dE, 1e-12, `symmetry pair #${i + 1}`);
  }
  assert.equal(ciede2000([50, 0, 0], [50, 0, 0]), 0);
});

test("Individual Typology Angle (ITA°) formula, b* > 1 skin domain guard, and 6-band classification", () => {
  approx(computeIta(70, 10), Math.atan(2) * (180 / Math.PI), 1e-6);
  approx(computeIta(50, 15), 0, 1e-6);
  assert.ok(Number.isNaN(computeIta(65, 0)), "b* = 0 is outside skin domain");
  assert.ok(Number.isNaN(computeIta(35, -5)), "b* < 0 is outside skin domain");
  assert.ok(Number.isNaN(computeIta(65, 1)), "b* = 1 boundary is excluded");
  assert.ok(Number.isFinite(computeIta(65, 1.01)), "b* > 1 is valid");

  assert.equal(itaBandIndex(Number.NaN), ITA_UNAVAILABLE_BAND);
  assert.equal(itaBandIndex(45, 0.5), ITA_UNAVAILABLE_BAND);
  assert.equal(classifyIta(Number.NaN), ITA_UNAVAILABLE_LABEL);
  assert.equal(classifyIta(45, -2), ITA_UNAVAILABLE_LABEL);

  assert.equal(classifyIta(60), "Very Light");
  assert.equal(classifyIta(55), "Light");
  assert.equal(classifyIta(41.1), "Light");
  assert.equal(classifyIta(41), "Intermediate");
  assert.equal(classifyIta(28.1), "Intermediate");
  assert.equal(classifyIta(28), "Tan");
  assert.equal(classifyIta(10.1), "Tan");
  assert.equal(classifyIta(10), "Brown");
  assert.equal(classifyIta(-29.9), "Brown");
  assert.equal(classifyIta(-30), "Dark");
  assert.equal(classifyIta(-60), "Dark");
});

test("Shades of Gray (p=6) white balance restores warm-tinted illumination", () => {
  const rgba = new Uint8ClampedArray(64 * 4);
  for (let i = 0; i < 64; i++) {
    rgba[i * 4] = 220;
    rgba[i * 4 + 1] = 170;
    rgba[i * 4 + 2] = 110;
    rgba[i * 4 + 3] = 255;
  }
  const gains = computeShadesOfGrayGains(rgba, null, 6);
  assert.ok(gains.b > gains.g && gains.g > gains.r);
  const rOut = srgbToLinear(220 / 255) * gains.r;
  const gOut = srgbToLinear(170 / 255) * gains.g;
  const bOut = srgbToLinear(110 / 255) * gains.b;
  approx(rOut, gOut, 1e-5);
  approx(gOut, bOut, 1e-5);
  const [, a, b] = linearRgbToLab(rOut, gOut, bOut);
  approx(a, 0, 1e-2);
  approx(b, 0, 1e-2);
});

test("Optical indices and Tsumura 3x3 chromophore separation", () => {
  // Check exact M * M^-1 = I
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += TSUMURA_MATRIX[r][k] * TSUMURA_INVERSE[k][c];
      approx(sum, r === c ? 1 : 0, 1e-12, `identity[${r},${c}]`);
    }
  }

  // Clamping at [1e-3, 1]
  approx(melaninIndex(1), 0, 1e-9);
  approx(melaninIndex(0), 300, 1e-9);
  approx(erythemaIndex(0.5, 0.5), 0, 1e-9);
  approx(erythemaIndex(0.8, 0.2), 100 * Math.log10(4), 1e-9);

  // Neutral gray -> zero melanin and hemoglobin, positive shading
  const gray = separateChromophores(0.4, 0.4, 0.4);
  approx(gray.melanin, 0, 1e-12);
  approx(gray.hemoglobin, 0, 1e-12);
  assert.ok(gray.shading > 0);

  // Physiological separation: vascular red vs pigmented brown vs light skin
  const lightSkin = separateChromophores(0.76, 0.55, 0.44);
  const vascular = separateChromophores(0.68, 0.20, 0.22);
  const pigmented = separateChromophores(0.28, 0.13, 0.05);
  assert.ok(vascular.hemoglobin > lightSkin.hemoglobin * 3, "vascular pixel has elevated hemoglobin");
  assert.ok(pigmented.melanin > lightSkin.melanin * 2.5, "pigmented pixel has elevated melanin");
});

function makeSyntheticDermoscopy({
  width = 96,
  height = 96,
  vignette = true,
  skinRgb = [224, 186, 162],
  lesionRgb = [180, 48, 56],
  lesionRadius = 18,
} = {}) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const apertureR = Math.min(width, height) * 0.46;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      const d = Math.hypot(x - cx, y - cy);
      let rgb = skinRgb;
      if (vignette && d > apertureR) rgb = [4, 4, 4];
      else if (lesionRadius > 0 && d <= lesionRadius) rgb = lesionRgb;
      rgba[idx] = rgb[0];
      rgba[idx + 1] = rgb[1];
      rgba[idx + 2] = rgb[2];
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

test("corner vignette flood-fill masks corners without masking a dark central melanoma", () => {
  const rgba = makeSyntheticDermoscopy({
    vignette: true,
    skinRgb: [222, 184, 160],
    lesionRgb: [10, 8, 8], // very dark central lesion, luminance < 22
    lesionRadius: 16,
  });
  const { validMask, vignetteCount } = detectVignetteMask(rgba, 96, 96);
  assert.ok(vignetteCount > 1000, "corners masked");
  assert.equal(validMask[0], 0, "top-left corner excluded");
  assert.equal(validMask[48 * 96 + 48], 1, "central dark lesion preserved");
});

test("end-to-end analysis detects vascular vs pigmented lesions, uniform fallback, manual ROIs, and outputs", () => {
  // 1. Vascular lesion
  const vascRgba = makeSyntheticDermoscopy({ lesionRgb: [186, 46, 54], lesionRadius: 18 });
  const vasc = analyzeSkinImage(vascRgba, 96, 96, { whiteBalance: false, maskVignette: true, roiMode: "auto" });
  assert.equal(vasc.roi.strategy, "auto-otsu");
  assert.ok(vasc.vignetteCount > 0);
  assert.ok(vasc.roi.comparison.deltaHemoglobin > 0.5, "vascular lesion raises hemoglobin OD");
  assert.ok(vasc.roi.comparison.deltaEI > 20, "vascular lesion raises Erythema Index");
  assert.ok(vasc.roi.comparison.deltaE2000 > 15, "vascular lesion has large ΔE2000");

  // 2. Pigmented melanoma
  const pigRgba = makeSyntheticDermoscopy({ lesionRgb: [64, 38, 22], lesionRadius: 18 });
  const pig = analyzeSkinImage(pigRgba, 96, 96, { whiteBalance: false, maskVignette: true, roiMode: "auto" });
  assert.equal(pig.roi.strategy, "auto-otsu");
  assert.ok(pig.roi.comparison.deltaMelanin > 0.5, "pigmented lesion raises melanin OD");
  assert.ok(pig.roi.comparison.deltaMI > 40, "pigmented lesion raises Melanin Index");
  assert.ok(pig.roi.comparison.deltaITA < -30, "pigmented lesion lowers ITA°");

  // 3. Uniform image falls back to central 25% disk
  const flatRgba = makeSyntheticDermoscopy({ vignette: false, lesionRadius: 0 });
  const flat = analyzeSkinImage(flatRgba, 96, 96, { maskVignette: true, roiMode: "auto" });
  assert.equal(flat.roi.strategy, "auto-central-fallback");
  approx(flat.roi.comparison.deltaE2000, 0, 1e-4);

  // 4. Manual ROI override
  const manual = evaluateRois({
    width: vasc.width,
    height: vasc.height,
    validMask: vasc.validMask,
    validCount: vasc.validCount,
    maps: vasc.maps,
    roiMode: "auto",
    customTarget: { cx: 48, cy: 48, r: 10 },
    customReference: { cx: 74, cy: 48, r: 8 },
  });
  assert.equal(manual.strategy, "manual");
  assert.ok(manual.target.pixelCount > 250 && manual.reference.pixelCount > 150);
  assert.ok(manual.comparison.deltaE2000 > 15);

  // 5. PNG, CSV, and SVG outputs
  for (const kind of ["hemoglobin", "melanin", "ita"]) {
    const pngBytes = encodeMapPng(kind, vasc);
    assert.ok(hasPngSignature(pngBytes), `${kind} PNG signature`);
    const decoded = decodePng(pngBytes);
    assert.equal(decoded.width, 96);
    assert.equal(decoded.height, 96);
  }
  const csv = colorimetryCsv(vasc);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 4, "header + 3 rows");
  assert.match(lines[1], /^target,/);
  assert.match(lines[2], /^reference,/);
  assert.match(lines[3], /^target_minus_reference,/);

  const svg = itaDiagramSvg(vasc.roi.target, vasc.roi.reference, vasc.roi.comparison);
  assert.ok(svg.startsWith("<svg ") && svg.endsWith("</svg>"));
  assert.ok(svg.includes("Target") && svg.includes("Reference"));
  assert.ok(svg.includes("coord ITA") && svg.includes("pixel-wise ITA mean"));
});

test("empty, 1x1, and excluded-vignette ROIs return null stats and never fabricate pixels", () => {
  // 1. 1x1 image: Target has 1 px, Reference has 0 px -> null reference & comparison stats
  const onePx = new Uint8ClampedArray([210, 165, 130, 255]);
  const oneRes = analyzeSkinImage(onePx, 1, 1, { maskVignette: true, roiMode: "auto" });
  assert.equal(oneRes.roi.target.pixelCount, 1);
  assert.equal(oneRes.roi.reference.pixelCount, 0);
  assert.equal(oneRes.roi.reference.L.mean, null);
  assert.equal(oneRes.roi.reference.dominantItaBand, null);
  assert.equal(oneRes.roi.comparison.deltaE2000, null);
  assert.equal(oneRes.roi.comparison.deltaL, null);
  const oneCsv = colorimetryCsv(oneRes);
  assert.ok(oneCsv.includes("rgb_ei_proxy_mean") && oneCsv.includes("melanin_od_proxy_mean"));
  assert.ok(!oneCsv.includes("null"));
  const oneSvg = itaDiagramSvg(oneRes.roi.target, oneRes.roi.reference, oneRes.roi.comparison);
  assert.ok(oneSvg.includes("Target") && !oneSvg.includes("Reference (coord ITA"));

  // 2. Manual circle placed entirely inside excluded dark vignette corner -> 0 pixels, null stats
  const vascRgba = makeSyntheticDermoscopy({ vignette: true, lesionRadius: 18 });
  const vasc = analyzeSkinImage(vascRgba, 96, 96, { maskVignette: true, roiMode: "auto" });
  const emptyTarget = evaluateRois({
    width: vasc.width,
    height: vasc.height,
    validMask: vasc.validMask,
    validCount: vasc.validCount,
    maps: vasc.maps,
    roiMode: "auto",
    customTarget: { cx: 2, cy: 2, r: 3 },
    customReference: { cx: 70, cy: 48, r: 8 },
  });
  assert.equal(emptyTarget.target.pixelCount, 0, "must not reinsert masked center pixel");
  assert.equal(emptyTarget.target.L.mean, null);
  assert.equal(emptyTarget.target.dominantItaBand, null);
  assert.equal(emptyTarget.comparison.deltaE2000, null);
  const svgMissingTarget = itaDiagramSvg(emptyTarget.target, emptyTarget.reference, emptyTarget.comparison);
  assert.ok(!svgMissingTarget.includes("Target (coord ITA"));
  assert.ok(svgMissingTarget.includes("Reference (coord ITA"));
});

test("transparent PNG pixels are always excluded even when maskVignette is false", () => {
  const width = 48;
  const height = 48;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      if (x < width / 2) {
        // Transparent bright red that would distort results if included
        rgba[idx] = 255;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      } else {
        rgba[idx] = 215;
        rgba[idx + 1] = 175;
        rgba[idx + 2] = 145;
        rgba[idx + 3] = 255;
      }
    }
  }
  const alphaCheck = buildAlphaMask(rgba, width, height);
  assert.equal(alphaCheck.alphaExcludedCount, (width * height) / 2);

  const res = analyzeSkinImage(rgba, width, height, { maskVignette: false, roiMode: "central" });
  assert.equal(res.alphaExcludedCount, (width * height) / 2);
  assert.equal(res.validCount, (width * height) / 2);
  assert.equal(res.validMask[0], 0);
  // All valid pixels have identical skin color, so target and reference should match with ~0 ΔE2000
  approx(res.roi.comparison.deltaE2000, 0, 1e-3);

  // Fully transparent image produces 0 valid pixels and null stats without crashing
  const allTransparent = new Uint8ClampedArray(16 * 16 * 4);
  const emptyRes = analyzeSkinImage(allTransparent, 16, 16, { maskVignette: false, roiMode: "auto" });
  assert.equal(emptyRes.validCount, 0);
  assert.equal(emptyRes.roi.target.pixelCount, 0);
  assert.equal(emptyRes.roi.reference.pixelCount, 0);
  assert.equal(emptyRes.roi.comparison.deltaE2000, null);
  const emptySvg = itaDiagramSvg(emptyRes.roi.target, emptyRes.roi.reference, emptyRes.roi.comparison);
  assert.ok(emptySvg.includes("No valid ROI pixels available"));
});

test("neutral gray (b* <= 0) pixels are excluded from ITA° domain and rendered distinctly", () => {
  const width = 40;
  const height = 40;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 140;
    rgba[i * 4 + 1] = 140;
    rgba[i * 4 + 2] = 140;
    rgba[i * 4 + 3] = 255;
  }
  const res = analyzeSkinImage(rgba, width, height, { maskVignette: false, roiMode: "central" });
  assert.equal(res.roi.target.itaValidPixels, 0);
  assert.equal(res.roi.target.ita.mean, null);
  assert.equal(res.roi.target.ita.median, null);
  assert.equal(res.roi.target.meanCoordIta, null);
  assert.equal(res.roi.target.dominantItaBand, ITA_UNAVAILABLE_LABEL);
  assert.equal(res.roi.comparison.deltaITA, null);
  const itaRgba = renderMapRgba("ita", res, { opaque: true });
  assert.equal(itaRgba[0], ITA_UNAVAILABLE_RGB[0]);
  assert.equal(itaRgba[1], ITA_UNAVAILABLE_RGB[1]);
  assert.equal(itaRgba[2], ITA_UNAVAILABLE_RGB[2]);
});

test("vignette masking excludes framed circular border, protects central dark lesion across thin dark bridge, and records guard", () => {
  // 1. 1px white outer frame around dark circular border (mirrors ISIC_0000004.jpg structure)
  const framed = makeSyntheticDermoscopy({ vignette: true, lesionRgb: [170, 50, 55], lesionRadius: 16 });
  for (let x = 0; x < 96; x++) {
    for (const y of [0, 95]) {
      const p = (y * 96 + x) << 2;
      framed[p] = 254;
      framed[p + 1] = 254;
      framed[p + 2] = 254;
    }
  }
  for (let y = 0; y < 96; y++) {
    for (const x of [0, 95]) {
      const p = (y * 96 + x) << 2;
      framed[p] = 254;
      framed[p + 1] = 254;
      framed[p + 2] = 254;
    }
  }
  const framedMask = detectVignetteMask(framed, 96, 96);
  assert.ok(framedMask.vignetteCount > 1000, "framed circular dark border is excluded");
  assert.equal(framedMask.vignetteGuardTriggered, false);
  assert.equal(framedMask.validMask[48 * 96 + 48], 1, "central lesion stays valid");

  // 2. Thin dark line bridging outer border to central dark melanoma
  const bridged = makeSyntheticDermoscopy({ vignette: true, lesionRgb: [8, 8, 8], lesionRadius: 14 });
  for (let x = 0; x <= 48; x++) {
    const p = (48 * 96 + x) << 2;
    bridged[p] = 5;
    bridged[p + 1] = 5;
    bridged[p + 2] = 5;
  }
  const bridgedMask = detectVignetteMask(bridged, 96, 96);
  assert.equal(bridgedMask.validMask[48 * 96 + 48], 1, "central dark lesion protected from bridge leak");
  assert.equal(bridgedMask.vignetteGuardTriggered, false);

  // 3. Uniformly dark image triggers safety guard
  const uniformDark = new Uint8ClampedArray(64 * 64 * 4);
  for (let i = 0; i < 64 * 64; i++) {
    uniformDark[i * 4] = 4;
    uniformDark[i * 4 + 1] = 4;
    uniformDark[i * 4 + 2] = 4;
    uniformDark[i * 4 + 3] = 255;
  }
  const darkRes = detectVignetteMask(uniformDark, 64, 64);
  assert.equal(darkRes.vignetteGuardTriggered, true);
  assert.equal(darkRes.vignetteCount, 0);
  assert.equal(darkRes.validCount, 64 * 64);
});

test("morphological perilesional ring avoids elongated lesion overlap, detects manual overlap, and maps Otsu bin boundary exactly", () => {
  // Elongated lesion spanning x in [24..72], y in [42..54]
  const width = 96;
  const height = 96;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) << 2;
      const inLesion = x >= 24 && x <= 72 && y >= 42 && y <= 54;
      rgba[idx] = inLesion ? 90 : 220;
      rgba[idx + 1] = inLesion ? 35 : 185;
      rgba[idx + 2] = inLesion ? 25 : 160;
      rgba[idx + 3] = 255;
    }
  }
  const elongated = analyzeSkinImage(rgba, width, height, { maskVignette: false, roiMode: "auto" });
  assert.equal(elongated.roi.strategy, "auto-otsu");
  assert.equal(elongated.roi.autoFallback, false);
  assert.equal(elongated.roi.overlapPixels, 0, "auto perilesional ring never overlaps lesion");
  assert.ok(elongated.roi.reference.pixelCount > 200);

  // Manual overlapping circles report overlapPixels > 0
  const overlapping = evaluateRois({
    width,
    height,
    validMask: elongated.validMask,
    validCount: elongated.validCount,
    maps: elongated.maps,
    roiMode: "auto",
    customTarget: { cx: 48, cy: 48, r: 12 },
    customReference: { cx: 54, cy: 48, r: 12 },
  });
  assert.ok(overlapping.overlapPixels > 100, "overlapping manual ROIs report overlapPixels > 0");

  // Exact Otsu bin-to-threshold mapping on clean bimodal distribution
  const vals = new Float32Array(200);
  const indices = new Int32Array(200);
  for (let i = 0; i < 200; i++) {
    vals[i] = i < 100 ? 10 : 50;
    indices[i] = i;
  }
  const { threshold } = otsuThreshold(vals, indices, 4);
  let fg = 0;
  let bg = 0;
  for (let i = 0; i < 200; i++) {
    if (vals[i] >= threshold) fg++;
    else bg++;
  }
  assert.equal(bg, 100);
  assert.equal(fg, 100);
});

test("manual target ROI inside a lesion places automatic perilesional reference ring outside the lesion", () => {
  const width = 96;
  const height = 96;
  const lesionRadius = 22;
  const rgba = makeSyntheticDermoscopy({
    width,
    height,
    vignette: true,
    skinRgb: [224, 186, 162],
    lesionRgb: [182, 46, 54],
    lesionRadius,
  });

  const result = analyzeSkinImage(rgba, width, height, {
    whiteBalance: false,
    maskVignette: true,
    roiMode: "auto",
    customTarget: { cx: 48, cy: 48, r: 6 },
    customReference: null,
  });

  assert.equal(result.roi.strategy, "manual-target");
  assert.equal(result.roi.overlapPixels, 0);
  assert.ok(result.roi.reference.pixelCount > 100, "automatic reference ring has perilesional pixels");

  let refInsideLesion = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (result.roi.referenceMask[y * width + x] && Math.hypot(x - 48, y - 48) <= lesionRadius) {
        refInsideLesion++;
      }
    }
  }
  assert.equal(refInsideLesion, 0, "automatic reference ring must not sample lesion pixels");
  assert.ok(result.roi.comparison.deltaE2000 > 15, `expected strong lesion-vs-skin ΔE2000, got ${result.roi.comparison.deltaE2000}`);
  assert.ok(result.roi.comparison.deltaHemoglobin > 0.5, "manual vascular target keeps elevated ΔHb vs perilesional skin");
});
