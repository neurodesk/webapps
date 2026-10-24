// Read-only checks of a completed run, so reference checks can be repeated without registration.
//   node packages/hmc/validation/check-nifreeze-outputs.mjs ROOT OUT trivial|gp
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHmcNode } from "../src/node.js";
import { outputNames } from "../src/outputs.js";

function commandWords(command) {
  const words = [];
  let depth = 0;
  let word = "";
  for (const char of command.trim()) {
    if (char === "[") depth++;
    if (char === "]") depth--;
    if (/\s/.test(char)) {
      if (!depth && word) { words.push(word); word = ""; }
    } else word += char;
  }
  if (word) words.push(word);
  return words;
}

export async function checkNifreezeOutputs(root, out, model) {
  const manifest = JSON.parse(await readFile(new URL("../../../exes/dwi/hmc/validation/reference.manifest.json", import.meta.url), "utf8"));
  const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
  async function reference(path) {
    const bytes = await readFile(join(root, path));
    const entry = entries.get(path);
    assert.equal(bytes.length, entry.bytes, path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, path);
    return bytes.toString("utf8");
  }
  const hmc = await loadHmcNode();
  const argv = hmc.nifreezeArguments(1234);
  for (let i = 0; i < 90; i++) {
    const command = await reference(`nifreeze-trivial-a1/work/cmd-${String(i).padStart(5, "0")}.sh`);
    const words = commandWords(command);
    assert.equal(words.shift(), "antsRegistration");
    const mapped = words.map(word => word
      .replace(/\/var\/tmp\/dwi-hmc\/runs\/[^/]+\/work\/predicted_\d+\.nii\.gz/g, "fixed.nii")
      .replace(/\/var\/tmp\/dwi-hmc\/runs\/[^/]+\/work\/sample_\d+\.nii\.gz/g, "moving.nii")
      .replace(/\/var\/tmp\/dwi-hmc\/runs\/[^/]+\/work\/brainmask\.nii\.gz/g, "mask.nii")
      .replace(/^ants-\d+$/, "out"));
    mapped.splice(4, 0, "--float", "1");
    mapped.push("--random-seed", "1234");
    assert.deepEqual(argv, mapped, `registration argv ${i}`);
  }
  const run = model === "gp" ? "nifreeze-gp" : "nifreeze-trivial-a1";
  const lines = (await reference(`${run}/motion.tsv`)).replaceAll("\\t", "\t").trim().split("\n");
  const columns = lines.shift().split("\t");
  const axes = ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z"];
  const names = outputNames("sub-107_dir-AP_dwi.nii.gz");
  const report = JSON.parse(await readFile(join(out, "estimator-report.json"), "utf8"));
  const source = JSON.parse((await reference("input/input-facts.json")).replaceAll("NaN", "null"));
  const rows = [];
  for (const line of lines) {
    const cells = line.split("\t").map(Number);
    const frame = cells[columns.indexOf("original_index")];
    const transform = hmc.readMat(await readFile(join(out, names.transform(frame))));
    const [actual] = hmc.motionParams([transform], { shape: source.shape.slice(0, 3), affine: source.affine });
    const motion = [...actual.translation, ...actual.rotation];
    rows.push({ frame, difference: axes.map((axis, i) => motion[i] - cells[columns.indexOf(axis)]) });
  }
  assert.equal(rows.length, 90);
  report.referenceChecks = {
    matchedCommands: 90,
    nativeMotionAxes: axes,
    nativeMotionUnits: ["mm", "mm", "mm", "rad", "rad", "rad"],
    maximumAbsoluteDifference: axes.map((_, axis) => Math.max(...rows.map(row => Math.abs(row.difference[axis])))),
    rows,
  };
  await writeFile(join(out, "estimator-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ model, matchedCommands: 90, maximumAbsoluteDifference: report.referenceChecks.maximumAbsoluteDifference }));
  return report.referenceChecks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, out, model] = process.argv.slice(2);
  if (!root || !out || !["trivial", "gp"].includes(model)) throw new Error("Usage: check-nifreeze-outputs.mjs ROOT OUT trivial|gp");
  await checkNifreezeOutputs(root, out, model);
}
