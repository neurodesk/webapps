import assert from "node:assert/strict";
import { test } from "node:test";
import { b0Volumes, meanVolumes, outputNames } from "../src/pipeline.js";

test("the bias field comes from the b0 volumes, or every volume without b-values", () => {
  assert.deepEqual(b0Volumes([0, 1000, 5, 2000], 4), [0, 2]);
  assert.deepEqual(b0Volumes(null, 3), [0, 1, 2]);
  assert.throws(() => b0Volumes([1000, 2000], 2), /no b0 volume/);
  for (const value of [-1, NaN, Infinity]) {
    assert.throws(() => b0Volumes([0, value], 2), /finite non-negative/);
  }
});

test("the reference is the voxel-wise mean of the chosen volumes", () => {
  const mean = meanVolumes(Float32Array.from([0, 2, 100, 100, 2, 0, 100, 102]), 4, [0, 1]);
  assert.deepEqual(Array.from(mean), [1, 1, 100, 101]);
});

test("derivative names keep the BIDS suffix", () => {
  assert.deepEqual(outputNames("sub-01_dir-AP_dwi.nii.gz"), {
    image: "sub-01_dir-AP_desc-n4_dwi.nii.gz",
    bias: "sub-01_dir-AP_desc-n4_biasfield.nii.gz",
    mask: "sub-01_dir-AP_desc-brain_mask.nii.gz",
    bval: "sub-01_dir-AP_desc-n4_dwi.bval",
    bvec: "sub-01_dir-AP_desc-n4_dwi.bvec",
    sidecar: "sub-01_dir-AP_desc-n4_dwi.json",
  });
  assert.equal(outputNames("t1.nii").image, "t1_desc-n4.nii.gz");
});


test("derivative names replace a previous description entity", () => {
  assert.deepEqual(outputNames("sub-01_desc-denoise_dwi.nii.gz"), {
    image: "sub-01_desc-n4_dwi.nii.gz",
    bias: "sub-01_desc-n4_biasfield.nii.gz",
    mask: "sub-01_desc-brain_mask.nii.gz",
    bval: "sub-01_desc-n4_dwi.bval",
    bvec: "sub-01_desc-n4_dwi.bvec",
    sidecar: "sub-01_desc-n4_dwi.json",
  });
});
