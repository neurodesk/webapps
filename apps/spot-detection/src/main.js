// Spot detection: Big-FISH's LoG spot detector with its automatic elbow threshold and
// Gaussian sub-pixel fit, on one smFISH TIFF stack, with optional per-cell counts.
// The numerics (src/bigfish.js, src/subpixel.js) run in a worker, one per run.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createNiivueVolumePreview,
  createFileField,
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
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readImageStack } from "./image-stack.js";
import { APP, DEFAULTS, checkRun, describeImage, detectionSettings, formatThreshold, outputNames, provenance, voxelFromFile } from "./config.js";
import { niftiFile, overlayVolume } from "./volumes.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "smFISH spot detection (Big-FISH)",
  controlsContract: { privacy: "#privacyBtn" },
});

const SLICE_TYPES = { axial: SLICE_TYPE.AXIAL, coronal: SLICE_TYPE.CORONAL, sagittal: SLICE_TYPE.SAGITTAL, multiplanar: SLICE_TYPE.MULTIPLANAR };
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.AXIAL;
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = layout;
    viewer.isLegendVisible = false;
    // Anatomical letters (A, L) mean nothing on a microscope stack.
    viewer.isOrientationTextVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({
  views: [
    { id: "axial", label: "XY", active: true },
    { id: "coronal", label: "XZ" },
    { id: "sagittal", label: "YZ" },
    { id: "multiplanar", label: "3-Plane" },
  ],
  window: false,
  overlay: false,
  colormap: false,
  download: false,
  screenshot: false,
});
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.AXIAL;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true, channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }] });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const labelField = createFileField({ id: "labelInput", label: "Cell labels", kind: "mask", text: "Drop a label TIFF on the image grid" });
$("labelField").append(labelField);

// The loaded image ({ name, image, file, display }), its optional cell labels ({ name, image }),
// the abort controllers of a load or run in progress, and the last run's result rows.
let input = null;
let labels = null;
let loading = null;
let running = null;
let outputs = {};

function status(message, { error = false, channel = "technical" } = {}) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

const preview = createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState: $("emptyState") });
async function showVolume(volume, options) {
  await viewerReady();
  return preview(volume, options);
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    void showResult(stage).catch((error) => status(error.message, { error: true }));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

async function showResult(stage) {
  if (!input) return;
  if (stage === "input" || !outputs.overlay) {
    log.log(`Showing ${input.name}`, "info", "technical");
    return showVolume({ file: input.display });
  }
  log.log(`Showing ${outputs.overlay.base.name} with the detected spots`, "info", "technical");
  return showVolume({ file: outputs.overlay.base, overlay: { file: outputs.overlay.file, range: [0.5, 1] } });
}

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", "voxelZ", "voxelYx", "radiusZ", "radiusYx", "detectIn", "threshold", "subpixel", "clearLabels"]) $(id).disabled = busy;
  if (!busy) $("detectIn").disabled = !input || input.image.shape.length !== 3;
  labelField.disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function clearLabels() {
  labels = null;
  labelField.setText("Drop a label TIFF on the image grid");
  labelField.setHasFiles(false);
  $("clearLabels").hidden = true;
  syncInputFiles("labelInput", []);
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(true);
  progress.begin(message);
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

async function readTiffFiles(files, signal, what) {
  if (files.length !== 1) throw new Error(`Choose one ${what} TIFF; this selection has ${files.length} files.`);
  const [file] = files;
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (!/\.tiff?$/i.test(file.name)) throw new Error(`${file.name} is not a TIFF (.tif or .tiff).`);
  const image = await readImageStack(await file.arrayBuffer(), { signal });
  signal.throwIfAborted();
  return { file, image };
}

function showVoxelSize(voxelSize) {
  const fromFile = voxelFromFile(voxelSize);
  if (fromFile.voxelZ !== undefined) $("voxelZ").value = String(fromFile.voxelZ);
  if (fromFile.voxelYx !== undefined) $("voxelYx").value = String(fromFile.voxelYx);
  return Object.keys(fromFile).length > 0;
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    const { file, image } = await readTiffFiles(files, current, "image");
    if (image.shape.length === 3 && image.shape[0] < 2) throw new Error(`${file.name} has one plane; it is read as a 2D image.`);
    const fromFile = showVoxelSize(image.voxelSize);
    const settings = detectionSettings(formParameters());
    const display = niftiFile(image, settings.voxelSize.slice(-3), `${file.name}.nii`);
    await showVolume({ file: display }, { signal: current });
    current.throwIfAborted();
    input = { name: file.name, file, image, display };
    clearLabels();
    clearOutputs();
    syncInputFiles("imageInput", files);
    $("detectIn").value = image.shape.length === 3 ? "stack" : "image";
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = describeImage(file.name, image.shape, image.dtype);
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    log.log(`${describeImage(file.name, image.shape, image.dtype)}; voxel size ${fromFile ? "from the file" : "from the form"}`, "info", "analysis");
    status(`${file.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

async function loadLabels(filesPromise, signal) {
  if (!input) throw new Error("Load the image before its cell labels.");
  const operation = begin("Reading cell labels…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const { file, image } = await readTiffFiles(await filesPromise, current, "label");
    if (image.dtype !== "uint8" && image.dtype !== "uint16") throw new Error(`${file.name} is ${image.dtype}; cell labels must be uint8 or uint16 integers.`);
    const shape = input.image.shape;
    const fits = image.shape.length === shape.length ? image.shape.every((n, a) => n === shape[a]) : image.shape.length === 2 && image.shape.every((n, a) => n === shape.at(a - 2));
    if (!fits) throw new Error(`${file.name} is ${image.shape.join(" × ")}; it must match the image (${shape.join(" × ")}) or its y × x plane.`);
    const cells = new Set(image.data).size - (image.data.includes(0) ? 1 : 0);
    if (!cells) throw new Error(`${file.name} has no nonzero labels.`);
    labels = { name: file.name, file, image, cells };
    clearOutputs();
    labelField.setText(`${file.name} · ${plural(cells, "cell")}`);
    labelField.setHasFiles(true);
    $("clearLabels").hidden = false;
    syncInputFiles("labelInput", [file]);
    progress.setProgress(0);
    status(`Spots will be counted in the ${plural(cells, "cell")} of ${file.name}`);
  } finally {
    loading = null;
    finish(operation);
  }
}

function analyseInWorker(message, signal) {
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
      reject(new Error(event.message || "The detection worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress) {
        progress.setProgress(data.progress.fraction, `${data.progress.stage}…`);
        return;
      }
      stop();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.postMessage(message);
  });
}

function formParameters() {
  return {
    voxelZ: $("voxelZ").value,
    voxelYx: $("voxelYx").value,
    radiusZ: $("radiusZ").value,
    radiusYx: $("radiusYx").value,
    threshold: $("threshold").value,
    projection: $("detectIn").value === "projection",
    subpixel: $("subpixel").checked,
  };
}

function showSettings(settings) {
  $("voxelZ").value = String(settings.voxelSize[0]);
  $("voxelYx").value = String(settings.voxelSize[2]);
  $("radiusZ").value = String(settings.spotRadius[0]);
  $("radiusYx").value = String(settings.spotRadius[2]);
  $("threshold").value = settings.threshold === null ? "" : String(settings.threshold);
  if (input?.image.shape.length === 3) $("detectIn").value = settings.projection ? "projection" : "stack";
  $("subpixel").checked = settings.subpixel;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function textFile(text, name) {
  return new File([text], name, { type: "text/csv" });
}

async function detect(signal, settings = detectionSettings(formParameters())) {
  if (!input) throw new Error("Load an image before detecting spots.");
  checkRun(input.image, settings, labels?.image);
  const operation = begin(`Detecting spots in ${input.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutputs();
  try {
    const ndim = settings.projection && input.image.shape.length === 3 ? 2 : input.image.shape.length;
    log.log(`${input.name}: voxel size ${settings.voxelSize.slice(-ndim).join(" × ")} nm, spot radius ${settings.spotRadius.slice(-ndim).join(" × ")} nm, ${ndim === 3 ? "3D stack" : settings.projection ? "2D maximum projection" : "2D image"}`, "info", "analysis");
    const started = performance.now();
    const image = { data: input.image.data, shape: input.image.shape, dtype: input.image.dtype };
    const result = await analyseInWorker({ image, settings, labels: labels && labels.image }, current);
    const seconds = (performance.now() - started) / 1000;
    const names = outputNames(input.name, ndim === 2 && input.image.shape.length === 3);
    const voxel = [settings.voxelSize[0], settings.voxelSize[1], settings.voxelSize[2]];
    const base = niftiFile(result.image, voxel, ndim === input.image.shape.length ? `${input.name}.nii` : `${input.name}_mip.nii`);
    const marks = overlayVolume(result.image.shape, result.spots);
    const overlay = await gzipFile(await niftiFile(marks, voxel, names.overlay).arrayBuffer(), names.overlay, current);
    current.throwIfAborted();
    const spotsFile = textFile(result.spotsCsv, names.spots);
    const sigma = result.sigma.map((s) => s.toFixed(3)).join(" × ");
    log.log(`LoG sigma ${sigma} px${result.curve ? `; ${result.curve.thresholds.length} candidate thresholds` : ""}`, "info", "technical");
    log.log(`Threshold ${formatThreshold(result.threshold)}${settings.threshold === null ? " (automatic, elbow of the spot count curve)" : " (set by hand)"}; ${result.spots.length} spots`, "info", "analysis");
    outputs = {
      spots: { description: `Spots · ${result.spots.length} at threshold ${formatThreshold(result.threshold)}`, file: spotsFile },
      overlay: { description: "Spot overlay (NIfTI)", file: overlay, base },
    };
    if (result.cells) {
      const cellsFile = textFile(result.cellsCsv, names.cells);
      outputs.cells = { description: `Cell counts · ${plural(result.cells.cells.length, "cell")}`, file: cellsFile };
      for (const cell of result.cells.cells) log.log(`Cell ${cell.id}: ${cell.spots} spots (${cell.area} px)`, "info", "analysis");
      log.log(`${result.cells.outside} spots outside every cell`, "info", "analysis");
    }
    await showResult("overlay");
    current.throwIfAborted();
    results.render({ input: { description: "Input image", file: input.file }, ...outputs });
    $("outputSection").open = true;
    log.log(`Detected in ${seconds.toFixed(1)} s`, "info", "technical");
    progress.end(`${result.spots.length} spots detected`);
    status(`${result.spots.length} spots detected`, { channel: "analysis" });
    const artifacts = [{ role: "spots", file: spotsFile }, { role: "overlay", file: overlay }];
    if (outputs.cells) artifacts.push({ role: "cells", file: outputs.cells.file });
    return { artifacts, provenance: { ...provenance({ input: input.name, labels: labels?.name, settings, result }), seconds: Number(seconds.toFixed(1)) } };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

function report(error) {
  const cancelled = error?.name === "AbortError";
  status(cancelled ? "Cancelled" : error.message, { error: !cancelled });
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
labelField.onFiles((files) => {
  void loadLabels(files).catch((error) => {
    syncInputFiles("labelInput", labels ? [labels.file] : []);
    report(error);
  });
});
$("clearLabels").onclick = () => {
  clearLabels();
  clearOutputs();
  status("Spots will not be counted per cell");
};
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    const role = (name) => example.files.findIndex((file) => file.role === name);
    showSettings(detectionSettings(example.parameters ?? DEFAULTS));
    await loadFiles(Promise.resolve([files[role("image")]]), signal);
    assertCurrent();
    if (role("labels") >= 0) {
      await loadLabels(Promise.resolve([files[role("labels")]]), signal);
      $("labelSection").open = true;
    }
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = detectionSettings(formParameters());
  } catch (error) {
    $("advancedSettings").open = true;
    report(error);
    return;
  }
  void detect(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    "detect-spots": async ({ inputs, parameters, signal }) => {
      detectionSettings(parameters);
      await loadFiles(Promise.resolve(inputs.image), signal);
      if (inputs.labels?.length) await loadLabels(Promise.resolve(inputs.labels), signal);
      // A voxel size the parameters leave out comes from the TIFF's metadata, as in the form.
      const given = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value != null));
      const settings = detectionSettings({ ...DEFAULTS, ...voxelFromFile(input.image.voxelSize), ...given });
      showSettings(settings);
      return detect(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
