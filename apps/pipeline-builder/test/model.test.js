import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  addStep, autoBind, bindInput, bindNewWorkflowInput, candidateSources, compatibleSources, elementType, emptyWorkflow,
  issuesByStep, parameterText, parseParameter, parseWorkflow, preferredSource, removeStep, serializeWorkflow, setParameter, setWorkflowOutput,
  toolCatalog, toolLabel, workflowIssues,
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

// Array declarations as generated for QSMbly echoTimesMs and SeedSeg folds.
const arrayParameter = (type, items, extra = {}) => ({ type, optional: true, extensions: { "neurodesk/parameter": { type: "array", items, ...extra } } });
const echoTimes = arrayParameter("core:array<core:number>", { type: "number", minimum: 0.001 });
const folds = arrayParameter("core:array<core:integer>", { type: "integer", enum: [0, 1, 2, 3, 4] });

test("array parameters parse JSON or comma-separated text into typed arrays", () => {
  assert.deepEqual(parseParameter("[10, 20.5]", echoTimes), { value: [10, 20.5] });
  assert.deepEqual(parseParameter(" 10 , 20.5 ", echoTimes), { value: [10, 20.5] });
  assert.deepEqual(parseParameter("7", echoTimes), { value: [7] });
  assert.deepEqual(parseParameter("0, 4", folds), { value: [0, 4] });
  assert.deepEqual(parseParameter("true,false", arrayParameter("core:array<core:boolean>", { type: "boolean" })), { value: [true, false] });
  const names = arrayParameter("core:array<core:string>", { type: "string" });
  assert.deepEqual(parseParameter("a, b c", names), { value: ["a", "b c"] });
  assert.deepEqual(parseParameter('["a,b", "10"]', names), { value: ["a,b", "10"] });
  assert.deepEqual(parseParameter("10, 20", names), { value: ["10", "20"] });
  for (const text of ["", "  ", "[]"]) assert.deepEqual(parseParameter(text, echoTimes), { value: undefined });
});

test("invalid array entries return an error instead of a value", () => {
  const error = (text, decl) => parseParameter(text, decl).error;
  assert.equal(error("10, abc", echoTimes), 'Expected a number, got "abc".');
  assert.equal(error('["10"]', echoTimes), 'Expected a number, got "10".');
  assert.equal(error("10,,20", echoTimes), "A value is missing between commas.");
  assert.equal(error("[10, 20", echoTimes), "Enter a JSON array or comma-separated values.");
  assert.equal(error('[{"a": 1}]', echoTimes), 'Expected a number, got {"a":1}.');
  assert.equal(error("0, 0.0001", echoTimes), "0 is below the minimum 0.001.");
  assert.equal(error("1.5", folds), "Expected an integer, got 1.5.");
  assert.equal(error("5", folds), "5 is not one of 0, 1, 2, 3, 4.");
  assert.equal(error("yes", arrayParameter("core:array<core:boolean>", { type: "boolean" })), 'Expected true or false, got "yes".');
  assert.equal(error("[1, 2]", arrayParameter("core:array<core:string>", { type: "string" })), "Expected text, got 1.");
  const bounded = arrayParameter("core:array<core:number>", { type: "number", maximum: 9 }, { minItems: 2, maxItems: 3 });
  assert.equal(error("1", bounded), "Expected at least 2 values, got 1.");
  assert.equal(error("1, 2, 3, 4", bounded), "Expected at most 3 values, got 4.");
  assert.equal(error("1, 10", bounded), "10 is above the maximum 9.");
});

test("an array constant shows as text that parses back to the same array", () => {
  for (const [value, decl] of [[[10, 20], echoTimes], [[0, 4], folds], [["a,b", "c"], arrayParameter("core:array<core:string>", { type: "string" })]]) {
    assert.deepEqual(parseParameter(parameterText(value), decl), { value });
  }
  assert.equal(parameterText([10, 20]), "[10, 20]");
  assert.equal(parameterText(undefined), "");
  assert.equal(parameterText(0.5), "0.5");
});

test("number parameters reject text, fractions for integers and values outside min and max", () => {
  const integer = { type: "core:integer", min: 0, max: 8 };
  assert.deepEqual(parseParameter("3", integer), { value: 3 });
  assert.deepEqual(parseParameter("", integer), { value: undefined });
  assert.equal(parseParameter("1.5", integer).error, "Expected an integer, got 1.5.");
  assert.equal(parseParameter("9", integer).error, "9 is above the maximum 8.");
  assert.deepEqual(parseParameter("0.25", { type: "core:number" }), { value: 0.25 });
  assert.equal(parseParameter("abc", { type: "core:number" }).error, 'Expected a number, got "abc".');
});

test("array constants are stored as arrays and mistyped constants are workflow errors", () => {
  const qsm = tool("qsmbly", "reconstruct", { param_echoTimesMs: echoTimes, param_strength: { type: "core:number", min: 0, optional: true } }, {});
  const { doc } = addStep(emptyWorkflow(), qsm);
  const set = setParameter(doc, "qsmbly", "param_echoTimesMs", parseParameter("10, 20", echoTimes).value, qsm);
  assert.deepEqual(set.steps.qsmbly.inputs.param_echoTimesMs, { constant: [10, 20] });
  assert.deepEqual(workflowIssues(set, [qsm]), []);
  const imported = { ...doc, steps: { qsmbly: { tool: qsm.id, inputs: { param_echoTimesMs: { constant: "[10,20]" }, param_strength: { constant: "3" } } } } };
  assert.deepEqual(workflowIssues(imported, [qsm]).map(issue => [issue.code, issue.path, issue.message]), [
    ["constant-invalid", "steps.qsmbly.inputs.param_echoTimesMs", 'Expected an array, got "[10,20]".'],
    ["constant-invalid", "steps.qsmbly.inputs.param_strength", 'Expected a number, got "3".'],
  ]);
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

test("imports whose maps hold non-objects are refused before the editor walks them", () => {
  const base = { kind: "workflow", id: "a.b/c", steps: {} };
  const refused = [
    [{ steps: { a: null } }, "steps.a"],
    [{ steps: { a: { tool: "x", inputs: [] } } }, "steps.a.inputs"],
    [{ steps: { a: { tool: "x", inputs: { b: null } } } }, "steps.a.inputs.b"],
    [{ inputs: { x: null } }, "inputs.x"],
    [{ outputs: "hello" }, "outputs"],
  ];
  for (const [fields, path] of refused) {
    assert.throws(() => parseWorkflow(JSON.stringify({ ...base, ...fields })), new RegExp(`${path.replaceAll(".", "\\.")} must be an object`));
  }
  assert.doesNotThrow(() => parseWorkflow(JSON.stringify({ ...base, steps: { a: { tool: "x" } } })));
});

test("issues group by step and tools group by app", () => {
  const grouped = issuesByStep([{ path: "steps.n4.inputs.x" }, { path: "outputs.y" }], ["n4"]);
  assert.deepEqual([...grouped.keys()], ["n4", ""]);
  // An imported id may contain a dot; it must not be cut at the dot or lost.
  const dotted = issuesByStep([
    { path: "steps.bad.name" }, { path: "steps.bad.name.inputs.x" }, { path: "steps.bad.inputs.y" }, { path: "steps.gone.inputs.z" },
  ], ["bad", "bad.name"]);
  assert.deepEqual([...dotted].map(([id, list]) => [id, list.map(issue => issue.path)]), [
    ["bad.name", ["steps.bad.name", "steps.bad.name.inputs.x"]],
    ["bad", ["steps.bad.inputs.y"]],
    ["", ["steps.gone.inputs.z"]],
  ]);
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
