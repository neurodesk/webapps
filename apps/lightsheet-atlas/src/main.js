// Light-sheet atlas: register a cleared mouse brain to the Allen CCFv3 and count cells per region.
// The page owns the form, the viewer and the results; src/worker.js runs the science.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { openMicroscopyStack } from "@neurodesk/webapp-components/file-io/microscopy-stack";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import WorkerUrl from "./worker.js?worker&url";
import { APP, DETECTION_FIELDS, EXAMPLE_SETTINGS, outputNames, runSettings } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Allen atlas registration and cell counts",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.MULTIPLANAR;
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = layout;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
$("viewer").prepend(toolbar);
const log = createConsole({
  id: "technicalLog",
  resizable: true,
  channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }],
});
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// The loaded stack ({ files, name, shape, dtype }), the operation in progress and the outputs.
let input = null;
let loading = null;
let running = null;
let outputs = {};
let shown = null;

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

async function show(sample, overlay) {
  await viewerReady();
  $("emptyState").hidden = true;
  const layers = [{ url: sample.file, name: sample.file.name }];
  if (overlay?.kind === "labels") layers.push({ url: overlay.file, name: overlay.file.name, opacity: 0.35 });
  if (overlay?.kind === "cells") layers.push({ url: overlay.file, name: overlay.file.name, colormap: "red", calMin: 0.5, calMax: 1, isTransparentBelowCalMin: true, opacity: 1 });
  await viewer.loadVolumes(layers);
  if (overlay?.kind === "labels") await viewer.setColormapLabel(1, overlay.colormap);
  shown = overlay?.stage ?? "sample";
}

// The overlay a result row shows over the sample: atlas labels or cell marks.
function overlayOf(stage) {
  const entry = outputs[stage];
  if (entry?.kind === "labels") return { kind: "labels", file: entry.display, colormap: entry.colormap, stage };
  if (entry?.kind === "cells") return { kind: "cells", file: entry.marks, stage };
  return null;
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    void show(outputs.sample, overlayOf(stage)).catch((error) => status(error.message, true, "technical"));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  shown = null;
  results.render();
  $("outputSection").open = false;
}

const FORM_IDS = ["imageInput", "voxelZ", "voxelY", "voxelX", "orientation", "register", "detect", ...Object.keys(DETECTION_FIELDS)];
function setBusy(busy) {
  results.inert = busy;
  for (const id of FORM_IDS) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(true);
  progress.begin(message);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

const formatUm = (value) => (value === null || value === undefined ? "" : String(Number(value.toPrecision(6))));

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading the stack…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    const stack = await openMicroscopyStack(files);
    await stack.readPlane(0);
    current.throwIfAborted();
    input = { files, name: stack.name, shape: stack.shape, dtype: stack.dtype };
    clearOutputs();
    const size = stack.voxelSizeUm;
    $("voxelZ").value = formatUm(size.z);
    $("voxelY").value = formatUm(size.y);
    $("voxelX").value = formatUm(size.x);
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${stack.name} · ${stack.shape.join(" × ")} (z × y × x) · ${stack.dtype}`;
    $("dropZone").classList.add("has-files");
    if (!shown) $("emptyState").textContent = "Run the analysis to show the stack here.";
    progress.setProgress(0);
    const missing = [size.z, size.y, size.x].some((v) => v === null);
    status(missing ? `${stack.name} loaded · enter the voxel size` : `${stack.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

function formSettings() {
  return runSettings({
    voxelSizeUm: [$("voxelZ").value, $("voxelY").value, $("voxelX").value],
    orientation: $("orientation").value,
    register: $("register").checked,
    detect: $("detect").checked,
    detection: Object.fromEntries(Object.keys(DETECTION_FIELDS).map((id) => [id, $(id).value])),
  });
}

function revealField(field) {
  if (Object.hasOwn(DETECTION_FIELDS, field)) $("advancedSettings").open = true;
  const section = $(field)?.closest("details.nd-sidebar-section:not(#advancedSettings)");
  if (section) section.open = true;
  $(field)?.focus();
}

function runWorker(job, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(WorkerUrl, { type: "module" });
    const stop = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The analysis worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        progress.setProgress(data.fraction, data.message);
      } else if (data.type === "log") {
        log.log(data.message, "info", "technical");
      } else {
        stop();
        if (data.type === "error") reject(new Error(data.message));
        else resolve(data);
      }
    };
    worker.postMessage(job);
  });
}

async function analyse(signal, settings = formSettings()) {
  if (!input) throw new Error("Load a stack before running the analysis.");
  const operation = begin(`Analysing ${input.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    const steps = [settings.register && "atlas registration", settings.detect && "cell detection"].filter(Boolean).join(" and ");
    log.log(`${input.name}: ${steps}; voxel ${settings.voxelSizeUm.join(" × ")} µm (z × y × x), orientation ${settings.orientation}`, "info", "analysis");
    const started = performance.now();
    const result = await runWorker({ files: input.files, voxelSizeUm: settings.voxelSizeUm, orientation: settings.orientation, register: settings.register, detect: settings.detect, detectOptions: settings.detection }, current);
    current.throwIfAborted();
    const names = outputNames(input.name);
    const nifti = (bytes, name) => gzipFile(bytes, name, current);
    const csv = (bytes, name) => new File([bytes], name, { type: "text/csv" });
    const next = {};
    next.sample = { description: `Sample on the ${settings.register ? "atlas" : "display"} grid · ${result.gridShape.join(" × ")}`, file: await nifti(result.files.sample, names.sample) };
    if (result.files.labels) {
      next.labels = { description: "Allen atlas labels on the sample", file: await nifti(result.files.registeredAtlas, names.registeredAtlas), kind: "labels", colormap: result.labelColormap };
      next.labels.display = await nifti(result.files.labels, `display-${names.registeredAtlas}`);
    }
    if (result.files.marks) next.cells = { description: `Cell candidates · ${result.cellCount}`, file: csv(result.files.cells, names.cells), kind: "cells", marks: await nifti(result.files.marks, names.marks) };
    if (result.files.regions) next.regions = { description: `Regions · ${result.regionRows} rows`, file: csv(result.files.regions, names.regions), viewable: false };
    current.throwIfAborted();
    outputs = next;
    await show(next.sample, overlayOf(next.labels ? "labels" : next.cells ? "cells" : "sample"));
    results.render(next);
    $("outputSection").open = true;
    const seconds = (performance.now() - started) / 1000;
    if (settings.detect) log.log(`${result.cellCount} cell candidates${result.assignedCells !== null && result.assignedCells !== undefined ? `, ${result.assignedCells} inside atlas regions` : ""}`, "info", "analysis");
    if (result.matrix) log.log(`Affine (sample to atlas, RAS):\n${result.matrix.trim()}`, "info", "technical");
    const summary = settings.register ? `Registered to the Allen atlas${settings.detect ? ` · ${result.cellCount} cells` : ""}` : `${result.cellCount} cell candidates`;
    log.log(`${summary} in ${seconds.toFixed(0)} s`, "info", "analysis");
    progress.end(summary);
    status(summary);
    return {
      artifacts: Object.entries(next).map(([role, value]) => ({ role, file: value.file })),
      provenance: { ...settings, seconds: Number(seconds.toFixed(1)), cellCount: result.cellCount, gridShape: result.gridShape },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

function report(error) {
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
for (const id of FORM_IDS.slice(1)) $(id).addEventListener("change", () => {
  if (Object.keys(outputs).length) {
    clearOutputs();
    status("Settings changed · run again for new results");
  }
});

function applyExample(id) {
  const settings = EXAMPLE_SETTINGS[id];
  if (!settings) return;
  $("orientation").value = settings.orientation;
  $("register").checked = settings.register;
  $("detect").checked = settings.detect;
}

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message) => status(message, false, "technical"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
    applyExample(example.id);
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    if (error.field) revealField(error.field);
    report(error);
    return;
  }
  void analyse(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    "map-cells": async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      if (parameters.voxelSizeUm) [$("voxelZ").value, $("voxelY").value, $("voxelX").value] = parameters.voxelSizeUm.map(String);
      $("orientation").value = parameters.orientation ?? $("orientation").value;
      $("register").checked = parameters.register ?? true;
      $("detect").checked = parameters.detect ?? true;
      return analyse(signal, formSettings());
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs, shown: () => shown });
