// BrainQCNet: every slice of a T1-weighted image classified for artifacts by
// @neurodesk/brainqcnet, with ONNX Runtime Web in a worker, one worker per run.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createPreviewQueue,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { createNiftiFromData, decodeNiftiBuffer, downloadFile } from "@neurodesk/webapp-components/file-io";
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { flaggedSliceMap } from "@neurodesk/brainqcnet";
import { APP, mapName, qualitySettings, reportFiles, verdictRows, verdictStatus, volumeRefusal } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Artifact detection on T1-weighted MRI",
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
let overlayOpacity = 0.4;
let attached = null;
// The viewer attaches to its canvas with the first image, so an empty canvas shows only #emptyState.
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
const toolbar = createViewerToolbar({ window: false, overlay: true, colormap: false, download: false, screenshot: false });
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (attached && viewer.volumes.length > 1) void viewer.setVolume(1, { opacity: overlayOpacity });
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

// The loaded image ({ file, buffer }), the abort controllers of a load or run in progress,
// and the last run's result rows.
let input = null;
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

// The T1 and, once a run has finished, the flagged-slice map over it (1-3 flagged slices, 0 transparent).
const show = createPreviewQueue({
  ready: Promise.resolve(),
  render: async (scene) => {
    await viewerReady();
    if (!scene) {
      await viewer.removeAllVolumes();
    } else {
      const layers = [{ url: scene.image, name: scene.image.name, colormap: "gray" }];
      if (scene.map) {
        layers.push({ url: scene.map, name: scene.map.name, colormap: "warm", calMin: 0.5, calMax: 3, isTransparentBelowCalMin: true, opacity: overlayOpacity });
      }
      await viewer.loadVolumes(layers);
    }
    $("emptyState").hidden = Boolean(scene);
  },
});

const results = createResultList({
  element: $("resultList"),
  onView: (stage, result) => {
    log.log(`Showing ${result.file.name}`, "info", "analysis");
    const scene = { image: input.file, map: stage === "map" ? result.file : null };
    void show(scene).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function renderVerdict(summary) {
  const body = $("verdict").tBodies[0];
  body.replaceChildren(...(summary ? verdictRows(summary) : []).map(({ label, value, flag }) => {
    const row = document.createElement("tr");
    if (flag) row.dataset.flag = "";
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = label;
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(name, cell);
    return row;
  }));
  $("verdict").hidden = !summary;
}

function clearOutputs() {
  outputs = {};
  results.render();
  renderVerdict(null);
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", "method", "areas", "backend"]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

// One load or run at a time: `begin` claims the slot, links the caller's signal and shows the
// status; `finish` releases it whatever happened.
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

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    const images = await readImageFiles(files, { signal: current });
    current.throwIfAborted();
    if (images.length !== 1) throw new Error(`Choose one NIfTI image or one DICOM series; this selection has ${images.length}.`);
    const [file] = images;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const description = await describeNiftiFile(file);
    const refusal = volumeRefusal(description);
    if (refusal) throw new Error(refusal);
    const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
    current.throwIfAborted();
    await show({ image: file, map: null }, { signal: current });
    current.throwIfAborted();
    input = { file, buffer };
    clearOutputs();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${description.dims.join(" × ")} · ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

async function resolveBackend(requested) {
  if (requested !== "auto") return requested;
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  return adapter ? "webgpu" : "wasm";
}

/** One worker per run; aborting terminates it, which frees the model and its heap. */
function classifyInWorker(job, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
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
      reject(new Error(event.message || "The BrainQCNet worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        progress.setProgress(data.value, data.message);
      } else if (data.type === "log") {
        log.log(data.message, "info", "technical");
      } else if (data.type === "error") {
        stop();
        reject(new Error(data.message));
      } else if (data.type === "result") {
        stop();
        resolve(data);
      }
    };
    worker.postMessage(job, [job.bytes]);
  });
}

function textFile(name, text) {
  return new File([text], name, { type: "text/csv" });
}

function formSettings() {
  return qualitySettings({
    method: $("method").value,
    areas: $("areas").valueAsNumber,
    backend: $("backend").value,
  });
}

function showSettings(settings) {
  $("method").value = settings.method;
  $("areas").value = String(settings.areas);
  $("backend").value = settings.backend === "webgpu" ? "auto" : settings.backend;
}

async function checkQuality(signal, settings = formSettings()) {
  if (!input) throw new Error("Load a T1-weighted image before checking it.");
  const operation = begin(`Checking ${input.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutputs();
  try {
    const backend = await resolveBackend(settings.backend);
    current.throwIfAborted();
    log.log(`BrainQCNet, ${settings.method} method, ${settings.areas} areas per axis`, "info", "analysis");
    const result = await classifyInWorker({ bytes: input.buffer.slice(0), backend, method: settings.method, areas: settings.areas }, current);
    const { summary } = result;
    const tables = reportFiles(input.file.name, summary, result.seconds);
    const map = flaggedSliceMap(result.dims, result.crop, result.predictions);
    const mapFile = await gzipFile(createNiftiFromData(map, input.buffer), mapName(input.file.name), current);
    await show({ image: input.file, map: mapFile }, { signal: current });
    current.throwIfAborted();
    outputs = { map: { description: "Flagged-slice map · 0–3 per voxel", file: mapFile } };
    for (const [role, { name, label, text }] of Object.entries(tables)) {
      outputs[role] = { description: label, file: textFile(name, text), viewable: false };
    }
    // The input leads the list, so the viewer can go back to the image without the map.
    results.render({ input: { description: "T1-weighted image", file: input.file }, ...outputs });
    renderVerdict(summary);
    $("outputSection").open = true;
    log.log(`Classified ${result.predictions.length} slices in ${result.seconds.toFixed(1)} s on ${result.backend === "wasm" ? "WebAssembly" : "WebGPU"}`, "info", "technical");
    const message = verdictStatus(summary);
    progress.end(message);
    status(message);
    return {
      artifacts: Object.entries(outputs).map(([role, { file }]) => ({ role, file })),
      measurements: {
        proba: summary.proba,
        pred: summary.pred,
        axes: Object.fromEntries(["x", "y", "z"].map((axis) => [axis, { proba: summary.axes[axis].proba, pred: summary.axes[axis].pred }])),
      },
      provenance: {
        method: "BrainQCNet (Garcia, Dosenbach & Kelly 2024), ResNet152 ProtoPNet",
        settings: { method: settings.method, areas: settings.areas },
        backend: result.backend,
        slices: result.predictions.length,
        seconds: Number(result.seconds.toFixed(1)),
      },
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
const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    $("advancedSettings").open = true;
    report(error);
    return;
  }
  void checkQuality(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    "check-quality": async ({ inputs, inputDetails, parameters, signal }) => {
      const settings = qualitySettings(parameters);
      exampleControl.cancel();
      await loadFiles(Promise.resolve(imageFiles(inputs, inputDetails)), signal);
      showSettings(settings);
      return checkQuality(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
