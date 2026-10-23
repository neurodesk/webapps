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

test("animation frames: one slice per volume, one grey scale per pair, anterior up", async () => {
  const { axialSlices, greyPixels, greyScale } = await import("../src/frames.js");
  const dims = [2, 2, 3];
  const data = Float32Array.from({ length: 2 * 12 }, (_, i) => i);
  const slices = axialSlices(data, dims, 2);
  assert.deepEqual([...slices[0]], [4, 5, 6, 7]);
  assert.deepEqual([...slices[1]], [16, 17, 18, 19]);
  assert.equal(greyScale(Float32Array.of(0, 1, 2), Float32Array.of(4, -1)), 4);
  const pixels = greyPixels(Float32Array.of(0, 2, 4, 8), [2, 2], 8);
  // Row y = 1 (values 4, 8) is drawn first.
  assert.deepEqual([pixels[0], pixels[4], pixels[8], pixels[12]], [128, 255, 0, 64]);
  assert.equal(pixels[3], 255);
});

test("the preview slice is 60 % of the way up the head, not the middle of the field of view", async () => {
  const { previewSlice } = await import("../src/frames.js");
  // A 4 × 4 × 20 b0 with the head in slices 6 to 14; slices 5 and 15 have too little area.
  const dims = [4, 4, 20];
  const mean = new Float32Array(4 * 4 * 20);
  for (let z = 5; z <= 15; z++) for (let i = 0; i < (z === 5 || z === 15 ? 1 : 16); i++) mean[z * 16 + i] = 100;
  assert.equal(previewSlice(mean, dims), 11);
  assert.equal(previewSlice(new Float32Array(4 * 4 * 20), dims), 10);
});

test("the GIF encoder writes a looping GIF89a with one image per frame", async () => {
  const { encodeGif, lzw } = await import("../src/gif.js");
  const frames = [Uint8Array.from({ length: 12 }, (_, i) => i * 20), new Uint8Array(12).fill(255)];
  const gif = encodeGif({ width: 4, height: 3, frames });
  assert.equal(new TextDecoder().decode(gif.subarray(0, 6)), "GIF89a");
  assert.equal(gif[6] | (gif[7] << 8), 4);
  assert.equal(gif.at(-1), 0x3b);
  assert.equal(gif.filter((b, i) => b === 0x2c && gif[i - 8] === 0x21 && gif[i - 7] === 0xf9).length, 2);
  // Clear code first (256 in 9 bits: low byte 0, then bit 0 of the next byte set).
  const codes = lzw(Uint8Array.of(1, 1, 1, 1));
  assert.equal(codes[0], 0);
  assert.equal(codes[1] & 1, 1);
});

test("the preview leaves out the b0 volumes", async () => {
  const { previewVolumes } = await import("../src/before-after-gif.js");
  assert.deepEqual(previewVolumes([0, 1000, 5, 2000, 50, 51]), [1, 3, 5]);
});

test("the input summary: file, volumes and shells, acquisition, field source", async () => {
  const { inputSummary: summary } = await import("../src/pipeline.js");
  // Items keep non-breaking spaces; compare with ordinary ones.
  const inputSummary = (args) => summary(args).map((line) => line.replaceAll("\u00a0", " "));
  const timing = Array.from({ length: 60 }, (_, s) => s % 20);
  const adni = describeSeries({
    bvals: [...Array(13).fill(0), ...Array(6).fill(500), ...Array(48).fill(1000), ...Array(60).fill(2005)],
    sidecar: { PhaseEncodingDirection: "j", TotalReadoutTime: 0.0632499, MultibandAccelerationFactor: 3, SliceTiming: timing },
    dims: [96, 96, 60],
  });
  assert.deepEqual(inputSummary({ name: "a.nii.gz", series: adni, reverse: "a_rev.nii.gz" }), [
    "a.nii.gz",
    "127 vol: 13 b0 · b500×6 · b1000×48 · b2000×60",
    "PE j, 63 ms readout · multiband 3 · slice timing",
    "Reverse-PE b0: a_rev.nii.gz",
  ]);
  const clinical = describeSeries({ bvals: [...Array(5).fill(5), ...Array(30).fill(995)], sidecar: { PhaseEncodingDirection: "j-", TotalReadoutTime: 0.05 }, dims: [96, 96, 60] });
  assert.deepEqual(inputSummary({ name: "dwi.nii.gz", series: clinical }), ["dwi.nii.gz", "35 vol: 5 b0 · b1000×30", "PE j-, 50 ms readout"]);
  const dsi = describeSeries({ bvals: [0, ...Array.from({ length: 41 }, (_, k) => 800 + k * 105)], sidecar: {}, dims: [96, 96, 60] });
  assert.deepEqual(inputSummary({ name: "dsi.nii.gz", series: dsi, field: "topup_fieldcoef.nii.gz" }), [
    "dsi.nii.gz",
    "42 vol: 1 b0 · 41 DWI, b 800–5000",
    "PE: not in sidecar",
    "Field map: topup_fieldcoef.nii.gz",
  ]);
  const noReadout = describeSeries({ bvals: [0, ...Array(30).fill(1000)], sidecar: { PhaseEncodingDirection: "j" }, dims: [96, 96, 60] });
  assert.equal(inputSummary({ name: "x", series: noReadout, entered: { pe: "j-", readout: 0.05 } })[2], "PE j, 50 ms readout (set below)");
  assert.equal(inputSummary({ name: "x", series: dsi, entered: { pe: "j-", readout: 0.05 } })[2], "PE j-, 50 ms readout (set below)");
});
