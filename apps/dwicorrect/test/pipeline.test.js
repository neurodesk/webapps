import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acqpRow,
  bidsStem,
  classifyInputs,
  confoundsTsv,
  defaultSettings,
  describeSeries,
  motionSummary,
  multibandFactor,
  outliersTsv,
  outputNames,
  readGradients,
  shellOf,
  shorelineArgs,
} from "../src/pipeline.js";

const ras = [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
const las = [[-2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];

test("gradients: rows or columns, checked against the volumes", () => {
  const { bvals, bvecs } = readGradients("0 1000 2000\n", "1 0 0\n0 1 0\n0 0 1\n", 3);
  assert.deepEqual(bvals, [0, 1000, 2000]);
  assert.deepEqual(bvecs, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual(readGradients("0 5 5", "1 0 0\n0 1 0\n0 0 1", 3).bvecs, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.throws(() => readGradients("0 1000", "1 0 0\n0 1 0\n0 0 1", 3), /2 values for 3 volumes/);
  assert.throws(() => readGradients("0 1000 1000", "1 0\n0 1", 3), /3 directions/);
});

test("shells cluster within 100 of their first b-value, as shoreline's", () => {
  assert.deepEqual(shellOf([5, 995, 1000, 2005, 40, 1990]), [0, 995, 995, 2005, 0, 2005]);
});

test("multiband from the sidecar's factor or SliceTiming's repeats", () => {
  assert.equal(multibandFactor({ MultibandAccelerationFactor: 3 }, 72), 3);
  assert.equal(multibandFactor({ MultibandAccelerationFactor: 5 }, 72), 1);
  assert.equal(multibandFactor({ SliceTiming: [0, 0.5, 0, 0.5] }, 4), 2);
  assert.equal(multibandFactor({ SliceTiming: [0, 0.25, 0.5, 0.75] }, 4), 1);
  assert.equal(multibandFactor({}, 4), 1);
});

function series({ dwi = 100, b0 = 7, shells = [1000, 2000], sidecar = {} } = {}) {
  const bvals = [...Array(b0).fill(0), ...Array.from({ length: dwi }, (_, k) => shells[k % shells.length])];
  return describeSeries({ bvals, sidecar, dims: [96, 96, 60] });
}

test("defaults follow the series, and each states its rule", () => {
  const big = defaultSettings(series({ sidecar: { MultibandAccelerationFactor: 3, SliceTiming: Array.from({ length: 60 }, (_, s) => s % 20) } }), "reverse");
  assert.equal(big.model.value, "shore");
  assert.match(big.model.rule, /≥ 72 DWIs → 3dSHORE \(100\)/);
  assert.equal(big.outliers.value, "both");
  assert.match(big.outliers.rule, /Multiband 3/);
  assert.equal(big.sliceToVolume.available, true);
  assert.equal(big.sliceToVolume.value, false);
  assert.match(big.field.rule, /Reverse-PE b0 found/);
  const small = defaultSettings(series({ dwi: 30, shells: [1000] }), "none");
  assert.equal(small.model.value, "gp");
  assert.match(small.model.rule, /< 72 DWIs → Gaussian process \(30\)/);
  assert.equal(small.outliers.value, "sw");
  assert.equal(small.sliceToVolume.available, false);
  const dsi = defaultSettings(series({ shells: [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000] }), "none");
  assert.equal(dsi.shelled.value, false);
  assert.match(dsi.shelled.rule, /> 6 b-values → not shelled \(8\)/);
});

test("acqp rows use FSL's voxel axes: x reverses for a positive determinant", () => {
  assert.equal(acqpRow("j-", 0.05, ras), "0 -1 0 0.05");
  assert.equal(acqpRow("i", 0.05, ras), "-1 0 0 0.05");
  assert.equal(acqpRow("i", 0.05, las), "1 0 0 0.05");
  assert.throws(() => acqpRow("x", 0.05, ras));
});

test("the command line carries the settings, the field and the slice groups", () => {
  const timed = series({ sidecar: { SliceTiming: Array.from({ length: 60 }, (_, s) => s % 20) } });
  const settings = { model: "shore", outliers: "both", sliceToVolume: true, eddyCurrents: "quadratic", iterations: 5 };
  const args = shorelineArgs({ settings, series: timed, field: "estimated" });
  for (const a of ["--imain=dwi.nii.gz", "--mask=mask.nii.gz", "--field=field.nii.gz", "--json=dwi.json", "--mporder=6", "--ol_type=both", "--model=shore", "--flm=quadratic", "--slm=linear", "--repol", "--out=out"]) {
    assert.ok(args.includes(a), a);
  }
  const plain = shorelineArgs({ settings: { ...settings, eddyCurrents: "movement", sliceToVolume: true }, series: series({ sidecar: { MultibandAccelerationFactor: 2 } }), field: "topup" });
  assert.ok(plain.includes("--topup=topup") && plain.includes("--mb=2") && plain.includes("--slm=none"));
  assert.ok(!plain.some((a) => a.startsWith("--mporder") || a.startsWith("--json")));
  assert.ok(!shorelineArgs({ settings, series: series(), field: "none" }).some((a) => a.startsWith("--field") || a.startsWith("--topup")));
  const kept = shorelineArgs({ settings: { ...settings, replaceOutliers: false }, series: series(), field: "none" });
  assert.ok(!kept.includes("--repol") && !kept.some((a) => a.startsWith("--ol_type")));
});

test("outputs are BIDS derivatives of the series' stem", () => {
  assert.equal(bidsStem("sub-01_ses-1_acq-mb3_dir-AP_dwi.nii.gz"), "sub-01_ses-1_acq-mb3_dir-AP");
  const names = outputNames("sub-01_dir-AP_dwi.nii.gz");
  assert.equal(names.dwi, "sub-01_dir-AP_desc-preproc_dwi.nii.gz");
  assert.equal(names.confounds, "sub-01_dir-AP_desc-confounds_timeseries.tsv");
  assert.equal(outputNames("dwi.nii").dwi, "dwi_desc-preproc_dwi.nii.gz");
  assert.equal(bidsStem("scan_20241031_7.nii.gz"), "scan_20241031_7");
  assert.equal(bidsStem("sub-01_desc-raw_dwi.nii.gz"), "sub-01");
});

const parameters = "0.1 0.2 0.3 0.01 0.02 0.03 5 6\n0 0 0 0 0 0 0 0\n";
const movementRms = "0.5 0.0\n0.7 0.2\n";
const outlierMap = "One row per scan, one column per slice. Outlier: 1, Non-outlier: 0\n0 1 0\n0 0 0\n";

test("confounds and outlier tables from the command line's files", () => {
  const confounds = confoundsTsv({ parameters, movementRms, outlierMap }).trim().split("\n").map((l) => l.split("\t"));
  assert.deepEqual(confounds[0], ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z", "rms_reference", "rms_previous", "outlier_slices"]);
  assert.deepEqual(confounds[1], ["0.100000", "0.200000", "0.300000", "0.010000", "0.020000", "0.030000", "0.500000", "0.000000", "1"]);
  assert.equal(outliersTsv(outlierMap, 3), "slice_0\tslice_1\tslice_2\n0\t1\t0\n0\t0\t0\n");
  const summary = motionSummary({ parameters, movementRms, outlierMap });
  assert.deepEqual(summary[0].outlierSlices, [1]);
  assert.ok(Math.abs(summary[0].rotationDegrees[0] - 0.573) < 1e-3);
  assert.equal(summary[1].rmsPrevious, 0.2);
});

const file = (name) => ({ name });

test("inputs: the DWI series, a reverse b0 on its grid, and an optional field", () => {
  const dwi = { image: file("sub-01_dir-AP_dwi.nii.gz"), sidecar: { PhaseEncodingDirection: "j-" }, bval: file("a.bval"), bvec: file("a.bvec"), frames: 100, sameGrid: true };
  const reverse = { image: file("sub-01_dir-PA_epi.nii.gz"), sidecar: { PhaseEncodingDirection: "j" }, bval: null, bvec: null, frames: 2, sameGrid: true };
  const t1 = { image: file("sub-01_T1w.nii.gz"), sidecar: {}, bval: null, bvec: null, frames: 1, sameGrid: false };
  const topup = { image: file("topup_fieldcoef.nii.gz"), sidecar: null, bval: null, bvec: null, frames: 1, sameGrid: false, intent: 2016 };
  const found = classifyInputs([t1, reverse, dwi]);
  assert.equal(found.dwi, dwi);
  assert.equal(found.reverse, reverse);
  assert.equal(found.field, null);
  assert.deepEqual(found.ignored, ["sub-01_T1w.nii.gz"]);
  assert.equal(classifyInputs([dwi, topup]).field.kind, "topup");
  const hz = { image: file("b0_map.nii.gz"), sidecar: { Units: "Hz" }, bval: null, bvec: null, frames: 1, sameGrid: true };
  assert.equal(classifyInputs([dwi, hz]).field.kind, "hz");
  assert.equal(classifyInputs([dwi, { ...reverse, sameGrid: false }]).reverse, null);
  assert.throws(() => classifyInputs([reverse]), /\.bval and \.bvec/);
  assert.throws(() => classifyInputs([dwi, topup, hz]), /at most one field map/);
});

test("the displacement chart uses the shared chart classes and marks volumes with outliers", async () => {
  const { displacementChart } = await import("../src/report.js");
  const svg = displacementChart([
    { volume: 0, rms: 0, rmsPrevious: 0, outlierSlices: [] },
    { volume: 1, rms: 1.2, rmsPrevious: 1.2, outlierSlices: [4] },
    { volume: 2, rms: 0.8, rmsPrevious: 0.4, outlierSlices: [] },
  ]);
  assert.match(svg, /<svg xmlns="http:\/\/www.w3.org\/2000\/svg" class="nd-chart"/);
  assert.equal((svg.match(/nd-chart-marker/g) || []).length, 1);
  assert.match(svg, /nd-chart-median/);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,6}\b|style=/i);
});
