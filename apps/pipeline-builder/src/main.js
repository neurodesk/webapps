import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import wasmUrl from "../vendor/neuroflow/neuroflow_wasm_bg.wasm?url";
import { APP } from "./config.js";
import { createValidator, loadCatalog } from "./validator.js";
import {
  addStep, autoBind, bindInput, bindNewWorkflowInput, compatibleSources, emptyWorkflow, issuesByStep,
  moveStep, outputKey, parseWorkflow, removeStep, serializeWorkflow, setParameter, setWorkflowOutput,
  toolCatalog, toolFields, toolLabel,
} from "./model.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Pipeline builder",
  subtitle: "Chain apps into a NeuroFlow workflow",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});
const toolbar = createViewerToolbar({
  views: [{ id: "steps", label: "Workflow", active: true }],
  window: false, overlay: false, colormap: false, download: false, screenshot: false,
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About Pipeline Builder", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null));
  return node;
}

const catalogBase = new URL(`${import.meta.env.BASE_URL}neuroflow/`, document.baseURI);
let tools = [];
let toolsById = new Map();
let validate = () => ({ ok: false, issues: [] });
let doc = emptyWorkflow();
let selected = null;
let validation = { ok: true, issues: [] };
let editorKey = null;
let reported = new Map();

function setDoc(next, { select = selected } = {}) {
  doc = next;
  selected = select && doc.steps[select] ? select : null;
  render();
}

function editStep(id) {
  setDoc(doc, { select: id });
  $("stepSection").open = true;
}

function render() {
  const focused = document.activeElement?.id;
  validation = validate(doc);
  const steps = Object.entries(doc.steps);
  const byStep = issuesByStep(validation.issues ?? []);
  const errors = (validation.issues ?? []).filter(issue => issue.severity === "error");
  $("workflowId").value = doc.id ?? "";
  $("workflowDescription").value = doc.description ?? "";
  $("emptyState").hidden = steps.length > 0;
  $("workflowReport").hidden = steps.length === 0;

  $("stepRows").replaceChildren(...steps.map(([id, step]) => {
    const tool = toolsById.get(step.tool);
    const name = el("button", { type: "button", id: `step-${id}`, className: "nd-btn nd-btn-secondary nd-btn-sm", textContent: id, title: `Edit ${id}` });
    name.setAttribute("aria-pressed", String(id === selected));
    name.onclick = () => editStep(id);
    const reads = Object.values(step.inputs ?? {}).map(binding => binding.ref).filter(Boolean);
    const stepErrors = (byStep.get(id) ?? []).filter(issue => issue.severity === "error");
    return el("tr", {},
      el("td", {}, name),
      el("td", { textContent: tool ? toolLabel(tool) : step.tool }),
      el("td", { textContent: reads.join(", ") || "—" }),
      el("td", { textContent: stepErrors.map(issue => issue.message).join(" ") || "None" }));
  }));

  const rows = [
    ...Object.entries(doc.inputs ?? {}).map(([name, input]) => [name, "Input", input.type, input.formats ? `Supplied as ${input.formats.join(" or ")}` : "Supplied at run time"]),
    ...Object.entries(doc.outputs ?? {}).map(([name, output]) => [name, "Output", output.type, output.ref]),
  ];
  $("ioRows").replaceChildren(...rows.map(cells => el("tr", {}, ...cells.map(text => el("td", { textContent: text })))));

  const general = (byStep.get("") ?? []).filter(issue => issue.severity === "error").map(issue => issue.message);
  const count = `${errors.length} problem${errors.length === 1 ? "" : "s"} to fix before export.`;
  const summary = steps.length === 0
    ? "Add a step to start a workflow."
    : validation.ok ? `Valid · ${steps.length} step${steps.length === 1 ? "" : "s"}.` : [count, ...general].join(" ");
  const warnings = validation.issues.filter(issue => issue.severity === "warning");
  $("workflowWarnings").hidden = warnings.length === 0;
  $("warningSummary").textContent = `Warnings (${warnings.length})`;
  $("warningMessages").replaceChildren(...warnings.map(issue => el("p", {
    className: "nd-file-info", textContent: `${issue.path || "workflow"}: ${issue.message}`,
  })));
  $("validationSummary").textContent = summary;
  $("validationSummary").classList.toggle("error", !validation.ok);
  $("runButton").disabled = steps.length === 0 || !validation.ok;
  logDiagnostics(steps.length ? validation.issues ?? [] : [], summary);
  renderStep();
  if (focused && document.activeElement?.id !== focused) $(focused)?.focus();
}

// Each problem goes to the console once, when an edit introduces it. An unfinished
// workflow is not a failure, so problems log as warnings, which leave the console closed.
function logDiagnostics(issues, summary) {
  const lines = new Map(issues.map(issue => [`${issue.path || "workflow"}: ${issue.message}`, issue.severity]));
  for (const line of lines.keys()) if (!reported.has(line)) log.log(line, "warning");
  const hadErrors = [...reported.values()].includes("error");
  const hasErrors = [...lines.values()].includes("error");
  if (reported.size && !hasErrors && (hadErrors || !lines.size) && Object.keys(doc.steps).length) log.log(summary, "success");
  reported = lines;
}

function sourceSelect(id, name, decl, tool) {
  const select = el("select", { id: `bind-${name}` });
  const current = doc.steps[id].inputs?.[name]?.ref ?? "";
  select.append(el("option", { value: "", textContent: decl.optional ? "Not used" : "Choose a source" }));
  for (const source of compatibleSources(doc, id, name, tools, validate)) {
    select.append(el("option", { value: source.ref, textContent: source.label }));
  }
  select.append(el("option", { value: "new", textContent: "New workflow input" }));
  if (current && ![...select.options].some(option => option.value === current)) {
    select.append(el("option", { value: current, textContent: `${current} (incompatible)` }));
  }
  select.value = current;
  select.onchange = () => setDoc(select.value === "new"
    ? bindNewWorkflowInput(doc, id, name, tool)
    : bindInput(doc, id, name, select.value || null));
  return select;
}

function parameterField(id, name, decl, tool) {
  const current = doc.steps[id].inputs?.[name]?.constant ?? decl.default;
  const label = name.replace(/^param_/, "");
  let control;
  if (decl.enum) {
    control = el("select", {}, ...decl.enum.map(value => el("option", { value: String(value), textContent: String(value) })));
    control.value = String(current ?? "");
    control.onchange = () => setDoc(setParameter(doc, id, name, decl.enum.find(value => String(value) === control.value), tool));
  } else if (decl.type === "core:boolean") {
    control = el("input", { type: "checkbox", checked: Boolean(current) });
    control.onchange = () => setDoc(setParameter(doc, id, name, control.checked, tool));
    return el("label", { className: "nd-check" }, control, ` ${label}`);
  } else if (decl.type === "core:number" || decl.type === "core:integer") {
    control = el("input", { type: "number", value: current ?? "" });
    if (decl.min !== undefined) control.min = decl.min;
    if (decl.max !== undefined) control.max = decl.max;
    control.onchange = () => setDoc(setParameter(doc, id, name, control.value === "" ? undefined : Number(control.value), tool));
  } else {
    control = el("input", { type: "text", value: current ?? "" });
    control.onchange = () => setDoc(setParameter(doc, id, name, control.value, tool));
  }
  control.id = `param-${name}`;
  const text = el("label", { htmlFor: control.id }, label);
  if (decl.description) text.title = decl.description;
  return el("div", { className: "nd-field" }, text, control);
}

// Parameter values are left out: their controls already show them, and rebuilding
// would drop focus and close Parameters while the user edits.
function stepEditorKey() {
  const bindings = Object.entries(doc.steps).map(([id, step]) => [id, step.tool,
    Object.entries(step.inputs ?? {}).filter(([, binding]) => binding.ref)]);
  return JSON.stringify([selected, doc.inputs, doc.outputs, bindings]);
}

function renderStep() {
  const editor = $("stepEditor");
  const step = selected && doc.steps[selected];
  const tool = step && toolsById.get(step.tool);
  $("stepHint").hidden = Boolean(step);
  const key = step ? stepEditorKey() : null;
  if (key === editorKey) return;
  editorKey = key;
  if (!step) return editor.replaceChildren();
  const parametersOpen = editor.querySelector("details")?.open ?? false;
  const id = selected;
  const fields = tool ? toolFields(tool) : { data: [], parameters: [] };
  const parts = [el("p", { className: "nd-hint", textContent: `${id} · ${tool ? toolLabel(tool) : `${step.tool} is not in the catalog`}` })];
  for (const [name, decl] of fields.data) {
    const select = sourceSelect(id, name, decl, tool);
    parts.push(el("div", { className: "nd-field" }, el("label", { htmlFor: select.id, title: decl.description ?? "" }, name.replace(/^input_/, "")), select));
  }
  if (fields.parameters.length) {
    parts.push(el("details", { className: "nd-sidebar-section", open: parametersOpen },
      el("summary", { className: "nd-section-title", textContent: "Parameters" }),
      el("div", { className: "nd-section-content" }, ...fields.parameters.map(([name, decl]) => parameterField(id, name, decl, tool)))));
  }
  if (fields.engine?.enum?.length > 1) parts.push(parameterField(id, "engine", fields.engine, tool));
  for (const name of Object.keys(tool?.outputs ?? {})) {
    const box = el("input", { type: "checkbox", id: `output-${name}`, checked: Boolean(outputKey(doc, id, name)) });
    box.onchange = () => setDoc(setWorkflowOutput(doc, id, name, box.checked, tool));
    parts.push(el("label", { className: "nd-check" }, box, ` Workflow output: ${name.replace(/^output_/, "")}`));
  }
  const position = Object.keys(doc.steps).indexOf(id);
  const moves = [["Move up", -1], ["Move down", 1]].map(([label, direction]) => {
    const button = el("button", {
      type: "button", className: "nd-btn nd-btn-secondary", textContent: label,
      disabled: direction < 0 ? position === 0 : position === Object.keys(doc.steps).length - 1,
    });
    button.onclick = () => {
      setDoc(moveStep(doc, id, direction));
      status(`Moved ${id} ${direction < 0 ? "up" : "down"}`);
    };
    return button;
  });
  parts.push(el("div", { className: "nd-row" }, ...moves));
  const remove = el("button", { type: "button", className: "nd-btn nd-btn-secondary", textContent: "Remove step" });
  remove.onclick = () => { setDoc(removeStep(doc, id)); status(`Removed ${id}`); };
  parts.push(remove);
  editor.replaceChildren(...parts);
}

$("addStepButton").onclick = () => {
  const tool = toolsById.get($("toolSelect").value);
  if (!tool) return;
  const added = addStep(doc, tool);
  setDoc(autoBind(added.doc, added.stepId, tools, validate), { select: added.stepId });
  $("stepSection").open = true;
  status(`Added ${added.stepId}: ${toolLabel(tool)}`);
};
$("workflowId").onchange = () => setDoc({ ...doc, id: $("workflowId").value.trim() });
$("workflowDescription").onchange = () => setDoc({ ...doc, description: $("workflowDescription").value.trim() });
$("newButton").onclick = () => {
  exampleControl.reset();
  $("fileInfo").hidden = true;
  setDoc(emptyWorkflow(), { select: null });
  status("New workflow");
};

function openWorkflow(next, label) {
  reported = new Map();
  setDoc(next, { select: null });
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = label;
  status(validation.ok ? `${label} opened` : `${label} opened with problems; see the Issues column`, !validation.ok);
}

async function loadWorkflowFiles(files, assertCurrent = () => {}) {
  if (files.length !== 1) throw new Error("Choose one .workflow.json file.");
  const [file] = files;
  const next = parseWorkflow(await file.text());
  assertCurrent();
  openWorkflow(next, file.name);
}
function importFiles(filesPromise) {
  exampleControl.cancel();
  return Promise.resolve(filesPromise).then(loadWorkflowFiles).catch(error => status(error.message, true));
}
$("workflowInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
bindFileDrop($("dropZone"), importFiles, document, () => $("workflowInput").disabled);

const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadWorkflowFiles(files, assertCurrent);
  },
});
$("exampleControl").append(exampleControl);

function exportFile() {
  const name = `${(doc.id ?? "workflow").split("/").pop() || "workflow"}.workflow.json`;
  return new File([serializeWorkflow(doc)], name, { type: "application/json" });
}
$("runButton").onclick = () => {
  if (!validation.ok) return;
  const file = exportFile();
  downloadFile(file);
  status(`Exported ${file.name}`);
};

function setReady(ready) {
  for (const id of ["toolSelect", "addStepButton", "workflowInput", "newButton"]) $(id).disabled = !ready;
  exampleControl.setDisabled(!ready);
}

async function start() {
  setReady(false);
  progress.begin("Loading the tool catalog…", { cancellable: false });
  try {
    ({ tools } = await loadCatalog(catalogBase));
    toolsById = new Map(tools.map(tool => [tool.id, tool]));
    validate = await createValidator(tools, wasmUrl);
    $("toolSelect").replaceChildren(...toolCatalog(tools).map(group => el("optgroup", { label: group.title },
      ...group.tools.map(tool => el("option", { value: tool.id, textContent: toolLabel(tool) })))));
    setReady(true);
    render();
    progress.end("Catalog ready");
    status(`${tools.length} operations from the Neurodesk catalog`);
  } catch (cause) {
    const error = new Error(`The tool catalog could not load: ${cause.message}`, { cause });
    progress.end("Catalog unavailable", { success: false });
    status(error.message, true);
    throw error;
  }
}
// The page has reported a failed load; automation runs await `ready` and fail with it.
const ready = start();
void ready.catch(() => {});

registerAppAutomation({
  app: APP.id,
  operations: {
    validate: async ({ inputs, signal }) => {
      await ready;
      signal?.throwIfAborted();
      await loadWorkflowFiles(inputs.workflow);
      const errors = (validation.issues ?? []).filter(issue => issue.severity === "error");
      if (!validation.ok) throw new Error(errors.map(issue => `${issue.path || "workflow"}: ${issue.message}`).join("\n"));
      const report = new File([`${JSON.stringify(validation, null, 2)}\n`], "validation.json", { type: "application/json" });
      return {
        artifacts: [{ role: "workflow", file: exportFile() }, { role: "validation", file: report }],
        provenance: { method: "neuroflow-validate", catalogTools: tools.length, scientificProcessing: false },
      };
    },
  },
});
window.addEventListener("pagehide", () => exampleControl.destroy());

export default Object.freeze({ workspace, toolbar, log, info });
