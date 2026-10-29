// ANTs DenoiseImage: adaptive non-local means denoising of one 3D MR image. The filter is
// @neurodesk/ants-denoise, the WebAssembly build BISON runs, in its own module worker.
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
import { createNiftiFromData, decodeNiftiBuffer, downloadFile } from "@neurodesk/webapp-components/file-io";
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { readBrainMask } from "@neurodesk/webapp-components/file-io/brain-mask";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import denoiseWorkerUrl from "@neurodesk/ants-denoise/worker?worker&url";
import { APP, denoiseSettings, denoisedName, provenance, volumeRefusal } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Adaptive non-local means denoising",
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
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const maskField = createFileField({ id: "maskInput", label: "Mask", kind: "image", text: "Drop a mask on the image grid" });
$("maskField").append(maskField);

// The loaded image ({ file, buffer, description }), its optional mask ({ file, data, voxels }),
// the abort controllers of a load or run in progress, and the last run's result rows.
let input = null;
let mask = null;
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const preview = createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState: $("emptyState") });
async function showVolume(volume, options) {
  await viewerReady();
  return preview(volume, options);
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    log.log(`Showing ${result.file.name}`, "info");
    void showVolume({ file: result.file }).catch((error) => status(error.message, true));
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
  for (const id of ["imageInput", "noiseModel", "patchRadius", "searchRadius", "clearMask"]) $(id).disabled = busy;
  maskField.disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function clearMask() {
  mask = null;
  maskField.setText("Drop a mask on the image grid");
  maskField.setHasFiles(false);
  $("clearMask").hidden = true;
  syncInputFiles("maskInput", []);
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
  status(message);
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
    await showVolume({ file }, { signal: current });
    current.throwIfAborted();
    input = { file, buffer, description };
    clearMask();
    clearOutputs();
    syncInputFiles("imageInput", files);
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

async function loadMask(filesPromise, signal) {
  if (!input) throw new Error("Load the image before its mask.");
  const operation = begin("Reading mask…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const images = await readImageFiles(await filesPromise, { signal: current });
    if (images.length !== 1) throw new Error("Choose one NIfTI mask.");
    const [file] = images;
    const data = await readBrainMask(await file.arrayBuffer(), input.buffer, { name: file.name, grid: "image", signal: current });
    current.throwIfAborted();
    const voxels = data.reduce((sum, value) => sum + value, 0);
    if (!voxels) throw new Error(`${file.name} has no nonzero voxels.`);
    mask = { file, data, voxels };
    clearOutputs();
    maskField.setText(`${file.name} · ${voxels} voxels`);
    maskField.setHasFiles(true);
    $("clearMask").hidden = false;
    syncInputFiles("maskInput", [file]);
    progress.setProgress(0);
    status(`Only the ${voxels} voxels of ${file.name} will be denoised`);
  } finally {
    loading = null;
    finish(operation);
  }
}

/** DenoiseImage in a new module worker of @neurodesk/ants-denoise; aborting terminates it, freeing its heap. */
function denoiseInWorker(message, transfer, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(denoiseWorkerUrl, { type: "module" });
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
      reject(new Error(event.message || "The denoise worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      stop();
      for (const line of data.log ?? []) log.log(line, "info");
      if (data.heapBytes) log.log(`DenoiseImage module heap: ${Math.round(data.heapBytes / 2 ** 20)} MB`, "info");
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.output);
    };
    worker.postMessage({ id: 1, ...message }, transfer);
  });
}

function formSettings() {
  return denoiseSettings({
    noiseModel: $("noiseModel").value,
    patchRadius: $("patchRadius").valueAsNumber,
    searchRadius: $("searchRadius").valueAsNumber,
  });
}

function showSettings(settings) {
  $("noiseModel").value = settings.noiseModel;
  $("patchRadius").value = String(settings.patchRadius);
  $("searchRadius").value = String(settings.searchRadius);
}

async function denoise(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image before denoising it.");
  const operation = begin(`Denoising ${input.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutputs();
  try {
    const where = mask ? `the ${mask.voxels} mask voxels` : "the whole image";
    log.log(`DenoiseImage on ${where}: ${settings.noiseModel} noise, patch radius ${settings.patchRadius}, search radius ${settings.searchRadius}`, "info");
    const started = performance.now();
    const image = input.buffer.slice(0);
    const maskImage = mask ? createNiftiFromData(mask.data, input.buffer, { dims: input.description.dims }) : null;
    const output = await denoiseInWorker({ image, mask: maskImage, ...settings }, maskImage ? [image, maskImage] : [image], current);
    const seconds = (performance.now() - started) / 1000;
    const file = await gzipFile(output, denoisedName(input.file.name), current);
    await showVolume({ file }, { signal: current });
    current.throwIfAborted();
    const runProvenance = provenance({ input: input.file.name, settings, mask: mask && { name: mask.file.name, voxels: mask.voxels } });
    outputs = { image: { description: `Denoised image · ${settings.noiseModel}, patch ${settings.patchRadius}, search ${settings.searchRadius}`, file } };
    // The input leads the list, so the viewer can go back to the image before denoising.
    results.render({ input: { description: "Input image", file: input.file }, ...outputs });
    $("outputSection").open = true;
    log.log(`Denoised in ${seconds.toFixed(1)} s. Native equivalent: ${runProvenance.nativeCommand}`, "info");
    progress.end("Image denoised");
    status("Image denoised");
    return { artifacts: [{ role: "image", file }], provenance: { ...runProvenance, seconds: Number(seconds.toFixed(1)) } };
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
maskField.onFiles((files) => {
  void loadMask(files).catch((error) => {
    syncInputFiles("maskInput", mask ? [mask.file] : []);
    report(error);
  });
});
$("clearMask").onclick = () => {
  clearMask();
  clearOutputs();
  status("The whole image will be denoised");
};
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

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    $("advancedSettings").open = true;
    report(error);
    return;
  }
  void denoise(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    denoise: async ({ inputs, inputDetails, parameters, signal }) => {
      const settings = denoiseSettings(parameters);
      await loadFiles(Promise.resolve(imageFiles(inputs, inputDetails)), signal);
      if (inputs.mask?.length) await loadMask(Promise.resolve(inputs.mask), signal);
      showSettings(settings);
      return denoise(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
