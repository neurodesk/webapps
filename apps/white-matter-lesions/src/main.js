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
  ProgressManager,
  createMaskEditor,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { readVolume } from "@neurodesk/synthsr";
import { APP } from "./config.js";
import { applyMaskEdit, lesionSummary, segmentationOutputs } from "./outputs.js";
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
// A token for the open edit, so a reset that discards it also ignores its late callbacks.
let editing = null;
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
  overlay: false,
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
const log = createConsole({ id: "technicalLog" });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let source = null;
let outputs = {};
// One job at a time: loading an image or segmenting it. Cancel aborts the job and ends its worker.
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (editing) return;
    show(stage);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
  onEdit: (stage, result) => void editResult(stage, result),
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
  $("skullStripped").disabled = busy;
  $("backend").disabled = busy;
  $("folds").disabled = busy;
  $("runButton").disabled = busy || !source;
}

function begin(phase, message) {
  const controller = new AbortController();
  job = { phase, controller, worker: null };
  progress.begin(message);
  status(message);
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, result } = {}) {
  if (job !== current) return false;
  current.worker?.terminate();
  job = null;
  progress.end(message, { success });
  status(message, error);
  refreshControls();
  if (current.completion) {
    if (success) current.completion.resolve(result);
    else current.completion.reject(current.controller.signal.aborted
      ? current.controller.signal.reason : new Error(message));
  }
  return true;
}

function closeEdit() {
  editing = null;
  const cancelled = editor?.cancel();
  results.setEditingEnabled(!editor || editor.session.state === 'idle');
  return cancelled;
}

async function editResult(stage, result) {
  if (job || editing || !source) return;
  const session = {};
  editing = session;
  results.setEditingEnabled(false);
  try {
    await show(stage);
    if (editing !== session) return;
    if (!await editor.start({ stage, file: result.file, label: "Lesion mask", overlayIndex: 1 })) closeEdit();
  } catch (error) {
    if (editing !== session) return;
    status(error.message, true);
    closeEdit();
  }
}

function renderOutputs() {
  results.render(outputs);
  $("outputSection").open = Object.keys(outputs).length > 1;
}

async function ensureViewer() {
  viewerReady ??= (async () => {
    viewer = new NiiVue({ isDragDropEnabled: false });
    await viewer.attachTo("gl1");
    layouts.multiplanar();
    viewer.isLegendVisible = false;
    editor = createMaskEditor({
      nv: viewer,
      onApply: async (stage, file, { original }) => {
        const session = editing;
        const volume = readVolume(await file.arrayBuffer());
        if (editing !== session) return;
        closeEdit();
        outputs = applyMaskEdit(outputs, file, original, volume);
        renderOutputs();
        status(`${outputs.mask.description} · edited`);
        await show(stage);
      },
      onCancel: () => {
        if (!editing) return;
        status("Edit discarded");
        closeEdit();
      },
      onError: (_stage, error) => status(error.message, true),
    });
    editor.addEventListener("nd-mask-edit-end", () => results.setEditingEnabled(true));
    editor.addEventListener("nd-mask-edit-start", ({ detail }) => status(detail.message));
    toolbar.after(editor);
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
    return viewer;
  })();
  return viewerReady;
}

// The FLAIR stays underneath; a result is drawn over it.
function show(stage) {
  const revision = ++viewRevision;
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision || !source) return;
    const nv = await ensureViewer();
    const layers = [{ url: source, name: source.name }];
    if (stage === "mask") layers.push({ url: outputs.mask.file, name: outputs.mask.file.name, colormap: "red", opacity: 0.7 });
    if (stage === "probability") layers.push({
      url: outputs.probability.file,
      name: outputs.probability.file.name,
      colormap: "warm",
      calMin: 0.1,
      calMax: 1,
      isTransparentBelowCalMin: true,
      opacity: 0.7,
    });
    await nv.loadVolumes(layers);
    if (revision !== viewRevision) return;
    $("gl1").hidden = false;
    $("emptyState").hidden = true;
    $("viewerNotice").hidden = true;
    for (const [index, key] of Object.keys(outputs).entries()) {
      $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", key === stage);
    }
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error");
  });
  return viewQueue;
}

async function loadFiles(filesPromise, signal) {
  if (job) throw new Error("Wait for the current step to finish or cancel it, then retry.");
  const current = begin("loading", "Reading image…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  source = null;
  const cancelled = closeEdit();
  outputs = {};
  renderOutputs();
  ++viewRevision;
  $("gl1").hidden = true;
  $("emptyState").hidden = false;
  $("location").textContent = "";
  $("fileInfo").hidden = true;
  $("dropZone").classList.remove("has-files");
  try {
    await cancelled;
    current.controller.signal.throwIfAborted();
    const files = await filesPromise;
    current.controller.signal.throwIfAborted();
    const images = await readImageFiles(files, { signal: current.controller.signal });
    current.controller.signal.throwIfAborted();
    if (images.length !== 1) throw new Error("Choose one FLAIR image: a NIfTI file or one DICOM series.");
    const volume = readVolume(await images[0].arrayBuffer());
    current.controller.signal.throwIfAborted();
    source = images[0];
    outputs = { flair: { description: "FLAIR", file: source } };
    renderOutputs();
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${source.name} · ${volume.dims.join(" × ")} voxels`;
    $("dropZone").classList.add("has-files");
    end(current, "FLAIR loaded · ready to segment lesions");
    await show("flair");
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function importFiles(filesPromise) {
  exampleControl.cancel();
  return loadFiles(filesPromise).catch((error) => status(error.message, true));
}

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

async function resolveBackend(requested) {
  if (requested !== "auto") return requested;
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  return adapter ? "webgpu" : "wasm";
}

async function segment(parameters, onProgress = () => {}) {
  if (!source || job) throw new Error("Load a FLAIR image and wait for the current step to finish.");
  const current = begin("running", "Starting lesion segmentation…");
  current.completion = Promise.withResolvers();
  // Cancellation may settle the operation while adapter discovery is still pending.
  void current.completion.promise.catch(() => {});
  const inputName = source.name;
  const cancelled = closeEdit();
  outputs = { flair: outputs.flair };
  renderOutputs();
  try {
    await cancelled;
    if (job !== current) return current.completion.promise;
    show("flair");
    const backend = await resolveBackend(parameters.backend);
    if (job !== current) return current.completion.promise;
    current.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    current.worker.onmessage = ({ data }) => {
      if (job !== current) return;
      if (data.type === "progress") {
        progress.setProgress(data.value, data.message);
        onProgress({ message: data.message, value: data.value });
        log.log(data.message);
      } else if (data.type === "log") {
        log.log(data.message);
      } else if (data.type === "error") {
        end(current, data.message, { success: false, error: true });
      } else if (data.type === "result") {
        const summary = lesionSummary(data.summary);
        Object.assign(outputs, segmentationOutputs(inputName, data));
        renderOutputs();
        log.log(JSON.stringify(data.provenance));
        end(current, `Segmentation complete · ${summary}`, { result: {
          artifacts: ["mask", "probability", "table"].map((role) => ({ role, file: outputs[role].file })),
          measurements: data.summary,
          provenance: data.provenance,
        } });
        show("mask");
      }
    };
    current.worker.onerror = (event) => {
      end(current, event.message || "The processing worker failed. Reload and try again.", { success: false, error: true });
    };
    current.worker.postMessage({ file: source, backend, folds: parameters.folds, skullStripped: parameters.skullStripped });
  } catch (error) {
    end(current, error.message, { success: false, error: true });
  }
  return current.completion.promise;
}

$("runButton").addEventListener("click", () => {
  void segment({
    backend: $("backend").value,
    folds: Number($("folds").value),
    skullStripped: $("skullStripped").checked,
  }).catch((error) => {
    if (error.name !== "AbortError") status(error.message, true);
  });
});

registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    segment: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      await loadFiles(Promise.resolve(inputs.image), signal);
      signal.throwIfAborted();
      $("backend").value = parameters.backend;
      $("folds").value = String(parameters.folds);
      $("skullStripped").checked = parameters.skullStripped;
      return runAbortable(signal, () => segment(parameters, reportProgress), cancel);
    },
  },
});

function cancel() {
  exampleControl.cancel();
  if (!job) return;
  const current = job;
  current.controller.abort();
  end(current, "Cancelled", { success: false });
}
$("cancelButton").onclick = cancel;
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
