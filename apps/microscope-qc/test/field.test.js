// Field illumination against ImageJ (GaussianBlur) and MetroloJ_QC's formulas evaluated in
// Fiji (test/fixtures/metroloj-reference.json), and analytic cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyseField, imagejGaussianBlur, imagejGaussianKernel, lineProfile } from "../src/core/field.js";
import { smallField } from "./synthetic.js";

const reference = JSON.parse(readFileSync(new URL("./fixtures/metroloj-reference.json", import.meta.url), "utf8"));

test("the σ = 2 blur equals ImageJ's GaussianBlur pixel for pixel on a 16-bit image", () => {
  const { width, height, data } = smallField();
  const blurred = imagejGaussianBlur(data, width, height, 2, "uint16");
  assert.equal(reference.small.blurred.length, width * height);
  assert.deepEqual(Array.from(blurred), reference.small.blurred);
});

test("field metrics equal the ImageJ reference", () => {
  const { width, height, data } = smallField();
  const field = analyseField(data, { width, height, dtype: "uint16" }, { blur: true, step: 10, referenceZone: true });
  const ref = reference.small.field;
  for (const key of ["uniformity", "fieldUniformity", "centeringAccuracy", "min", "max"]) assert.ok(Math.abs(field[key] - ref[key]) < 1e-9, `${key}: ${field[key]} vs ${ref[key]}`);
  assert.ok(Math.abs(field.reference.x - ref.reference.x) < 1e-9 && Math.abs(field.reference.y - ref.reference.y) < 1e-9);
});

test("a uniform image is 100 % uniform and centred", () => {
  const field = analyseField(new Uint16Array(40 * 30).fill(500), { width: 40, height: 30, dtype: "uint16" });
  assert.equal(field.uniformity, 100);
  assert.equal(field.fieldUniformity, 100);
  assert.equal(field.centeringAccuracy, 100);
  assert.equal(field.referencePixels, 1200);
});

test("centering accuracy falls with the distance of the bright zone from the centre", () => {
  const width = 100;
  const height = 80;
  const data = new Float32Array(width * height).fill(100);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) data[y * width + x] = 1000;
  const field = analyseField(data, { width, height, dtype: "float32" }, { blur: false });
  const distance = Math.hypot(5 - 50, 5 - 40);
  assert.ok(Math.abs(field.centeringAccuracy - (100 - (200 * distance) / Math.hypot(width, height))) < 1e-12);
  assert.ok(Math.abs(field.uniformity - 10) < 1e-12);
});

test("the kernel is normalised and its tail sums match", () => {
  const { kernel, tail } = imagejGaussianKernel(2, 0.0002, 100);
  let sum = kernel[0];
  for (let i = 1; i < kernel.length; i++) sum += 2 * kernel[i];
  assert.ok(Math.abs(sum - 1) < 1e-6);
  assert.ok(Math.abs(tail[0] - (1 - kernel[0]) / 2) < 1e-6);
});

test("profiles sample round(length) + 1 points along the line", () => {
  const image = Float32Array.from({ length: 12 }, (_, i) => i);
  const profile = lineProfile(image, 4, 3, [0, 1], [3, 1]);
  assert.deepEqual(Array.from(profile.values), [4, 5, 6, 7]);
});
