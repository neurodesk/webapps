// BLAST-CT in the browser: 3D non-contrast head CT (NIfTI or DICOM) in, 4-class TBI lesion
// segmentation (IPH, EAH, oedema, IVH) and native-space volume CSV out.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  LabelLegend,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { MAX_NATIVE_VOXELS, MAX_WORKING_VOXELS } from "@neurodesk/blastct/geometry";
import { DEFAULT_MODEL_ID } from "@neurodesk/blastct/models";
import { lesionsCsv, measureLesions, writeLabelNifti } from "@neurodesk/blastct/results";
import { APP, CT_BRAIN_WINDOW, labelColormap, legendOf, normalizeBackend, outputName, stemName } from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  controlsContract: { privacy: "#privacyBtn" },
});

let viewer;
let viewerReady;
let viewQueue = Promise.resolve();
let viewRevision = 0;
let shownBase = null;

const layouts = {
  multiplanar: () => {
    viewer.sliceType = SLICE_TYPE.MULTIPLANAR;
    viewer.multiplanarType = MULTIPLANAR_TYPE.GRID;
    viewer.showRender = SHOW_RENDER.ALWAYS;
  },
  axial: () => { viewer.sliceType = SLICE_TYPE.AXIAL; },
  coronal: () => { viewer.sliceType = SLICE_TYPE.CORONAL; },
  sagittal: () => { viewer.sliceType = SLICE_TYPE.SAGITTAL; },
};

const toolbar = createViewerToolbar({
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "multiplanar", label: "3-Plane", active: true },
    { id: "axial", label: "Axial" },
    { id: "coronal", label: "Coronal" },
    { id: "sagittal", label: "Sagittal" },
  ].map((view) => ({
    ...view,
    onClick: () => {
      if (!viewer) return;
      layouts[view.id]();
      viewer.drawScene();
      toolbar.setActive(view.id);
    },
  })),
});
$("viewer").prepend(toolbar);

let overlayOpacity = 0.65;
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
const legend = new LabelLegend({ element: $("labelLegend") });

let ctFile = null;
let outputs = {};
let result = null;
const view = { overlay: true };
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "segmentation") view.overlay = !view.overlay;
    else if (stage === "ct") view.overlay = false;
    void show();
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  $("imageInput").disabled = busy;
  $("backend").disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !ctFile;
}

function begin(kind, message) {
  const controller = new AbortController();
  job = { kind, controller, worker: null };
  progress.begin(message);
  status(message);
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, value } = {}) {
  if (job !== current) return false;
  current.worker?.terminate();
  job = null;
  progress.end(message, { success });
  status(message, error);
  refreshControls();
  if (current.completion) {
    if (success) current.completion.resolve(value);
    else current.completion.reject(current.controller.signal.aborted ? current.controller.signal.reason : new Error(message));
  }
  return true;
}

function inputRows() {
  return ctFile ? { ct: { description: "Head CT input", file: ctFile } } : {};
}

function renderOutputs() {
  results.render(outputs);
  $("labelLegend").hidden = !result;
  if (result) {
    const { labels, metrics } = legendOf(result.summary);
    legend.render(labels, metrics);
  }
  $("outputSection").open = Boolean(result);
  for (const [index, key] of Object.keys(outputs).entries()) {
    const active = (key === "ct" && !view.overlay) || (key === "segmentation" && view.overlay);
    $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", active);
  }
}

function clearResults() {
  result = null;
  outputs = inputRows();
  renderOutputs();
}

async function ensureViewer() {
  viewerReady ??= (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false });
    await viewer.attachTo("gl1");
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}

function show() {
  const revision = ++viewRevision;
  renderOutputs();
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    if (!ctFile) return;
    const nv = await ensureViewer();
    const layers = [{
      url: ctFile,
      name: ctFile.name,
      calMin: CT_BRAIN_WINDOW.min,
      calMax: CT_BRAIN_WINDOW.max,
    }];
    const segmentation = view.overlay && outputs.segmentation?.file;
    if (segmentation) {
      layers.push({ url: segmentation, name: segmentation.name, opacity: overlayOpacity, isColorbarVisible: false });
    }
    const crosshair = shownBase === ctFile ? nv.getCrosshairPos() : null;
    await nv.loadVolumes(layers);
    if (segmentation) await nv.setColormapLabel(1, labelColormap());
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownBase = ctFile;
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error");
  });
  return viewQueue;
}

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  viewQueue = viewQueue.then(async () => {
    if (viewer?.volumes.length > 1) await viewer.setVolume(1, { opacity: overlayOpacity });
  }).catch((error) => log.log(error.message, "error"));
});

async function checkImage(file) {
  const description = await describeNiftiFile(file);
  if (description.dimensionality !== 3 || description.frames > 1) {
    throw new Error(
      `${file.name} is ${description.dims.join(" × ")}. BLAST-CT requires a single 3D non-contrast head CT volume.`,
    );
  }
  const nativeVoxels = description.dims[0] * description.dims[1] * description.dims[2];
  if (nativeVoxels > MAX_NATIVE_VOXELS) {
    throw new Error(
      `${file.name} has ${nativeVoxels.toLocaleString()} native voxels, exceeding the browser limit of ${MAX_NATIVE_VOXELS.toLocaleString()} voxels.`,
    );
  }
  const approxIsoVoxels =
    Math.ceil(description.dims[0] * description.spacingMm[0]) *
    Math.ceil(description.dims[1] * description.spacingMm[1]) *
    Math.ceil(description.dims[2] * description.spacingMm[2]);
  if (approxIsoVoxels > MAX_WORKING_VOXELS) {
    throw new Error(
      `${file.name} spans ~${approxIsoVoxels.toLocaleString()} voxels at 1 mm, exceeding the browser limit of ${MAX_WORKING_VOXELS.toLocaleString()} voxels.`,
    );
  }
  return description;
}

async function load(chosen, signal) {
  if (job) throw new Error("Wait for the current operation to finish or cancel it, then retry.");
  const current = begin("loading", "Reading head CT scan…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!chosen.length) throw new Error("Choose a 3D head CT NIfTI image or DICOM series.");
    const images = await readImageFiles(chosen, { signal: current.controller.signal });
    current.controller.signal.throwIfAborted();
    if (images.length !== 1) {
      throw new Error("Choose one 3D head CT NIfTI image or one DICOM series at a time.");
    }
    const [file] = images;
    const description = await checkImage(file);
    current.controller.signal.throwIfAborted();
    ctFile = file;
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    $("dropZone").classList.add("has-files");
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${description.dims.join(" × ")} · ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm`;
    $("emptyState").hidden = true;
    clearResults();
    end(current, `${file.name} loaded`);
    await show();
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function importFiles(filesPromise) {
  if (job) {
    log.log("Wait for the current operation to finish or cancel it before loading another scan.", "warn");
    return Promise.resolve();
  }
  exampleControl.cancel();
  return Promise.resolve(filesPromise)
    .then((chosen) => load(Array.from(chosen)))
    .catch((error) => status(error.message, true));
}

$("imageInput").addEventListener("change", (event) => {
  const chosen = Array.from(event.target.files);
  event.target.value = "";
  if (chosen.length) void importFiles(chosen);
});
bindFileDrop($("dropZone"), importFiles);

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    await load(fetched, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

const gzip = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

async function segment(onProgress = () => {}) {
  if (!ctFile || job) throw new Error("Load a 3D head CT scan and wait for the current step to finish.");
  const backend = normalizeBackend($("backend").value);
  clearResults();
  const current = begin("running", "Starting BLAST-CT segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const stem = stemName(ctFile.name);
  log.log(`BLAST-CT ${DEFAULT_MODEL_ID} on ${ctFile.name} (backend: ${backend})`);
  current.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  current.worker.onmessage = ({ data }) => {
    if (job !== current) return;
    if (data.type === "progress") {
      progress.setProgress(data.value, data.message);
      onProgress({ message: data.message, value: data.value });
    } else if (data.type === "log") {
      log.log(data.message);
    } else if (data.type === "error") {
      end(current, data.message, { success: false, error: true });
    } else if (data.type === "result") {
      void finish(current, data, stem).catch((error) => end(current, error.message, { success: false, error: true }));
    }
  };
  current.worker.onerror = (event) => {
    event.preventDefault?.();
    end(current, event.message || "The BLAST-CT worker failed. Reload the page and try again.", { success: false, error: true });
  };
  current.worker.onmessageerror = () => {
    end(current, "The BLAST-CT worker returned an unreadable message.", { success: false, error: true });
  };
  current.worker.postMessage({
    file: ctFile,
    modelId: DEFAULT_MODEL_ID,
    backend,
  });
  return current.completion.promise;
}

async function finish(current, data, stem) {
  const summary = measureLesions(data.labels, data.spacing);
  const niftiBytes = writeLabelNifti(data.labels, data.dims, data.headerBytes);
  const segFile = new File([await gzip(niftiBytes)], outputName(stem, "segmentation.nii.gz"), { type: "application/gzip" });
  const csvFile = new File([lesionsCsv(summary, stem)], outputName(stem, "volumes.csv"), { type: "text/csv" });
  if (job !== current) return;
  result = { summary };
  outputs = {
    ...inputRows(),
    segmentation: { description: "Lesion labels", file: segFile },
    volumes: { description: "Volumes (CSV)", file: csvFile, viewable: false },
  };
  view.overlay = true;
  for (const row of summary.classes) {
    log.log(`${row.shortLabel} (${row.label}): ${row.volumeMl.toFixed(2)} ml (${row.voxels} voxels)`);
  }
  log.log(`Total lesion burden: ${summary.totalVolumeMl.toFixed(2)} ml (${summary.totalVoxels} voxels)`);
  log.log(`Run: ${JSON.stringify(data.provenance)}`);
  const detected = summary.classes.filter((row) => row.voxels > 0).length;
  end(
    current,
    `Segmentation complete · ${summary.totalVolumeMl.toFixed(1)} ml across ${detected} ${detected === 1 ? "class" : "classes"}`,
    {
      value: {
        artifacts: [
          { role: "segmentation", file: segFile },
          { role: "volumes", file: csvFile },
        ],
        measurements: {
          totalVolumeMl: summary.totalVolumeMl,
          totalVoxels: summary.totalVoxels,
          classes: summary.classes.map(({ id, key, label, voxels, volumeMl }) => ({ id, key, label, voxels, volumeMl })),
        },
        provenance: data.provenance,
      },
    },
  );
  await show();
}

$("runButton").addEventListener("click", () => {
  void segment().catch((error) => {
    if (error.name !== "AbortError") status(error.message, true);
  });
});

function cancel() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort();
  end(current, current.kind === "running" ? "Segmentation cancelled" : "Loading cancelled", { success: false });
}
$("cancelButton").onclick = cancel;

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    segment: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      const chosen = inputs.image ?? [];
      await load(chosen, signal);
      signal.throwIfAborted();
      $("backend").value = normalizeBackend(parameters.backend ?? "auto");
      return runAbortable(signal, () => segment(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
