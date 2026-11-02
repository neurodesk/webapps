// SDC: susceptibility distortion correction in this browser, from a reverse phase-encoding b = 0
// pair (PyHySCO port) or from a DWI series and a T1w (sdcflows' SyN-SDC, packages/sdc).
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createFileField,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createNiivueVolumePreview,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { createNiftiFromData, decodeNiftiBuffer, downloadFile, readNiftiFrames, sameNiftiGrid } from "@neurodesk/webapp-components/file-io";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { PRIOR_FILES, acquisition } from "@neurodesk/sdc/syn";
import registrationWorker from "@neurodesk/hmc-registration/worker?worker&url";
import denoiseWorker from "@neurodesk/ants-denoise/worker?worker&url";
import n4Worker from "@neurodesk/sdc/syn/n4-worker?worker&url";
import fieldFitUrl from "@neurodesk/sdc/field-fit.wasm?url";
import priorManifest from "../../../models/sdc.manifest.json";
import { APP } from "./config.js";
import { fieldSummaryText, missingAcquisition, selectBidsSyn, selectSynSeries, stageProgress } from "./syn.js";
import { b0Frames, fieldExecution, fieldProvenance, fieldSidecar, meanFrames, outputNames, selectBidsPair, selectPair, voxelSizes } from "./pipeline.js";
import { estimateField } from "./estimate.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "SDC",
  subtitle: "Susceptibility distortion correction",
  controlsContract: { privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const viewer = new NiiVueGPU({ isDragDropEnabled: false, backgroundColor: [0, 0, 0, 1] });
const viewerReady = viewer.attachTo("gl1").then(() => {
  viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
  viewer.isLegendVisible = false;
});
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  viewer.sliceType = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

/** The two loaded inputs, each { name, sidecar, header buffer, mean, frames used, total frames }. */
let pair = null;
/** The loaded SyN-SDC inputs: { files, dims, dwi, bval, bvec, sidecar, t1w, missing }. */
let syn = null;
/** Uploaded brain masks for SyN-SDC, each a File, or null for MindGrab's. */
const masks = { dwi: null, t1w: null };
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    if (loading || running) return;
    const preview = result.overlay && outputs.after ? { file: outputs.after.file, overlay: { file: result.file, range: result.overlay } } : { file: result.file };
    void showVolume(preview).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

const showVolume = createNiivueVolumePreview({ viewer, ready: viewerReady, emptyState: $("emptyState") });

async function gzipFile(buffer, name) {
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new File([await new Response(stream).arrayBuffer()], name, { type: "application/gzip" });
}

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

const isSyn = () => $("method").value === "syn";

function setBusy(busy) {
  $("imageInput").disabled = busy;
  $("resultList").inert = busy;
  exampleControl?.setDisabled(busy);
  for (const id of ["method", "direction", "readout", "prior", "clearMasks"]) $(id).disabled = busy;
  for (const field of Object.values(maskFields)) field.disabled = busy;
  $("reference").disabled = busy || !pair;
  $("runButton").disabled = busy || !(isSyn() ? syn : pair);
}

/** One input: its b = 0 mean and what the summary shows. */
async function readInput(entry, signal) {
  const buffer = await decodeNiftiBuffer(await entry.image.arrayBuffer());
  signal.throwIfAborted();
  const { data, dims, frames, header } = readNiftiFrames(buffer);
  const bval = entry.bval ? await entry.bval.text() : null;
  const used = b0Frames(bval, frames);
  const voxels = dims[0] * dims[1] * dims[2];
  return {
    name: entry.image.name,
    sidecar: entry.sidecar,
    buffer,
    dims,
    affine: header.affine,
    frames,
    used: used.length,
    mean: meanFrames(data, voxels, used),
  };
}

function describe(input) {
  const volumes = input.frames > 1 ? ` · b = 0 mean of ${input.used}/${input.frames}` : "";
  return `${input.name} · ${input.sidecar.PhaseEncodingDirection}${volumes}`;
}

function renderPair() {
  const [first, second] = pair;
  $("fileInfo").hidden = false;
  $("fileInfo").textContent = `Image 1: ${describe(first)}`;
  $("pairInfo").hidden = false;
  $("pairInfo").textContent = `Image 2: ${describe(second)}`;
  $("reference").replaceChildren(...pair.map((input, k) => new Option(input.name, String(k), k === 0, k === 0)));
}

async function loadFiles(filesPromise, signal, { ordered = false } = {}) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading images…");
  status("Reading images…");
  try {
    const files = await filesPromise;
    const bidsPair = ordered ? null : await selectBidsPair(files);
    const chosen = bidsPair ?? selectPair(await readDiffusionSeries(files, { signal: controller.signal, anonymizeSidecar: true }), { ordered });
    controller.signal.throwIfAborted();
    const inputs = [];
    for (const entry of chosen) inputs.push(await readInput(entry, controller.signal));
    const [first, second] = inputs;
    // 0.01 mm: two series of one session can differ by float32 rounding of their affines.
    if (first.dims.join() !== second.dims.join() || !sameNiftiGrid(first.buffer, second.buffer, 0.01)) {
      throw new Error(`The images are on different grids (${first.dims.join("×")} and ${second.dims.join("×")}); both must be in one space.`);
    }
    const preview = await gzipFile(createNiftiFromData(Float32Array.from(first.mean), first.buffer, { dims: first.dims }), "image1_b0_mean.nii.gz");
    await showVolume({ file: preview }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    pair = inputs;
    syn = null;
    clearOutputs();
    renderPair();
    $("dropZone").classList.add("has-files");
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    progress.setProgress(0);
    status(`${first.name} and ${second.name} loaded`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

async function estimate(signal) {
  if (!pair || loading || running) throw new Error("Load an image pair before estimating the field.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  const [first, second] = pair;
  const phaseEncodingDirection = first.sidecar.PhaseEncodingDirection;
  const totalReadoutTime = Number(first.sidecar.TotalReadoutTime);
  progress.begin("Estimating the field…");
  progress.setCancellable(true);
  status(`Estimating the field with PyHySCO, reference ${first.name}`);
  try {
    const started = performance.now();
    const out = await estimateField({
      image1: first.mean,
      image2: second.mean,
      dims: first.dims,
      voxel: voxelSizes(first.affine),
      options: { phaseEncodingDirection, totalReadoutTime },
      signal: controller.signal,
    });
    const seconds = (performance.now() - started) / 1000;
    log.log(`PyHySCO: ${out.iterations} Gauss-Newton iterations in ${seconds.toFixed(1)} s`);
    const execution = fieldExecution(out);
    log.log(`PyHySCO backend: ${execution.backend}${execution.adapter ? ` (${execution.adapter})` : ""}`);
    if (execution.gpuError) log.log(`WebGPU failed. CPU fallback: ${execution.gpuError}`, "warning");
    const names = outputNames(first.name, second.name);
    const volume = (data, name) => gzipFile(createNiftiFromData(Float32Array.from(data), first.buffer, { dims: first.dims, range: "auto", clampCalMax: false }), name);
    const field = await volume(out.field, names.field);
    controller.signal.throwIfAborted();
    const corrected1 = await volume(out.corrected1, names.corrected1);
    controller.signal.throwIfAborted();
    const corrected2 = await volume(out.corrected2, names.corrected2);
    controller.signal.throwIfAborted();
    const meta = fieldSidecar({ image1: first.name, image2: second.name, phaseEncodingDirection, totalReadoutTime, iterations: out.iterations, execution });
    const sidecar = new File([`${JSON.stringify(meta, null, 2)}\n`], names.sidecar, { type: "application/json" });
    const rows = {
      field: { description: "Field map (Hz)", file: field },
      sidecar: { description: "Field map sidecar", file: sidecar, viewable: false },
      corrected1: { description: "Corrected image 1 (QC)", file: corrected1 },
      corrected2: { description: "Corrected image 2 (QC)", file: corrected2 },
    };
    await showVolume({ file: field }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Field estimated");
    status(`Field estimated in ${out.iterations} iterations`);
    return {
      artifacts: Object.entries(rows).map(([role, row]) => ({ role, file: row.file })),
      provenance: fieldProvenance({ iterations: out.iterations, reference: first.name, phaseEncodingDirection, totalReadoutTime, execution }),
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
  }
}


// ---- SyN-SDC ---------------------------------------------------------------------------------

const maskFields = {
  dwi: createFileField({ id: "dwiMaskInput", label: "DWI brain mask (optional)", kind: "image", text: "Drop a mask on the DWI grid" }),
  t1w: createFileField({ id: "t1wMaskInput", label: "T1w brain mask (optional)", kind: "image", text: "Drop a mask on the T1w grid" }),
};
$("dwiMaskField").append(maskFields.dwi);
$("t1wMaskField").append(maskFields.t1w);

function setMask(kind, file) {
  masks[kind] = file;
  maskFields[kind].setText(file ? file.name : kind === "dwi" ? "Drop a mask on the DWI grid" : "Drop a mask on the T1w grid");
  maskFields[kind].setHasFiles(Boolean(file));
  $(`${kind}MaskInput`).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: file ? [file] : [] } }));
  $("clearMasks").hidden = !masks.dwi && !masks.t1w;
}

for (const kind of ["dwi", "t1w"]) {
  maskFields[kind].onFiles(async (files) => {
    try {
      const images = await readImageFiles(await files);
      if (images.length !== 1) throw new Error("Choose one NIfTI mask or one DICOM mask series.");
      setMask(kind, images[0]);
      status(`${images[0].name} will be the ${kind === "dwi" ? "DWI" : "T1w"} brain mask`);
    } catch (error) {
      setMask(kind, masks[kind]);
      report(error);
    }
  });
}
$("clearMasks").onclick = () => {
  setMask("dwi", null);
  setMask("t1w", null);
  status("Using MindGrab brain masks");
};

/** Shows the fields of the chosen method; the inputs of the other method are dropped. */
function showMethod() {
  const synMethod = isSyn();
  $("pyhyscoFields").hidden = synMethod;
  $("synFields").hidden = !synMethod;
  $("dropText").textContent = synMethod ? "Drop a DWI series and a T1w, NIfTI, DICOM or BIDS" : "Drop an AP/PA pair with sidecars, NIfTI or DICOM";
  $("imageInput").setAttribute("aria-label", synMethod
    ? "Choose a DWI series with its bval, bvec and JSON sidecar, and a T1-weighted image"
    : "Choose two images with opposite phase-encoding directions, with their JSON sidecars and an optional bval");
  $("runButton").textContent = synMethod ? "Correct distortion" : "Estimate field";
  $("directionField").hidden = !syn?.missing.direction;
  $("readoutField").hidden = !syn?.missing.readout;
}

function clearInputs() {
  pair = null;
  syn = null;
  clearOutputs();
  $("fileInfo").hidden = true;
  $("pairInfo").hidden = true;
  $("dropZone").classList.remove("has-files");
  showMethod();
  setBusy(false);
}

$("method").addEventListener("change", () => {
  if (pair || syn) {
    clearInputs();
    void showVolume(null).catch((error) => status(error.message, true));
  } else showMethod();
  status(isSyn() ? "Drop a DWI series and a T1w" : "Drop files");
});

async function loadSynFiles(filesPromise, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading images…");
  status("Reading images…");
  try {
    const files = await filesPromise;
    const chosen = (await selectBidsSyn(files)) ?? selectSynSeries(await readDiffusionSeries(files, { signal: controller.signal, anonymizeSidecar: true }));
    controller.signal.throwIfAborted();
    const buffer = await decodeNiftiBuffer(await chosen.image.arrayBuffer());
    const bval = await chosen.bval.text();
    const { data, dims, frames } = readNiftiFrames(buffer);
    const used = b0Frames(bval, frames);
    const preview = await gzipFile(createNiftiFromData(Float32Array.from(meanFrames(data, dims[0] * dims[1] * dims[2], used)), buffer, { dims }), "b0_mean.nii.gz");
    await showVolume({ file: preview }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    pair = null;
    for (const kind of ["dwi", "t1w"]) if (masks[kind]) setMask(kind, null);
    syn = { files, dims, dwi: chosen.image, bval, bvec: await chosen.bvec.text(), sidecar: chosen.sidecar ?? null, t1w: chosen.t1w, missing: missingAcquisition(chosen.sidecar) };
    clearOutputs();
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `DWI: ${chosen.image.name} · ${dims.join("×")}×${frames} · b = 0 mean of ${used.length}`;
    $("pairInfo").hidden = false;
    $("pairInfo").textContent = `T1w: ${chosen.t1w.name}`;
    $("dropZone").classList.add("has-files");
    showMethod();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    progress.setProgress(0);
    const asks = [syn.missing.direction && "the phase-encoding direction", syn.missing.readout && "the total readout time"].filter(Boolean);
    status(asks.length ? `No sidecar gives ${asks.join(" or ")}; enter it` : `${chosen.image.name} and ${chosen.t1w.name} loaded`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

/** The pinned prior files of models/sdc.manifest.json, checked against their SHA-256. */
async function fetchPrior(signal) {
  const prior = {};
  for (const name of Object.values(PRIOR_FILES)) {
    const asset = priorManifest.assets.find((entry) => entry.filename === name);
    const integrity = { bytes: asset.bytes, sha256: asset.sha256 };
    prior[name] = new Uint8Array(await fetchModel({ url: priorManifest.base_url + name, integrity }, { signal }));
  }
  return prior;
}

/** Runs packages/sdc's pipeline in a new worker; cancelling terminates it and its workers. */
function runSynWorker(inputs, signal, onProgress) {
  const absolute = (url) => new URL(url, location.href).href;
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  const urls = {
    registrationWorker: absolute(registrationWorker),
    denoiseWorker: absolute(denoiseWorker),
    n4Worker: absolute(n4Worker),
    n4Kernel: { module: `${base}n4/n4-bias.mjs`, wasm: `${base}n4/n4-bias.wasm` },
    fieldFit: absolute(fieldFitUrl),
    mindgrab: `${base}mindgrab/`,
  };
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL("./syn-worker.js", import.meta.url), { type: "module" });
    const finish = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.progress) return onProgress(data.progress);
      finish();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The SyN-SDC worker failed."));
    };
    worker.postMessage({ urls, inputs });
  });
}

async function correctSyn(signal) {
  if (!syn || loading || running) throw new Error("Load a DWI series and a T1w before correcting.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  progress.begin("Correcting the distortion…");
  progress.setCancellable(true);
  const readout = $("readout").value.trim();
  const options = {
    phaseEncodingDirection: syn.missing.direction ? $("direction").value : undefined,
    totalReadoutTime: syn.missing.readout && readout ? Number(readout) : undefined,
  };
  try {
    // Refuse a run without the direction or the readout time before any download.
    acquisition(syn.sidecar, syn.dims, options);
    const started = performance.now();
    let stage = null;
    let stageStarted = started;
    const onProgress = (event) => {
      if (event.stage !== stage) {
        if (stage) log.log(`${stageProgress({ stage }).message}: ${((performance.now() - stageStarted) / 1000).toFixed(1)} s`);
        stage = event.stage;
        stageStarted = performance.now();
      }
      const { message, fraction } = stageProgress(event);
      progress.setProgress(fraction, `${message}…`);
    };
    status(`Correcting ${syn.dwi.name} with SyN-SDC`);
    progress.setProgress(0, "Downloading the distortion prior…");
    const prior = $("prior").value === "atlas" ? await fetchPrior(controller.signal) : null;
    const read = async (file) => (file ? new Uint8Array(await file.arrayBuffer()) : null);
    const result = await runSynWorker({
      dwi: await read(syn.dwi),
      bval: syn.bval,
      bvec: syn.bvec,
      sidecar: syn.sidecar,
      fileName: syn.dwi.name,
      t1w: await read(syn.t1w),
      epiMask: await read(masks.dwi),
      t1wMask: await read(masks.t1w),
      prior,
      ...options,
    }, controller.signal, onProgress);
    log.log(`SyN-SDC finished in ${((performance.now() - started) / 60000).toFixed(1)} min`);
    if (result.qc.mindgrab.length) log.log(`MindGrab brain masks on ${result.qc.mindgrab.join(", ")}`);
    log.log(`Phase encoding ${result.provenance.PhaseEncodingDirection} (${result.provenance.PhaseEncodingDirectionSource}), total readout time ${result.provenance.TotalReadoutTime} s (${result.provenance.TotalReadoutTimeSource})`);
    log.log(fieldSummaryText(result.qc.field, result.provenance.PhaseEncodingDirection));
    const { names, files } = result;
    const file = (name) => new File([files[name]], name, { type: name.endsWith(".gz") ? "application/gzip" : name.endsWith(".json") ? "application/json" : "text/plain" });
    const qcName = (kind) => names.field.replace(/_desc-preproc_fieldmap\.nii\.gz$/, `_desc-${kind}QC_b0.nii.gz`);
    const rows = {
      corrected: { description: "Corrected DWI series", file: file(names.image) },
      bval: { description: "bval", file: file(names.bval), viewable: false },
      bvec: { description: "bvec", file: file(names.bvec), viewable: false },
      sidecar: { description: "DWI sidecar", file: file(names.sidecar), viewable: false },
      field: { description: "Field map (Hz)", file: file(names.field), overlay: [1, Math.max(2, Math.ceil(result.qc.field.p95))] },
      fieldSidecar: { description: "Field map sidecar", file: file(names.fieldSidecar), viewable: false },
      before: { description: "Mean b0, before (QC)", file: new File([result.qc.before], qcName("before"), { type: "application/gzip" }) },
      after: { description: "Mean b0, after (QC)", file: new File([result.qc.after], qcName("after"), { type: "application/gzip" }) },
      mask: { description: "DWI brain mask", file: file(names.mask) },
      coefficients: { description: "Field B-spline coefficients", file: file(names.coefficients), viewable: false },
      coefficientsSidecar: { description: "Coefficients sidecar", file: file(names.coefficientsSidecar), viewable: false },
      displacement: { description: "Displacement field (ITK)", file: file(names.displacement), viewable: false },
    };
    await showVolume({ file: rows.after.file, overlay: { file: rows.field.file, range: rows.field.overlay } }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Distortion corrected");
    status(`Distortion corrected in ${((performance.now() - started) / 60000).toFixed(1)} min`);
    return {
      artifacts: Object.entries(rows).map(([role, row]) => ({ role, file: row.file })),
      provenance: { method: "syn-sdc", ...result.provenance, qc: result.qc.field },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    running = null;
    setBusy(false);
  }
}

function report(error) {
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function importFiles(files) {
  exampleControl.cancel();
  return (isSyn() ? loadSynFiles(files) : loadFiles(files)).catch(report);
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
$("reference").addEventListener("change", () => {
  if (!pair) return;
  if ($("reference").value === "1") pair = [pair[1], pair[0]];
  clearOutputs();
  renderPair();
});
bindFileDrop($("dropZone"), importFiles);
const exampleControl = createExampleSelector({
  examples,
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    if ($("method").value !== example.method) {
      $("method").value = example.method;
      clearInputs();
    }
    await (isSyn() ? loadSynFiles : loadFiles)(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);
showMethod();

$("runButton").addEventListener("click", () => {
  void (isSyn() ? correctSyn() : estimate()).catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    pyhysco: async ({ inputs, inputDetails, signal }) => {
      if (isSyn()) {
        $("method").value = "pyhysco";
        clearInputs();
      }
      const files = [1, 2].flatMap(index => imageFiles(inputs, inputDetails, {
        image: `image${index}`, sidecar: `sidecar${index}`, bval: `bval${index}`, bvec: null,
        name: `image${index}_${inputs[`image${index}`][0].name}`,
      }));
      await loadFiles(Promise.resolve(files), signal, { ordered: true });
      return estimate(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
