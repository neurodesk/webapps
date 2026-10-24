// Recheck an existing complete estimator run without repeating registration.
// node nifreeze-gate-check.mjs REFERENCE OUTPUT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadHmcNode } from "../src/node.js";
import { nativeFloatGate } from "./nifreeze-gate.mjs";

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error("Usage: nifreeze-gate-check.mjs REFERENCE OUTPUT");
const manifest = JSON.parse(await readFile(new URL("../../../exes/dwi/hmc/validation/reference.manifest.json", import.meta.url), "utf8"));
const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
async function pinned(path) {
  const bytes = await readFile(join(root, path));
  const expected = entries.get(path);
  assert.ok(expected, `Unlisted reference: ${path}`);
  assert.equal(bytes.length, expected.bytes, path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, path);
  return bytes;
}
const facts = JSON.parse((await pinned("input/input-facts.json")).toString().replaceAll("NaN", "null"));
const bvals = (await pinned("input/sub-107_dir-AP_dwi.bval")).toString().trim().split(/\s+/).map(Number);
const rawIndices = bvals.flatMap((b, v) => b > 50 ? [v] : []);
assert.equal(rawIndices.length, 90);
const cases = [];
for (const [volume, rawVolume] of rawIndices.entries()) {
  const name = `ants-${String(volume).padStart(5, "0")}0GenericAffine.mat`;
  cases.push({
    volume, rawVolume,
    wasm: await readFile(join(out, `sub-107_dir-AP_vol-${String(rawVolume).padStart(4, "0")}_desc-hmc_xfm.mat`)),
    nativeFloat: await pinned(`nifreeze-gp-float/work/${name}`),
    nativeDouble: await pinned(`nifreeze-gp/work/${name}`),
    secondSeed: await pinned(`nifreeze-gp-seed1235/work/${name}`),
  });
}
const report = nativeFloatGate({ hmc: await loadHmcNode(), grid: { shape: facts.shape.slice(0, 3), affine: facts.affine }, cases });
await writeFile(join(out, "native-float-gate.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ pass: report.pass, worldFailingCells: report.world.failingCells, qsiprepFailingCells: report.qsiprep.failingCells }));
if (!report.pass) process.exitCode = 1;
