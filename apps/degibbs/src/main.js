// Degibbs: Gibbs-ringing removal by local subvoxel shifts (MRtrix mrdegibbs port), in this browser.
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
import { assertNiftiDecodedSize, createNiftiFromData, decodeNiftiBuffer, downloadFile, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { bidsDiffusionSeries, chooseBidsRun, chosenBidsRun } from "@neurodesk/webapp-components/file-io/bids";
import { imageFiles, registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { sliceAxes } from "@neurodesk/degibbs";
import { gzipFile, sidecarText } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { derivativeSidecar, outputNames } from "@neurodesk/degibbs/outputs";
import { APP } from "./config.js";
import { correctVolumes } from "./pool.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Degibbs",
  subtitle: "Gibbs-ringing removal",
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
$("aboutBtn").onclick = () => info.open("About Degibbs", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let input = null;
let loading = null;
let running = null;
let outputs = {};
// The loaded BIDS folder's files and runs, so another run can be chosen without a new drop.
let folder = null;

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

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  $("imageInput").disabled = busy;
  $("runSelect").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

/** Show the run selector for a BIDS folder with more than one DWI run. A run without its gradient tables is disabled. */
function showRuns(runs, index) {
  const option = (run, i) => {
    const text = run.missing.length ? `${run.label} (no ${run.missing.join(", ")})` : run.label;
    const item = new Option(text, String(i), false, i === index);
    item.disabled = run.missing.length > 0;
    return item;
  };
  $("runSelect").replaceChildren(...(runs ?? []).map(option));
  $("runField").hidden = !runs || runs.length < 2;
}

async function loadFiles(filesPromise, signal, runIndex = null) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  loading = controller;
  setBusy(true);
  progress.begin("Reading image…");
  status("Reading image…");
  try {
    const files = await filesPromise;
    const runs = await bidsDiffusionSeries(files, { require: [] });
    // A folder loads the run last chosen from the same files (Undo gives them back), else its first complete run.
    const index = runs ? (runIndex ?? chosenBidsRun(runs)) : 0;
    const series = runs ? [runs[index]] : await readDiffusionSeries(files, { signal: controller.signal, anonymizeSidecar: true });
    controller.signal.throwIfAborted();
    if (series.length !== 1) throw new Error(`Choose one image; this selection has ${series.length}.`);
    const [{ image, bval, bvec, sidecar }] = series;
    await assertNiftiDecodedSize(image);
    const buffer = await decodeNiftiBuffer(await image.arrayBuffer());
    controller.signal.throwIfAborted();
    const frames = readNiftiFrames(buffer);
    const axes = sliceAxes(sidecar?.SliceEncodingDirection);
    await showVolume({ file: image }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    input = { name: image.name, buffer, ...frames, bval, bvec, sidecar };
    if (runs) chooseBidsRun(runs, index);
    folder = runs ? { files, runs, index } : null;
    showRuns(runs, index);
    clearOutputs();
    $("sliceAxes").value = axes.join(",");
    $("fileInfo").hidden = false;
    const gradients = [bval && "bval", bvec && "bvec"].filter(Boolean).join(", ");
    $("fileInfo").textContent = `${image.name} · ${frames.dims.join("×")}${frames.frames > 1 ? `×${frames.frames}` : ""}${gradients ? ` · ${gradients}` : ""}`;
    $("dropZone").classList.add("has-files");
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
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

async function removeRinging(signal) {
  if (!input || loading || running) throw new Error("Load an image before removing ringing.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  const axes = $("sliceAxes").value.split(",").map(Number);
  progress.begin(`Removing ringing from ${input.frames} volume${input.frames === 1 ? "" : "s"}…`);
  progress.setCancellable(true);
  status(`Removing ringing from ${input.frames} volumes, slice axes ${axes.map((a) => a + 1).join(" and ")}`);
  try {
    const corrected = await correctVolumes({
      data: input.data,
      dims: input.dims,
      frames: input.frames,
      axes,
      signal: controller.signal,
      onProgress: (fraction) => progress.setProgress(fraction),
    });
    controller.signal.throwIfAborted();
    const names = outputNames(input.name);
    const dims = input.frames > 1 ? [...input.dims, input.frames] : input.dims;
    const image = await gzipFile(createNiftiFromData(corrected, input.buffer, { dims }), names.image);
    controller.signal.throwIfAborted();
    const rows = { image: { description: "Corrected image", file: image } };
    const artifacts = [{ role: "image", file: image }];
    for (const [role, description] of [["bval", "b-values (unchanged)"], ["bvec", "b-vectors (unchanged)"]]) {
      if (!input[role]) continue;
      const file = new File([input[role]], names[role]);
      rows[role] = { description, file, viewable: false };
      artifacts.push({ role, file });
    }
    const sidecar = new File([sidecarText(derivativeSidecar(input.sidecar))], names.sidecar, { type: "application/json" });
    rows.sidecar = { description: "Sidecar", file: sidecar, viewable: false };
    artifacts.push({ role: "sidecar", file: sidecar });
    await showVolume({ file: image }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Ringing removed");
    status(`Ringing removed from ${input.frames} volume${input.frames === 1 ? "" : "s"}`);
    return { artifacts, provenance: { method: "mrdegibbs-3.0.8-port", sliceAxes: axes, nshifts: 20, minW: 1, maxW: 3 } };
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
bindFileDrop($("dropZone"), importFiles);
$("runSelect").addEventListener("change", (event) => {
  if (!folder) return;
  const loaded = folder.index;
  exampleControl.cancel();
  void loadFiles(Promise.resolve(folder.files), undefined, Number(event.target.value)).catch((error) => {
    event.target.value = String(loaded);
    report(error);
  });
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
  void removeRinging().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    degibbs: async ({ inputs, inputDetails, parameters, signal }) => {
      await loadFiles(Promise.resolve(imageFiles(inputs, inputDetails)), signal);
      if (parameters.sliceAxes) $("sliceAxes").value = parameters.sliceAxes;
      return removeRinging(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
