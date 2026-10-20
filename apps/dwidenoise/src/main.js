// Dwidenoise: Patch2Self denoising of diffusion MRI (DIPY 1.12.1 version 1 port), in this browser.
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
import { createNiftiFromData, decodeNiftiBuffer, downloadFile, extractNiftiHeader, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { readDiffusionSeries, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import wasmUrl from "@neurodesk/dwidenoise/wasm?url";
import { APP } from "./config.js";
import { derivativeSidecar, outputNames, parseBvals } from "./pipeline.js";
import { denoiseSeries } from "./pool.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: "Dwidenoise",
  subtitle: "Patch2Self denoising",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// The main thread uses the module for the group rule and the one solve per group.
const patch2self = loadDwidenoise(fetch(wasmUrl));

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
$("aboutBtn").onclick = () => info.open("About Dwidenoise", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let input = null;
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
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
  results.inert = busy;
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
  status("Reading image…");
  try {
    const files = await filesPromise;
    const series = await readDiffusionSeries(files, { signal: controller.signal, anonymizeSidecar: true });
    controller.signal.throwIfAborted();
    if (series.length !== 1) throw new Error(`Choose one DWI; this selection has ${series.length} images.`);
    const [{ image, bval, bvec, sidecar }] = series;
    if (!bval) throw new Error(`Choose the .bval file with ${image.name}: Patch2Self groups volumes by b-value.`);
    const buffer = await decodeNiftiBuffer(await image.arrayBuffer());
    controller.signal.throwIfAborted();
    const frames = readNiftiFrames(buffer);
    const bvals = parseBvals(await bval.text(), frames.frames);
    const p2s = await patch2self;
    const groups = p2s.groups(bvals);
    await showVolume({ file: image }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    // Keep only the header (and extensions) of the decoded file: the volumes are in frames.data.
    input = { name: image.name, ...frames, headerBytes: extractNiftiHeader(buffer), bvals, bval, bvec, sidecar };
    clearOutputs();
    $("fileInfo").hidden = false;
    const gradients = ["bval", bvec && "bvec"].filter(Boolean).join(", ");
    const volumes = `${groups.b0.length} b0, ${groups.dwi.length} weighted`;
    $("fileInfo").textContent = `${image.name} · ${frames.dims.join("×")}×${frames.frames} · ${volumes} · ${gradients}`;
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

async function denoise(signal) {
  if (!input || loading || running) throw new Error("Load a DWI with its bval before denoising.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  running = controller;
  setBusy(true);
  clearOutputs();
  progress.begin(`Denoising ${input.frames} volumes…`);
  progress.setCancellable(true);
  try {
    const p2s = await patch2self;
    const groups = p2s.fittedGroups(input.bvals);
    const nvox = input.dims[0] * input.dims[1] * input.dims[2];
    const sizes = groups.map((group) => group.length).join(" and ");
    status(`Denoising ${input.frames} volumes in ${groups.length} group${groups.length === 1 ? "" : "s"} of ${sizes}`);
    let denoised = await denoiseSeries({
      data: input.data,
      nvox,
      frames: input.frames,
      groups,
      solve: (gram, group) => p2s.solve(gram, group),
      signal: controller.signal,
      onProgress: (fraction) => progress.setProgress(fraction),
    });
    controller.signal.throwIfAborted();
    const names = outputNames(input.name);
    const bytes = createNiftiFromData(denoised, input.headerBytes, { dims: [...input.dims, input.frames] });
    // Release the float32 result before compression, so the peak holds one fewer full copy.
    denoised = null;
    const image = await gzipFile(bytes, names.image);
    controller.signal.throwIfAborted();
    const rows = { image: { description: "Denoised image", file: image } };
    const artifacts = [{ role: "image", file: image }];
    for (const [role, description] of [["bval", "b-values (unchanged)"], ["bvec", "b-vectors (unchanged)"]]) {
      if (!input[role]) continue;
      const file = new File([input[role]], names[role]);
      rows[role] = { description, file, viewable: false };
      artifacts.push({ role, file });
    }
    const sidecar = new File([`${JSON.stringify(derivativeSidecar(input.sidecar), null, 2)}\n`], names.sidecar, { type: "application/json" });
    rows.sidecar = { description: "Sidecar", file: sidecar, viewable: false };
    artifacts.push({ role: "sidecar", file: sidecar });
    await showVolume({ file: image }, { signal: controller.signal });
    controller.signal.throwIfAborted();
    outputs = rows;
    results.render(rows);
    $("outputSection").open = true;
    progress.end("Denoised");
    status(`Denoised ${input.frames} volumes`);
    return {
      artifacts,
      provenance: { method: "patch2self-v1-dipy-1.12.1-port", model: "ols", patchRadius: 0, b0Threshold: p2s.B0_THRESHOLD, groups },
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
  void denoise().catch(report);
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    denoise: async ({ inputs, inputDetails, signal }) => {
      // DICOM is converted before this call; its bval and bvec arrive as sidecars of the image.
      const sidecars = inputDetails.image?.sidecars ?? [];
      await loadFiles(Promise.resolve([...inputs.image, ...sidecars, ...(inputs.bval ?? []), ...(inputs.bvec ?? [])]), signal);
      return denoise(signal);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
