// StarDist: 2D nucleus segmentation with the pretrained 2D_versatile_fluo model. The numerics
// live in src/stardist.js; src/worker.js runs them with ONNX Runtime Web, one worker per run.
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
import { createNiftiFromVolume, downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import workerUrl from "./worker.js?worker&url";
import { APP, MODEL } from "./config.js";
import { writeLabelTiff } from "@neurodesk/webapp-components/file-io/tiff";
import { readImage, nucleiCsv } from "./image-io.js";
import { automaticTiles } from "./stardist.js";
import { labelColormap, outputName, segmentationSettings } from "./settings.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Nucleus segmentation",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
let display = "filled";
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = SLICE_TYPE.AXIAL;
    viewer.isLegendVisible = false;
    // A microscopy image has no patient axes: no crosshair and no orientation letters.
    viewer.crosshairWidth = 0;
    viewer.isOrientationTextVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({
  views: [
    { id: "filled", label: "Filled", active: true },
    { id: "outlines", label: "Outlines" },
    { id: "image", label: "Image" },
  ],
  viewsLabel: "Labels",
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
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

// The loaded image ({ file, width, height, format, planes }), the abort controllers of a load or
// run in progress, and the last run's outputs.
let input = null;
let loading = null;
let running = null;
let outputs = {};
let opacity = 0.5;

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function plane() {
  return input.planes[Number($("channel").value) || 0];
}

// A 2D image as a one-slice NIfTI whose rows run down the screen, as in the source file.
function niftiFile(data, name) {
  const { width, height } = input;
  const affine = [[1, 0, 0, 0], [0, -1, 0, height - 1], [0, 0, 1, 0], [0, 0, 0, 1]];
  const buffer = createNiftiFromVolume({ dims: [width, height, 1], img: data, hdr: { dims: [3, width, height, 1, 1, 1, 1, 1], pixDims: [1, 1, 1, 1, 1, 1, 1, 1], affine } });
  return new File([buffer], name, { type: "application/octet-stream" });
}

function applyDisplay() {
  if (viewer.volumes.length < 2) return Promise.resolve();
  return viewer.setVolume(1, { opacity: display === "image" ? 0 : opacity, atlasOutline: display === "outlines" ? 1 : 0 });
}

let shown = Promise.resolve();
function show(labels) {
  shown = shown.catch(() => {}).then(async () => {
    await viewerReady();
    const volumes = [{ url: niftiFile(Float32Array.from(plane().data), "image.nii"), name: "image.nii", colormap: "gray" }];
    if (labels) volumes.push({ url: niftiFile(labels.data, "labels.nii"), name: "labels.nii", opacity });
    await viewer.loadVolumes(volumes);
    if (labels) {
      await viewer.setColormapLabel(1, labelColormap(labels.count));
      await applyDisplay();
    }
    $("emptyState").hidden = true;
  });
  return shown;
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  display = detail.value;
  void applyDisplay().catch(report);
});
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  opacity = detail.value;
  void applyDisplay().catch(report);
});

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (stage === "labels" && outputs.labels) void show(outputs.labels.view).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", "channel", "probThresh", "nmsThresh", "tiles", "resetSettings"]) $(id).disabled = busy;
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

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    if (files.length !== 1) throw new Error(`Choose one 2D image; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const image = await readImage(file.name, await file.arrayBuffer());
    current.throwIfAborted();
    input = { file, ...image };
    clearOutputs();
    $("channel").replaceChildren(...image.planes.map((item, index) => new Option(item.label, String(index))));
    $("channelField").hidden = image.planes.length < 2;
    await show(null);
    current.throwIfAborted();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${image.width} × ${image.height} · ${image.format}${image.planes.length > 1 ? ` · ${image.planes.length} channels` : ""}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

function segmentInWorker(job, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const stop = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The StarDist worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") progress.setProgress(data.value, data.message);
      else if (data.type === "log") log.log(data.message, "info", "technical");
      else {
        stop();
        if (data.type === "error") reject(new Error(data.message));
        else resolve(data);
      }
    };
    worker.postMessage(job);
  });
}

function formSettings() {
  return segmentationSettings({
    channel: Number($("channel").value || 0) + 1,
    probThresh: $("probThresh").valueAsNumber,
    nmsThresh: $("nmsThresh").valueAsNumber,
    tiles: Number($("tiles").value),
  }, MODEL);
}

function showSettings(settings) {
  $("probThresh").value = String(settings.probThresh);
  $("nmsThresh").value = String(settings.nmsThresh);
  $("tiles").value = String(settings.tiles);
  if (input && settings.channel > input.planes.length) throw new Error(`${input.file.name} has ${input.planes.length} channels; channel ${settings.channel} does not exist.`);
  $("channel").value = String(settings.channel - 1);
}

async function runSegmentation(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image before segmenting it.");
  const operation = begin(`Segmenting ${input.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    const source = plane();
    const nTiles = settings.tiles ? [settings.tiles, settings.tiles] : automaticTiles(input.height, input.width);
    log.log(`StarDist ${MODEL.name} on ${source.label} of ${input.file.name}: probability ${settings.probThresh}, overlap ${settings.nmsThresh}, ${nTiles.join(" × ")} tiles`, "info", "analysis");
    const result = await segmentInWorker({
      image: source.data,
      width: input.width,
      height: input.height,
      probThresh: settings.probThresh,
      nmsThresh: settings.nmsThresh,
      nTiles,
    }, current);
    current.throwIfAborted();
    log.log(`Normalized to the 1st and 99.8th percentiles: ${result.normalization.low} to ${result.normalization.high}`, "info", "analysis");
    const base = input.file.name.replace(/\.(ome\.)?(tiff?|png)$/i, "");
    const labelsFile = new File([writeLabelTiff(result.labels, input.width, input.height)], outputName(base, "labels.tif"), { type: "image/tiff" });
    const tableFile = new File([nucleiCsv(result.nuclei)], outputName(base, "nuclei.csv"), { type: "text/csv" });
    outputs = {
      labels: { description: `Nucleus labels · ${result.count} nuclei`, file: labelsFile, view: { data: result.labels, count: result.count } },
      table: { description: "Nucleus table · CSV", file: tableFile, viewable: false },
    };
    await show(outputs.labels.view);
    current.throwIfAborted();
    results.render(outputs);
    $("outputSection").open = true;
    const seconds = result.seconds.toFixed(1);
    log.log(`${result.count} nuclei from ${result.candidates} candidate polygons`, "info", "analysis");
    log.log(`Segmented in ${seconds} s`, "info", "technical");
    progress.end(`${result.count} nuclei segmented`);
    status(`${result.count} nuclei segmented`);
    return {
      artifacts: [{ role: "labels", file: labelsFile }, { role: "table", file: tableFile }],
      provenance: {
        method: "StarDist 2D",
        model: MODEL.name,
        modelSha256: MODEL.sha256,
        channel: source.label,
        ...settings,
        nTiles,
        normalization: { pmin: MODEL.normalization.pmin, pmax: MODEL.normalization.pmax, ...result.normalization },
        nuclei: result.count,
        seconds: Number(seconds),
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
$("channel").addEventListener("change", () => {
  clearOutputs();
  void show(null).catch(report);
});
$("resetSettings").onclick = () => {
  showSettings({ ...segmentationSettings({}, MODEL), channel: Number($("channel").value || 0) + 1 });
};
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
  void runSegmentation(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    segment: async ({ inputs, parameters, signal }) => {
      const settings = segmentationSettings(parameters, MODEL);
      await loadFiles(Promise.resolve(inputs.image), signal);
      showSettings(settings);
      return runSegmentation(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
