// Runs the complete estimator on the pinned M0 series, independently of the kept-target replay.
//   node packages/hmc/validation/nifreeze-loop.mjs ROOT OUT trivial|gp [WORKERS]
// ROOT is fetched by exes/dwi/hmc/validation/fetch_reference.py (gp, clip, decomposition,
// nifreeze-replay). GP writes its report even when the native-float acceptance gate fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { correctNiFreeze } from "../src/nifreeze.js";
import { readSeries } from "../src/pipeline.js";
import { loadHmcNode, nodeRuntime } from "../src/node.js";
import { nativeFloatGate } from "./nifreeze-gate.mjs";

const [root, out, model, workerText = "4"] = process.argv.slice(2);
if (!root || !out || !["trivial", "gp"].includes(model)) throw new Error("Usage: nifreeze-loop.mjs ROOT OUT trivial|gp [WORKERS]");
const manifest = JSON.parse(await readFile(new URL("../../../exes/dwi/hmc/validation/reference.manifest.json", import.meta.url), "utf8"));
const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function pinned(path) {
  const expected = entries.get(path);
  assert.ok(expected, `Unlisted reference: ${path}`);
  const bytes = await readFile(join(root, path));
  assert.equal(bytes.length, expected.bytes, path);
  assert.equal(hash(bytes), expected.sha256, path);
  return bytes;
}
const text = async path => new TextDecoder().decode(await pinned(path));
const values = text => text.trim().split(/\s+/).map(Number);
const volume = async path => readNiftiFrames(await decodeNiftiBuffer(await pinned(path)), Float64Array).data;
const run = model === "gp" ? "nifreeze-gp" : "nifreeze-trivial-a1";
const fileName = "sub-107_dir-AP_dwi.nii.gz";
const series = await readSeries(await pinned(`input/${fileName}`));
const bvals = values(await text("input/sub-107_dir-AP_dwi.bval"));
const bvecs = (await text("input/sub-107_dir-AP_dwi.bvec")).trim().split("\n").map(values);
const mask = Uint8Array.from(await volume("mask/sub-107_dir-AP_desc-mindgrab_mask.nii.gz"), value => value ? 1 : 0);
const hmc = await loadHmcNode();
const templateHash = hash(await volume("nifreeze-trivial-a1/work/predicted_00000.nii.gz"));
const visitOrder = model === "trivial" ? values(await text(`${run}/work/order.txt`)) : undefined;
let checkedPredictions = 0;
const predictionHashes = [];
let lastReported = 0;
const start = performance.now();
const result = await correctNiFreeze({
  series, bvals, bvecs, mask, hmc, model, seed: 1234, visitOrder, fileName,
  sidecar: JSON.parse(await text("input/sub-107_dir-AP_dwi.json")),
  runtime: nodeRuntime({ workers: Number(workerText) }),
  onPrediction: ({ index, volume }) => {
    if (model === "trivial") assert.equal(hash(volume), templateHash, `prediction ${index}`);
    predictionHashes[index] = hash(volume);
    checkedPredictions++;
  },
  onProgress: event => {
    if (event.stage === "register" && event.done >= lastReported + 10) {
      lastReported = event.done;
      console.log(`${model}: ${event.done}/${event.total} registrations, ${((performance.now() - start) / 1000).toFixed(1)} s`);
    }
  },
});
const seconds = (performance.now() - start) / 1000;
assert.equal(result.transforms.length, 101);
assert.equal(result.registered.filter(Boolean).length, 90);
assert.equal(checkedPredictions, 90);
const written = await readSeries(result.files[result.names.image]);
assert.equal(written.frames, 101);
assert.deepEqual(written.dims, series.dims);
const voxels = series.dims.reduce((a, b) => a * b);
for (let v = 0; v < series.frames; v++) if (result.b0[v]) {
  assert.deepEqual(written.data.subarray(v * voxels, (v + 1) * voxels), series.data.subarray(v * voxels, (v + 1) * voxels));
}
const motionRows = new TextDecoder().decode(result.files[result.names.motion]).trim().split("\n");
assert.equal(motionRows.length, 102);
assert.equal(values(new TextDecoder().decode(result.files[result.names.bval])).length, 101);
assert.ok(new TextDecoder().decode(result.files[result.names.bvec]).trim().split("\n").every(row => values(row).length === 101));
const report = { model, seconds, volumes: 101, registered: 90, checkedPredictions, visitOrder: result.visitOrder, q53: null };
if (model === "gp") {
  const predictionMismatches = [];
  for (let i = 0; i < 90; i++) {
    const reference = await volume(`nifreeze-gp/work/predicted_${String(i).padStart(5, "0")}.nii.gz`);
    if (predictionHashes[i] !== hash(reference)) predictionMismatches.push(i);
  }
  report.predictionMismatches = predictionMismatches;
  const grid = { shape: series.dims, affine: series.affine };
  const native = [];
  const secondSeed = [];
  const nativeFloat = [];
  const rawIndices = result.b0.flatMap((b0, v) => b0 ? [] : [v]);
  for (let i = 0; i < rawIndices.length; i++) {
    const name = `ants-${String(i).padStart(5, "0")}0GenericAffine.mat`;
    native.push(hmc.readMat(await pinned(`nifreeze-gp/work/${name}`)));
    secondSeed.push(hmc.readMat(await pinned(`nifreeze-gp-seed1235/work/${name}`)));
    nativeFloat.push(await pinned(`nifreeze-gp-float/work/${name}`));
  }
  const motion = hmc.motionParams(native, grid);
  const seedMotion = hmc.motionParams(secondSeed, grid);
  const axes = ["tx", "ty", "tz", "rx", "ry", "rz"];
  const parameters = row => [...row.translation, ...row.rotation.map(value => value * 180 / Math.PI)];
  const rows = rawIndices.map((v, i) => {
    const actual = parameters(result.motion[v]);
    const reference = parameters(motion[i]);
    const seed = parameters(seedMotion[i]);
    const difference = actual.map((value, k) => Math.abs(value - reference[k]));
    const spread = reference.map((value, k) => Math.abs(value - seed[k]));
    return { volume: i, rawVolume: v, difference, spread, failingAxes: axes.filter((_, k) => difference[k] > spread[k]), equalsNativeFloat: hash(result.files[result.names.transform(v)]) === hash(nativeFloat[i]) };
  });
  report.q53 = { failingVolumes: rows.filter(row => row.failingAxes.length).length, failingCells: rows.reduce((n, row) => n + row.failingAxes.length, 0), differsFromNativeFloat: rows.filter(row => !row.equalsNativeFloat).map(row => row.volume), rows };
  const cases = [];
  for (let i = 0; i < rawIndices.length; i++) {
    const v = rawIndices[i];
    const name = `ants-${String(i).padStart(5, "0")}0GenericAffine.mat`;
    cases.push({
      volume: i, rawVolume: v,
      wasm: result.files[result.names.transform(v)],
      nativeFloat: nativeFloat[i],
      nativeDouble: await pinned(`nifreeze-gp/work/${name}`),
      secondSeed: await pinned(`nifreeze-gp-seed1235/work/${name}`),
    });
  }
  report.nativeFloatGate = nativeFloatGate({ hmc, grid, cases });
}
await mkdir(out, { recursive: true });
for (const [name, bytes] of Object.entries(result.files)) await writeFile(join(out, name), bytes);
await writeFile(join(out, "estimator-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  ...report,
  q53: report.q53 && { ...report.q53, rows: undefined },
  nativeFloatGate: report.nativeFloatGate && {
    pass: report.nativeFloatGate.pass,
    worldFailingCells: report.nativeFloatGate.world.failingCells,
    qsiprepFailingCells: report.nativeFloatGate.qsiprep.failingCells,
  },
  visitOrder: undefined,
}));
if (report.nativeFloatGate?.pass === false || report.predictionMismatches?.length) {
  console.error("The estimator does not meet the native-float world-centre gate or prediction parity.");
  process.exitCode = 1;
}
