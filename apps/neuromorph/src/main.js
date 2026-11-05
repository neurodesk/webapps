// NeuroMorph: SWC checks, a tube view coloured by neurite type, and NeuroM-defined
// morphometrics with Sholl analysis. The science lives in ./morph; this file is the UI.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindFileDrop,
  bindInfoTooltips,
  LabelLegend,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { writeMz3 } from "@neurodesk/webapp-components/file-io/mesh";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP } from "./config.js";
import { readSwc, writeSwc } from "./morph/swc.js";
import { analyse, buildMorphology, extent } from "./morph/morphometrics.js";
import { morphologyMesh, TYPE_COLORS, TYPE_LABELS } from "./morph/tubes.js";
import { bifurcationsCsv, morphometricsCsv, shollCsv, summary } from "./morph/outputs.js";
import { renderMorphometricsReport, renderShollReport } from "./report.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const isSwc = (file) => /\.swc$/i.test(file.name);
const stem = (name) => name.replace(/\.swc$/i, "");

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Neuron morphology from SWC reconstructions",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "render", label: "3D", active: true, onClick: () => showView("render") },
    { id: "morphometrics", label: "Morphometrics", hidden: true, onClick: () => showView("morphometrics") },
    { id: "sholl", label: "Sholl", hidden: true, onClick: () => showView("sholl") },
  ],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);
const legend = new LabelLegend({ element: $("legend") });

const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = SLICE_TYPE.RENDER;
    viewer.isOrientCubeVisible = false;
    viewer.is3DCrosshairVisible = false;
    viewer.isColorbarVisible = false;
    // Looking down the z axis with y up: NeuroMorpho.Org's standardized files put the
    // principal axis (the apical dendrite of a pyramidal cell) along y.
    viewer.azimuth = 180;
    viewer.elevation = 90;
    // NiiVue frames a mesh by its bounding sphere; zoom out so a long neuron is not clipped.
    viewer.scaleMultiplier = 0.75;
  });
  return attached;
}

/**
 * The loaded reconstructions. Each keeps its text so the repair option can be changed
 * without reading the files again.
 * @type {{ name: string, text: string, samples: import("./morph/swc.js").Sample[], issues: import("./morph/swc.js").Issue[], morphology: import("./morph/morphometrics.js").Morphology, analysis?: ReturnType<typeof analyse> }[]}
 */
let neurons = [];
let selected = 0;
let measured = false;
let loading = null;
let running = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => showView(stage === "sholl" ? "sholl" : "morphometrics"),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function viewTabs(visible) {
  for (const id of ["morphometrics", "sholl"]) {
    const tab = toolbar.viewTabs.querySelector(`[data-view="${id}"]`);
    if (tab) tab.hidden = !visible;
  }
}

function showView(id) {
  const neuron = neurons[selected];
  const report = id !== "render" && measured && neuron?.analysis;
  $("morphometricsReport").hidden = !(report && id === "morphometrics");
  $("shollReport").hidden = !(report && id === "sholl");
  if (report && id === "morphometrics") renderMorphometricsReport($("morphometricsReport"), neuron);
  if (report && id === "sholl") renderShollReport($("shollReport"), neuron);
  toolbar.setActive(report ? id : "render");
}

function clearResults() {
  measured = false;
  for (const neuron of neurons) delete neuron.analysis;
  results.render();
  $("outputSection").open = false;
  viewTabs(false);
  showView("render");
}

function parse(name, text) {
  const { samples, issues } = readSwc(text, { repair: $("repair").checked });
  const morphology = buildMorphology(samples);
  if (!morphology.neurites.length) throw new Error(`${name} has no neurites to measure.`);
  return { name, text, samples, issues, morphology };
}

function renderChecks() {
  const neuron = neurons[selected];
  const messages = (neuron?.issues ?? []).filter((issue) => issue.severity !== "info");
  $("checks").replaceChildren(...messages.slice(0, 4).map((issue) => Object.assign(document.createElement("p"), {
    className: "nd-message warning",
    textContent: `${issue.repaired ? "Repaired: " : ""}${issue.message}`,
  })));
}

function boundsCentre(vertices) {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < vertices.length; k++) {
    low[k % 3] = Math.min(low[k % 3], vertices[k]);
    high[k % 3] = Math.max(high[k % 3], vertices[k]);
  }
  return low.map((value, axis) => (value + high[axis]) / 2);
}

let showing = Promise.resolve();
/** Draw one neuron as tubes coloured by type. */
function showNeuron(index) {
  selected = index;
  renderChecks();
  showing = showing.catch(() => {}).then(async () => {
    const neuron = neurons[index];
    if (!neuron) return;
    await viewerReady();
    const mesh = morphologyMesh(neuron.morphology, 2 * extent(neuron.morphology));
    await viewer.loadMeshes([{ url: new File([writeMz3(mesh.vertices, mesh.faces, mesh.colors)], `${stem(neuron.name)}.mz3`), name: neuron.name }]);
    // Orbit about the middle of the neuron rather than the origin, which is usually the soma.
    viewer.renderPivotMM = boundsCentre(mesh.vertices);
    $("emptyState").hidden = true;
    legend.render(mesh.types.map((type, k) => ({ index: k, name: TYPE_LABELS[type], color: TYPE_COLORS[type] })));
    $("legendSection").open = true;
    const all = neuron.morphology.neurites;
    $("viewLabel").textContent = `${neuron.name} · ${neuron.samples.length} samples · ${all.length} neurite${all.length === 1 ? "" : "s"}`;
    log.log(`Displayed ${neuron.name}: ${mesh.vertices.length / 3} vertices`);
    showView(toolbar.querySelector(".nd-view-tab.active")?.dataset.view ?? "render");
  });
  return showing;
}

function setBusy(busy) {
  $("swcInput").disabled = busy;
  $("runButton").disabled = busy || !neurons.length;
  $("shollStep").disabled = busy;
  $("repair").disabled = busy;
  $("neuronSelect").disabled = busy;
  exampleControl.setDisabled(busy);
}

async function loadFiles(filesPromise, signal) {
  if (loading || running) throw new Error("NeuroMorph is busy. Wait or cancel, then retry.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading reconstructions…");
  try {
    const files = await filesPromise;
    const swc = files.filter(isSwc).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    if (!swc.length) throw new Error("Choose one or more .swc reconstructions.");
    const loaded = [];
    for (const [k, file] of swc.entries()) {
      controller.signal.throwIfAborted();
      progress.setProgress(k / swc.length, `Reading ${file.name}…`);
      loaded.push(parse(file.name, await file.text()));
    }
    controller.signal.throwIfAborted();
    neurons = loaded;
    clearResults();
    const select = $("neuronSelect");
    select.replaceChildren(...neurons.map((neuron, k) => new Option(neuron.name, String(k))));
    $("neuronField").hidden = neurons.length < 2;
    const skipped = files.length - swc.length;
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${neurons.length === 1 ? neurons[0].name : `${neurons.length} reconstructions`}${skipped ? ` · ${skipped} other file${skipped === 1 ? "" : "s"} skipped` : ""}`;
    $("dropZone").classList.add("has-files");
    for (const neuron of neurons) {
      log.log(`${neuron.name}: ${neuron.samples.length} samples, ${neuron.morphology.neurites.length} neurites`);
      for (const issue of neuron.issues) log.log(`${neuron.name}: ${issue.message}${issue.lines.length ? ` (lines ${issue.lines.slice(0, 10).join(", ")})` : ""}`, issue.severity === "info" ? "info" : "warn");
    }
    await showNeuron(0);
    progress.reset();
    status(`${neurons.length === 1 ? neurons[0].name : `${neurons.length} reconstructions`} loaded`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

function report(error) {
  if (error?.name === "AbortError") return status("Cancelled");
  status(error.message, true);
  progress.end(error.message, { success: false });
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("swcInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("neuronSelect").addEventListener("change", () => void showNeuron(Number($("neuronSelect").value)).catch(report));
$("shollStep").addEventListener("input", () => {
  if (measured) clearResults();
});
$("repair").addEventListener("change", () => {
  if (!neurons.length) return;
  try {
    neurons = neurons.map((neuron) => parse(neuron.name, neuron.text));
    clearResults();
    void showNeuron(selected).catch(report);
  } catch (error) {
    report(error);
  }
});

function shollStep() {
  const step = Number($("shollStep").value);
  if (!(step > 0)) {
    $("taskSection").open = true;
    $("shollStep").reportValidity();
    throw new Error("The Sholl step must be a positive number of µm.");
  }
  return step;
}

function outputName(kind) {
  return `${neurons.length === 1 ? stem(neurons[0].name) : "neuromorph"}_${kind}.csv`;
}

/** Measure every loaded neuron, yielding between neurons so a long batch can be cancelled. */
async function measureAll(signal, step = shollStep()) {
  if (!neurons.length || loading || running) throw new Error("Load SWC reconstructions before measuring them.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  progress.begin("Measuring…");
  try {
    for (const [k, neuron] of neurons.entries()) {
      await new Promise((resolve) => setTimeout(resolve));
      controller.signal.throwIfAborted();
      progress.setProgress(k / neurons.length, `Measuring ${neuron.name}…`);
      neuron.analysis = analyse(neuron.morphology, step);
    }
    controller.signal.throwIfAborted();
    const measuredNeurons = neurons.map(({ name, analysis }) => ({ name, analysis }));
    const files = {
      morphometrics: new File([morphometricsCsv(measuredNeurons)], outputName("morphometrics"), { type: "text/csv" }),
      sholl: new File([shollCsv(measuredNeurons)], outputName("sholl"), { type: "text/csv" }),
      bifurcations: new File([bifurcationsCsv(measuredNeurons)], outputName("bifurcations"), { type: "text/csv" }),
    };
    const rows = {
      morphometrics: { description: "Morphometrics table", file: files.morphometrics },
      sholl: { description: `Sholl intersections · ${step} µm step`, file: files.sholl },
      bifurcations: { description: "Bifurcation angles", file: files.bifurcations, viewable: false },
    };
    const repaired = [];
    for (const neuron of neurons) {
      if (!neuron.issues.some((issue) => issue.repaired)) continue;
      const file = new File([writeSwc(neuron.samples, [`Repaired by NeuroMorph ${APP.version} from ${neuron.name}`])], `${stem(neuron.name)}_repaired.swc`, { type: "text/plain" });
      rows[`repaired-${repaired.length}`] = { description: `Repaired SWC · ${neuron.name}`, file, viewable: false };
      repaired.push(file);
    }
    measured = true;
    results.render(rows);
    $("outputSection").open = true;
    viewTabs(true);
    showView("morphometrics");
    for (const neuron of neurons) log.log(`${neuron.name}: ${JSON.stringify(summary(neuron.analysis))}`);
    const message = `${neurons.length === 1 ? neurons[0].name : `${neurons.length} reconstructions`} measured`;
    progress.end(message);
    status(message);
    return {
      artifacts: [
        { role: "morphometrics", file: files.morphometrics },
        { role: "sholl", file: files.sholl },
        { role: "bifurcations", file: files.bifurcations },
        ...repaired.map((file) => ({ role: "repaired", file })),
      ],
      provenance: { method: "NeuroM 4 morphometrics", app: APP.id, version: APP.version, shollStepUm: step, repair: $("repair").checked },
      measurements: Object.fromEntries(neurons.map((neuron) => [neuron.name, summary(neuron.analysis)])),
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

$("runButton").addEventListener("click", () => {
  void measureAll().catch((error) => {
    if (error.name === "AbortError") {
      clearResults();
      progress.reset("Measurement cancelled");
      return status("Measurement cancelled");
    }
    report(error);
  });
});
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};

registerAppAutomation({
  app: APP.id,
  operations: {
    measure: async ({ inputs, parameters, signal }) => {
      if (parameters.repair !== undefined) $("repair").checked = Boolean(parameters.repair);
      if (parameters.shollStep !== undefined) $("shollStep").value = String(parameters.shollStep);
      await loadFiles(Promise.resolve(inputs.reconstructions), signal);
      return measureAll(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
