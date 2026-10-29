// The accepted HMC registration gate (#451, 2026-10-24) on a replay that nifreeze-replay.mjs wrote:
// for each of the 90 GP volumes and six axes about the world grid centre,
// |WASM - native float| <= |native double - native double seed 1235|. It is
// packages/hmc/validation/nifreeze-gate.mjs, unchanged, which the complete estimator run uses; this
// script feeds it the replay's transforms instead of an estimator's output, so a kernel build can be
// checked in about two minutes. The 11 b0 pairs of q53-b0/ get the same rule as a supplement (the
// accepted gate covers GP). Every reference transform is checked against
// exes/dwi/hmc/validation/reference.manifest.json.
//
//   node validation/nifreeze-replay-gate.mjs <HMC_REFERENCE> <OUT> [<BASELINE_OUT>]
//
// It writes OUT/native-float-gate.json and exits 1 when the GP gate fails. With BASELINE_OUT,
// another replay (for example the committed kernel's), it also counts the transforms that are the
// same bytes in both. exes/dwi/hmc/tests/q53_replay.rs keeps the historical comparison with native
// double.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeFloatGate } from "../../hmc/validation/nifreeze-gate.mjs";
import { loadHmcNode } from "../../hmc/src/node-runtime.js";

const B0_VOLUMES = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const [root, out, baseline] = process.argv.slice(2);
if (!root || !out) throw new Error("usage: node validation/nifreeze-replay-gate.mjs <HMC_REFERENCE> <OUT> [<BASELINE_OUT>]");
const manifest = JSON.parse(await readFile(new URL("../../../exes/dwi/hmc/validation/reference.manifest.json", import.meta.url), "utf8"));
const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
async function pinned(path) {
  const bytes = await readFile(join(root, path));
  const expected = entries.get(path);
  assert.ok(expected, `Unlisted reference: ${path}`);
  assert.equal(sha256(bytes), expected.sha256, path);
  return bytes;
}

const facts = JSON.parse((await pinned("input/input-facts.json")).toString().replaceAll("NaN", "null"));
const grid = { shape: facts.shape.slice(0, 3), affine: facts.affine };
const bvals = (await pinned("input/sub-107_dir-AP_dwi.bval")).toString().trim().split(/\s+/).map(Number);
const rawIndices = bvals.flatMap((b, v) => (b > 50 ? [v] : []));
assert.equal(rawIndices.length, 90);

const sameAsBaseline = { gp: 0, b0: 0 };
async function replayed(set, file) {
  const bytes = await readFile(join(out, set, file));
  if (baseline && sha256(bytes) === sha256(await readFile(join(baseline, set, file)))) sameAsBaseline[set]++;
  return bytes;
}
const gp = [];
for (const [volume, rawVolume] of rawIndices.entries()) {
  const name = `ants-${String(volume).padStart(5, "0")}0GenericAffine.mat`;
  gp.push({
    volume, rawVolume,
    wasm: await replayed("gp", name),
    nativeFloat: await pinned(`nifreeze-gp-float/work/${name}`),
    nativeDouble: await pinned(`nifreeze-gp/work/${name}`),
    secondSeed: await pinned(`nifreeze-gp-seed1235/work/${name}`),
  });
}
const b0 = [];
for (const k of B0_VOLUMES) {
  const id = String(k).padStart(3, "0");
  b0.push({
    volume: k, rawVolume: k,
    wasm: await replayed("b0", `float-${id}_0GenericAffine.mat`),
    nativeFloat: await pinned(`q53-b0/float-${id}_0GenericAffine.mat`),
    nativeDouble: await pinned(`q53-b0/double-${id}_0GenericAffine.mat`),
    secondSeed: await pinned(`q53-b0/double_seed1235-${id}_0GenericAffine.mat`),
  });
}

const hmc = await loadHmcNode();
const report = { gp: nativeFloatGate({ hmc, grid, cases: gp }), b0: nativeFloatGate({ hmc, grid, cases: b0 }) };
const summary = (r) => ({
  pass: r.pass,
  ...Object.fromEntries(["world", "qsiprep"].map((convention) => [convention, {
    failingVolumes: r[convention].failingVolumes,
    failingCells: r[convention].failingCells,
    failing: r[convention].rows.filter((row) => row.failingAxes.length).map((row) => ({ volume: row.volume, axes: row.failingAxes })),
    doubleFailingVolumes: r[convention].rows.filter((row) => row.doubleFailingAxes.length).length,
    doubleFailingCells: r[convention].rows.reduce((n, row) => n + row.doubleFailingAxes.length, 0),
  }])),
  equalsNativeFloat: r.world.rows.filter((row) => row.equalsNativeFloat).length,
});
const result = { gp: summary(report.gp), b0Supplement: summary(report.b0), ...(baseline && { sameBytesAsBaseline: sameAsBaseline }) };
await writeFile(join(out, "native-float-gate.json"), `${JSON.stringify({ ...result, rows: report }, null, 1)}\n`);
console.log(JSON.stringify(result));
if (!report.gp.pass) process.exitCode = 1;
