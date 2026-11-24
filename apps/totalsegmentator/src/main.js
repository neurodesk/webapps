// TotalSegmentator in the browser: CT and MRI whole-body, vertebrae and abdominal muscle
// segmentation with nnU-Net v2 models on WebGPU / WebAssembly.
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
  createMaskEditor,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { createElement } from "@neurodesk/webapp-components/core";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { readVolume } from "@neurodesk/synthsr";
import { colormapForTask } from "@neurodesk/totalsegmentator/labels";
import { taskById } from "@neurodesk/totalsegmentator/models";
import { segmentationResults } from "@neurodesk/totalsegmentator/results";
import { APP, describePlan, distinctGroups, filterReportRows } from "./config.js";
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
let editor = null;
let editing = null;
let shownSource = null;
let overlayVisible = true;
let overlayOpacity = 0.6;
let activeView = "multiplanar";

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

function setViewMode(id) {
  activeView = id;
  const isReport = id === "results";
  $("reportView").hidden = !isReport;
  toolbar.setActive(id);
  if (!isReport && viewer) {
    layouts[id]();
    viewer.drawScene();
  }
}

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
    { id: "results", label: "Results" },
  ].map((view) => ({
    ...view,
    onClick: () => setViewMode(view.id),
  })),
});
$("viewer").prepend(toolbar);
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// Loaded input scan (File + metadata) and optional multi-series list from DICOM conversion.
let source = null;
let seriesList = [];
let outputs = {};
let lastResult = null;
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running" || editing) return;
    if (stage === "segmentation") {
      overlayVisible = !overlayVisible;
      setViewMode(activeView === "results" ? "multiplanar" : activeView);
      void show();
    } else if (stage === "statistics") {
      setViewMode("results");
    } else {
      setViewMode(activeView === "results" ? "multiplanar" : activeView);
      void show();
    }
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
  onEdit: (stage, entry) => void editResult(stage, entry),
});

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

function selectedTaskParams() {
  const task = $("taskSelect").value;
  const spec = taskById(task);
  const resolution = spec.supportsResolution ? $("resolutionSelect").value : "full";
  const subset = spec.supportsResolution && resolution === "full" && spec.subsets
    ? ($("subsetSelect").value || "all")
    : "all";
  return { task, resolution, subset, backend: $("backend").value };
}

function syncTaskControls() {
  const task = $("taskSelect").value;
  const spec = taskById(task);
  $("resolutionField").hidden = !spec.supportsResolution;
  const showSubset = spec.supportsResolution && $("resolutionSelect").value === "full" && Boolean(spec.subsets);
  $("subsetField").hidden = !showSubset;
  if (spec.subsets) {
    const previous = $("subsetSelect").value;
    $("subsetSelect").replaceChildren(
      ...spec.subsets.map((entry) => createElement("option", { value: entry.id, text: entry.label })),
    );
    if (spec.subsets.some((entry) => entry.id === previous)) $("subsetSelect").value = previous;
  }
  $("modelHint").textContent = describePlan(selectedTaskParams());
}

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  $("imageInput").disabled = busy;
  $("seriesSelect").disabled = busy;
  $("taskSelect").disabled = busy;
  $("resolutionSelect").disabled = busy;
  $("subsetSelect").disabled = busy;
  $("backend").disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !source;
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

function closeEdit() {
  editing = null;
  const cancelled = editor?.cancel();
  results.setEditingEnabled(!editor || editor.session.state === "idle");
  return cancelled;
}

function renderReportTable() {
  const rows = lastResult?.rows ?? [];
  const tbody = $("reportTable").tBodies[0];
  if (!lastResult) {
    $("reportSummary").textContent = "Run segmentation to measure anatomical structures.";
    tbody.replaceChildren();
    return;
  }
  const modality = taskById(lastResult.task).modality;
  const unit = modality === "ct" ? "HU" : "a.u.";
  $("reportMeanHeader").textContent = `Mean (${unit})`;
  $("reportSdHeader").textContent = `SD (${unit})`;

  const filtered = filterReportRows(rows, {
    group: $("reportGroupFilter").value,
    query: $("reportSearch").value,
  });
  const totalMl = filtered.reduce((sum, r) => sum + r.ml, 0);
  $("reportSummary").textContent = `Showing ${filtered.length} of ${rows.length} detected structures · total ${totalMl.toFixed(1)} mL.`;

  tbody.replaceChildren(
    ...filtered.map((row) => createElement("tr", {}, [
      createElement("td", { className: "nd-numeric", text: String(row.id) }),
      createElement("td", { text: row.name }),
      createElement("td", { text: row.groupLabel }),
      createElement("td", { className: "nd-numeric", text: row.ml.toFixed(2) }),
      createElement("td", { className: "nd-numeric", text: row.mean === null ? "—" : row.mean.toFixed(1) }),
      createElement("td", { className: "nd-numeric", text: row.sd === null ? "—" : row.sd.toFixed(1) }),
    ])),
  );
}

function populateReportGroups(rows) {
  const groups = distinctGroups(rows);
  $("reportGroupFilter").replaceChildren(
    createElement("option", { value: "all", text: "All groups" }),
    ...groups.map((g) => createElement("option", { value: g.id, text: g.label })),
  );
  $("reportGroupFilter").value = "all";
  $("reportSearch").value = "";
}

function renderOutputs() {
  results.render(outputs);
  $("outputSection").open = Boolean(lastResult);
  for (const [index, key] of Object.keys(outputs).entries()) {
    const active = (key === "input" && activeView !== "results")
      || (key === "segmentation" && overlayVisible && activeView !== "results")
      || (key === "statistics" && activeView === "results");
    $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", active);
  }
  renderReportTable();
}

function clearResults() {
  closeEdit();
  lastResult = null;
  outputs = source ? { input: { description: "Input scan", file: source.file } } : {};
  populateReportGroups([]);
  if (activeView === "results") setViewMode("multiplanar");
  renderOutputs();
}

async function ensureViewer() {
  viewerReady ??= (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false });
    await viewer.attachTo("gl1");
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    editor = createMaskEditor({
      nv: viewer,
      onApply: async (_stage, editedFile) => {
        const session = editing;
        const edited = readVolume(await editedFile.arrayBuffer());
        if (editing !== session || !lastResult) return;
        const labels = Uint8Array.from(edited.data, (v) => Math.max(0, Math.min(255, Math.round(v))));
        const modality = taskById(lastResult.task).modality;
        const built = segmentationResults({
          labels,
          imageData: lastResult.imageData,
          dims: edited.dims,
          affine: edited.affine,
          task: lastResult.task,
          modality,
        }, source.file.name);
        const segFile = await gzipFile(built.segmentation.bytes, `${built.segmentation.name}.gz`, "application/gzip");
        const tableFile = new File([built.table.text], built.table.name, { type: "text/tab-separated-values" });
        lastResult = { ...lastResult, rows: built.rows, segFile, tableFile };
        outputs = {
          input: { description: "Input scan", file: source.file },
          segmentation: { description: "Segmentation mask", file: segFile, editable: true },
          statistics: { description: "Structure statistics (TSV)", file: tableFile, downloadableOnly: false },
        };
        populateReportGroups(built.rows);
        closeEdit();
        renderOutputs();
        status(`Mask updated · ${built.rows.length} structures`);
      },
      onCancel: () => closeEdit(),
    });
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
    if (!source?.file) return;
    const nv = await ensureViewer();
    const layers = [{ url: source.file, name: source.file.name }];
    const segFile = overlayVisible && outputs.segmentation?.file;
    if (segFile) {
      layers.push({ url: segFile, name: segFile.name, opacity: overlayOpacity, isColorbarVisible: false });
    }
    const crosshair = shownSource === source.file ? nv.getCrosshairPos() : null;
    await nv.loadVolumes(layers);
    if (segFile && lastResult) {
      await nv.setColormapLabel(1, colormapForTask(lastResult.task));
    }
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownSource = source.file;
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").textContent = `Could not display the image: ${error.message || error}`;
    $("viewerNotice").hidden = false;
  });
  return viewQueue;
}

async function editResult(stage, entry) {
  if (job || editing || !source || !lastResult) return;
  const session = {};
  editing = session;
  results.setEditingEnabled(false);
  overlayVisible = true;
  setViewMode(activeView === "results" ? "multiplanar" : activeView);
  try {
    await show();
    if (editing !== session) return;
    const cmap = colormapForTask(lastResult.task);
    if (!await editor.start({ stage, file: entry.file, label: "Segmentation mask", overlayIndex: 1, labelNames: cmap.labels })) {
      closeEdit();
    }
  } catch (error) {
    if (editing !== session) return;
    status(error.message, true);
    closeEdit();
  }
}

async function gzipFile(bytes, name, type) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = await new Response(stream).arrayBuffer();
  return new File([compressed], name, { type });
}

function describeVolume(file, volume) {
  const spacing = [0, 1, 2].map((a) => Math.hypot(volume.affine[0][a], volume.affine[1][a], volume.affine[2][a]).toFixed(2));
  return `${file.name} · ${volume.dims.join(" × ")} · ${spacing.join(" × ")} mm`;
}

async function selectSeries(index) {
  const picked = seriesList[index];
  if (!picked) return;
  const vol = readVolume(await picked.file.arrayBuffer());
  source = { file: picked.file, dims: vol.dims, affine: vol.affine };
  $("fileInfo").textContent = describeVolume(picked.file, vol);
  $("fileInfo").hidden = false;
  $("emptyState").hidden = true;
  $("dropZone").classList.add("has-files");
  clearResults();
  await show();
}

async function loadInputFiles(fileList, { signal, assertCurrent = () => {} } = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const current = begin("loading", "Reading scan…");
  const abort = () => current.controller.abort(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
  signal?.addEventListener("abort", abort, { once: true });
  const activeSignal = current.controller.signal;
  try {
    activeSignal.throwIfAborted();
    const images = await readImageFiles(files, { signal: activeSignal });
    assertCurrent();
    activeSignal.throwIfAborted();
    if (job !== current) return;

    if (!images?.length) throw new Error("No readable 3D NIfTI or DICOM volume found.");
    const list = images.map((file) => ({ file, label: file.name }));
    const firstVol = readVolume(await list[0].file.arrayBuffer());
    assertCurrent();
    activeSignal.throwIfAborted();
    if (job !== current) return;

    seriesList = list;
    $("seriesField").hidden = list.length <= 1;
    $("seriesSelect").replaceChildren(
      ...list.map((entry, idx) => createElement("option", { value: String(idx), text: entry.label })),
    );
    source = { file: list[0].file, dims: firstVol.dims, affine: firstVol.affine };
    $("fileInfo").textContent = describeVolume(list[0].file, firstVol);
    $("fileInfo").hidden = false;
    $("emptyState").hidden = true;
    $("dropZone").classList.add("has-files");
    clearResults();
    end(current, `Ready · ${list[0].file.name}`);
    await show();
  } catch (error) {
    const cancelled = error?.name === "AbortError" || activeSignal.aborted;
    end(current, cancelled ? "Cancelled" : (error.message || "Could not load scan"), { success: false, error: !cancelled });
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function runSegmentation(overrideParams = null, reportProgress = null) {
  if (!source) return Promise.reject(new Error("Load a CT or MRI scan first."));
  if (job) return Promise.reject(new Error("A job is already running."));
  closeEdit();
  const params = overrideParams ? { ...selectedTaskParams(), ...overrideParams } : selectedTaskParams();
  const current = begin("running", "Starting TotalSegmentator…");

  return new Promise((resolve, reject) => {
    current.completion = { resolve, reject };
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    current.worker = worker;

    worker.onmessage = async ({ data }) => {
      if (job !== current) return;
      if (data.type === "progress") {
        progress.setProgress(data.value, data.message);
        reportProgress?.(data.value, data.message);
        return;
      }
      if (data.type === "log") {
        log.log(data.message, "info");
        return;
      }
      if (data.type === "error") {
        end(current, data.message || "Segmentation failed", { success: false, error: true });
        return;
      }
      if (data.type === "result") {
        try {
          progress.setProgress(0.98, "Writing outputs…");
          const modality = taskById(params.task).modality;
          const built = segmentationResults({
            labels: data.labels,
            imageData: data.imageData,
            dims: data.dims,
            affine: data.affine,
            task: params.task,
            modality,
          }, source.file.name);
          const segFile = await gzipFile(built.segmentation.bytes, `${built.segmentation.name}.gz`, "application/gzip");
          const tableFile = new File([built.table.text], built.table.name, { type: "text/tab-separated-values" });
          if (job !== current) return;

          lastResult = {
            task: params.task,
            rows: built.rows,
            imageData: data.imageData,
            segFile,
            tableFile,
            provenance: data.provenance,
          };
          overlayVisible = true;
          outputs = {
            input: { description: "Input scan", file: source.file },
            segmentation: { description: "Segmentation mask", file: segFile, editable: true },
            statistics: { description: "Structure statistics (TSV)", file: tableFile },
          };
          populateReportGroups(built.rows);
          const summary = `Segmentation complete · ${built.rows.length} structures (${data.provenance.seconds} s)`;
          end(current, summary, {
            success: true,
            value: {
              artifacts: [
                { role: "segmentation", file: segFile },
                { role: "statistics", file: tableFile },
              ],
              measurements: { structures: built.rows },
              provenance: data.provenance,
            },
          });
          await show();
        } catch (error) {
          end(current, error.message || "Failed to write outputs", { success: false, error: true });
        }
      }
    };

    worker.onerror = (event) => {
      if (job !== current) return;
      end(current, event.message || "Worker error", { success: false, error: true });
    };

    worker.postMessage({
      file: source.file,
      task: params.task,
      resolution: params.resolution,
      subset: params.subset,
      backend: params.backend,
    });
  });
}

// Wire controls.
const exampleControl = createExampleSelector({
  examples,
  scope: $("controls"),
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    await loadInputFiles(fetched, { signal, assertCurrent });
  },
});
$("exampleControl").append(exampleControl);

bindFileDrop($("dropZone"), (dropped) => {
  void loadInputFiles(dropped).catch(() => {});
});
$("imageInput").addEventListener("change", (event) => {
  void loadInputFiles(event.target.files).catch(() => {});
});
$("seriesSelect").addEventListener("change", (event) => {
  void selectSeries(Number(event.target.value));
});
$("taskSelect").addEventListener("change", () => syncTaskControls());
$("resolutionSelect").addEventListener("change", () => syncTaskControls());
$("subsetSelect").addEventListener("change", () => syncTaskControls());
$("runButton").addEventListener("click", () => {
  void runSegmentation().catch(() => {});
});
$("cancelButton").addEventListener("click", () => {
  if (!job) return;
  job.controller.abort(new DOMException("Cancelled by user", "AbortError"));
  end(job, "Cancelled", { success: false });
});

toolbar.control("overlayOpacity").addEventListener("input", (event) => {
  overlayOpacity = Number(event.target.value);
  toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;
  if (viewer?.volumes.length > 1) {
    void viewer.setVolume(1, { opacity: overlayVisible ? overlayOpacity : 0 });
  }
});

$("reportGroupFilter").addEventListener("change", () => renderReportTable());
$("reportSearch").addEventListener("input", () => renderReportTable());
$("downloadStatsBtn").addEventListener("click", () => {
  if (lastResult?.tableFile) downloadFile(lastResult.tableFile);
});

syncTaskControls();
refreshControls();
renderReportTable();

function cancelJob() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort(new DOMException("Cancelled by user", "AbortError"));
  end(current, "Cancelled", { success: false });
}

// WebMCP / browser automation registration.
registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    segment: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      if (inputs?.image?.length) {
        await runAbortable(signal, () => loadInputFiles(inputs.image, { signal }), cancelJob);
      }
      signal.throwIfAborted();
      if (parameters?.task) $("taskSelect").value = parameters.task;
      if (parameters?.resolution && !$("resolutionField").hidden) $("resolutionSelect").value = parameters.resolution;
      syncTaskControls();
      if (parameters?.subset && !$("subsetField").hidden) $("subsetSelect").value = parameters.subset;
      if (parameters?.backend) $("backend").value = parameters.backend;
      syncTaskControls();
      return runAbortable(signal, () => runSegmentation(parameters, reportProgress), cancelJob);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancelJob();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
