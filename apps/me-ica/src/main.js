import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { MULTIPLANAR_TYPE, SHOW_RENDER, SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  bindFileDrop,
  bindInfoTooltips,
  createConsole,
  createExampleSelector,
  createInfoDialog,
  createPreviewQueue,
  createResultList,
  createViewerToolbar,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { zipStore } from "./zip.js";
import { APP } from "./config.js";
import { groupEchoes, parseEchoTimes } from "./inputs.js";
import { createRunner } from "./runner.js";
import examples from "../examples.json";

// tedana's PCA classifies voxels with good signal in 3+ echoes; with 2 it has none and fails.
const MIN_ECHOES = 3;
// Trees with an external_regressor_config; they need the regressors TSV (tedana --external).
const REGRESSOR_TREES = new Set([...document.querySelectorAll('#tree optgroup option')].map((o) => o.value));
let regressors = null;

const $ = (id) => document.getElementById(id);

mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "ME-ICA",
  subtitle: "Multi-echo fMRI denoising (tedana) in the browser",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// Viewer: one NiiVue canvas; the Components tab swaps in the metrics table.
const viewer = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
const layouts = { multiplanar: SLICE_TYPE.MULTIPLANAR, axial: SLICE_TYPE.AXIAL, coronal: SLICE_TYPE.CORONAL, sagittal: SLICE_TYPE.SAGITTAL, render: SLICE_TYPE.RENDER };
const toolbar = createViewerToolbar({
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    ["multiplanar", "3-Plane"],
    ["axial", "Axial"],
    ["coronal", "Coronal"],
    ["sagittal", "Sagittal"],
    ["render", "3D"],
  ]
    .map(([id, label], index) => ({ id, label, active: index === 0, onClick: () => showLayout(id) }))
    .concat({ id: "components", label: "Components", hidden: true, onClick: () => showComponents() }),
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);
const viewerReady = viewer.attachTo("gl1").then(() => {
  viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.showRender = SHOW_RENDER.ALWAYS;
  viewer.isLegendVisible = false;
  viewer.createExtensionContext().on("locationChange", ({ detail }) => {
    const value = detail.values[0]?.value;
    $("location").textContent = `${detail.mm.map(Math.round).join("×")} mm  ${value == null ? "" : Number(value).toPrecision(4)}`;
  });
});

const info = createInfoDialog({ id: "infoDialog" });
$("aboutBtn").onclick = () => info.open("About ME-ICA", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

// Workflow state: echoes in TE order, then the last run's outputs.
let echoes = [];
let outputs = null;
let busy = false;
let active = null;
let importController = null;
let dataController = new AbortController();

const results = createResultList({
  element: $("resultList"),
  onView: (stage, result) => {
    if (stage === "metrics") return showComponents();
    const signal = outputs?.signal;
    void show(result.file, result.description, { signal, statMap: stage === "accepted" || stage === "components", ...(stage === "t2star" && { cal: T2STAR_WINDOW }) })
      .catch(error => { if (error.name !== "AbortError") status(error.message, true); });
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});
const runner = createRunner({
  createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
});

function setBusy(value) {
  busy = value;
  $("imageInput").disabled = value;
  exampleControl.setDisabled(value);
  for (const id of ["echoTimes", "tree", "tedpca", "seed", "maxit", "maxrestart"]) $(id).disabled = value;
  $("runButton").disabled = value || echoes.length < MIN_ECHOES;
  $("zipButton").disabled = value || !outputs;
}

// tedana caps T2* fits at 10x the 99.5th percentile, so the map has outliers to hundreds of seconds
// that wash out the default window; tissue T2* sits around 0.02-0.08 s.
const T2STAR_WINDOW = { calMin: 0, calMax: 0.1 };

/** Show an image. Component maps (tedana's "stat-z" maps: regression weights on z-scored data,
 * mostly within ±0.7) go over the S0 map as warm/cool overlays from |0.3|, about the top 10%. */
const display = createPreviewQueue({
  ready: viewerReady,
  render: async (preview) => {
    if (!preview) {
      await viewer.removeAllVolumes();
      $("emptyState").hidden = false;
      $("imageLabel").textContent = "";
      $("componentReport").hidden = true;
      return;
    }
    const window = preview.range ? { calMin: preview.range[0], calMax: preview.range[1] } : {};
    const volumes = preview.base
      ? [{ url: preview.base, name: preview.base.name }, { url: preview.file, name: preview.file.name, colormap: "warm", colormapNegative: "winter", calMin: 0.3, calMax: 0.7 }]
      : [{ url: preview.file, name: preview.file.name, ...window }];
    await viewer.loadVolumes(volumes);
    if (preview.frame) await viewer.setFrame4D(viewer.volumes.at(-1).id, preview.frame);
    $("componentReport").hidden = true;
    $("emptyState").hidden = true;
    $("imageLabel").textContent = preview.label;
    if (toolbar.viewTabs.querySelector(".active")?.dataset.view === "components") showLayout("multiplanar");
  },
});

function show(file, label, { frame = 0, statMap = false, cal, signal } = {}) {
  const preview = Object.freeze({
    file,
    base: statMap ? outputs?.files.get("S0map.nii.gz") ?? null : null,
    label,
    frame,
    range: cal ? Object.freeze([cal.calMin, cal.calMax]) : null,
  });
  return display(preview, { signal });
}

function showLayout(id) {
  $("componentReport").hidden = true;
  viewer.sliceType = layouts[id];
  viewer.drawScene();
  toolbar.setActive(id);
}

function clearOutputs() {
  outputs = null;
  results.render();
  $("summary").textContent = "";
  $("componentReport").replaceChildren();
  $("componentReport").hidden = true;
  toolbar.viewTabs.querySelector('[data-view="components"]').hidden = true;
  $("outputSection").open = false;
  $("zipButton").disabled = true;
}

// Inputs: echo images (any order) with optional sidecars that supply TE and ordering.
async function loadFiles(files, signal) {
  if (busy) throw new Error("ME-ICA is busy. Wait or cancel, then retry.");
  signal?.throwIfAborted();
  importController?.abort();
  const controller = new AbortController();
  importController = controller;
  $("runButton").disabled = true;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const grouped = await groupEchoes(files);
    controller.signal.throwIfAborted();
    if (grouped.echoes.length < MIN_ECHOES) throw new Error("Choose at least three echo NIfTI images (with their JSON sidecars if available).");
    await show(grouped.echoes[0].file, `Echo 1 · ${grouped.echoes[0].file.name}`, { signal: controller.signal });
    controller.signal.throwIfAborted();
    dataController.abort();
    dataController = new AbortController();
    clearOutputs();
    echoes = grouped.echoes;
    regressors = grouped.regressors;
    $("echoTimes").value = grouped.echoTimes;
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${echoes.length} echoes: ${echoes.map((e) => e.file.name).join(", ")}${regressors ? ` · regressors ${regressors.name}` : ""}${grouped.ignored.length ? ` · ignored ${grouped.ignored.join(", ")}` : ""}`;
    $("dropZone").classList.add("has-files");
    $("runButton").disabled = false;
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [...files] } }));
    status(grouped.echoTimes ? `${echoes.length} echoes loaded; echo times from sidecars` : `${echoes.length} echoes loaded; enter their echo times`);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (importController === controller) {
      importController = null;
      $("runButton").disabled = busy || echoes.length < MIN_ECHOES;
    }
  }
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch((error) => { if (error.name !== "AbortError") status(error.message, true); });
}
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(files);
});
bindFileDrop($("dropZone"), (files) => Promise.resolve(files).then(importFiles));
const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(files, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

// Progress through the workflow's own log lines.
const STAGES = [
  ["Starting", 0.02],
  ["Computing EPI mask", 0.05],
  ["Computing PCA of", 0.25],
  ["Computing PCA component", 0.5],
  ["Selected", 0.55],
  ["ICA with", 0.7],
  ["Selecting components", 0.75],
  ["Writing tables", 0.8],
  ["Writing component maps", 0.85],
];
function onPhase(phase) {
  const stage = STAGES.find(([prefix]) => phase.startsWith(prefix));
  progress.setProgress(stage ? stage[1] : progress.value ?? 0, phase);
  log.log(phase);
}

const MEDIA = { ".nii.gz": "application/gzip", ".tsv": "text/tab-separated-values", ".json": "application/json" };
const asFile = ({ name, buffer }) => new File([buffer], name, { type: Object.entries(MEDIA).find(([ext]) => name.endsWith(ext))?.[1] ?? "application/octet-stream" });

async function run(signal) {
  signal?.throwIfAborted();
  if (importController) throw new Error("Wait for the echo import to finish.");
  if (busy || echoes.length < MIN_ECHOES) return null;
  const tes = parseEchoTimes($("echoTimes").value, echoes.length);
  const external = REGRESSOR_TREES.has($("tree").value);
  if (external && !regressors) throw new Error("This tree needs a regressors TSV, such as fMRIPrep's *_desc-confounds_timeseries.tsv.");
  const options = {
    tree: $("tree").value,
    tedpca: $("tedpca").value,
    seed: Number($("seed").value),
    maxit: Number($("maxit").value),
    maxrestart: Number($("maxrestart").value),
    command: `me-ica (browser) -e ${tes.join(" ")} --tree ${$("tree").value} --tedpca ${$("tedpca").value} --seed ${$("seed").value}${external ? ` --external ${regressors.name}` : ""}`,
  };
  if (![options.seed, options.maxit, options.maxrestart].every(Number.isInteger) || options.seed < 0) throw new Error("Seed, iterations and restarts must be non-negative integers.");
  clearOutputs();
  setBusy(true);
  active = new AbortController();
  const controller = active;
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin("Starting ME-ICA…");
  try {
    if (external) options.external = await regressors.text();
    controller.signal.throwIfAborted();
    const buffers = await Promise.all(echoes.map((e) => e.file.arrayBuffer()));
    const payload = { echoes: echoes.map((e, i) => ({ name: e.file.name, buffer: buffers[i] })), tes, options };
    const out = await runner.run(payload, buffers, onPhase, controller.signal);
    controller.signal.throwIfAborted();
    const next = { summary: out.summary, files: new Map(out.files.map((f) => [f.name, asFile(f)])), signal: dataController.signal };
    await show(next.files.get("desc-denoised_bold.nii.gz"), "Denoised series", { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = next;
    renderOutputs();
    progress.end(`${out.summary.accepted} of ${out.summary.n_components} components accepted`);
    status(`Done: ${out.summary.n_components} components, ${out.summary.accepted} accepted, ${out.summary.rejected} rejected (seed ${out.summary.seed})`);
    return outputs;
  } catch (error) {
    progress.end(error.name === "AbortError" ? "Cancelled" : "Failed", { success: false });
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    active = null;
    setBusy(false);
  }
}

const RESULTS = [
  ["denoised", "desc-denoised_bold.nii.gz", "Denoised series"],
  ["optcom", "desc-optcom_bold.nii.gz", "Optimally combined series"],
  ["t2star", "T2starmap.nii.gz", "T2* map (s)"],
  ["s0", "S0map.nii.gz", "S0 map"],
  ["accepted", "desc-ICAAccepted_stat-z_components.nii.gz", "Accepted component maps"],
  ["components", "desc-ICA_stat-z_components.nii.gz", "All component maps"],
  ["mask", "desc-adaptiveGoodSignal_mask.nii.gz", "Adaptive mask (good echoes)"],
  ["metrics", "desc-tedana_metrics.tsv", "Component metrics (table)"],
];

function renderOutputs() {
  const items = {};
  for (const [stage, name, description] of RESULTS) {
    const file = outputs.files.get(name);
    if (file) items[stage] = { description, file };
  }
  results.render(items);
  const s = outputs.summary;
  $("summary").textContent = `${s.n_components} components · ${s.accepted} accepted · ${s.rejected} rejected`;
  toolbar.viewTabs.querySelector('[data-view="components"]').hidden = false;
  $("outputSection").open = true;
  $("zipButton").disabled = false;
}

// Components tab: tedana's metrics table; a row shows that component's z-map.
async function showComponents() {
  if (!outputs) return;
  const current = outputs;
  const [header, ...rows] = (await current.files.get("desc-tedana_metrics.tsv").text()).trim().split("\n").map((l) => l.split("\t"));
  if (outputs !== current) return;
  const col = (name) => header.indexOf(name);
  const columns = [["Component", "Component"], ["classification", "Class"], ["kappa", "Kappa"], ["rho", "Rho"], ["variance explained", "Variance %"], ["classification_tags", "Tags"]];
  const table = document.createElement("table");
  table.className = "nd-data-table";
  table.createTHead().insertRow().append(...columns.map(([, label]) => Object.assign(document.createElement("th"), { textContent: label })));
  const body = table.createTBody();
  rows.forEach((row, k) => {
    const tr = body.insertRow();
    tr.setAttribute("role", "button");
    tr.tabIndex = 0;
    tr.title = `Show ${row[0]}'s map`;
    for (const [name] of columns) {
      const value = row[col(name)];
      tr.insertCell().textContent = /^-?\d+\.\d+/.test(value) ? Number(value).toFixed(2) : value === "n/a" ? "" : value;
    }
    const open = () => void show(current.files.get("desc-ICA_stat-z_components.nii.gz"), `${row[0]} map · ${row[col("classification")]}`, { frame: k, statMap: true, signal: current.signal })
      .catch(error => { if (error.name !== "AbortError") status(error.message, true); });
    tr.onclick = open;
    tr.onkeydown = (event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), open());
  });
  const scroll = Object.assign(document.createElement("div"), { className: "nd-table-scroll" });
  scroll.append(table);
  const lead = Object.assign(document.createElement("p"), { className: "nd-report-lead", textContent: `${outputs.summary.accepted} accepted, ${outputs.summary.rejected} rejected. Select a component to view its map.` });
  $("componentReport").replaceChildren(lead, scroll);
  $("componentReport").hidden = false;
  toolbar.setActive("components");
}

$("runButton").addEventListener("click", () => {
  run().catch((error) => status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError"));
});
$("cancelButton").onclick = () => {
  exampleControl.cancel();
  active?.abort();
  runner.cancel();
};
$("zipButton").addEventListener("click", () => {
  if (!outputs) return;
  Promise.all([...outputs.files.values()].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })))
    .then((files) => downloadFile(new File([zipStore(files)], "me-ica_outputs.zip", { type: "application/zip" })))
    .catch((e) => status(e.message, true));
});

registerAppAutomation({
  app: APP.id,
  operations: {
    denoise: async ({ inputs, parameters, signal }) => {
      await loadFiles([...inputs.echoes, ...(inputs.sidecars ?? []), ...(inputs.regressors ?? [])], signal);
      if (parameters.echoTimes) $("echoTimes").value = parameters.echoTimes;
      for (const id of ["tree", "tedpca", "seed"]) if (parameters[id] != null) $(id).value = String(parameters[id]);
      const done = await run(signal);
      const file = (name) => done.files.get(name);
      return {
        artifacts: [
          { role: "denoised", file: file("desc-denoised_bold.nii.gz") },
          { role: "optcom", file: file("desc-optcom_bold.nii.gz") },
          { role: "t2star", file: file("T2starmap.nii.gz") },
          { role: "metrics", file: file("desc-tedana_metrics.tsv") },
        ],
        measurements: done.summary,
        provenance: { method: "me-ica (tedana e07066c workflow)", tree: $("tree").value, seed: done.summary.seed, regressors: REGRESSOR_TREES.has($("tree").value) ? regressors?.name : undefined },
      };
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  importController?.abort();
  dataController.abort();
  active?.abort();
  runner.cancel();
});
