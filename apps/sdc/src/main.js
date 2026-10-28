// SDC: susceptibility field from a reverse phase-encoding b = 0 pair (PyHySCO port), in this browser.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVueGPU, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
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
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { APP } from "./config.js";
import { b0Frames, fieldExecution, fieldProvenance, fieldSidecar, meanFrames, outputNames, selectBidsPair, selectPair, voxelSizes } from "./pipeline.js";
import { estimateField } from "./estimate.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "SDC",
  subtitle: "Reverse phase-encoding distortion correction",
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
    void showVolume({ file: result.file }).catch((error) => status(error.message, true));
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

function setBusy(busy) {
  $("imageInput").disabled = busy;
  $("resultList").inert = busy;
  exampleControl?.setDisabled(busy);
  $("reference").disabled = busy || !pair;
  $("runButton").disabled = busy || !pair;
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
$("reference").addEventListener("change", () => {
  if ($("reference").value === "1") pair = [pair[1], pair[0]];
  clearOutputs();
  renderPair();
});
bindFileDrop($("dropZone"), importFiles);
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
  void estimate().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    pyhysco: async ({ inputs, inputDetails, signal }) => {
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
