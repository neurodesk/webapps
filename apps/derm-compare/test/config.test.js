// DOM-independent unit tests for config, settings validation, and output encoders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decode as decodePng } from "fast-png";
import {
  APP,
  DEFAULTS,
  DESCRIPTIVE_THRESHOLDS,
  SettingsError,
  TRANSFORM_CONVENTION,
  buildProvenance,
  clampFlickerInterval,
  readSettings,
} from "../src/config.js";
import { encodeRgbaPng, metricsCsv, outputStem, provenanceJson } from "../src/outputs.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app config reads version from package.json and is frozen", () => {
  assert.equal(APP.id, "derm-compare");
  assert.equal(APP.title, "DermCompare");
  assert.equal(APP.version, pkg.version);
  assert.match(APP.version, /^\d+\.\d+\.\d{8}$/);
  assert.ok(Object.isFrozen(APP));
});

test("readSettings applies defaults and validates maxAngle bounds", () => {
  assert.deepEqual(readSettings(), {
    normalizeColor: DEFAULTS.normalizeColor,
    suppressHair: DEFAULTS.suppressHair,
    allowScale: DEFAULTS.allowScale,
    maxAngle: DEFAULTS.maxAngle,
  });
  assert.deepEqual(
    readSettings({ normalizeColor: false, suppressHair: false, allowScale: true, maxAngle: 40 }),
    { normalizeColor: false, suppressHair: false, allowScale: true, maxAngle: 40 },
  );
  assert.throws(() => readSettings({ maxAngle: -5 }), SettingsError);
  assert.throws(() => readSettings({ maxAngle: 120 }), SettingsError);
  assert.throws(() => readSettings({ maxAngle: Number.NaN }), SettingsError);
});

test("clampFlickerInterval clamps to valid range", () => {
  assert.equal(clampFlickerInterval(50), 150);
  assert.equal(clampFlickerInterval(600), 600);
  assert.equal(clampFlickerInterval(9000), 3000);
  assert.equal(clampFlickerInterval("bad"), DEFAULTS.flickerIntervalMs);
});

test("outputs encode valid PNG, CSV, and JSON provenance with synced Kittler references and honest statuses", () => {
  assert.equal(outputStem("ISIC_0011414_1024.jpg"), "ISIC_0011414_1024");
  assert.equal(outputStem("lesion.PNG"), "lesion");

  const rgba = new Uint8ClampedArray(4 * 3 * 4).fill(180);
  const pngBytes = encodeRgbaPng(rgba, 4, 3);
  const decoded = decodePng(pngBytes);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.channels, 4);

  const registration = { registered: true, initialNcc: 0.5, alignedNcc: 0.95, dx: 4.5, dy: -2.25, angleDeg: 7.5, scale: 1, overlapPct: 92.5 };
  const metrics = {
    validOverlapPx: 10000,
    hairExcludedPx: 42,
    segmentationStatus: "ok",
    growthStatus: "measured",
    clippedByFov: false,
    baselineAreaPx: 2000,
    followupAreaPx: 2100,
    areaChangePct: 5,
    dice: 0.96,
    jaccard: 0.92,
    centroidShiftPx: 0.8,
    lesionMeanDeltaE: 3.1,
    lesionP95DeltaE: 6.4,
    lesionDeltaEOver10Pct: 1.2,
    rawLesionMeanDeltaE: 4.0,
    skinMeanDeltaE: 1.4,
    skinP95DeltaE: 3.0,
    overlapMeanDeltaE: 1.9,
    overlapP95DeltaE: 4.2,
    rawOverlapMeanDeltaE: 2.7,
  };
  const csv = metricsCsv({ registration, metrics, preprocessing: { baselineHairPct: 0.4, followupHairPct: 0.5, baselineGains: [1, 1, 1], followupGains: [1.05, 1, 0.95] } });
  assert.ok(csv.startsWith("metric,value,unit\n"));
  assert.ok(csv.includes("aligned_ncc,0.95,"));
  assert.ok(csv.includes("lesion_mean_delta_e2000,3.1,DE2000"));
  assert.ok(csv.includes("lesion_raw_mean_delta_e2000,4,DE2000"));

  // Scale-fitted CSV labels area/Dice as post-alignment and notes indeterminate growth.
  const scaleCsv = metricsCsv({
    registration: { ...registration, scale: 1.07 },
    metrics: { ...metrics, growthStatus: "indeterminate-scale-fitted" },
    settings: { allowScale: true },
  });
  assert.ok(scaleCsv.includes("post_alignment_area_diff_pct,5,%"));
  assert.ok(scaleCsv.includes("post_alignment_shape_dice,0.96,"));
  assert.ok(scaleCsv.includes("indeterminate"));

  // Empty segmentation CSV renders Unavailable (never 0).
  const emptyCsv = metricsCsv({
    registration,
    metrics: { ...metrics, segmentationStatus: "baseline-empty", growthStatus: "unavailable-empty-segmentation", areaChangePct: null, dice: null, jaccard: null, centroidShiftPx: null },
  });
  assert.ok(emptyCsv.includes("area_change_pct,Unavailable,%"));
  assert.ok(emptyCsv.includes("dice_overlap,Unavailable,"));

  const prov = buildProvenance({
    baseline: { name: "base.png", width: 128, height: 128 },
    followup: { name: "foll.png", width: 128, height: 128 },
    settings: readSettings({ allowScale: true }),
    registration,
    metrics: { ...metrics, growthStatus: "indeterminate-scale-fitted" },
    elapsedSeconds: 0.42,
  });
  const parsed = JSON.parse(provenanceJson(prov));
  assert.equal(parsed.app, "derm-compare");
  assert.equal(parsed.transformConvention, TRANSFORM_CONVENTION);
  assert.deepEqual(parsed.descriptiveThresholds, DESCRIPTIVE_THRESHOLDS);
  assert.ok(parsed.references.some((r) => r.includes("Kittler et al. (2000) J Am Acad Dermatol 43(3):467-476")));
  assert.ok(parsed.references.some((r) => r.includes("Kittler et al. (2006) Arch Dermatol 142(9):1113-1119")));
  assert.match(parsed.growthInterpretationNote, /indeterminate/i);
});
