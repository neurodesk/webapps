// DOM-independent config and contract unit tests (Node, no browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APP,
  DEFAULT_SETTINGS,
  MAX_ANALYSIS_SIDE,
  buildProvenance,
  computeAnalysisDimensions,
  readSettings,
} from "../src/config.js";
import { analyzeSkinImage } from "../src/core/analyze.js";

const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app id is lowercase kebab-case and config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.equal(APP.id, "skin-chromophore");
  assert.equal(APP.title, "Skin Chromophore");
  assert.equal(APP.version, pkg.version);
  assert.match(APP.version, /^\d+\.\d+\.\d{8}$/);
  assert.ok(Object.isFrozen(APP));
});

test("readSettings validates defaults and rejects unknown ROI modes", () => {
  assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
  assert.deepEqual(
    readSettings({ whiteBalance: true, maskVignette: false, roiMode: "central" }),
    { whiteBalance: true, maskVignette: false, roiMode: "central" },
  );
  assert.throws(() => readSettings({ roiMode: "invalid" }), /Unsupported ROI mode/);
});

test("automation contract and pinned examples match", () => {
  assert.equal(automation.schemaVersion, 2);
  assert.equal(automation.defaultOperation, "analyze");
  const op = automation.operations.analyze;
  assert.deepEqual(op.inputs.image.formats, ["jpg", "jpeg", "png"]);
  assert.deepEqual(Object.keys(op.parameters).sort(), ["maskVignette", "roiMode", "whiteBalance"]);
  assert.deepEqual(
    Object.keys(op.artifacts).sort(),
    ["colorimetry", "hemoglobin", "ita", "melanin", "provenance"],
  );
  assert.equal(examples.length, 3);
  for (const ex of examples) {
    assert.equal(ex.files.length, 1);
    assert.equal(ex.files[0].role, "image");
    assert.match(ex.files[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(ex.files[0].bytes > 0);
  }
});

test("computeAnalysisDimensions caps images above MAX_ANALYSIS_SIDE while preserving aspect ratio", () => {
  assert.equal(MAX_ANALYSIS_SIDE, 1024);
  assert.deepEqual(computeAnalysisDimensions(1022, 767), {
    width: 1022,
    height: 767,
    scale: 1,
    downscaled: false,
  });
  const square = computeAnalysisDimensions(1936, 1936);
  assert.equal(square.width, 1024);
  assert.equal(square.height, 1024);
  assert.equal(square.downscaled, true);
  const wide = computeAnalysisDimensions(4000, 3000);
  assert.equal(wide.width, 1024);
  assert.equal(wide.height, 768);
  assert.equal(wide.downscaled, true);
});

test("buildProvenance records fixed-basis RGB proxy matrix, clipping rule, display ranges, and warnings", () => {
  const rgba = new Uint8ClampedArray(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    rgba[i * 4] = 215;
    rgba[i * 4 + 1] = 175;
    rgba[i * 4 + 2] = 145;
    rgba[i * 4 + 3] = 255;
  }
  const analysis = analyzeSkinImage(rgba, 32, 32, { maskVignette: true, roiMode: "auto" });
  const record = buildProvenance({
    file: { name: "sample.png", size: 1234 },
    width: 32,
    height: 32,
    originalWidth: 64,
    originalHeight: 64,
    downscaled: true,
    format: "png",
    settings: readSettings(),
    analysis,
    manualRoi: { target: null, reference: null },
  });
  assert.equal(record.input.originalWidth, 64);
  assert.equal(record.input.width, 32);
  assert.equal(record.input.downscaled, true);
  assert.equal(record.methods.chromophoreModel.perImageIca, false);
  assert.equal(record.methods.chromophoreModel.calibratedSpectrophotometry, false);
  assert.equal(record.methods.chromophoreModel.basisMatrix.length, 3);
  assert.equal(record.methods.chromophoreModel.inverseMatrix.length, 3);
  assert.match(record.methods.chromophoreModel.nonNegativeClipping, /max\(0/);
  assert.equal(record.display.hemoglobin.range.length, 2);
  assert.equal(record.display.melanin.range.length, 2);
  assert.equal(record.autoFallback, true);
  assert.equal(record.overlapPixels, 0);
  assert.ok(record.warnings.some((w) => /fell back/i.test(w)));
});
