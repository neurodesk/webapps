import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldSummary, missingAcquisition, selectBidsSyn, selectSynSeries, stageProgress } from "../src/syn.js";

const file = (name, path) => {
  const entry = new File(["x"], name);
  if (path) Object.defineProperty(entry, "webkitRelativePath", { value: path });
  return entry;
};
const series = (name, gradients = false) => ({ image: file(name), bval: gradients ? file("x.bval") : null, bvec: gradients ? file("x.bvec") : null, sidecar: {} });

test("loose files: the series with gradients is the DWI, the *_T1w image the T1w", () => {
  const chosen = selectSynSeries([series("sub-01_T1w.nii.gz"), series("sub-01_dir-AP_dwi.nii.gz", true), series("sub-01_dir-PA_epi.nii.gz")]);
  assert.equal(chosen.image.name, "sub-01_dir-AP_dwi.nii.gz");
  assert.equal(chosen.t1w.name, "sub-01_T1w.nii.gz");
  assert.equal(selectSynSeries([series("dwi.nii", true), series("anatomy.nii")]).t1w.name, "anatomy.nii");
});

test("loose files without one DWI series or one T1w are refused", () => {
  assert.throws(() => selectSynSeries([series("t1.nii")]), /one DWI series with its bval and bvec/);
  assert.throws(() => selectSynSeries([series("a.nii", true), series("b.nii", true), series("t1.nii")]), /has 2 DWI series/);
  assert.throws(() => selectSynSeries([series("dwi.nii", true)]), /needs a T1-weighted image/);
  assert.throws(() => selectSynSeries([series("dwi.nii", true), series("a.nii"), series("b.nii")]), /Choose one T1w image/);
});

test("a BIDS folder gives the run's DWI and its subject's T1w", async () => {
  const files = [
    file("sub-01_dir-AP_dwi.nii.gz", "ds/sub-01/dwi/sub-01_dir-AP_dwi.nii.gz"),
    file("sub-01_dir-AP_dwi.bval", "ds/sub-01/dwi/sub-01_dir-AP_dwi.bval"),
    file("sub-01_dir-AP_dwi.bvec", "ds/sub-01/dwi/sub-01_dir-AP_dwi.bvec"),
    file("sub-01_T1w.nii.gz", "ds/sub-01/anat/sub-01_T1w.nii.gz"),
  ];
  const chosen = await selectBidsSyn(files);
  assert.equal(chosen.image.name, "sub-01_dir-AP_dwi.nii.gz");
  assert.equal(chosen.t1w.name, "sub-01_T1w.nii.gz");
  await assert.rejects(selectBidsSyn(files.slice(0, 3)), /No T1w image of sub-01/);
  assert.equal(await selectBidsSyn([file("image.nii.gz")]), null);
});

test("flat BIDS names are read as a BIDS selection", async () => {
  const chosen = await selectBidsSyn([file("sub-01_dir-AP_dwi.nii.gz"), file("sub-01_dir-AP_dwi.bval"), file("sub-01_dir-AP_dwi.bvec"), file("sub-01_run-001_T1w.nii.gz")]);
  assert.equal(chosen.t1w.name, "sub-01_run-001_T1w.nii.gz");
});

test("the sidebar asks only for what no sidecar gives", () => {
  assert.deepEqual(missingAcquisition(null), { direction: true, readout: true });
  assert.deepEqual(missingAcquisition({ PhaseEncodingDirection: "j-", TotalReadoutTime: 0.04 }), { direction: false, readout: false });
  assert.deepEqual(missingAcquisition({ PhaseEncodingDirection: "j-", EffectiveEchoSpacing: 0.0003 }), { direction: false, readout: false });
  assert.deepEqual(missingAcquisition({ TotalReadoutTime: 0.04 }), { direction: true, readout: false });
});

test("stages map to messages and a rising progress", () => {
  assert.equal(stageProgress({ stage: "syn" }).message, "Registering with SyN along the phase-encoding axis");
  assert.deepEqual(stageProgress({ stage: "unwarp", done: 137, total: 137 }), { message: "Unwarping the DWI series: 137/137", fraction: 0.99 });
  const order = ["reference", "masks", "anatomical", "affine", "resample", "laplacian", "syn", "field", "unwarp", "write"].map((stage) => stageProgress({ stage }).fraction);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the field summary counts only mask voxels", () => {
  const summary = fieldSummary(Float32Array.from([100, -4, 2, -1, 3]), Uint8Array.from([0, 1, 1, 1, 1]), 0.05);
  assert.deepEqual(summary, { voxels: 4, median: 3, p95: 4, max: 4, shift: 0.2 });
  assert.throws(() => fieldSummary(Float32Array.from([1]), Uint8Array.from([0]), 0.05), /mask is empty/);
});
