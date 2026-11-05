import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, DEFAULTS, detectionSettings, outputNames } from "../src/config.js";

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
