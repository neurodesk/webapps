// Deconvolution: Richardson-Lucy (optionally with total-variation regularisation) of one
// widefield or confocal stack, with a Gibson-Lanni or measured PSF. The numerics are the
// @neurodesk/deconvolution WebAssembly module, run in a module worker per step.
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
import { createFloat32Nifti, createNiftiFromVolume, downloadFile } from "@neurodesk/webapp-components/file-io";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { writeImageJTiff } from "@neurodesk/microscopy-tiff";
import { autoPsfSize, memoryPlan, normaliseSum, opticsSettings, prepareImage, prepareMeasuredPsf, runSettings, MAX_PSF_SIDE, METHODS } from "@neurodesk/deconvolution";
import workerUrl from "@neurodesk/deconvolution/worker?worker&url";
import { APP, DEFAULT_OPTICS, EXAMPLE_OPTICS, niftiGeometry, outputNames, provenance, spacingComplete } from "./config.js";
import { readVolume } from "./input.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Richardson-Lucy deconvolution of microscopy stacks",
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

const PSF_FIELD_TEXT = "Drop a measured PSF stack";
const psfField = createFileField({ id: "psfInput", label: "Measured PSF", kind: "model", text: PSF_FIELD_TEXT, multiple: false });
$("psfField").append(psfField);

// The loaded stack ({ name, file, format, dims, data, spacingUm, niftiHeader, view }), an
// optional measured PSF ({ file, data, dims, spacingUm }), the abort controllers of a load or
// run in progress, and the last run's result rows.
let input = null;
let measured = null;
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const preview = createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState: $("emptyState") });
async function show(file, options) {
  await viewerReady();
  return preview({ file }, options);
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    log.log(`Showing ${result.view.name}`, "info");
    void show(result.view).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

const FORM_IDS = ["imageInput", "spacingXY", "spacingZ", "modality", "na", "immersionIndex", "emission", "excitation", "method", "iterations", "tvWeight", "sampleIndex", "depth", "psfXY", "psfZ", "clearPsf"];
function setBusy(busy) {
  results.inert = busy;
  for (const id of FORM_IDS) $(id).disabled = busy;
  psfField.disabled = busy;
  exampleControl?.setDisabled(busy);
  if (!busy) syncDependentFields();
  $("runButton").disabled = busy || !input;
}

function syncDependentFields() {
  $("excitation").disabled = $("modality").value !== "confocal";
  $("tvWeight").disabled = $("method").value !== "rltv";
  const theoretical = !measured;
  for (const id of ["modality", "na", "immersionIndex", "emission", "sampleIndex", "depth", "psfXY", "psfZ"]) $(id).disabled = !theoretical;
  if (!theoretical) $("excitation").disabled = true;
}
$("modality").addEventListener("change", syncDependentFields);
$("method").addEventListener("change", syncDependentFields);

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function showOptics(optics) {
  $("modality").value = optics.modality;
  $("na").value = String(optics.na);
  $("immersionIndex").value = String(optics.immersionIndex);
  $("sampleIndex").value = String(optics.sampleIndex);
  $("emission").value = String(optics.emissionNm);
  $("excitation").value = String(optics.excitationNm);
  $("depth").value = String(optics.depthUm);
  syncDependentFields();
}

function clearMeasuredPsf() {
  measured = null;
  psfField.setText(PSF_FIELD_TEXT);
  psfField.setHasFiles(false);
  $("clearPsf").hidden = true;
  syncInputFiles("psfInput", []);
  syncDependentFields();
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

function niftiFor(volume, name) {
  const geometry = niftiGeometry(volume.dims, volume.spacingUm);
  const buffer = createNiftiFromVolume({ hdr: geometry, img: volume.data instanceof Float32Array ? volume.data : Float32Array.from(volume.data) });
  return new File([buffer], name, { type: "application/octet-stream" });
}

function oneFile(files, what) {
  if (files.length !== 1) throw new Error(`Choose one ${what} file; this selection has ${files.length}.`);
  return files[0];
}

function describeSpacing(spacingUm) {
  return ["x", "y", "z"].map((axis) => (spacingUm[axis] ? Number(spacingUm[axis].toPrecision(4)) : "?")).join(" × ");
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading stack…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    const file = oneFile(files, "TIFF or NIfTI");
    const volume = await readVolume(file, { signal: current });
    current.throwIfAborted();
    const [nz, ny, nx] = volume.dims;
    const view = volume.format === "nifti" ? file : niftiFor({ ...volume, spacingUm: { x: volume.spacingUm.x ?? 1, y: volume.spacingUm.y ?? 1, z: volume.spacingUm.z ?? 1 } }, `${outputNames(file.name).previewNifti.replace(/\.gz$/, "")}`);
    await show(view, { signal: current });
    current.throwIfAborted();
    input = { ...volume, file, view };
    clearOutputs();
    syncInputFiles("imageInput", files);
    showSpacing("spacingXY", volume.spacingUm.x);
    showSpacing("spacingZ", volume.spacingUm.z);
    if (volume.spacingUm.x && volume.spacingUm.y && Math.abs(volume.spacingUm.x - volume.spacingUm.y) > 0.01 * volume.spacingUm.x) {
      log.log(`The pixels are not square (${describeSpacing(volume.spacingUm)} µm); the PSF uses the x size for both.`, "warning");
    }
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${nx} × ${ny} × ${nz} · ${describeSpacing(volume.spacingUm)} µm`;
    $("dropZone").classList.add("has-files");
    log.log(`Voxel size from ${volume.spacingSource ?? "nowhere: enter it"}; ${volume.format.toUpperCase()} ${nx} × ${ny} × ${nz}`, "info");
    progress.setProgress(0);
    if (spacingComplete(formSpacing())) status(`${file.name} loaded`);
    else status(`${file.name} loaded · enter its voxel size`);
  } finally {
    loading = null;
    finish(operation);
  }
}

async function loadMeasuredPsf(filesPromise, signal) {
  const operation = begin("Reading measured PSF…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const file = oneFile(await filesPromise, "PSF");
    const volume = await readVolume(file, { signal: current });
    current.throwIfAborted();
    measured = { file, data: volume.data, dims: volume.dims, spacingUm: volume.spacingUm };
    clearOutputs();
    psfField.setText(`${file.name} · ${volume.dims.slice().reverse().join(" × ")}`);
    psfField.setHasFiles(true);
    $("clearPsf").hidden = false;
    syncInputFiles("psfInput", [file]);
    progress.setProgress(0);
    status(`The measured PSF ${file.name} replaces the theoretical one`);
  } finally {
    loading = null;
    finish(operation);
  }
}

/** A module worker for one request; aborting terminates it, freeing its memory. */
function inWorker(request, transfer, signal, onProgress) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
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
      reject(new Error(event.message || "The deconvolution worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        onProgress?.(data);
        return;
      }
      stop();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    };
    worker.postMessage(request, transfer);
  });
}

// The fields show the file's calibration to 6 digits; while a field still shows it, the run
// uses the file's exact value, so the PSF grid matches the file.
function showSpacing(id, value) {
  $(id).value = value ? String(Number(value.toPrecision(6))) : "";
  $(id).dataset.exact = value ? String(value) : "";
}

function fieldSpacing(id) {
  const field = $(id);
  const exact = Number(field.dataset.exact);
  return exact && field.value === String(Number(exact.toPrecision(6))) ? exact : field.valueAsNumber;
}

function formSpacing() {
  const xy = fieldSpacing("spacingXY");
  return { x: xy, y: xy, z: fieldSpacing("spacingZ") };
}

function formOptics() {
  return opticsSettings({
    modality: $("modality").value,
    na: $("na").valueAsNumber,
    immersionIndex: $("immersionIndex").valueAsNumber,
    sampleIndex: $("sampleIndex").valueAsNumber,
    emissionNm: $("emission").valueAsNumber,
    excitationNm: $("excitation").valueAsNumber,
    depthUm: $("depth").valueAsNumber || 0,
  });
}

function formSettings() {
  return runSettings({ method: $("method").value, iterations: $("iterations").valueAsNumber, tvWeight: $("tvWeight").valueAsNumber });
}

function psfOverride(id) {
  const value = $(id).value.trim();
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PSF_SIDE || n % 2 === 0) throw new Error(`PSF sizes must be odd whole numbers from 1 to ${MAX_PSF_SIDE}.`);
  return n;
}

/** The PSF for this run: `{ data (peak 1), dims, source }`. */
async function makePsf(spacingUm, optics, signal) {
  if (measured) {
    const spacing = measured.spacingUm;
    const differs = ["x", "z"].some((axis) => spacing[axis] && Math.abs(spacing[axis] - spacingUm[axis]) > 0.05 * spacingUm[axis]);
    if (differs) throw new Error(`The measured PSF's voxel size (${describeSpacing(spacing)} µm) differs from the image's; resample it to ${describeSpacing(spacingUm)} µm first.`);
    const prepared = prepareMeasuredPsf(measured.data, measured.dims);
    log.log(`Measured PSF: background ${prepared.background.toPrecision(4)} subtracted, cropped to ${prepared.dims.slice().reverse().join(" × ")} around its peak`, "info");
    const peak = prepared.data.reduce((max, v) => Math.max(max, v), 0);
    return { data: prepared.data.map((v) => v / peak), dims: prepared.dims, source: "measured", file: measured.file.name, background: prepared.background };
  }
  const auto = autoPsfSize({ ...optics, spacingUm, dims: input.dims });
  const size = { xy: psfOverride("psfXY") ?? auto.xy, z: input.dims[0] === 1 ? 1 : psfOverride("psfZ") ?? auto.z };
  log.log(`Gibson-Lanni ${optics.modality} PSF ${size.xy} × ${size.xy} × ${size.z}: NA ${optics.na}, immersion ${optics.ni}, emission ${optics.emissionUm * 1000} nm${optics.excitationUm ? `, excitation ${optics.excitationUm * 1000} nm` : ""}, depth ${optics.depthUm} µm`, "info");
  const { psf } = await inWorker({ type: "psf", optics, spacingUm, size }, [], signal);
  return { data: psf, dims: [size.z, size.xy, size.xy], source: "theoretical" };
}

async function deconvolve(signal, settings = formSettings()) {
  if (!input) throw new Error("Load a stack before deconvolving it.");
  const spacingUm = formSpacing();
  if (!spacingComplete(spacingUm)) throw new Error("Enter the voxel size: the PSF depends on it.");
  const optics = measured ? null : formOptics();
  const operation = begin(`Deconvolving ${input.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    const started = performance.now();
    status("Computing the PSF…");
    const psf = await makePsf(spacingUm, optics, current);
    current.throwIfAborted();
    const plan = memoryPlan(input.dims, psf.dims, { tv: settings.tvWeight > 0 });
    log.log(`FFT grid ${plan.padded.slice().reverse().join(" × ")}; about ${Math.round(plan.bytes / 2 ** 20)} MB of WebAssembly memory`, "info");
    if (!plan.fits) throw new Error(`This stack and PSF need about ${Math.round(plan.bytes / 2 ** 20)} MB; crop the stack or shrink the PSF.`);
    const { data: image, negative } = prepareImage(input.data);
    if (negative) log.log(`${negative} negative voxels set to 0: Richardson-Lucy needs a nonnegative image.`, "warning");
    progress.setProgress(0.05);
    const label = METHODS[settings.method].label;
    status(`${label}: iteration 0 of ${settings.iterations}`);
    const { estimate } = await inWorker(
      { type: "deconvolve", image, dims: input.dims, psf: normaliseSum(psf.data), psfDims: psf.dims, iterations: settings.iterations, tvWeight: settings.tvWeight },
      [image.buffer],
      current,
      ({ iteration }) => {
        progress.setProgress(0.05 + (0.9 * iteration) / settings.iterations);
        $("statusText").textContent = `${label}: iteration ${iteration} of ${settings.iterations}`;
      },
    );
    current.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    const names = outputNames(input.name);
    const [nz, ny, nx] = input.dims;
    const tiff = new File([writeImageJTiff({ data: estimate, width: nx, height: ny, depth: nz, spacingUm })], names.tiff, { type: "image/tiff" });
    const niftiBytes = input.format === "nifti"
      ? createFloat32Nifti(estimate, input.niftiHeader)
      : createNiftiFromVolume({ hdr: niftiGeometry(input.dims, spacingUm), img: estimate });
    const nifti = await gzipFile(niftiBytes, names.nifti, current);
    const psfVolume = { dims: psf.dims, spacingUm, data: Float32Array.from(psf.data) };
    const psfTiff = new File([writeImageJTiff({ data: psfVolume.data, width: psf.dims[2], height: psf.dims[1], depth: psf.dims[0], spacingUm })], names.psfTiff, { type: "image/tiff" });
    const psfView = niftiFor(psfVolume, names.psfNifti.replace(/\.gz$/, ""));
    await show(nifti, { signal: current });
    current.throwIfAborted();
    const record = provenance({ input: input.name, dims: input.dims, spacingUm, optics, psf, settings, seconds: Number(seconds.toFixed(1)) });
    const psfLabel = psf.source === "measured" ? `Measured PSF · ${psf.file}` : `Gibson-Lanni PSF · ${optics.modality}, NA ${optics.na}`;
    outputs = {
      image: { description: `Deconvolved · ${label}, ${settings.iterations} iterations (TIFF)`, file: tiff, view: nifti },
      nifti: { description: "Deconvolved (NIfTI)", file: nifti, view: nifti },
      psf: { description: `${psfLabel} (TIFF)`, file: psfTiff, view: psfView },
    };
    // The input leads the list, so the viewer can go back to the stack before deconvolution.
    results.render({ input: { description: "Input stack", file: input.file, view: input.view }, ...outputs });
    $("outputSection").open = true;
    log.log(`Deconvolved in ${seconds.toFixed(1)} s: ${JSON.stringify(record)}`, "info");
    progress.end("Stack deconvolved");
    status("Stack deconvolved");
    return {
      artifacts: [{ role: "image", file: tiff }, { role: "nifti", file: nifti }, { role: "psf", file: psfTiff }],
      provenance: record,
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
psfField.onFiles((files) => {
  void loadMeasuredPsf(files).catch((error) => {
    syncInputFiles("psfInput", measured ? [measured.file] : []);
    report(error);
  });
});
$("clearPsf").onclick = () => {
  clearMeasuredPsf();
  clearOutputs();
  status("The theoretical PSF will be used");
};
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
    clearMeasuredPsf();
    showOptics(EXAMPLE_OPTICS[example.id] ?? DEFAULT_OPTICS);
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
    if (!measured) formOptics();
  } catch (error) {
    report(error);
    return;
  }
  void deconvolve(undefined, settings).catch((error) => {
    // Reveal the field that needs attention when it sits in the collapsed settings.
    if (/PSF sizes|sample refractive|depth/.test(error.message)) $("advancedSettings").open = true;
    report(error);
  });
});

registerAppAutomation({
  app: APP.id,
  operations: {
    deconvolve: async ({ inputs, parameters, signal }) => {
      const settings = runSettings({ method: parameters.method, iterations: parameters.iterations, tvWeight: parameters.tvWeight });
      await loadFiles(Promise.resolve(inputs.image), signal);
      if (inputs.psf?.length) await loadMeasuredPsf(Promise.resolve(inputs.psf), signal);
      else clearMeasuredPsf();
      showOptics({
        modality: parameters.modality ?? DEFAULT_OPTICS.modality,
        na: parameters.numericalAperture ?? DEFAULT_OPTICS.na,
        immersionIndex: parameters.immersionIndex ?? DEFAULT_OPTICS.immersionIndex,
        sampleIndex: parameters.sampleIndex ?? DEFAULT_OPTICS.sampleIndex,
        emissionNm: parameters.emissionNm ?? DEFAULT_OPTICS.emissionNm,
        excitationNm: parameters.excitationNm ?? DEFAULT_OPTICS.excitationNm,
        depthUm: parameters.depthUm ?? DEFAULT_OPTICS.depthUm,
      });
      if (parameters.voxelSizeXYUm) showSpacing("spacingXY", parameters.voxelSizeXYUm);
      if (parameters.voxelSizeZUm) showSpacing("spacingZ", parameters.voxelSizeZUm);
      $("method").value = settings.method;
      $("iterations").value = String(settings.iterations);
      if (settings.method === "rltv") $("tvWeight").value = String(settings.tvWeight);
      syncDependentFields();
      return deconvolve(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
