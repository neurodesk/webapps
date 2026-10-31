import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as model from "../src/model.js";
import { createValidator } from "../src/validator.js";

const source = {
  id: "lab/source",
  inputs: {},
  outputs: {
    image: { type: "neuro:volume" },
    images: { type: "core:array<neuro:volume>" },
    conditional: { type: "neuro:volume", optional: true },
  },
};
const target = {
  id: "lab/target",
  inputs: {
    input_images: {
      type: "core:array<neuro:volume>",
      extensions: { "neurodesk/data": { minimum: 2, maximum: 3 } },
    },
    input_optional: { type: "neuro:volume", optional: true },
  },
  outputs: {},
};
const tools = [source, target];
function workflow(binding) {
  return {
    ...model.emptyWorkflow(),
    inputs: { images: { type: "core:array<neuro:volume>" }, image: { type: "neuro:volume" } },
    steps: {
      source: { tool: source.id, inputs: {} },
      target: { tool: target.id, inputs: { input_images: binding } },
    },
  };
}
const countWarnings = doc => model.workflowIssues(doc, tools).filter(issue => issue.code === "input-count");

test("array workflow inputs retain their container type and format qualifiers", () => {
  const tool = { ...target, inputs: { input_images: { ...target.inputs.input_images, formats: ["nii", "nii-gz"] } } };
  const doc = model.bindNewWorkflowInput(workflow(), "target", "input_images", tool);
  assert.deepEqual(doc.inputs["images-2"], { type: "core:array<neuro:volume>", formats: ["nii", "nii-gz"] });
  assert.deepEqual(doc.steps.target.inputs.input_images, { ref: "inputs.images-2" });
});

test("moving a step changes its position and retains all document bindings", () => {
  const doc = workflow({ ref: "steps.source.outputs.image" });
  doc.steps.independent = { tool: source.id, inputs: {} };
  doc.outputs.result = { type: "neuro:volume", ref: "steps.source.outputs.image" };
  const moved = model.moveStep(doc, "independent", -1);
  assert.deepEqual(Object.keys(moved.steps), ["source", "independent", "target"]);
  assert.deepEqual(moved.steps.target.inputs, { input_images: { ref: "steps.source.outputs.image" } });
  assert.deepEqual(moved.inputs, doc.inputs);
  assert.deepEqual(moved.outputs, doc.outputs);
  assert.deepEqual(Object.keys(doc.steps), ["source", "target", "independent"]);
  assert.deepEqual(Object.keys(model.moveStep(moved, "independent", 1).steps), ["source", "target", "independent"]);
  assert.equal(model.moveStep(doc, "source", -1), doc);
  assert.equal(model.moveStep(doc, "independent", 1), doc);
  assert.equal(model.moveStep(doc, "missing", -1), doc);
});

test("scalar refs reveal an undersized collection without blocking export", () => {
  for (const ref of ["inputs.image", "steps.source.outputs.image"]) {
    assert.deepEqual(countWarnings(workflow({ ref })), [{
      severity: "warning", code: "input-count", path: "steps.target.inputs.input_images",
      message: "Expected at least 2 items; this binding supplies 1.",
    }]);
  }
});

test("constant collections report bounds and accept valid counts", () => {
  assert.deepEqual(countWarnings(workflow({ constant: ["a", "b"] })), []);
  assert.deepEqual(countWarnings(workflow({ constant: ["a", "b", "c", "d"] })), [{
    severity: "warning", code: "input-count", path: "steps.target.inputs.input_images",
    message: "Expected at most 3 items; this binding supplies 4.",
  }]);
  assert.deepEqual(countWarnings(workflow()), [{
    severity: "warning", code: "input-count", path: "steps.target.inputs.input_images",
    message: "Expected at least 2 items; this binding supplies 0.",
  }]);
});

test("array refs defer item count checks to execution", () => {
  for (const ref of ["inputs.images", "steps.source.outputs.images"]) {
    assert.deepEqual(countWarnings(workflow({ ref })), [{
      severity: "warning", code: "input-count", path: "steps.target.inputs.input_images",
      message: "Item count needs a run-time check (minimum 2, maximum 3).",
    }]);
  }
});

test("optional outputs are reported once, by the NeuroFlow core", async () => {
  const validate = await createValidator(tools, await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const doc = workflow({ ref: "steps.source.outputs.conditional" });
  doc.steps.target.inputs.input_optional = { ref: "steps.source.outputs.conditional" };
  doc.outputs.result = { type: "neuro:volume", ref: "steps.source.outputs.conditional" };
  assert.deepEqual(model.workflowIssues(doc, tools).filter(issue => issue.code === "optional-output"), []);
  const optional = () => validate(doc).issues.filter(issue => issue.code === "optional-output").map(issue => issue.path);
  assert.deepEqual(optional(), ["steps.target.inputs.input_images", "outputs.result.ref"]);
  // An optional workflow output (spec 0.1.3) accepts an absent value.
  doc.neuroflow = "0.1.3";
  doc.outputs.result.optional = true;
  assert.deepEqual(optional(), ["steps.target.inputs.input_images"]);
});

test("undeclared inputs and invalid constants are reported once per path", async () => {
  const param = { ...target, inputs: { ...target.inputs, param_echoTimesMs: {
    type: "core:array<core:number>", optional: true,
    extensions: { "neurodesk/parameter": { type: "array", items: { type: "number", minimum: 0.001 } } },
  } } };
  const validate = await createValidator([source, param], await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const doc = workflow({ ref: "inputs.missing" });
  const issues = constant => {
    doc.steps.target.inputs.param_echoTimesMs = { constant };
    return validate(doc).issues.filter(issue => ["input-undeclared", "constant-invalid"].includes(issue.code)).map(issue => [issue.code, issue.path]);
  };
  // The core checks the element type; the builder alone checks the per-item minimum.
  for (const constant of ["[10,20]", [0]]) {
    assert.deepEqual(issues(constant), [
      ["input-undeclared", "steps.target.inputs.input_images"],
      ["constant-invalid", "steps.target.inputs.param_echoTimesMs"],
    ]);
  }
});

test("names outside the localId grammar and non-step output refs are core errors", async () => {
  const validate = await createValidator(tools, await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const doc = workflow({ ref: "inputs.images" });
  doc.steps["Bad id!"] = doc.steps.source;
  doc.inputs["Bad name"] = { type: "neuro:volume" };
  doc.outputs = { stray: { type: "neuro:volume", ref: "inputs.image" } };
  const issues = validate(doc).issues.filter(issue => ["local-id-invalid", "output-ref-not-step"].includes(issue.code)).map(issue => [issue.code, issue.path, issue.severity]);
  assert.deepEqual(issues.sort(), [
    ["local-id-invalid", "inputs.Bad name", "error"],
    ["local-id-invalid", "steps.Bad id!", "error"],
    ["output-ref-not-step", "outputs.stray.ref", "error"],
  ]);
});

test("the core's issues survive a builder check that throws", async () => {
  const validate = await createValidator(tools, await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const result = validate({ ...model.emptyWorkflow(), steps: { broken: null } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.path === "steps.broken" && !/Builder checks failed/.test(issue.message)));
  assert.ok(result.issues.some(issue => /Builder checks failed/.test(issue.message)));
});

test("required outputs and unbounded inputs need no additional warnings", () => {
  const unbounded = { ...target, inputs: { input_images: { type: "core:array<neuro:volume>", optional: true } } };
  const doc = workflow({ ref: "steps.source.outputs.images" });
  doc.outputs.result = { type: "neuro:volume", ref: "steps.source.outputs.image" };
  assert.deepEqual(model.workflowIssues(doc, [source, unbounded]), []);
});

test("bounded 0.1.2 workflows remain valid through import, export and their round trip", async () => {
  const bounded = { ...target, neuroflow: "0.1.2", inputs: { input_images: { type: "core:array<neuro:volume>", minItems: 2, maxItems: 3 } } };
  const validate = await createValidator([source, bounded], await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const doc = { ...workflow({ constant: ["one", "two"] }), neuroflow: "0.1.2", description: "A bounded collection" };
  doc.inputs.images.minItems = 2;
  doc.inputs.images.maxItems = 3;
  assert.equal(validate(doc).ok, true);
  const imported = model.parseWorkflow(JSON.stringify(doc));
  const exported = JSON.parse(model.serializeWorkflow(doc));
  const roundTrip = JSON.parse(model.serializeWorkflow(imported));
  for (const edited of [imported, exported, roundTrip]) {
    assert.equal(edited.neuroflow, "0.1.2");
    assert.deepEqual(edited.inputs.images, doc.inputs.images);
    assert.equal(validate(edited).ok, true, JSON.stringify(validate(edited).issues));
    for (const constant of [["one"], ["one", "two", "three", "four"]]) {
      const invalid = structuredClone(edited);
      invalid.steps.target.inputs.input_images = { constant };
      assert.equal(validate(invalid).ok, false, "item bounds still apply after editing");
    }
  }
});

test("explicit spec versions survive editing so the core can reject unsupported versions", async () => {
  const validate = await createValidator(tools, await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  for (const version of ["0.1.1", "0.1.2", "9.9.9"]) {
    const doc = { ...workflow({ constant: ["one", "two"] }), neuroflow: version, description: "Version preservation" };
    const roundTrip = JSON.parse(model.serializeWorkflow(model.parseWorkflow(JSON.stringify(doc))));
    assert.equal(roundTrip.neuroflow, version);
    assert.equal(validate(roundTrip).ok, version !== "9.9.9");
  }
});

test("the core rejects a misspelled key, including after an import round trip", async () => {
  const validate = await createValidator(tools, await readFile(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const doc = workflow({ constant: ["one", "two"] });
  doc.steps.target.optinal = true;
  const roundTrip = JSON.parse(model.serializeWorkflow(model.parseWorkflow(JSON.stringify(doc))));
  for (const candidate of [doc, roundTrip]) {
    const result = validate(candidate);
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.filter(issue => issue.code === "unknown-field").map(issue => issue.path), ["steps.target.optinal"]);
  }
});
