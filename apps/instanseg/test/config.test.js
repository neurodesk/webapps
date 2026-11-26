import assert from "node:assert/strict";
import test from "node:test";
import { APP, MAX_DISPLAY_LABELS, displayLabels, labelColormap, normalizeSettings, outputName } from "../src/config.js";

test("APP and normalizeSettings validate InstanSeg defaults and bounds", () => {
  assert.equal(APP.id, "instanseg");
  const defaults = normalizeSettings({}, 0.5);
  assert.equal(defaults.pixelSize, 0.5);
  assert.equal(defaults.seedThreshold, 0.7);
  assert.equal(defaults.maskThreshold, 0.53);
  assert.equal(defaults.overlapThreshold, 0.3);
  assert.equal(defaults.tileSize, 512);
  assert.equal(defaults.backend, "auto");
  assert.throws(() => normalizeSettings({ seedThreshold: 0.01 }), /Seed threshold/);
  assert.throws(() => normalizeSettings({ maskThreshold: 1.0 }), /Mask threshold/);
  assert.throws(() => normalizeSettings({ pixelSize: 2.5 }), /Pixel size/);
});

test("outputName, displayLabels, and labelColormap handle large label counts cleanly", () => {
  assert.equal(outputName("he_crop 1", "labels.tif"), "he_crop_1_instanseg_labels.tif");
  const cmap = labelColormap(5);
  assert.deepEqual(cmap.I, [0, 1, 2, 3, 4, 5]);
  assert.equal(cmap.A[0], 0);
  assert.equal(cmap.A[5], 255);

  const huge = labelColormap(20000);
  assert.equal(huge.I.length, MAX_DISPLAY_LABELS + 1);
  const mapped = displayLabels(new Int32Array([0, 1, MAX_DISPLAY_LABELS, MAX_DISPLAY_LABELS + 1]));
  assert.deepEqual([...mapped], [0, 1, MAX_DISPLAY_LABELS, 1]);
});
