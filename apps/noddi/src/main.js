// NODDI: diffusion tensor and NODDI (AMICO) maps from a DWI series, fitted in this browser.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { SLICE_TYPE } from "@niivue/niivue";
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
import {
  assertNiftiDecodedSize,
  createNiftiFromData,
  decodeNiftiBuffer,
  downloadFile,
  readNiftiFrames,
  sameNiftiGrid,
} from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { brainMask, mindgrab } from "@neurodesk/runtime-support/mindgrab";
import { parseBvalBvec } from "@neurodesk/dwi2trx/gradients";
import { loadNoddi } from "@neurodesk/noddi";
import wasmUrl from "@neurodesk/noddi/wasm?url";
import { APP } from "./config.js";
import { bidsStem, maskIndices, meanVolumes, outputEntries } from "@neurodesk/noddi/pipeline";
import { fitVolume } from "./fit-pool.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "NODDI",
  subtitle: "Diffusion tensor and NODDI maps",
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
$("aboutBtn").onclick = () => info.open("About NODDI", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const noddiApi = loadNoddi(fetch(wasmUrl));
let input = null;
let mask = null;
let outputs = {};
let loading = null;
let fitting = null;
let noddiRequested = $("fitNoddi").checked;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    void showVolume(result.file, result.range).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

async function showVolume(file, range) {
  await viewerReady;
  // Without a range NiiVue windows the image from its own intensities.
  const window = range ? { calMin: range[0], calMax: range[1] } : {};
  await viewer.loadVolumes([{ url: file, name: file.name, colormap: "gray", ...window }]);
  $("emptyState").hidden = true;
}

async function niftiFile(buffer, name) {
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new File([await new Response(stream).arrayBuffer()], name, { type: "application/gzip" });
}

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

/** Reads a DWI with its gradients from one selection (NIfTI with bval and bvec, or DICOM). */
async function readDwi(files, signal) {
  const series = (await readDiffusionSeries(files, { signal })).filter((entry) => entry.bval && entry.bvec);
  signal?.throwIfAborted();
  if (!series.length) throw new Error("Choose a DWI with its .bval and .bvec files, or a DICOM diffusion series.");
  if (series.length > 1) throw new Error(`Choose one diffusion series; this selection has ${series.length}.`);
  const [{ image, bval, bvec }] = series;
  await assertNiftiDecodedSize(image);
  const buffer = await decodeNiftiBuffer(await image.arrayBuffer());
  signal?.throwIfAborted();
  const { bvals, bvecs } = parseBvalBvec(await bval.text(), await bvec.text());
  const frames = readNiftiFrames(buffer);
  if (frames.frames !== bvals.length) {
    throw new Error(`${image.name} has ${frames.frames} volumes but the gradient files list ${bvals.length}.`);
  }
  const table = (await noddiApi).describe(bvals, bvecs);
  if (table.dtiError) throw new Error(table.dtiError);
  const voxels = frames.dims[0] * frames.dims[1] * frames.dims[2];
  return { name: image.name, buffer, dims: frames.dims, data: frames.data, voxels, bvals, bvecs, table, meanB0: meanVolumes(frames.data, voxels, table.b0) };
}

async function loadFiles(filesPromise, signal) {
  if (loading || fitting) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading diffusion data…");
  progress.setCancellable(true);
  status("Reading diffusion data…");
  try {
    const files = await filesPromise;
    const dwi = await readDwi(files, controller.signal);
    controller.signal.throwIfAborted();
    const b0 = await niftiFile(createNiftiFromData(dwi.meanB0, dwi.buffer, { dims: dwi.dims }), `${bidsStem(dwi.name)}_desc-meanb0.nii.gz`);
    controller.signal.throwIfAborted();
    await showVolume(b0);
    controller.signal.throwIfAborted();
    input = dwi;
    mask = null;
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("maskInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [] } }));
    $("maskInfo").hidden = true;
    $("maskDrop").classList.remove("has-files");
    clearOutputs();
    const shells = dwi.table.shells.map((b, i) => `${dwi.table.shellCounts[i]}×b${b}`).join(", ");
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${dwi.name} · ${dwi.table.b0.length}×b0, ${shells}`;
    $("dropZone").classList.add("has-files");
    $("fitNoddi").disabled = Boolean(dwi.table.noddiError);
    $("fitNoddi").checked = noddiRequested && !dwi.table.noddiError;
    $("noddiNote").hidden = !dwi.table.noddiError;
    $("noddiNote").textContent = dwi.table.noddiError ? "One shell: only the tensor maps can be fitted." : "";
    log.log(dwi.table.noddiError ?? `NODDI can run on shells ${shells}.`, "info");
    progress.setProgress(0);
    status(`${dwi.name} loaded`);
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
  if (!input) throw new Error("Load the diffusion data before its mask.");
  if (loading || fitting) throw new Error("Wait for the current operation to finish, or cancel it.");
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
    if (!sameNiftiGrid(buffer, input.buffer)) throw new Error(`${file.name} is not on the DWI grid.`);
    const volume = readNiftiFrames(buffer);
    if (volume.frames !== 1) throw new Error("The brain mask must be a single 3D image.");
    mask = Uint8Array.from(volume.data, (value) => (value > 0 ? 1 : 0));
    $("maskInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    clearOutputs();
    $("maskInfo").hidden = false;
    $("maskInfo").textContent = `${file.name} · ${maskIndices(mask).length} voxels`;
    $("maskDrop").classList.add("has-files");
    status(`${file.name} will limit the fit`);
  } finally {
    signal?.removeEventListener("abort", abort);
    loading = null;
    setBusy(false);
    progress.stopTimer();
    progress.setCancellable(false);
  }
}

function setBusy(busy) {
  $("imageInput").disabled = busy;
  $("maskInput").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

async function fitModels(signal) {
  if (!input || loading || fitting) throw new Error("Load diffusion data before fitting.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  fitting = controller;
  setBusy(true);
  clearOutputs();
  const withNoddi = $("fitNoddi").checked && !input.table.noddiError;
  const weighted = $("tensorFit").value === "wls";
  progress.setCancellable(true);
  try {
    let brain = mask;
    let maskSource = "supplied";
    if (!brain) {
      progress.begin("Extracting the brain from the mean b0 with MindGrab…");
      progress.setCancellable(true);
      status("Extracting the brain from the mean b0 with MindGrab");
      const meanB0 = createNiftiFromData(input.meanB0, input.buffer, { dims: input.dims });
      const extracted = await brainMask(new Uint8Array(meanB0), { assetPath: `${import.meta.env.BASE_URL}mindgrab/`, signal: controller.signal });
      brain = Uint8Array.from(readNiftiFrames(extracted.mask).data, (value) => (value > 0 ? 1 : 0));
      maskSource = `mindgrab-${mindgrab.version}-${extracted.backend}`;
      log.log(`MindGrab ${mindgrab.version} brain mask on ${extracted.backend}`, "info");
    }
    const indices = maskIndices(brain);
    if (!indices.length) throw new Error("The brain mask has no voxels. Supply a mask, or check the b0 volumes.");
    progress.begin(`Fitting ${indices.length} voxels…`);
    progress.setCancellable(true);
    status(`Fitting ${withNoddi ? "tensor and NODDI" : "tensor"} to ${indices.length} voxels`);
    const fit = await fitVolume({
      data: input.data,
      voxels: input.voxels,
      volumes: input.bvals.length,
      indices,
      bvals: input.bvals,
      bvecs: input.bvecs,
      weighted,
      noddi: withNoddi,
      signal: controller.signal,
      onProgress: (fraction) => progress.setProgress(fraction),
    });
    const stem = bidsStem(input.name);
    const dims = input.dims;
    const rows = {};
    const artifacts = [];
    for (const entry of outputEntries(fit, brain, stem)) {
      const nifti = createNiftiFromData(entry.data, input.buffer, { dims: [...dims, entry.frames] });
      const file = await niftiFile(nifti, entry.name);
      controller.signal.throwIfAborted();
      const range = entry.frames === 1 ? rangeOf(entry.model, entry.param) : undefined;
      rows[entry.role] = { description: entry.label, file, range, viewable: entry.frames === 1 };
      artifacts.push({ role: entry.role, file });
    }
    const first = rows["noddi-icvf"] ?? rows["tensor-fa"];
    await showVolume(first.file, first.range);
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end(`Fitted ${indices.length} voxels`);
    status(`Fitted ${indices.length} voxels · ${Object.keys(rows).length} maps`);
    return {
      artifacts,
      provenance: { method: withNoddi ? "dti+noddi-amico" : "dti", tensorFit: weighted ? "wls" : "ols", maskVoxels: indices.length, mask: maskSource },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    fitting = null;
    setBusy(false);
  }
}

/** Display window per map: the mask and fractions on 0–1, diffusivities to 3e-3 mm²/s. */
function rangeOf(model, param) {
  if (model === "noddi" || param === "fa" || param === "mask") return [0, 1];
  if (param === "s0") return undefined;
  return [0, 3e-3];
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
  fitting?.abort();
};
$("fitNoddi").addEventListener("change", () => {
  noddiRequested = $("fitNoddi").checked;
});
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
  void fitModels().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    fit: async ({ inputs, inputDetails, parameters, signal }) => {
      // DICOM is converted before this call; its bval and bvec arrive as sidecars of the image.
      const gradients = (inputDetails.image?.sidecars ?? []).filter((file) => /\.(bval|bvec)$/i.test(file.name));
      await loadFiles(Promise.resolve([...inputs.image, ...gradients, ...(inputs.bval ?? []), ...(inputs.bvec ?? [])]), signal);
      if (inputs.mask?.length) await loadMask(inputs.mask[0], signal);
      $("tensorFit").value = parameters.tensorFit;
      noddiRequested = parameters.noddi;
      $("fitNoddi").checked = noddiRequested && !input.table.noddiError;
      return fitModels(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  fitting?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
