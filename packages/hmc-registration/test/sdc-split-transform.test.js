import assert from "node:assert/strict";
import test from "node:test";
import { loadHmcRegistration } from "../src/node.js";
import { sdcInputs } from "./sdc-fixture.mjs";

// nipype renders a bracketed transform with spaces ("[ trans.mat, 1 ]"), so the native command
// line passes it as four tokens, and ANTs' parser regroups them (#462).
test("antsApplyTransforms takes a bracketed transform split over tokens, as nipype renders it", async () => {
  const kernel = await loadHmcRegistration();
  const inputs = sdcInputs();
  const argv = ["antsApplyTransforms", "-d", "3", "--float", "0", "-i", "labels.nii", "-r", "fixed.nii", "-o", "out.nii", "-n", "Linear", "-t"];
  const joined = kernel.run([...argv, "[trans.mat,1]"], inputs).outputs["out.nii"];
  const identity = kernel.run([...argv, "identity"], inputs).outputs["out.nii"];
  assert.notDeepEqual(joined, identity);
  for (const split of [["[", "trans.mat,", "1", "]"], ["[trans.mat,", "1]"]]) {
    assert.deepEqual(kernel.run([...argv, ...split], inputs).outputs["out.nii"], joined);
  }
  assert.throws(() => kernel.run([...argv, "[", "missing.mat,", "1", "]"], inputs), /reads "missing\.mat"/);
  assert.deepEqual(kernel.run([...argv, "[trans.mat,1]"], inputs).outputs["out.nii"], joined);
});
