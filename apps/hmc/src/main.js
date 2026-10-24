import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import { createResultList, createFileField, createInfoDialog, createConsole, createViewerToolbar, createExampleSelector, bindInfoTooltips, ProgressManager } from "@neurodesk/webapp-components/ui";
import { downloadFile, decodeNiftiBuffer, createNiftiFromData } from "@neurodesk/webapp-components/file-io";
import { readBrainMask } from "@neurodesk/webapp-components/file-io/brain-mask";
import { bidsDiffusionSeries, chooseBidsRun, chosenBidsRun } from "@neurodesk/webapp-components/file-io/bids";
import { meanVolumes } from "@neurodesk/webapp-components/volume/mean";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { brainMask, mindgrab } from "@neurodesk/runtime-support/mindgrab";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { readSeries } from "@neurodesk/hmc";
import { correctNiFreeze } from "@neurodesk/hmc/nifreeze";
import { browserRuntime, loadHmcBrowser } from "@neurodesk/hmc/browser";
import wasmUrl from "@neurodesk/hmc/hmc.wasm?url";
import registrationWorker from "@neurodesk/hmc-registration/worker?worker&url";
import { zipSync } from "fflate";
import examples from "../examples.json";

const $ = id => document.getElementById(id);
mountImagingWorkspace({ controls: "#controls", viewer: "#viewer", status: "#status", title: "HMC", controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" } });
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open("About HMC", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
const viewer = new NiiVue({ isDragDropEnabled: false });
const viewerReady = viewer.attachTo("gl1");
const views = { multiplanar: SLICE_TYPE.MULTIPLANAR, axial: SLICE_TYPE.AXIAL, sagittal: SLICE_TYPE.SAGITTAL, coronal: SLICE_TYPE.CORONAL, render: SLICE_TYPE.RENDER };
toolbar.addEventListener("nd-view-change", ({ detail }) => { viewer.sliceType = views[detail.value] ?? SLICE_TYPE.MULTIPLANAR; });
const api = loadHmcBrowser(wasmUrl);
api.catch(error => status(error.message, true));
let input = null;
let folder = null;
let mask = null;
let active = null;
let imports = Promise.resolve();
let importGeneration = 0;
const maskField = createFileField({ id: "maskInput", label: "Brain mask (optional)", kind: "image", text: "Drop a brain mask" });
$("maskField").append(maskField);
const results = createResultList({ element: $("resultList"), onView: (_stage, row) => { void show(row.file).catch(report); }, onDownload: (_stage, row) => downloadFile(row.file) });
bindInfoTooltips(document);

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function clearMask() {
  mask = null;
  $("maskInput").value = "";
  maskField.setText("Drop a brain mask");
  maskField.setHasFiles(false);
  $("clearMask").hidden = true;
  syncInputFiles("maskInput", []);
}

function queueImport(callback) {
  const generation = importGeneration;
  const next = imports.then(() => {
    if (generation !== importGeneration) throw new DOMException("Loading cancelled", "AbortError");
    return callback();
  });
  imports = next.catch(() => {});
  return next;
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function report(error) {
  progress.reset();
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

async function show(file) {
  await viewerReady;
  const url = URL.createObjectURL(file);
  try {
    await viewer.loadVolumes([{ url, name: file.name }]);
    $("emptyState").hidden = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function busy(value) {
  for (const id of ["imageInput", "method", "seed", "workers", "clearMask", "runSelect"]) $(id).disabled = value;
  maskField.disabled = value;
  exampleControl.setDisabled(value);
  $("runButton").disabled = value || !input;
  const undo = document.querySelector(".nd-status-undo");
  if (undo) undo.disabled = value;
}

async function operation(message, signal, callback) {
  if (active) throw new Error("Wait for the current operation or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  active = controller;
  busy(true);
  progress.begin(message);
  progress.setCancellable(true);
  try {
    return await callback(controller.signal);
  } finally {
    signal?.removeEventListener("abort", abort);
    active = null;
    busy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

async function load(files, signal, runIndex) {
  return operation("Reading diffusion image…", signal, async current => {
    const runs = await bidsDiffusionSeries(files, { require: [".bval", ".bvec"] });
    const index = runs ? (runIndex ?? chosenBidsRun(runs)) : 0;
    const series = runs ? [runs[index]] : await readDiffusionSeries(files, { signal: current, anonymizeSidecar: true });
    current.throwIfAborted();
    if (series.length !== 1) throw new Error("Choose one diffusion image and its gradients.");
    const [{ image, bval, bvec, sidecar }] = series;
    if (!bval || !bvec) throw new Error("Choose both bval and bvec files with the diffusion image.");
    const buffer = await decodeNiftiBuffer(await image.arrayBuffer());
    const decoded = await readSeries(buffer);
    const gradients = parseBvalBvec(await bval.text(), await bvec.text());
    if (gradients.bvals.length !== decoded.frames) throw new Error("The gradients must list every image volume.");
    await show(image);
    current.throwIfAborted();
    input = { sourceFiles: files, fileName: image.name, buffer, series: decoded, ...gradients, sidecar };
    clearMask();
    syncInputFiles("imageInput", files);
    folder = runs ? { files, runs, index } : null;
    if (runs) chooseBidsRun(runs, index);
    $("runField").hidden = !runs || runs.length < 2;
    $("runSelect").replaceChildren(...(runs ?? []).map((run, i) => new Option(run.image.name, String(i), false, i === index)));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${image.name} · ${decoded.dims.join("×")}×${decoded.frames}`;
    results.render();
    $("outputSection").open = false;
    progress.end("Diffusion image loaded");
  }).catch(error => {
    syncInputFiles("imageInput", input?.sourceFiles ?? []);
    throw error;
  });
}

async function run(signal, parameters = {}) {
  if (!input) throw new Error("Load diffusion data first.");
  const model = parameters.method ?? $("method").value;
  const seed = Number(parameters.seed ?? $("seed").value);
  const workers = Number(parameters.workers ?? $("workers").value);
  if (!["gp", "trivial"].includes(model)) throw new Error("Choose GP or the mean b0 template.");
  if (!Number.isInteger(seed) || seed < 1 || seed > 2147483647) throw new Error("Seed must be an integer from 1 to 2147483647.");
  if (!Number.isInteger(workers) || workers < 1 || workers > 4) throw new Error("Choose 1 to 4 registration workers.");
  return operation("Correcting head motion…", signal, async current => {
    const hmc = await api;
    let brain = mask?.data;
    let maskProvenance = { Source: "supplied" };
    if (!brain) {
      status("Extracting the brain from the mean b0");
      const b0 = hmc.b0Flags("nifreeze", input.bvals, input.bvecs).flatMap((value, v) => value ? [v] : []);
      if (!b0.length) throw new Error("The gradient table has no b0 volume.");
      const voxels = input.series.dims.reduce((a, b) => a * b, 1);
      const mean = meanVolumes(input.series.data, voxels, b0);
      const image = new Uint8Array(createNiftiFromData(mean, input.buffer, { dims: input.series.dims }));
      const extracted = await brainMask(image, { assetPath: `${import.meta.env.BASE_URL}mindgrab/`, backend: "cpu", signal: current });
      brain = await readBrainMask(extracted.mask, input.buffer, { signal: current });
      maskProvenance = { Source: "mindgrab", Model: "mindgrab", Version: mindgrab.version, Backend: extracted.backend };
    }
    if (!brain.some(Boolean)) throw new Error("The brain mask is empty.");
    const runtime = browserRuntime({ workerUrl: registrationWorker, workers });
    const series = { ...input.series, data: input.series.data.slice() };
    const corrected = await correctNiFreeze({ ...input, series, mask: brain, maskProvenance, hmc, runtime, model, seed, signal: current,
      onProgress: ({ stage, done, total }) => progress.setProgress(total ? done / total : 0, `${stage}: ${done}/${total}`),
    });
    const rows = {};
    const artifacts = [];
    for (const role of ["image", "bval", "bvec", "motion", "sidecar"]) {
      const name = corrected.names[role];
      const file = new File([corrected.files[name]], name);
      rows[role] = { description: role === "image" ? "Corrected diffusion image" : role, file, viewable: role === "image" };
      artifacts.push({ role, file });
    }
    const transforms = Object.fromEntries(Object.entries(corrected.files).filter(([name]) => name.endsWith(".mat")));
    const file = new File([zipSync(transforms)], "transforms.zip", { type: "application/zip" });
    rows.transforms = { description: "ITK transforms", file, viewable: false };
    artifacts.push({ role: "transforms", file });
    await show(rows.image.file);
    current.throwIfAborted();
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Head motion corrected");
    return { artifacts, provenance: { method: model, seed, workers, visitOrder: corrected.visitOrder, registration: "ANTs --float 1", b0: "unchanged" } };
  });
}

const exampleControl = createExampleSelector({ examples, onStatus: status, onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
  const files = await fetchFiles();
  assertCurrent();
  await queueImport(() => load(files, signal));
  assertCurrent();
} });
$("exampleControl").append(exampleControl);
$("imageInput").addEventListener("change", event => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  exampleControl.cancel();
  if (files.length) void queueImport(() => load(files)).catch(report);
});
async function loadMask(selected, signal) {
  return operation("Reading brain mask…", signal, async current => {
    if (!input) throw new Error("Load diffusion data before its mask.");
    const images = await readImageFiles(selected, { signal: current });
    if (images.length !== 1) throw new Error("Choose one NIfTI mask or one DICOM mask series.");
    const [file] = images;
    const brain = await readBrainMask(await file.arrayBuffer(), input.buffer, { grid: "DWI", signal: current });
    current.throwIfAborted();
    mask = { data: brain, file };
    maskField.setText(file.name);
    maskField.setHasFiles(true);
    $("clearMask").hidden = false;
    syncInputFiles("maskInput", [file]);
    progress.end("Brain mask loaded");
  });
}

maskField.onFiles(async files => {
  try {
    await queueImport(async () => loadMask(await files));
  } catch (error) {
    if (error.name === "AbortError") syncInputFiles("maskInput", mask ? [mask.file] : []);
    else clearMask();
    report(error);
  }
});
$("clearMask").onclick = () => {
  clearMask();
  status("Using automatic brain mask");
};
$("runSelect").addEventListener("change", () => {
  if (!folder) return;
  const previous = folder;
  const previousInput = input;
  const index = Number($("runSelect").value);
  void queueImport(() => load(previous.files, undefined, index)).catch(error => {
    if (folder === previous && input === previousInput) $("runSelect").value = String(previous.index);
    report(error);
  });
});
$("runButton").onclick = () => { void run().catch(report); };
$("cancelButton").onclick = () => {
  importGeneration++;
  exampleControl.cancel();
  active?.abort();
  syncInputFiles("imageInput", input?.sourceFiles ?? []);
  syncInputFiles("maskInput", mask ? [mask.file] : []);
};
registerAppAutomation({ app: "hmc", convertDicom: runDcm2niix, operations: { correct: async ({ inputs, inputDetails, parameters, signal }) => {
  await queueImport(() => load(imageFiles(inputs, inputDetails), signal));
  if (inputs.mask?.[0]) await queueImport(() => loadMask(inputs.mask, signal));
  return run(signal, parameters);
} } });
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  active?.abort();
});
