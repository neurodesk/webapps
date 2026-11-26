// AURORA in the browser: prepared 1 mm SRI24/BraTS T1c MRI in, two-region brain metastasis labels,
// channel masks, lesion count and volume table out.
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
import { ATLAS_DIMS } from "@neurodesk/aurora";
import { DEFAULT_MODEL_ID } from "@neurodesk/aurora/models";
import { segmentationResults, stemName } from "@neurodesk/aurora/results";
import { APP, labelColormap, legendOf, normalizeThreshold } from "./config.js";
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

let t1cFile = null;
let outputs = {};
let result = null;
const view = { overlay: true };
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "segmentation") view.overlay = !view.overlay;
    else if (stage === "t1c") view.overlay = false;
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
  $("threshold").disabled = busy;
  $("backend").disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !t1cFile;
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
  return t1cFile ? { t1c: { description: "T1c input", file: t1cFile } } : {};
}

function renderOutputs() {
  results.render(outputs);
  $("labelLegend").hidden = !result;
  if (result) {
    const { labels, metrics } = legendOf(result.rows);
    legend.render(labels, metrics);
  }
  $("outputSection").open = Boolean(result);
  for (const [index, key] of Object.keys(outputs).entries()) {
    const active = (key === "t1c" && !view.overlay) || (key === "segmentation" && view.overlay);
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
    if (!t1cFile) return;
    const nv = await ensureViewer();
    const layers = [{ url: t1cFile, name: t1cFile.name }];
    const segmentation = view.overlay && outputs.segmentation?.file;
    if (segmentation) {
      layers.push({ url: segmentation, name: segmentation.name, opacity: overlayOpacity, isColorbarVisible: false });
    }
    const crosshair = shownBase && nv.getCrosshairPos();
    await nv.loadVolumes(layers);
    if (segmentation) await nv.setColormapLabel(1, labelColormap());
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownBase = t1cFile;
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
  if (!/\.nii(\.gz)?$/i.test(file.name)) {
    throw new Error(`${file.name} is not a NIfTI image. AURORA reads .nii or .nii.gz.`);
  }
  const description = await describeNiftiFile(file);
  const onGrid = description.dims.length === 3 && description.dims.every((n, a) => n === ATLAS_DIMS[a]);
  if (!onGrid || description.spacingMm.some((mm) => Math.abs(mm - 1) > 1e-3)) {
    throw new Error(
      `${file.name} is ${description.dims.join(" × ")} at ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm. AURORA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid.`,
    );
  }
  return description;
}

async function load(chosen, signal) {
  if (job) throw new Error("Wait for the current operation to finish or cancel it, then retry.");
  const current = begin("loading", "Reading T1c image…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (chosen.length !== 1) throw new Error("Choose one prepared T1c NIfTI image.");
    const [file] = chosen;
    const description = await checkImage(file);
    current.controller.signal.throwIfAborted();
    t1cFile = file;
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
    log.log("Wait for the current operation to finish or cancel it before loading another image.", "warn");
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
  if (!t1cFile || job) throw new Error("Load a prepared T1c image and wait for the current step to finish.");
  const threshold = normalizeThreshold($("threshold").value);
  clearResults();
  const current = begin("running", "Starting AURORA segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const name = stemName(t1cFile.name);
  log.log(`AURORA ${DEFAULT_MODEL_ID} on ${t1cFile.name} (threshold ${threshold.toFixed(2)})`);
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
      void finish(current, data, name).catch((error) => end(current, error.message, { success: false, error: true }));
    }
  };
  current.worker.onerror = (event) => {
    event.preventDefault?.();
    end(current, event.message || "The AURORA worker failed. Reload the page and try again.", { success: false, error: true });
  };
  current.worker.onmessageerror = () => {
    end(current, "The AURORA worker returned an unreadable message.", { success: false, error: true });
  };
  current.worker.postMessage({
    file: t1cFile,
    modelId: DEFAULT_MODEL_ID,
    threshold,
    backend: $("backend").value,
  });
  return current.completion.promise;
}

async function finish(current, data, name) {
  const { segmentation, wholeMask, enhancingMask, table, rows, lesions } = segmentationResults(data, name);
  const segFile = new File([await gzip(segmentation.bytes)], `${segmentation.name}.gz`, { type: "application/gzip" });
  const wholeFile = new File([await gzip(wholeMask.bytes)], `${wholeMask.name}.gz`, { type: "application/gzip" });
  const enhFile = new File([await gzip(enhancingMask.bytes)], `${enhancingMask.name}.gz`, { type: "application/gzip" });
  const tableFile = new File([table.text], table.name, { type: "text/tab-separated-values" });
  if (job !== current) return;
  result = { rows, lesions };
  outputs = {
    ...inputRows(),
    segmentation: { description: "Metastasis labels", file: segFile },
    whole_mask: { description: "Whole lesion mask", file: wholeFile, viewable: false },
    metastasis_mask: { description: "Metastasis mask", file: enhFile, viewable: false },
    volumes: { description: "Volumes (TSV)", file: tableFile, viewable: false },
  };
  view.overlay = true;
  for (const row of rows) log.log(`${row.name}: ${row.ml.toFixed(3)} ml (${row.voxels} voxels)`);
  log.log(`Metastasis lesions (26-connected, >= 5 voxels): ${lesions.length}`);
  log.log(`Run: ${JSON.stringify(data.provenance)}`);
  const whole = rows.find(({ id }) => id === "WL");
  const met = rows.find(({ id }) => id === "MET");
  end(
    current,
    `Segmentation complete · ${lesions.length} ${lesions.length === 1 ? "lesion" : "lesions"} · whole ${whole.ml.toFixed(1)} ml, metastasis ${met.ml.toFixed(1)} ml`,
    {
      value: {
        artifacts: [
          { role: "segmentation", file: segFile },
          { role: "whole_mask", file: wholeFile },
          { role: "metastasis_mask", file: enhFile },
          { role: "volumes", file: tableFile },
        ],
        measurements: { volumes: rows, metastasisLesionCount: lesions.length },
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
  operations: {
    segment: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      const chosen = inputs.t1c ?? [];
      await load(chosen, signal);
      signal.throwIfAborted();
      $("threshold").value = String(normalizeThreshold(parameters.threshold ?? 0.5));
      $("backend").value = parameters.backend ?? "auto";
      return runAbortable(signal, () => segment(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
