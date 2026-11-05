// DOM-independent unit tests (Node, no browser) for settings, refusals, names and TIFF I/O.
import { test } from "node:test";
import assert from "node:assert/strict";
import { APP, MAX_VOXELS, analysisSettings, baseName, imageRefusal, inputKind, outputPlan } from "../src/config.js";
import { readTiff, writeTiff } from "../src/io.js";

test("app id is lowercase kebab-case and the config is frozen", () => {
  assert.match(APP.id, /^[a-z][a-z0-9-]*$/);
  assert.ok(Object.isFrozen(APP));
});

test("settings default to OrientationJ-like scales and refuse out-of-range values", () => {
  assert.deepEqual(analysisSettings({}), { sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 });
  assert.throws(() => analysisSettings({ sigma: 0 }), /Gradient scale σ must be between 0.5 and 20/);
  assert.throws(() => analysisSettings({ rho: Number.NaN }), /Window scale ρ/);
  assert.throws(() => analysisSettings({ minCoherency: 1.5 }), /Minimum coherency/);
});

test("images are refused when too small, too large or when σ is under a voxel along an axis", () => {
  const settings = analysisSettings({});
  assert.equal(imageRefusal({ dims: [64, 64, 1], spacing: [1, 1, 1] }, settings), null);
  assert.match(imageRefusal({ dims: [4, 64, 1], spacing: [1, 1, 1] }, settings), /at least 8 × 8/);
  assert.match(imageRefusal({ dims: [4096, 4096, 1], spacing: [1, 1, 1] }, settings), /crop or bin/);
  assert.ok(4096 * 4096 > MAX_VOXELS);
  assert.match(imageRefusal({ dims: [64, 64, 16], spacing: [0.5, 0.5, 2] }, settings), /σ is 0.25 voxels along z.*at least 4/);
  assert.equal(imageRefusal({ dims: [64, 64, 16], spacing: [0.5, 0.5, 2] }, { ...settings, sigma: 4 }), null);
  // A 2D image ignores its z spacing.
  assert.equal(imageRefusal({ dims: [64, 64, 1], spacing: [1, 1, 5] }, settings), null);
});

test("output names follow the input and its format", () => {
  assert.equal(baseName("skin.ome.tif"), "skin");
  assert.equal(inputKind("a.TIF"), "tiff");
  assert.equal(inputKind("a.nii.gz"), "nifti");
  assert.equal(inputKind("a.jpeg"), "raster");
  assert.equal(inputKind("a.czi"), null);
  const plan2d = outputPlan("skin.tif", 2, "tiff");
  assert.deepEqual(Object.keys(plan2d), ["orientation", "coherency", "energy", "colour", "distribution", "summary"]);
  assert.equal(plan2d.colour[0], "skin_hsb.png");
  const plan3d = outputPlan("stack.nii.gz", 3, "nifti");
  assert.equal(plan3d.azimuth[0], "stack_azimuth.nii.gz");
  assert.equal(plan3d.vectors[0], "stack_fibre_vectors.nii.gz");
});

test("float32 and RGB TIFF stacks round-trip through the shared TIFF module with their voxel size", async () => {
  const dims = [5, 3, 2];
  const data = Float32Array.from({ length: 30 }, (_, i) => i * 0.25 - 3);
  const back = await readTiff(writeTiff({ data, dims, spacing: [0.5, 0.5, 2], unit: "micron" }));
  assert.deepEqual(back.dims, dims);
  assert.deepEqual(back.spacing, [0.5, 0.5, 2]);
  assert.equal(back.unit, "micron");
  assert.deepEqual(Array.from(back.data), Array.from(data));
  const rgb = Uint8Array.from({ length: 90 }, (_, i) => (i * 7) % 256);
  const colour = await readTiff(writeTiff({ data: rgb, dims, rgb: true }));
  // Colour pages are read as the mean of their channels.
  assert.equal(colour.data[1], (rgb[3] + rgb[4] + rgb[5]) / 3);
});
