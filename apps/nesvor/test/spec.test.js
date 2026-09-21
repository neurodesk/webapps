import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_OPTIONS, PRESETS, masksComplete, nesvorArgv, presetOptions, validateNesvorSpec } from "../src/spec.js";

const parts = ["stack-0", "stack-1", "mask-0", "mask-1"];
const spec = (extra = {}) => ({
  tool: "nesvor",
  command: "reconstruct",
  stacks: [{ file: "stack-0", thickness: 3, mask: "mask-0" }, { file: "stack-1", thickness: 3 }],
  options: {},
  ...extra,
});

test("presets follow the upstream quick-start recipes", () => {
  assert.deepEqual(PRESETS.map(preset => preset.id), ["fetal-brain", "neonatal-brain", "fetal-body", "custom"]);
  const fetal = presetOptions("fetal-brain");
  assert.equal(fetal.registration, "svort");
  assert.equal(fetal.segmentation, true);
  assert.equal(fetal.biasFieldCorrection, true);
  const neonatal = presetOptions("neonatal-brain");
  assert.equal(neonatal.registration, "stack");
  assert.equal(neonatal.otsuThresholding, true);
  assert.equal(neonatal.segmentation, false);
  const body = presetOptions("fetal-body");
  assert.equal(body.deformable, true);
  assert.equal(body.outputResolution, 1);
  assert.equal(body.weightTransformation, 1);
  assert.equal(body.log2HashmapSize, 22);
  assert.equal(presetOptions("custom"), null);
  assert.throws(() => presetOptions("nope"), /Unknown protocol/);
});

test("validation fills defaults and rejects what the servers reject", () => {
  const valid = validateNesvorSpec(spec(), parts);
  assert.deepEqual(valid.options, { ...DEFAULT_OPTIONS });
  assert.deepEqual(valid.stacks[0], { file: "stack-0", thickness: 3, mask: "mask-0" });
  assert.throws(() => validateNesvorSpec(spec({ tool: "other" }), parts), /tool/);
  assert.throws(() => validateNesvorSpec(spec({ command: "register" }), parts), /command/);
  assert.throws(() => validateNesvorSpec(spec({ stacks: [] }), parts), /1 to 20/);
  assert.throws(() => validateNesvorSpec(spec({ stacks: [{ file: "stack-9", thickness: 3 }] }), parts), /uploaded part/);
  assert.throws(() => validateNesvorSpec(spec({ stacks: [{ file: "stack-0", thickness: 0 }] }), parts), /thickness/);
  assert.throws(() => validateNesvorSpec(spec({ stacks: [{ file: "stack-0", thickness: 3 }, { file: "stack-0", thickness: 3 }] }), parts), /twice/);
  assert.throws(() => validateNesvorSpec(spec({ options: { bogus: true } }), parts), /unknown option/);
  assert.throws(() => validateNesvorSpec(spec({ options: { registration: "magic" } }), parts), /registration/);
  assert.throws(() => validateNesvorSpec(spec({ options: { segmentation: "yes" } }), parts), /boolean/);
  assert.throws(() => validateNesvorSpec(spec({ options: { outputResolution: 5 } }), parts), /outputResolution/);
  assert.throws(() => validateNesvorSpec(spec({ options: { iterations: 100.5 } }), parts), /integer/);
  assert.equal(validateNesvorSpec(spec({ options: { iterations: 400, log2HashmapSize: 22 } }), parts).options.log2HashmapSize, 22);
});

test("the command line matches the protocol document", () => {
  const valid = validateNesvorSpec({
    tool: "nesvor",
    command: "reconstruct",
    stacks: [{ file: "stack-0", thickness: 3, mask: "mask-0" }, { file: "stack-1", thickness: 3, mask: "mask-1" }],
    options: { segmentation: true, biasFieldCorrection: true },
  }, parts);
  assert.deepEqual(nesvorArgv(valid), [
    "reconstruct",
    "--input-stacks", "/job/in/stack-0.nii.gz", "/job/in/stack-1.nii.gz",
    "--stack-masks", "/job/in/mask-0.nii.gz", "/job/in/mask-1.nii.gz",
    "--thicknesses", "3.0", "3.0",
    "--output-volume", "/job/out/volume.nii.gz", "--output-json", "/job/out/result.json",
    "--output-resolution", "0.8", "--registration", "svort",
    "--segmentation", "--bias-field-correction",
    "--n-iter", "6000",
    "--weight-transformation", "0.1", "--weight-deform", "0.1", "--weight-image", "1.0",
    "--batch-size", "4096", "--log2-hashmap-size", "19", "--verbose", "1",
  ]);
  const partial = validateNesvorSpec(spec(), parts);
  assert.ok(!nesvorArgv(partial).includes("--stack-masks"), "masks are passed only when every stack has one");
  assert.ok(nesvorArgv(partial, () => false).includes("/job/in/stack-0.nii"));
  assert.equal(masksComplete(partial.stacks), false);
  assert.equal(masksComplete(valid.stacks), true);
});
