import { test } from "node:test";
import assert from "node:assert/strict";
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { fusedTiff, linksCsv, outputStem, registeredConfiguration } from "../src/outputs.js";

test("the output stem is the tiles' common name without the tile index", () => {
  assert.equal(outputStem(["img_r001_c001.tif", "img_r001_c002.tif", "img_r004_c004.tif"]), "img");
  assert.equal(outputStem(["tile_1.ome.tif", "tile_2.ome.tif"]), "tile");
  assert.equal(outputStem(["1.tif", "2.tif"]), "mosaic");
  assert.equal(outputStem(["brain-x0-y0.tif", "brain-x1-y0.tif"]), "brain");
});

test("a fused z stack is written as a TIFF that reads back with its pixel size and values", async () => {
  const data = Uint16Array.from({ length: 4 * 3 * 2 }, (_, i) => i * 1000);
  const bytes = fusedTiff({ data, shape: [4, 3, 2], pixelSize: { x: 0.65, y: 0.65, z: 2 } });
  const stack = await readTiffStack(bytes.buffer);
  assert.equal(stack.pages, 2);
  assert.deepEqual(Array.from(stack.data), Array.from(data));
  assert.equal(stack.metadata.kind, "imagej");
  assert.equal(stack.metadata.sizeZ, 2);
  assert.ok(Math.abs(stack.metadata.pixelSize.x - 0.65) < 1e-6);
  assert.equal(stack.metadata.pixelSize.z, 2);
});

test("the registered configuration and pair table carry every tile and pair", () => {
  const names = ["a.tif", "b.tif"];
  assert.match(registeredConfiguration(names, [[0, 0], [90.25, -1.5]]), /^b\.tif; ; \(90\.25, -1\.5\)$/m);
  const csv = linksCsv(names, [{ i: 0, j: 1, approximateOffset: [90, 0], offset: [90.25, -1.5], r: 0.97, status: "used", residual: 0 }]);
  assert.equal(csv, "tile_a,tile_b,layout_dx,layout_dy,measured_dx,measured_dy,correlation,status,residual_px\na.tif,b.tif,90,0,90.25,-1.5,0.97,used,0\n");
});

test("OME-Zarr calibration is per axis: a known XY pixel size is kept when z is unknown", async () => {
  const { omeZarrCalibration } = await import("../src/outputs.js");
  assert.deepEqual(omeZarrCalibration({ x: 0.65, y: 0.75, z: null }, 3), { spacing: [0.65, 0.75, 1], units: { x: "micrometer", y: "micrometer" } });
  assert.deepEqual(omeZarrCalibration({ x: 0.65, y: 0.75, z: 2 }, 3), { spacing: [0.65, 0.75, 2], units: { x: "micrometer", y: "micrometer", z: "micrometer" } });
  assert.deepEqual(omeZarrCalibration({ x: 0.65, y: null, z: null }, 2), { spacing: [0.65, 1], units: { x: "micrometer" } });
  assert.deepEqual(omeZarrCalibration({ x: null, y: null, z: null }, 2), { spacing: [1, 1], units: {} });
  assert.deepEqual(omeZarrCalibration(undefined, 2), { spacing: [1, 1], units: {} });
});
