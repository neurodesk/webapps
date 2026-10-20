import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, divideVolumes, n4Arguments, rescaleBias } from "../src/index.js";

test("N4 arguments are MRtrix dwibiascorrect ants defaults", () => {
  const args = n4Arguments({ input: "in.nii", weight: "mask.nii", corrected: "c.nii", bias: "b.nii", ...DEFAULTS });
  assert.deepEqual(args, ["-d", "3", "-i", "in.nii", "-w", "mask.nii", "-o", "[c.nii,b.nii]", "-s", "4", "-b", "[100,3]", "-c", "[1000,0.0]"]);
  assert.ok(!n4Arguments({ input: "i", corrected: "c", bias: "b", ...DEFAULTS }).includes("-w"));
});

test("the bias field is rescaled to keep the brain integral", () => {
  const input = Float32Array.from([10, 20, 30, 99]);
  const corrected = Float32Array.from([20, 40, 60, 0]);
  const { bias, multiplier } = rescaleBias(input, corrected, Uint8Array.from([1, 1, 1, 0]), Float32Array.from([0.5, 0.5, 0.5, 1]));
  assert.equal(multiplier, 2);
  assert.deepEqual(Array.from(bias), [1, 1, 1, 2]);
  assert.throws(() => rescaleBias(input, corrected, new Uint8Array(4), bias), /no signal/);
});

test("every volume is divided by the field, and zero field gives zero", () => {
  const out = divideVolumes(Float32Array.from([2, 4, 6, 8]), 2, 2, Float32Array.from([2, 0]));
  assert.deepEqual(Array.from(out), [1, 0, 3, 0]);
});
