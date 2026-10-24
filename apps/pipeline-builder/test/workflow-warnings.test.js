import { test } from "node:test";
import assert from "node:assert/strict";
import * as model from "../src/model.js";

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

test("optional outputs warn on required consumers and workflow outputs", () => {
  const doc = workflow({ ref: "steps.source.outputs.conditional" });
  doc.steps.target.inputs.input_optional = { ref: "steps.source.outputs.conditional" };
  doc.outputs.result = { type: "neuro:volume", ref: "steps.source.outputs.conditional" };
  assert.deepEqual(model.workflowIssues(doc, tools).filter(issue => issue.code === "optional-output"), [
    {
      severity: "warning", code: "optional-output", path: "steps.target.inputs.input_images",
      message: "steps.source.outputs.conditional is optional and may be absent when this required input runs.",
    },
    {
      severity: "warning", code: "optional-output", path: "outputs.result",
      message: "steps.source.outputs.conditional is optional and may not produce this workflow output.",
    },
  ]);
  doc.outputs.result.optional = true;
  assert.equal(model.workflowIssues(doc, tools).filter(issue => issue.code === "optional-output").length, 1);
});

test("required outputs and unbounded inputs need no additional warnings", () => {
  const unbounded = { ...target, inputs: { input_images: { type: "core:array<neuro:volume>", optional: true } } };
  const doc = workflow({ ref: "steps.source.outputs.images" });
  doc.outputs.result = { type: "neuro:volume", ref: "steps.source.outputs.image" };
  assert.deepEqual(model.workflowIssues(doc, [source, unbounded]), []);
});
