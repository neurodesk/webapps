import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  addStep, autoBind, bindInput, bindNewWorkflowInput, candidateSources, compatibleSources, elementType, emptyWorkflow,
  issuesByStep, parseWorkflow, preferredSource, removeStep, serializeWorkflow, setParameter, setWorkflowOutput, toolCatalog, toolLabel,
} from "../src/model.js";

const tool = (app, operation, inputs, outputs) => ({
  id: `neurodesk.webapps/${app}/${operation}`,
  inputs,
  outputs,
  extensions: { "neurodesk/automation": { operation, contract: { app, title: app.toUpperCase(), operations: { [operation]: { title: operation } } } } },
});
const n4 = tool("n4", "correct",
  { input_image: { type: "core:array<neuro:volume>", formats: ["nifti"], description: "Image" }, param_iterations: { type: "core:number", default: 50, optional: true } },
  { output_image: { type: "neuro:volume" }, report: { type: "neuro:report" } });
const bet = tool("bet", "extract", { input_image: { type: "neuro:volume" } }, { output_brain: { type: "neuro:volume" } });
const tools = [n4, bet];

test("a new step gets a unique local id from its app", () => {
  let doc = emptyWorkflow();
  ({ doc } = addStep(doc, n4));
  const second = addStep(doc, n4);
  assert.deepEqual(Object.keys(second.doc.steps), ["n4", "n4-2"]);
  assert.deepEqual(second.doc.steps["n4-2"], { tool: n4.id, inputs: {} });
});

test("a new workflow input keeps the array type and formats of the tool input", () => {
  const { doc } = addStep(emptyWorkflow(), n4);
  const bound = bindNewWorkflowInput(doc, "n4", "input_image", n4);
  assert.equal(elementType("core:array<neuro:volume>"), "neuro:volume");
  assert.deepEqual(bound.inputs.image, { type: "core:array<neuro:volume>", formats: ["nifti"], description: "Image" });
  assert.deepEqual(bound.steps.n4.inputs.input_image, { ref: "inputs.image" });
});

test("candidates are workflow inputs and earlier step outputs, filtered by the validator", () => {
  let doc = bindNewWorkflowInput(addStep(emptyWorkflow(), n4).doc, "n4", "input_image", n4);
  doc = addStep(doc, bet).doc;
  assert.deepEqual(candidateSources(doc, "bet", tools).map(source => source.ref),
    ["inputs.image", "steps.n4.outputs.output_image", "steps.n4.outputs.report"]);
  assert.deepEqual(candidateSources(doc, "n4", tools).map(source => source.ref), ["inputs.image"]);
  const validate = trial => ({
    issues: trial.steps.bet.inputs.input_image?.ref.endsWith("report")
      ? [{ severity: "error", path: "steps.bet.inputs.input_image", message: "incompatible" }]
      : [{ severity: "error", path: "steps.other.inputs.x", message: "unrelated" }],
  });
  assert.deepEqual(compatibleSources(doc, "bet", "input_image", tools, validate).map(source => source.ref),
    ["inputs.image", "steps.n4.outputs.output_image"]);
});

test("a parameter equal to its default is not written", () => {
  const { doc } = addStep(emptyWorkflow(), n4);
  const set = setParameter(doc, "n4", "param_iterations", 20, n4);
  assert.deepEqual(set.steps.n4.inputs.param_iterations, { constant: 20 });
  assert.equal(setParameter(set, "n4", "param_iterations", 50, n4).steps.n4.inputs.param_iterations, undefined);
  assert.equal(setParameter(set, "n4", "param_iterations", Number.NaN, n4).steps.n4.inputs.param_iterations, undefined);
});

test("workflow outputs toggle and removing a step drops what read it", () => {
  let doc = bindNewWorkflowInput(addStep(emptyWorkflow(), n4).doc, "n4", "input_image", n4);
  doc = bindInput(addStep(doc, bet).doc, "bet", "input_image", "steps.n4.outputs.output_image");
  doc = setWorkflowOutput(doc, "n4", "output_image", true, n4);
  doc = setWorkflowOutput(doc, "bet", "output_brain", true, bet);
  assert.deepEqual(doc.outputs.image, { type: "neuro:volume", ref: "steps.n4.outputs.output_image" });
  assert.deepEqual(setWorkflowOutput(doc, "bet", "output_brain", false, bet).outputs, { image: doc.outputs.image });
  const removed = removeStep(doc, "n4");
  assert.deepEqual(Object.keys(removed.steps), ["bet"]);
  assert.deepEqual(removed.steps.bet.inputs, {});
  assert.deepEqual(removed.outputs, { brain: doc.outputs.brain });
  assert.deepEqual(removed.inputs, {});
});

test("a binding change drops the workflow input only the replaced binding read", () => {
  const doc = {
    ...emptyWorkflow(),
    inputs: { t1: { type: "neuro:volume" }, iterations: { type: "core:number" }, spare: { type: "core:string" } },
    steps: {
      n4: { tool: n4.id, inputs: { input_image: { ref: "inputs.t1" }, param_iterations: { ref: "inputs.iterations" } } },
      bet: { tool: bet.id, inputs: { input_image: { ref: "inputs.t1" } } },
    },
  };
  const names = next => Object.keys(next.inputs);
  assert.deepEqual(names(bindNewWorkflowInput(doc, "n4", "input_image", n4)), ["t1", "iterations", "spare", "image"]);
  const alone = bindInput(doc, "bet", "input_image", "steps.n4.outputs.output_image");
  assert.deepEqual(names(alone), ["t1", "iterations", "spare"]);
  assert.deepEqual(names(bindNewWorkflowInput(alone, "n4", "input_image", n4)), ["iterations", "spare", "image"]);
  assert.deepEqual(names(bindInput(alone, "n4", "input_image", null)), ["iterations", "spare"]);
  assert.deepEqual(names(bindInput(alone, "n4", "input_image", "inputs.t1")), ["t1", "iterations", "spare"]);
  assert.deepEqual(names(setParameter(alone, "n4", "param_iterations", 20, n4)), ["t1", "spare"]);
});

test("editing bindings preserves workflow inputs still read by step conditions", () => {
  const doc = parseWorkflow(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));
  doc.inputs.mask = { type: "neuro:volume" };
  doc.inputs.spare = { type: "core:string" };
  doc.steps.n4.inputs.input_mask = { ref: "inputs.mask" };
  doc.steps.segment.condition = "inputs.mask";
  const edits = [
    bindInput(doc, "n4", "input_mask", null),
    bindInput(doc, "n4", "input_mask", "inputs.t1"),
    bindNewWorkflowInput(doc, "n4", "input_mask", { inputs: { input_mask: { type: "neuro:volume" } } }),
    setParameter(doc, "n4", "input_mask", "constant", { inputs: {} }),
    removeStep(doc, "n4"),
  ];
  for (const edited of edits) {
    const exported = JSON.parse(serializeWorkflow(edited));
    assert.deepEqual(exported.inputs.mask, { type: "neuro:volume" });
    assert.deepEqual(exported.inputs.spare, { type: "core:string" });
    assert.equal(exported.steps.segment.condition, "inputs.mask");
  }
  const onlyCondition = bindInput(doc, "n4", "input_mask", null);
  assert.equal(removeStep(onlyCondition, "brain").inputs.mask.type, "neuro:volume");
  delete doc.steps.segment.condition;
  assert.equal(bindInput(doc, "n4", "input_mask", null).inputs.mask, undefined);
});

test("documents round-trip at NeuroFlow 0.1.1 and non-workflows are refused", () => {
  const doc = parseWorkflow(JSON.stringify({ neuroflow: "0.1.0", kind: "workflow", id: "a.b/c", steps: {} }));
  assert.equal(JSON.parse(serializeWorkflow(doc)).neuroflow, "0.1.1");
  assert.throws(() => parseWorkflow("{}"), /not a NeuroFlow workflow/);
  assert.throws(() => parseWorkflow("nope"), /not JSON/);
});

test("issues group by step and tools group by app", () => {
  const grouped = issuesByStep([{ path: "steps.n4.inputs.x" }, { path: "outputs.y" }]);
  assert.deepEqual([...grouped.keys()], ["n4", ""]);
  assert.deepEqual(toolCatalog(tools).map(group => group.title), ["BET", "N4"]);
  assert.equal(toolLabel(n4), "N4 · correct");
});

test("the shipped template is a 0.1.1 workflow over catalog operations", () => {
  const dir = new URL("../src/workflows/", import.meta.url);
  for (const name of readdirSync(dir)) {
    const doc = JSON.parse(readFileSync(new URL(name, dir), "utf8"));
    assert.equal(doc.neuroflow, "0.1.1");
    assert.equal(doc.kind, "workflow");
    for (const step of Object.values(doc.steps)) assert.match(step.tool, /^neurodesk\.webapps\/[a-z0-9-]+\/[a-z0-9-]+$/);
  }
});

test("a new input prefers a matching role across all steps, then the nearest step and type", () => {
  const decl = { type: "neuro:volume" };
  const sources = [
    { ref: "inputs.t1", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_bias", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_image", type: "neuro:volume" },
    { ref: "steps.n4.outputs.output_mask", type: "neuro:mask" },
  ];
  assert.equal(preferredSource(sources, "input_image", decl).ref, "steps.n4.outputs.output_image");
  assert.equal(preferredSource(sources.slice(1), "input_brain", decl).ref, "steps.n4.outputs.output_bias");
  assert.equal(preferredSource([sources[3]], "input_brain", decl).ref, "steps.n4.outputs.output_mask");
  assert.equal(preferredSource([], "input_image", decl), undefined);
  for (const ref of ["inputs.b0", "inputs.mean_b0", "inputs.mask", "inputs.reverse", "inputs.fieldmap", "steps.latest.outputs.output_mean-b0"]) {
    assert.equal(preferredSource([{ ref, type: "neuro:volume" }], "input_image", decl), undefined, ref);
  }
  assert.equal(preferredSource([{ ref: "inputs.image", type: "neuro:mask" }], "input_image", decl), undefined);
  assert.equal(preferredSource([{ ref: "steps.latest.outputs.output_brain", type: "neuro:volume" }], "input_image", decl), undefined);
  assert.equal(preferredSource([...sources, { ref: "steps.latest.outputs.output_mask", type: "neuro:volume" }], "input_image", decl).ref,
    "steps.n4.outputs.output_image");
  assert.equal(preferredSource([{ ref: "steps.latest.outputs.output_log", type: "neuro:volume" }], "input_image", decl), undefined);
  assert.equal(preferredSource([{ ref: "steps.latest.outputs.output_bvec", type: "neuro:gradients" }], "input_bval", { type: "neuro:gradients", optional: true }), undefined);
});

test("source choices put runtime checks after clean matches and label them", () => {
  const doc = {
    ...emptyWorkflow(),
    inputs: { unknown: { type: "neuro:volume" }, clean: { type: "neuro:volume" }, wrong: { type: "neuro:volume" } },
    steps: { n4: { tool: n4.id, inputs: {} } },
  };
  const validate = trial => ({ issues: [
    { path: "steps.other.inputs.image", severity: "warning", outcome: "requires-runtime-check" },
    ...(trial.steps.n4.inputs.input_image.ref === "inputs.unknown"
      ? [{ path: "steps.n4.inputs.input_image", severity: "warning", outcome: "requires-runtime-check" }]
      : trial.steps.n4.inputs.input_image.ref === "inputs.wrong"
        ? [{ path: "steps.n4.inputs.input_image", severity: "error" }] : []),
  ] });
  const sources = compatibleSources(doc, "n4", "input_image", tools, validate);
  assert.deepEqual(sources.map(source => source.ref), ["inputs.clean", "inputs.unknown"]);
  assert.equal(sources[0].label, "Workflow input clean");
  assert.equal(sources[1].label, "Workflow input unknown (needs a run-time check)");
});

test("automatic DWI bindings keep image and gradient roles through the full chain", async () => {
  const { loadCatalogContracts, neuroflowBundleFiles } = await import("../../../scripts/lib/neuroflow-bundle.mjs");
  const { createValidator } = await import("../src/validator.js");
  const { tools: catalog } = await neuroflowBundleFiles(await loadCatalogContracts({ exclude: ["pipeline-builder"] }));
  const validate = await createValidator(catalog, readFileSync(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  const operation = app => catalog.find(entry => entry.id === `neurodesk.webapps/${app}/${app === "dwidenoise" ? "denoise" : app === "degibbs" ? "degibbs" : app === "noddi" ? "fit" : app === "dwi2trx" ? "tractography" : app === "brain-extraction" ? "extract" : "correct"}`);
  let doc = emptyWorkflow();
  for (const app of ["dwidenoise", "degibbs", "dwicorrect", "n4", "brain-extraction", "noddi", "dwi2trx"]) {
    const added = addStep(doc, operation(app));
    doc = autoBind(added.doc, added.stepId, catalog, validate);
  }
  const refs = id => Object.fromEntries(Object.entries(doc.steps[id].inputs).map(([name, binding]) => [name, binding.ref]));
  assert.deepEqual(refs("dwidenoise"), { input_image: "inputs.image" });
  assert.deepEqual(refs("degibbs"), { input_image: "steps.dwidenoise.outputs.output_image", input_bval: "steps.dwidenoise.outputs.output_bval", input_bvec: "steps.dwidenoise.outputs.output_bvec", input_sidecar: "steps.dwidenoise.outputs.output_sidecar" });
  assert.deepEqual(refs("dwicorrect"), { input_dwi: "steps.degibbs.outputs.output_image", input_bval: "steps.degibbs.outputs.output_bval", input_bvec: "steps.degibbs.outputs.output_bvec", input_sidecar: "steps.degibbs.outputs.output_sidecar" });
  assert.deepEqual(refs("n4"), { input_image: "steps.dwicorrect.outputs.output_dwi", input_bval: "steps.dwicorrect.outputs.output_bval", input_bvec: "steps.dwicorrect.outputs.output_bvec", input_mask: "steps.dwicorrect.outputs.output_mask", input_sidecar: "steps.dwicorrect.outputs.output_sidecar" });
  assert.deepEqual(refs("brain-extraction"), { input_image: "steps.n4.outputs.output_image" });
  assert.deepEqual(refs("noddi"), { input_image: "steps.n4.outputs.output_image", input_bval: "steps.n4.outputs.output_bval", input_bvec: "steps.n4.outputs.output_bvec", input_mask: "steps.brain-extraction.outputs.output_mask" });
  assert.deepEqual(refs("dwi2trx"), { input_image: "steps.n4.outputs.output_image", input_bval: "steps.n4.outputs.output_bval", input_bvec: "steps.n4.outputs.output_bvec", input_mask: "steps.noddi.outputs.output_mask" });
  const bvals = compatibleSources(doc, "noddi", "input_bval", catalog, validate);
  assert.ok(bvals.some(source => source.ref === "steps.dwicorrect.outputs.output_bval"));
  assert.ok(bvals.every(source => !source.ref.endsWith("output_bvec")));
  const masks = compatibleSources(doc, "noddi", "input_mask", catalog, validate);
  assert.ok(masks.some(source => source.ref === "steps.brain-extraction.outputs.output_mask"));
  assert.ok(masks.every(source => source.ref !== "steps.n4.outputs.output_bias"));

  const template = parseWorkflow(readFileSync(new URL("../src/workflows/t1-segmentation.workflow.json", import.meta.url), "utf8"));
  let rebuilt = { ...emptyWorkflow(), inputs: template.inputs };
  for (const [id, step] of Object.entries(template.steps)) {
    rebuilt.steps[id] = { tool: step.tool, inputs: {} };
    rebuilt = autoBind(rebuilt, id, catalog, validate);
    assert.deepEqual(rebuilt.steps[id].inputs, step.inputs);
  }
});

test("SynthSeg labels can make a binary mask for noddi through niimath", async () => {
  const { loadCatalogContracts, neuroflowBundleFiles } = await import("../../../scripts/lib/neuroflow-bundle.mjs");
  const { createValidator } = await import("../src/validator.js");
  const { tools: catalog } = await neuroflowBundleFiles(await loadCatalogContracts({ exclude: ["pipeline-builder"] }));
  const validate = await createValidator(catalog, readFileSync(new URL("../vendor/neuroflow/neuroflow_wasm_bg.wasm", import.meta.url)));
  let doc = {
    ...emptyWorkflow(), description: "Convert segmentation labels to a binary diffusion fitting mask.",
    inputs: { image: { type: "neuro:volume", formats: ["nii-gz"] } },
    steps: {
      segment: { tool: "neurodesk.webapps/synthseg/segment", inputs: { input_image: { ref: "inputs.image" } } },
      binarize: { tool: "neurodesk.webapps/niimath/binarize", inputs: { input_image: { ref: "steps.segment.outputs.output_labels" } } },
      fit: { tool: "neurodesk.webapps/noddi/fit", inputs: { input_image: { ref: "inputs.image" }, input_mask: { ref: "steps.binarize.outputs.output_mask" } } },
    },
  };
  const valid = validate(doc);
  assert.equal(valid.ok, true, JSON.stringify(valid.issues));
  assert.ok(compatibleSources(doc, "fit", "input_mask", catalog, validate).some(source => source.ref === "steps.binarize.outputs.output_mask"));
  doc = bindInput(doc, "fit", "input_mask", "steps.segment.outputs.output_labels");
  assert.equal(validate(doc).ok, false);
  assert.ok(validate(doc).issues.some(issue => issue.path === "steps.fit.inputs.input_mask" && issue.severity === "error"));
});
