import { test } from "node:test";
import assert from "node:assert/strict";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { assembleJob, defaultThickness, describeStack, formatDims, isNiftiName, matchMasks, stem } from "../src/stacks.js";

test("names and stems", () => {
  assert.equal(stem("stack-d2.nii.gz"), "stack-d2");
  assert.equal(stem("volume.nii"), "volume");
  assert.equal(isNiftiName("a.NII.GZ"), true);
  assert.equal(isNiftiName("a.dcm"), false);
  assert.equal(formatDims([84, 82, 75]), "84 × 82 × 75");
});

test("thickness defaults to the slice spacing", () => {
  assert.equal(defaultThickness([1, 1, 3.5]), 3.5);
  assert.equal(defaultThickness([1.25, 1.25, 1.2549]), 1.25);
  assert.equal(defaultThickness([1, 1, 0]), 3);
  assert.equal(defaultThickness(undefined), 3);
});

test("describeStack reads dimensions and spacing from gzipped and plain NIfTI", async () => {
  for (const gzip of [true, false]) {
    const file = new File([syntheticNifti({ dims: [5, 6, 7], spacing: [1, 1, 2.5], gzip })], gzip ? "s.nii.gz" : "s.nii");
    const description = await describeStack(file);
    assert.deepEqual(description.dims, [5, 6, 7]);
    assert.equal(description.slices, 7);
    assert.equal(description.thickness, 2.5);
  }
  await assert.rejects(describeStack(new File([new Uint8Array(400)], "x.nii")), /not a NIfTI-1/);
});

test("masks pair by order when counts match and by name otherwise", () => {
  assert.deepEqual(matchMasks(["a.nii.gz", "b.nii.gz"], ["m1.nii.gz", "m2.nii.gz"]), [0, 1]);
  assert.deepEqual(matchMasks(["stack-d0.nii.gz", "stack-d1.nii.gz", "stack-d2.nii.gz"], ["stack-d2_mask.nii.gz"]), [2]);
  assert.deepEqual(matchMasks(["stack-1.nii.gz", "stack-10.nii.gz"], ["stack-10-mask.nii.gz"]), [1]);
  assert.deepEqual(matchMasks(["a.nii.gz", "b.nii.gz", "c.nii.gz"], ["other.nii.gz"]), [-1]);
});

test("assembleJob names parts and drops incomplete masks", () => {
  const stack = new File([new Uint8Array(1)], "a.nii.gz");
  const mask = new File([new Uint8Array(1)], "a_mask.nii.gz");
  const complete = assembleJob([{ file: stack, thickness: 2, mask }], { registration: "stack" });
  assert.deepEqual(Object.keys(complete.files), ["stack-0", "mask-0"]);
  assert.deepEqual(complete.spec.stacks, [{ file: "stack-0", thickness: 2, mask: "mask-0" }]);
  assert.equal(complete.masksUsed, true);
  const partial = assembleJob([{ file: stack, thickness: 2, mask }, { file: stack, thickness: 2, mask: null }], {});
  assert.deepEqual(Object.keys(partial.files), ["stack-0", "stack-1"]);
  assert.deepEqual(partial.spec.stacks, [{ file: "stack-0", thickness: 2 }, { file: "stack-1", thickness: 2 }]);
  assert.equal(partial.masksUsed, false);
});
