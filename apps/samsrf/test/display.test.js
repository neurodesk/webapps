import { test } from "node:test";
import assert from "node:assert/strict";
import { POLAR_COLORMAP_POINTS, cameraFor, countShown, encodeOverlay, hemisphereOf, mapKind, mapOrder, mapStyle } from "../src/display.js";

test("SamSrf map names are recognised", () => {
  assert.deepEqual(["Polar", "Eccentricity", "R^2", "Sigma", "Fwhm", "x0", "Noise Ceiling"].map(mapKind), ["polar", "eccentricity", "r2", "size", "size", "other", "other"]);
  assert.deepEqual(mapOrder(["R^2", "x0", "Sigma", "Eccentricity", "Polar"]), ["Polar", "Eccentricity", "Sigma", "R^2", "x0"]);
});

test("the polar angle colormap is cyclic", () => {
  for (const channel of ["R", "G", "B", "A"]) assert.equal(POLAR_COLORMAP_POINTS[channel][0], POLAR_COLORMAP_POINTS[channel].at(-1), channel);
});

test("vertices at or below the R² threshold are transparent; shown ones map into [1, 2]", () => {
  const values = Float32Array.from([-180, 0, 180, 90, Number.NaN]);
  const r2 = Float32Array.from([0.5, 0.5, 0.5, 0.05, 0.9]);
  const encoded = encodeOverlay(values, r2, 0.1, [-180, 180]);
  assert.deepEqual([...encoded], [1, 1.5, 2, 0, 0]);
  assert.equal(countShown(r2, 0.1), 4, "the count is of vertices passing the threshold");
  assert.equal(countShown(r2, 0), 5);
});

test("vertices outside the ROI (R² exactly 0) stay hidden at threshold 0", () => {
  assert.deepEqual([...encodeOverlay(Float32Array.from([3]), Float32Array.from([0]), 0, [0, 10])], [0]);
});

test("eccentricity runs to the stimulus radius; sizes to the shown 98th percentile", () => {
  const values = Float32Array.from({ length: 101 }, (_, index) => index);
  const r2 = new Float32Array(101).fill(1);
  assert.deepEqual(mapStyle("Eccentricity", values, { r2, threshold: 0, scalingFactor: 9.5 }).window, [0, 9.5]);
  assert.deepEqual(mapStyle("Sigma", values, { r2, threshold: 0 }).window, [0, 98]);
  assert.deepEqual(mapStyle("Polar", values, { r2, threshold: 0 }).window, [-180, 180]);
});

test("the camera sees each hemisphere's lateral surface from its own side", () => {
  assert.notEqual(cameraFor("lateral", "lh").azimuth, cameraFor("lateral", "rh").azimuth);
  assert.equal(cameraFor("lateral", "lh").azimuth, cameraFor("medial", "rh").azimuth);
  assert.equal(hemisphereOf(["aps_Bars.mat", "lh_uBars1.gii"]), "lh");
  assert.equal(hemisphereOf(["rh.inflated"]), "rh");
  assert.equal(hemisphereOf(["bars.gii"]), null);
});
