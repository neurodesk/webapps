// DOM-independent config, settings validation, automation, and example contract tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APP, DEFAULTS, SettingsError, readSettings } from "../src/config.js";

const automation = JSON.parse(readFileSync(new URL("../automation.json", import.meta.url), "utf8"));
const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("app config reads version from package.json and title from automation.json", () => {
  assert.equal(APP.id, "dermoscope");
  assert.equal(APP.title, "Dermoscope ABCD");
  assert.equal(APP.version, pkg.version);
  assert.ok(Object.isFrozen(APP));
});

test("readSettings defaults D to unscored (null) and accepts 0 or explicit 1..5", () => {
  const defaults = readSettings();
  assert.deepEqual(defaults, {
    removeHair: DEFAULTS.removeHair,
    colorConstancy: DEFAULTS.colorConstancy,
    thresholdBias: 0,
    pixelsPerMm: 0,
    differentialStructures: null,
  });

  assert.equal(readSettings({ differentialStructures: 0 }).differentialStructures, null);
  assert.equal(readSettings({ differentialStructures: "0" }).differentialStructures, null);
  assert.equal(readSettings({ differentialStructures: "" }).differentialStructures, null);
  assert.equal(readSettings({ differentialStructures: null }).differentialStructures, null);

  const custom = readSettings({
    removeHair: false,
    colorConstancy: true,
    thresholdBias: "-0.15",
    pixelsPerMm: "25.5",
    differentialStructures: "4",
  });
  assert.equal(custom.removeHair, false);
  assert.equal(custom.thresholdBias, -0.15);
  assert.equal(custom.pixelsPerMm, 25.5);
  assert.equal(custom.differentialStructures, 4);
});

test("readSettings rejects out-of-range parameters with field-scoped SettingsError", () => {
  assert.throws(
    () => readSettings({ thresholdBias: 0.5 }),
    (err) => err instanceof SettingsError && err.field === "thresholdBias",
  );
  assert.throws(
    () => readSettings({ thresholdBias: -0.35 }),
    (err) => err instanceof SettingsError && err.field === "thresholdBias",
  );
  assert.throws(
    () => readSettings({ pixelsPerMm: -1 }),
    (err) => err instanceof SettingsError && err.field === "pixelsPerMm",
  );
  assert.throws(
    () => readSettings({ differentialStructures: -1 }),
    (err) => err instanceof SettingsError && err.field === "differentialStructures",
  );
  assert.throws(
    () => readSettings({ differentialStructures: 6 }),
    (err) => err instanceof SettingsError && err.field === "differentialStructures",
  );
  assert.throws(
    () => readSettings({ differentialStructures: 2.5 }),
    (err) => err instanceof SettingsError && err.field === "differentialStructures",
  );
});

test("automation.json declares analyze operation with optional D default 0 and expected artifacts", () => {
  assert.equal(automation.schemaVersion, 2);
  assert.equal(automation.app, "dermoscope");
  assert.equal(automation.defaultOperation, "analyze");
  const op = automation.operations.analyze;
  assert.deepEqual(op.inputs.image.formats, ["jpg", "jpeg", "png"]);
  assert.deepEqual(Object.keys(op.parameters).sort(), [
    "colorConstancy",
    "differentialStructures",
    "pixelsPerMm",
    "removeHair",
    "thresholdBias",
  ]);
  assert.equal(op.parameters.differentialStructures.minimum, 0);
  assert.equal(op.parameters.differentialStructures.maximum, 5);
  assert.equal(op.parameters.differentialStructures.default, 0);
  assert.deepEqual(Object.keys(op.artifacts).sort(), [
    "mask",
    "metrics",
    "preprocessed",
    "provenance",
  ]);
  assert.deepEqual(op.engines, ["browser"]);
});

test("examples.json lists all three pinned ISIC dermoscopy images without clinical risk-band claims", () => {
  assert.equal(examples.length, 3);
  for (const example of examples) {
    assert.equal(example.files.length, 1);
    assert.equal(example.files[0].role, "image");
    assert.match(example.files[0].url, /\/resolve\/[0-9a-f]{40}\//);
    assert.match(example.files[0].sha256, /^[0-9a-f]{64}$/);
    assert.ok(example.files[0].bytes > 10000);
    assert.doesNotMatch(example.expectedResult, /benign-range|suspicious|high-risk|elevated TDS/i);
  }
});
