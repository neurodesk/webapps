import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  createFileField,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { zipSync } from "fflate";
import { APP } from "./config.js";
import { ENGINE } from "./engine.js";
import { EXPORT_CONVENTIONS, exportConvention } from "@neurodesk/samsrf";
import { runAnalysis, workerCount } from "./pool.js";
import { createSurfaceViewer } from "./viewer.js";
import {
  ANALYSES,
  DEFAULT_SETTINGS,
  HRF_OPTIONS,
  PRESETS,
  buildModel,
  changeScalingFactor,
  fineFit,
  hrfModel,
  hrfValue,
  parseModel,
  presetsFor,
  setFineFit,
  withInputNames,
} from "./models.js";
import { describeSurfaces, displaySurface, emptyInputs, mergeInputs, missingInputs, sortFiles } from "./inputs.js";
import { compareRunNames } from "@neurodesk/samsrf/inputs";
import { countShown, encodeOverlay, hemisphereOf, mapKind, mapLabel, mapOrder, mapStyle } from "./display.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Population receptive field mapping",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// ---- Viewer chrome ----

const threshold = document.createElement("input");
Object.assign(threshold, { id: "r2Threshold", type: "range", min: "0", max: "1", step: "0.01", value: "0.1" });
threshold.setAttribute("aria-label", "R² threshold");
const thresholdValue = document.createElement("span");
thresholdValue.textContent = "0.10";
const thresholdControl = document.createElement("label");
thresholdControl.className = "nd-opacity-control";
thresholdControl.append("R² >", threshold, thresholdValue);
const opacity = document.createElement("input");
Object.assign(opacity, { id: "mapOpacity", type: "range", min: "0", max: "1", step: "0.05", value: "1" });
opacity.setAttribute("aria-label", "Map opacity");
const opacityControl = document.createElement("label");
opacityControl.className = "nd-opacity-control";
opacityControl.append("Opacity", opacity);

const toolbar = createViewerToolbar({
  views: [
    { id: "medial", label: "Medial", active: true },
    { id: "lateral", label: "Lateral" },
    { id: "posterior", label: "Posterior" },
    { id: "ventral", label: "Ventral" },
  ],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [thresholdControl, opacityControl],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true, channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }] });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const viewer = createSurfaceViewer("gl1");
let view = "medial";
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  view = detail.value;
  viewer.setView(view, hemisphere());
});

function status(message, { error = false, channel = "technical" } = {}) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

// ---- Session state ----

/** @type {import('./inputs.js').Inputs} */
let inputs = emptyInputs();
let inputGeneration = 0;
/** @type {Record<string, unknown>} */
let model = buildModel("example-gaussian");
let modelFromPreset = true;
let editableScalingFactor = DEFAULT_SETTINGS.scalingFactor;
/** The finished analysis: its maps by name, its files, and the map on screen. */
let result = null;
/** The load or run in progress, cancelled by the status bar's ×. */
let busy = null;
let shownSurface = { mesh: null, curv: null };

const analysis = () => $("analysis").value;
const presetId = () => $("preset").value;
const hemisphere = () => hemisphereOf([...inputs.runs, ...Object.values(inputs.surfaces)].map((file) => file.name));

// ---- Input fields ----

function field(id, config) {
  const element = createFileField({ id: `${id}Input`, rootId: `${id}Drop`, ...config });
  $(`${id}Field`).append(element);
  return element;
}

const fields = {
  runs: field("runs", { kind: "dataset", multiple: true, text: "Drop run GIfTIs or a SamSrf data folder", label: "Choose run GIfTI files or a data folder" }),
  apertures: field("apertures", { kind: "metadata", text: "Drop apertures (.mat, NIfTI or GIF)", label: "Choose the stimulus apertures" }),
  roi: field("roi", { kind: "surface", text: "Drop an ROI label (optional)", label: "Choose an optional FreeSurfer ROI label" }),
  surfaces: field("surfaces", { kind: "surface", multiple: true, text: "Drop surfaces: white, inflated, curv, area", label: "Choose FreeSurfer surfaces, curvature and area" }),
  template: field("template", { kind: "surface", text: "Drop a template map GIfTI (e.g. Benson)", label: "Choose the template map" }),
  seed: field("seed", { kind: "surface", text: "Drop the seed region label", label: "Choose the seed region label" }),
  model: field("model", { kind: "model", accept: ".json", text: "Load a model JSON", label: "Choose a SamSrf model JSON file" }),
};
const FIELD_TEXT = Object.fromEntries(Object.entries(fields).map(([slot, element]) => [slot, element.getAttribute("text")]));

function slotText(slot) {
  if (slot === "runs") return inputs.runs.length ? `${inputs.runs.length} run${inputs.runs.length === 1 ? "" : "s"}` : null;
  if (slot === "surfaces") return describeSurfaces(inputs.surfaces) || null;
  return inputs[slot]?.name ?? null;
}

function renderInputs() {
  for (const slot of ["runs", "apertures", "roi", "surfaces", "template", "seed"]) {
    const text = slotText(slot);
    fields[slot].setText(text ?? FIELD_TEXT[slot]);
    fields[slot].setHasFiles(Boolean(text));
  }
  $("runsInfo").hidden = !inputs.runs.length;
  $("runsInfo").textContent = inputs.runs.map((file) => file.name).join(", ");
  model = withInputNames(model, analysis(), inputs);
  renderModel();
}

/** Replace the slots the files fill. A whole folder fills them all. */
async function addFiles(filesPromise, only, generation = inputGeneration) {
  const files = await filesPromise;
  if (generation !== inputGeneration) return;
  const { filled, ignored } = sortFiles(files);
  if (only === "surfaces") {
    for (const slot of Object.keys(filled)) if (slot !== "surfaces") ignored.push(...[filled[slot]].flat().map((file) => file.name));
    await setInputs(mergeInputs(inputs, { surfaces: filled.surfaces ?? {} }));
  } else if (only) {
    await setInputs(mergeInputs(inputs, { [only]: only === "runs" ? [...files].sort(compareRunNames) : files[0] }));
  } else {
    if (filled.model) await loadModelFile(filled.model, generation);
    if (generation !== inputGeneration) return;
    await setInputs(mergeInputs(inputs, filled));
  }
  if (ignored.length) status(`Not used: ${ignored.join(", ")}`, { error: true });
}

async function setInputs(next) {
  inputs = next;
  clearResult();
  renderInputs();
  const mesh = displaySurface(inputs.surfaces);
  const curv = inputs.surfaces.curv ?? null;
  if (mesh !== shownSurface.mesh || curv !== shownSurface.curv) {
    shownSurface = { mesh, curv };
    try {
      await viewer.showSurface(mesh, curv);
      viewer.setView(view, hemisphere());
      $("emptyState").hidden = Boolean(mesh);
      if (mesh) log.log(`Showing ${mesh.name}${curv ? ` shaded by ${curv.name}` : ""}`, "info", "technical");
    } catch (error) {
      shownSurface = { mesh: null, curv: null };
      status(`The surface could not be shown: ${error.message}`, { error: true });
    }
  }
  updateRunButton();
  status(missingInputs(analysis(), model, inputs).length ? "Add the remaining inputs" : "Ready");
}

function importInto(slot) {
  return (filesPromise) => {
    const generation = inputGeneration;
    exampleControl.cancel();
    void addFiles(filesPromise, slot, generation).catch((error) => {
      if (generation === inputGeneration) status(error.message, { error: true });
    });
  };
}
fields.runs.onFiles(importInto(null));
for (const slot of ["apertures", "roi", "surfaces", "template", "seed"]) fields[slot].onFiles(importInto(slot));
fields.model.onFiles((filesPromise) => {
  const generation = inputGeneration;
  void filesPromise.then(([file]) => loadModelFile(file, generation)).catch((error) => {
    if (generation === inputGeneration) status(error.message, { error: true });
  });
});
$("clearInputs").addEventListener("click", () => {
  inputGeneration += 1;
  exampleControl.reset();
  for (const field of Object.values(fields)) {
    field.input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [], cancelPending: true } }));
  }
  void setInputs(emptyInputs()).catch(report);
});

// ---- Model ----

function fillPresets() {
  $("preset").replaceChildren(...presetsFor(analysis()).map(({ id, label }) => new Option(label, id)));
}
$("hrf").replaceChildren(...HRF_OPTIONS.map(({ value, label }) => new Option(label, value)));
$("exportConvention").replaceChildren(...Object.entries(EXPORT_CONVENTIONS).map(([value, label]) => new Option(label, value)));

function settings() {
  const scalingFactor = $("scalingFactor").readOnly ? editableScalingFactor : Number($("scalingFactor").value);
  const tr = Number($("tr").value);
  return {
    scalingFactor: scalingFactor > 0 ? scalingFactor : DEFAULT_SETTINGS.scalingFactor,
    tr: tr > 0 ? tr : DEFAULT_SETTINGS.tr,
    exportConvention: $("exportConvention").value,
  };
}

function resetModel() {
  modelFromPreset = true;
  model = withInputNames(buildModel(presetId(), settings()), analysis(), inputs);
  renderModel();
}

/** Write the model into the JSON view and the controls that mirror its fields. */
function renderModel() {
  const kind = analysis();
  const fixedScale = modelFromPreset && PRESETS[presetId()]?.fixedScalingFactor !== undefined;
  $("modelJson").value = JSON.stringify(model, null, 2);
  $("modelJson").setCustomValidity("");
  if ("TR" in model) $("tr").value = String(model.TR);
  if ("Scaling_Factor" in model) {
    $("scalingFactor").value = String(model.Scaling_Factor);
    if (!fixedScale) editableScalingFactor = Number(model.Scaling_Factor);
  } else {
    $("scalingFactor").value = String(editableScalingFactor);
  }
  $("scalingFactor").readOnly = fixedScale;
  if ("Hrf" in model) {
    const value = hrfValue(model.Hrf);
    $("hrf").querySelector('option[value="custom"]')?.remove();
    if (value === "custom") {
      const option = new Option("Custom HRF (model JSON)", "custom");
      option.disabled = true;
      $("hrf").append(option);
    }
    $("hrf").value = value;
  }
  $("fineFit").value = fineFit(model);
  $("fineFitThreshold").value = String(model.Fine_Fit_Threshold ?? 0.01);
  $("coarseOnly").checked = Boolean(model.Coarse_Fit_Only);
  $("exportConvention").value = exportConvention(model.Export_Convention);
  $("revcorThreshold").value = String(model.R2_Threshold ?? 0);
  $("stimulusFields").hidden = kind === "cf";
  $("hrfField").hidden = kind === "cf";
  $("cfInputs").hidden = kind !== "cf";
  for (const element of document.querySelectorAll("[data-analysis]")) element.hidden = element.dataset.analysis !== kind;
  $("runButton").textContent = ANALYSES[kind].runLabel;
  updateRunButton();
}

function editModel(change) {
  model = change(model);
  clearResult();
  renderModel();
}

async function loadModelFile(file, generation = inputGeneration) {
  const text = await file.text();
  if (generation !== inputGeneration) return;
  const parsed = parseModel(text, analysis());
  modelFromPreset = false;
  editModel(() => withInputNames(parsed, analysis(), inputs));
  status(`Model ${parsed.Name} loaded from ${file.name}`);
}

$("analysis").addEventListener("change", () => {
  fillPresets();
  clearResult();
  resetModel();
  status(`${ANALYSES[analysis()].label} selected`);
});
$("preset").addEventListener("change", () => {
  clearResult();
  resetModel();
});
$("tr").addEventListener("change", () => editModel((current) => ({ ...current, TR: settings().tr })));
$("scalingFactor").addEventListener("change", () => editModel(current => changeScalingFactor(current, settings().scalingFactor, modelFromPreset ? presetId() : null)));
$("hrf").addEventListener("change", () => editModel((current) => ({ ...current, Hrf: hrfModel($("hrf").value) })));
$("fineFit").addEventListener("change", () => editModel((current) => setFineFit(current, $("fineFit").value, modelFromPreset ? PRESETS[presetId()] : null)));
$("fineFitThreshold").addEventListener("change", () => editModel((current) => ({ ...current, Fine_Fit_Threshold: Number($("fineFitThreshold").value) })));
$("coarseOnly").addEventListener("change", () => editModel((current) => {
  const next = { ...current, Coarse_Fit_Only: true };
  if (!$("coarseOnly").checked) delete next.Coarse_Fit_Only;
  return next;
}));
$("revcorThreshold").addEventListener("change", () => editModel((current) => ({ ...current, R2_Threshold: Number($("revcorThreshold").value) })));
$("exportConvention").addEventListener("change", () => editModel(current => ({ ...current, Export_Convention: $("exportConvention").value })));
$("modelJson").addEventListener("change", () => {
  try {
    model = parseModel($("modelJson").value, analysis());
    modelFromPreset = false;
    clearResult();
    renderModel();
  } catch (error) {
    $("modelJson").setCustomValidity(error.message);
    $("modelJson").reportValidity();
    status(error.message, { error: true });
    updateRunButton();
  }
});
$("saveModel").addEventListener("click", () => {
  downloadFile(new File([`${JSON.stringify(model, null, 4)}\n`], `${model.Name}.json`, { type: "application/json" }));
});

function updateRunButton() {
  const missing = missingInputs(analysis(), model, inputs);
  const invalid = !$("modelJson").checkValidity();
  $("runButton").disabled = Boolean(busy) || missing.length > 0 || invalid;
  $("runHint").textContent = invalid ? "Fix the model JSON" : missing.length ? `Needs ${missing.join(", ")}` : "";
  $("runHint").hidden = !$("runHint").textContent;
}

// ---- Results ----

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => void showMap(stage).catch((error) => status(error.message, { error: true })),
  onDownload: (stage) => {
    const file = result?.files.find((candidate) => candidate.name === stage);
    if (file) downloadFile(file);
  },
});

function clearResult() {
  if (!result) return;
  result = null;
  results.render({});
  $("downloadAll").disabled = true;
  $("location").textContent = "";
  void viewer.showMap(null);
}

function r2Values() {
  const r2 = result.maps.get(result.r2);
  return r2 ?? new Float32Array(result.vertexCount).fill(1);
}

let drawing = Promise.resolve();
/** Draw a result map on the surface with the current threshold. stage is the map's file name. */
function showMap(stage = result?.shown) {
  const draw = drawing.then(async () => {
    if (!result || !stage) return;
    const name = result.mapOf.get(stage);
    if (!name) return;
    result.shown = stage;
    const values = result.maps.get(name);
    const r2 = r2Values();
    const level = Number(threshold.value);
    const style = mapStyle(name, values, { r2, threshold: level, scalingFactor: model.Scaling_Factor });
    await viewer.showMap(encodeOverlay(values, r2, level, style.window), style.colormap, Number(opacity.value));
    const [low, high] = style.window.map((value) => Number(value.toPrecision(3)));
    $("location").textContent = `${mapLabel(name)} · ${low} to ${high} · ${countShown(r2, level)} vertices with R² > ${level.toFixed(2)}`;
  });
  // A failed draw rejects its own caller but must not block the draws queued after it.
  drawing = draw.catch(() => {});
  return draw;
}

let pendingDraw = 0;
threshold.addEventListener("input", () => {
  thresholdValue.textContent = Number(threshold.value).toFixed(2);
  cancelAnimationFrame(pendingDraw);
  pendingDraw = requestAnimationFrame(() => void showMap().catch((error) => status(error.message, { error: true })));
});
opacity.addEventListener("input", () => void viewer.setOpacity(Number(opacity.value)));

function renderResult() {
  const rows = {};
  const order = mapOrder([...result.mapOf.values()]);
  const files = [...result.files].sort((a, b) => {
    const rank = (file) => {
      const name = result.mapOf.get(file.name);
      return name ? order.indexOf(name) : order.length;
    };
    return rank(a) - rank(b);
  });
  for (const file of files) {
    const name = result.mapOf.get(file.name);
    rows[file.name] = { description: name ? mapLabel(name) : file.name, file, viewable: Boolean(name) && viewer.hasSurface };
  }
  results.render(rows, files.map((file) => file.name));
  $("downloadAll").disabled = false;
}

$("downloadAll").addEventListener("click", () => {
  if (!result) return;
  void Promise.all(result.files.map(async (file) => [file.name, new Uint8Array(await file.arrayBuffer())]))
    .then((entries) => downloadFile(new File([zipSync(Object.fromEntries(entries), { level: 6 })], `${result.outName}_maps.zip`, { type: "application/zip" })))
    .catch((error) => status(error.message, { error: true }));
});

// ---- Running ----

async function named(file) {
  return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

async function jobInputs() {
  const surfaces = {};
  for (const [role, file] of Object.entries(inputs.surfaces)) surfaces[role] = await named(file);
  return {
    analysis: analysis(),
    model: structuredClone(model),
    runs: await Promise.all(inputs.runs.map(named)),
    apertures: await named(inputs.apertures),
    roi: await named(inputs.roi),
    surfaces,
    template: await named(inputs.template),
    seed: await named(inputs.seed),
    normalise: $("normalise").checked,
    average: $("combine").value === "average",
  };
}

function setBusy(controller) {
  busy = controller;
  const locked = Boolean(controller);
  for (const element of Object.values(fields)) element.disabled = locked;
  for (const id of ["analysis", "preset", "tr", "scalingFactor", "hrf", "combine", "normalise", "fineFit", "fineFitThreshold", "coarseOnly", "revcorThreshold", "modelJson", "clearInputs"]) $(id).disabled = locked;
  exampleControl.setDisabled(locked);
  updateRunButton();
}

async function runSelected(signal) {
  const kind = analysis();
  const missing = missingInputs(kind, model, inputs);
  if (missing.length) throw new Error(`Add ${missing.join(", ")} before running.`);
  if (busy) throw new Error("An analysis is already running.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(controller);
  clearResult();
  const started = performance.now();
  progress.begin(`${ANALYSES[kind].label}…`);
  progress.setCancellable(true);
  log.log(`${ANALYSES[kind].label}: model ${model.Name}, ${inputs.runs.length} runs (${$("combine").value === "average" ? "averaged" : "concatenated"}${$("normalise").checked ? ", detrended and z-scored" : ""})`, "info", "analysis");
  log.log(`${ENGINE.name} on ${workerCount()} workers`, "info", "technical");
  try {
    const output = await runAnalysis(await jobInputs(), {
      signal: controller.signal,
      onProgress: (fraction, message) => progress.setProgress(fraction, message),
      onLog: (line) => log.log(line, "info", "analysis"),
    });
    controller.signal.throwIfAborted();
    const files = output.files.map(({ name, bytes }) => new File([bytes], name, { type: "application/octet-stream" }));
    const maps = new Map(output.maps.map(({ name, values }) => [name, values]));
    result = {
      analysis: kind,
      outName: output.outName,
      vertexCount: output.vertexCount,
      files,
      maps,
      mapOf: new Map(output.files.filter(({ map }) => maps.has(map)).map(({ name, map }) => [name, map])),
      r2: output.maps.find(({ name }) => mapKind(name) === "r2")?.name,
      shown: null,
    };
    for (const line of output.summary) log.log(line, "info", "analysis");
    for (const file of files) log.log(`Saved ${file.name}`, "info", "analysis");
    renderResult();
    $("outputSection").open = true;
    const firstMap = mapOrder([...result.mapOf.values()])[0];
    const first = [...result.mapOf].find(([, name]) => name === firstMap)?.[0];
    if (viewer.hasSurface && first) await showMap(first);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const outcome = ANALYSES[kind].outcome;
    progress.end(outcome);
    status(`${outcome} (${seconds} s)`, { channel: "analysis" });
    return {
      artifacts: files.map((file) => ({ role: "maps", file })),
      provenance: {
        method: `samsrf-${kind}`,
        engine: ENGINE.name,
        model: structuredClone(model),
        normalise: $("normalise").checked,
        average: $("combine").value === "average",
      },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    setBusy(null);
  }
}

function report(error) {
  if (error.name === "AbortError") status("Cancelled");
  else status(error.message, { error: true, channel: "analysis" });
}

$("runButton").addEventListener("click", () => void runSelected().catch(report));
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  busy?.abort();
};

// ---- Example ----

const EXAMPLE_SLOTS = { run: "runs", apertures: "apertures", roi: "roi", seed: "seed", template: "template" };

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: (message, error) => status(message, { error }),
  onLoad: async (example, { fetchFiles, assertCurrent }) => {
    const files = await fetchFiles();
    assertCurrent();
    const next = emptyInputs();
    example.files.forEach(({ role }, index) => {
      const slot = EXAMPLE_SLOTS[role];
      if (slot === "runs") next.runs.push(files[index]);
      else if (slot) next[slot] = files[index];
      else next.surfaces[role] = files[index];
    });
    await setInputs(next);
    assertCurrent();
    status(`${example.label} loaded · ${ANALYSES[analysis()].runLabel} when ready`);
  },
});
$("exampleControl").append(exampleControl);

// ---- Automation ----

function automationOperation(kind) {
  return async ({ inputs: given, parameters, signal }) => {
    $("analysis").value = kind;
    fillPresets();
    if (parameters.preset) $("preset").value = parameters.preset;
    if (parameters.tr) $("tr").value = String(parameters.tr);
    if (parameters.scalingFactor) {
      editableScalingFactor = parameters.scalingFactor;
      $("scalingFactor").value = String(parameters.scalingFactor);
    }
    resetModel();
    if (parameters.hrf) model = { ...model, Hrf: hrfModel(parameters.hrf) };
    if (typeof parameters.normalise === "boolean") $("normalise").checked = parameters.normalise;
    if (typeof parameters.average === "boolean") $("combine").value = parameters.average ? "average" : "concatenate";
    if (given.model?.length) await loadModelFile(given.model[0]);
    const next = emptyInputs();
    next.runs = [...given.runs];
    for (const slot of ["apertures", "roi", "template", "seed"]) next[slot] = given[slot]?.[0] ?? null;
    next.surfaces = sortFiles(given.surfaces ?? []).filled.surfaces ?? {};
    await setInputs(next);
    return runSelected(signal);
  };
}

registerAppAutomation({
  app: APP.id,
  operations: { prf: automationOperation("prf"), rc: automationOperation("rc"), cf: automationOperation("cf") },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  busy?.abort();
});

fillPresets();
renderInputs();
updateRunButton();

export default Object.freeze({ workspace, toolbar, log, info, results, viewer });
