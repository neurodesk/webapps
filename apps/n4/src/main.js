// N4: bias-field correction with ANTs N4 in WebAssembly, and MRtrix dwibiascorrect's DWI procedure.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createNiivueVolumePreview,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import {
  createNiftiFromData,
  decodeNiftiBuffer,
  downloadFile,
  readNiftiFrames,
  readNiftiImageData,
  sameNiftiGrid,
} from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { brainMask, mindgrab } from "@neurodesk/runtime-support/mindgrab";
import { parseNumbers } from "@neurodesk/dwi2trx/gradients";
import { divideVolumes, rescaleBias } from "@neurodesk/n4";
import { APP } from "./config.js";
import { b0Volumes, meanVolumes, outputNames } from "./pipeline.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "N4",
  subtitle: "Bias-field correction",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
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
$("aboutBtn").onclick = () => info.open("About N4", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

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

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    void showVolume({ file: result.file }).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

const showVolume = createNiivueVolumePreview({
  viewer,
  ready: viewerReady,
  emptyState: $("emptyState"),
});

async function gzipFile(buffer, name, signal) {
  signal?.throwIfAborted();
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  signal?.throwIfAborted();
  return new File([bytes], name, { type: "application/gzip" });
}

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  $("imageInput").disabled = busy;
  $("maskInput").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

async function loadFiles(filesPromise, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading image…");
  progress.setCancellable(true);
  status("Reading image…");
  try {
    const files = await filesPromise;
    const series = await readDiffusionSeries(files, { signal: controller.signal, anonymizeSidecar: true });
    controller.signal.throwIfAborted();
    if (series.length !== 1) throw new Error(`Choose one image; this selection has ${series.length}.`);
    const [{ image, bval, bvec, sidecar }] = series;
    const buffer = await decodeNiftiBuffer(await image.arrayBuffer());
    controller.signal.throwIfAborted();
    const frames = readNiftiFrames(buffer);
    const bvals = bval ? parseNumbers(await bval.text()) : null;
    if (bvals && bvals.length !== frames.frames) {
      throw new Error(`${image.name} has ${frames.frames} volumes but the bval file lists ${bvals.length}.`);
    }
    const reference = b0Volumes(bvals, frames.frames);
    controller.signal.throwIfAborted();
    await showVolume({ file: image }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    input = { name: image.name, buffer, ...frames, bval, bvec, sidecar, bvals, reference };
    mask = null;
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("maskInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [] } }));
    $("maskInfo").hidden = true;
    $("maskDrop").classList.remove("has-files");
    clearOutputs();
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${image.name} · ${frames.dims.join("×")}${frames.frames > 1 ? `×${frames.frames}` : ""}${bval || bvec ? ` · ${[bval && "bval", bvec && "bvec"].filter(Boolean).join(", ")}` : ""}`;
    $("dropZone").classList.add("has-files");
    $("modeNote").hidden = false;
    $("modeNote").textContent = bvals
      ? reference.length === 1
        ? "DWI: the field is fitted to the b0 volume."
        : `DWI: the field is fitted to the mean of ${reference.length} b0 volumes.`
      : frames.frames > 1
        ? `No bval: the field is fitted to the mean of all ${frames.frames} volumes.`
        : "3D image: N4 corrects it directly.";
    progress.setProgress(0);
    status(`${image.name} loaded`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

async function loadMask(file, signal) {
  signal?.throwIfAborted();
  if (!input) throw new Error("Load the image before its mask.");
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading mask…");
  progress.setCancellable(true);
  status("Reading mask…");
  try {
    const buffer = await decodeNiftiBuffer(await file.arrayBuffer());
    controller.signal.throwIfAborted();
    if (!sameNiftiGrid(buffer, input.buffer)) throw new Error(`${file.name} is not on the image grid.`);
    const volume = readNiftiFrames(buffer);
    if (volume.frames !== 1) throw new Error("The brain mask must be a single 3D image.");
    mask = Uint8Array.from(volume.data, (value) => (value > 0 ? 1 : 0));
    $("maskInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    clearOutputs();
    $("maskInfo").hidden = false;
    $("maskInfo").textContent = `${file.name} · ${mask.reduce((sum, v) => sum + v, 0)} voxels`;
    $("maskDrop").classList.add("has-files");
    status(`${file.name} will weight the fit`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

/** Runs N4 in a worker; aborting terminates it. */
function runN4(image, weight, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = (error) => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (error) reject(error);
    };
    const abort = () => stop(signal.reason ?? new DOMException("Correction cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => stop(new Error(event.message || "The N4 worker failed."));
    worker.onmessage = ({ data }) => {
      if (data.log !== undefined) return log.log(data.log, "info");
      if (data.error) return stop(new Error(data.error));
      stop();
      resolve(data);
    };
    worker.postMessage({ image, weight }, [image, weight]);
  });
}

async function correct(signal) {
  signal?.throwIfAborted();
  if (!input || loading || running) throw new Error("Load an image before correcting it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  progress.begin("Fitting the bias field…");
  progress.setCancellable(true);
  try {
    const voxels = input.dims[0] * input.dims[1] * input.dims[2];
    const reference = meanVolumes(input.data, voxels, input.reference);
    let brain = mask;
    let maskSource = "supplied";
    if (!brain) {
      const what = input.frames > 1 ? "the mean b0" : "the image";
      status(`Extracting the brain from ${what} with MindGrab`);
      const image = createNiftiFromData(reference, input.buffer, { dims: input.dims });
      const extracted = await brainMask(new Uint8Array(image), { assetPath: `${import.meta.env.BASE_URL}mindgrab/`, signal: controller.signal });
      brain = Uint8Array.from(readNiftiFrames(extracted.mask).data, (value) => (value > 0 ? 1 : 0));
      maskSource = `mindgrab-${mindgrab.version}-${extracted.backend}`;
      log.log(`MindGrab ${mindgrab.version} brain mask on ${extracted.backend}`, "info");
    }
    if (!brain.some(Boolean)) throw new Error("The brain mask has no voxels. Supply a mask, or check the image.");
    status(`Fitting the bias field to ${brain.reduce((sum, v) => sum + v, 0)} voxels`);
    const { corrected, bias } = await runN4(
      createNiftiFromData(reference, input.buffer, { dims: input.dims }),
      createNiftiFromData(brain, input.buffer, { dims: input.dims }),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const correctedReference = readNiftiImageData(corrected).data;
    let field = readNiftiImageData(bias).data;
    let image;
    if (input.frames > 1) {
      // MRtrix dwibiascorrect ants: keep the brain integral, then divide every volume.
      const scaled = rescaleBias(reference, correctedReference, brain, field);
      field = scaled.bias;
      log.log(`Bias field rescaled by ${scaled.multiplier.toPrecision(6)}`, "info");
      image = divideVolumes(input.data, voxels, input.frames, field);
    } else {
      image = correctedReference;
    }
    const names = outputNames(input.name);
    const dims = input.frames > 1 ? [...input.dims, input.frames] : input.dims;
    const rows = {
      image: { description: "Corrected image", file: await gzipFile(createNiftiFromData(Float32Array.from(image), input.buffer, { dims }), names.image, controller.signal) },
      bias: { description: "Bias field", file: await gzipFile(createNiftiFromData(Float32Array.from(field), input.buffer, { dims: input.dims }), names.bias, controller.signal) },
      mask: { description: "Brain mask", file: await gzipFile(createNiftiFromData(brain, input.buffer, { dims: input.dims }), names.mask, controller.signal) },
    };
    if (input.bval) rows.bval = { description: "b-values (unchanged)", file: new File([input.bval], names.bval), viewable: false };
    if (input.bvec) rows.bvec = { description: "b-vectors (unchanged)", file: new File([input.bvec], names.bvec), viewable: false };
    if (input.sidecar) {
      const sidecar = { ...input.sidecar, Description: "Bias-field correction with ANTs N4 (MRtrix dwibiascorrect ants procedure)" };
      rows.sidecar = { description: "Sidecar", file: new File([`${JSON.stringify(sidecar, null, 2)}\n`], names.sidecar, { type: "application/json" }), viewable: false };
    }
    await showVolume({ file: rows.image.file }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Bias field corrected");
    status("Bias field corrected");
    return {
      artifacts: Object.entries(rows).map(([role, row]) => ({ role, file: row.file })),
      provenance: { method: "ants-n4-2.6.2-wasm", procedure: input.frames > 1 ? "mrtrix-dwibiascorrect-ants" : "n4", mask: maskSource, shrink: 4, bspline: [100, 3], convergence: [1000, 0] },
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
$("maskInput").addEventListener("change", (event) => {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) void loadMask(file).catch(report);
});
bindFileDrop($("dropZone"), importFiles);
bindFileDrop($("maskDrop"), async (files) => {
  const [file] = await files;
  if (file) await loadMask(file).catch(report);
});
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
  void correct().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    correct: async ({ inputs, inputDetails, signal }) => {
      const sidecars = inputDetails.image?.sidecars ?? [];
      await loadFiles(Promise.resolve([...inputs.image, ...sidecars, ...(inputs.bval ?? []), ...(inputs.bvec ?? [])]), signal);
      if (inputs.mask?.length) await loadMask(inputs.mask[0], signal);
      return correct(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
