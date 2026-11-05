import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, DEFAULTS, MEMORY_BUDGET, checkRun, detectionSettings, formatThreshold, outputNames, voxelFromFile } from "../src/config.js";

test("app id is lowercase kebab-case and frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("defaults are the Big-FISH tutorial's voxel size and spot radius", () => {
  const settings = detectionSettings(DEFAULTS);
  assert.deepEqual(settings.voxelSize, [300, 103, 103]);
  assert.deepEqual(settings.spotRadius, [350, 150, 150]);
  assert.equal(settings.threshold, null);
  assert.equal(settings.projection, false);
  assert.equal(settings.subpixel, true);
});

test("form strings are parsed; an empty threshold is automatic", () => {
  const settings = detectionSettings({ voxelZ: "200", voxelYx: "65", radiusZ: "300", radiusYx: "100", threshold: "", projection: true, subpixel: false });
  assert.deepEqual(settings.voxelSize, [200, 65, 65]);
  assert.equal(settings.threshold, null);
  assert.equal(detectionSettings({ threshold: "12.5" }).threshold, 12.5);
});

test("invalid lengths and thresholds are refused", () => {
  assert.throws(() => detectionSettings({ voxelZ: "0" }), /Voxel size z/);
  assert.throws(() => detectionSettings({ radiusYx: "abc" }), /Spot radius yx/);
  assert.throws(() => detectionSettings({ threshold: "-1" }), /threshold/);
});

test("output names follow the input and the projection", () => {
  assert.deepEqual(outputNames("cells.ome.tif", true), { spots: "cells_mip_spots.csv", cells: "cells_mip_cell_counts.csv", overlay: "cells_mip_spots.nii.gz" });
  assert.equal(outputNames("stack.tiff", false).spots, "stack_spots.csv");
});

test("3D cell labels are refused with the maximum projection before a run", () => {
  const image = { shape: [5, 40, 48], dtype: "uint16" };
  const labels3d = { shape: [5, 40, 48] };
  const projection = detectionSettings({ projection: true });
  assert.throws(() => checkRun(image, projection, labels3d), /3D cell labels cannot count spots found in the 2D maximum projection/);
  assert.doesNotThrow(() => checkRun(image, detectionSettings({}), labels3d));
  assert.doesNotThrow(() => checkRun(image, projection, { shape: [40, 48] }));
  assert.doesNotThrow(() => checkRun(image, projection));
});

test("an image beyond the working-memory budget is refused before a run", () => {
  assert.equal(MEMORY_BUDGET, 4 * 1024 ** 3);
  const settings = detectionSettings({});
  assert.doesNotThrow(() => checkRun({ shape: [100, 1024, 1024], dtype: "uint16" }, settings));
  assert.throws(() => checkRun({ shape: [120, 1024, 1024], dtype: "uint16" }, settings), /120 × 1024 × 1024 uint16 image needs about 4\.6 GB of working memory, above the 4\.0 GB limit/);
  assert.throws(() => checkRun({ shape: [70, 1024, 1024], dtype: "float64" }, settings), /working memory/);
});

test("voxel sizes from file metadata are rounded as the form shows them; missing axes are left out", () => {
  assert.deepEqual(voxelFromFile({ z: 300.00000001, y: 102.99999, x: 102.99999 }), { voxelZ: 300, voxelYx: 103 });
  assert.deepEqual(voxelFromFile({ z: null, y: 65, x: null }), { voxelYx: 65 });
  assert.deepEqual(voxelFromFile(null), {});
});

test("thresholds display whole or to four significant digits", () => {
  assert.equal(formatThreshold(355), "355");
  assert.equal(formatThreshold(null), "none");
  assert.equal(formatThreshold(0.123456789), "0.1235");
  assert.equal(formatThreshold(1234.5678), "1235");
});
