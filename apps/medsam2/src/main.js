// MedSAM2: interactive 3D MRI and CT segmentation with SAM 2.1 Hiera-Tiny (512×512).
// Prompt view provides pixel-exact point/box prompting and live 2D/3D mask preview;
// 3-Plane/Axial/Coronal/Sagittal/3D views host NiiVue and the shared nd-mask-editor.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./medsam2.css";
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
import { downloadFile, decodeNiftiBuffer, readNiftiImageData } from "@neurodesk/webapp-components/file-io";
import { orientToRAS } from "@neurodesk/webapp-components/volume";
import { readImageFiles, runDcm2niix } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, createNiivueAdapter } from "@neurodesk/webapp-components/automation";
import workerUrl from "./worker.js?worker&url";
import { APP, MODEL, WINDOW_PRESETS } from "./config.js";
import {
  computeWindow,
  exportLabelsNifti,
  extractLabelSlice,
  extractSliceUint8,
  readNifti3D,
  sliceGeometry,
  toNativeLabels,
} from "./volume.js";
import {
  boxFromCorners,
  clickPixel,
  commitObject3D,
  hasPrompt,
  measureObjects3D,
  objectsTsv,
  parsePrompts,
  reconcileObjectsFromLabels,
  uncommitObject,
} from "./segmentation.js";
import { greyRgba, overlayRgba } from "./display.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const DRAG_PIXELS = 4;

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Interactive 3D medical segmentation",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

for (const preset of WINDOW_PRESETS) {
  $("windowPreset").append(new Option(preset.label, preset.id));
}

const niivueLayouts = {
  multiplanar: (nv) => {
    nv.sliceType = SLICE_TYPE.MULTIPLANAR;
    nv.multiplanarType = MULTIPLANAR_TYPE.GRID;
    nv.showRender = SHOW_RENDER.ALWAYS;
  },
  axial: (nv) => { nv.sliceType = SLICE_TYPE.AXIAL; },
  coronal: (nv) => { nv.sliceType = SLICE_TYPE.CORONAL; },
  sagittal: (nv) => { nv.sliceType = SLICE_TYPE.SAGITTAL; },
  render: (nv) => { nv.sliceType = SLICE_TYPE.RENDER; },
};

let activeView = "prompt";
let overlayOpacity = 0.5;
let viewer = null;
let viewerReady = null;
let editor = null;
let editing = null;
let viewQueue = Promise.resolve();
let viewRevision = 0;

const toolbar = createViewerToolbar({
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
  views: [
    { id: "prompt", label: "Prompt", active: true },
    { id: "multiplanar", label: "3-Plane" },
    { id: "axial", label: "Axial" },
    { id: "coronal", label: "Coronal" },
    { id: "sagittal", label: "Sagittal" },
    { id: "render", label: "3D" },
  ].map((view) => ({
    ...view,
    onClick: () => void switchView(view.id),
  })),
});
$("viewer").prepend(toolbar);
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;

const log = createConsole({
  id: "technicalLog",
  resizable: true,
  channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }],
});
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// Session state.
let seriesList = [];
let sourceFile = null;
let volume = null;
let intensityWindow = { lo: 0, hi: 1 };
let axis = "axial";
let currentSlice = 0;
let labels = null;
let objects = [];
let nextId = 1;
let prompt = { points: [], box: null };
let promptOrder = [];
let pending = null;
let pending3D = null;
let promptVersion = 0;
let volumeGeneration = 0;
let decoding = null;
let decodeRun = null;
let loading = null;
let propagating = null;
let negativeTool = false;
let outputs = {};

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function report(error) {
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

function geom() {
  return volume ? sliceGeometry(volume.dims, axis) : { width: 0, height: 0, depth: 0 };
}

function baseName() {
  return (sourceFile?.name || "volume").replace(/\.nii(\.gz)?$/i, "");
}

// ---------------------------------------------------------------------------------------------
// 2D Prompt canvas.

const promptCanvas = $("promptCanvas");
const context = promptCanvas.getContext("2d");
const layers = { base: document.createElement("canvas"), overlay: document.createElement("canvas") };
let viewTransform = { scale: 1, x: 0, y: 0 };
let drag = null;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paintLayer(layer, pixels, width, height) {
  layer.width = width;
  layer.height = height;
  layer.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
}

function refreshBase() {
  if (!volume) return;
  const { width, height } = geom();
  const sliceU8 = extractSliceUint8(volume.data, volume.dims, axis, currentSlice, intensityWindow.lo, intensityWindow.hi);
  paintLayer(layers.base, greyRgba(sliceU8), width, height);
}

function previewMaskForSlice(sliceIndex) {
  if (pending3D && pending3D.axis === axis && pending3D.masks.has(sliceIndex)) {
    return pending3D.masks.get(sliceIndex);
  }
  if (pending && pending.axis === axis && pending.slice === sliceIndex) {
    return pending.mask;
  }
  return null;
}

function refreshOverlay() {
  if (!volume || !labels) return;
  const { width, height } = geom();
  const sliceLbl = extractLabelSlice(labels, volume.dims, axis, currentSlice);
  paintLayer(layers.overlay, overlayRgba({
    labels: sliceLbl,
    width,
    height,
    opacity: overlayOpacity,
    preview: previewMaskForSlice(currentSlice),
    previewId: nextId,
  }), width, height);
}

function toSliceCoords(event) {
  const rect = promptCanvas.getBoundingClientRect();
  const ratio = promptCanvas.width / rect.width;
  return [
    ((event.clientX - rect.left) * ratio - viewTransform.x) / viewTransform.scale,
    ((event.clientY - rect.top) * ratio - viewTransform.y) / viewTransform.scale,
  ];
}

function drawMarker(x, y, positive, ratio) {
  const cx = viewTransform.x + (x + 0.5) * viewTransform.scale;
  const cy = viewTransform.y + (y + 0.5) * viewTransform.scale;
  context.beginPath();
  context.arc(cx, cy, 5 * ratio, 0, 2 * Math.PI);
  context.fillStyle = token(positive ? "--nd-color-primary" : "--nd-color-error");
  context.fill();
  context.lineWidth = 1.5 * ratio;
  context.strokeStyle = token("--nd-color-bg");
  context.stroke();
}

function drawBox([x0, y0, x1, y1], ratio, dashed) {
  context.setLineDash(dashed ? [4 * ratio, 3 * ratio] : []);
  context.lineWidth = 2 * ratio;
  context.strokeStyle = token("--nd-color-primary");
  context.strokeRect(
    viewTransform.x + x0 * viewTransform.scale,
    viewTransform.y + y0 * viewTransform.scale,
    (x1 - x0) * viewTransform.scale,
    (y1 - y0) * viewTransform.scale,
  );
  context.setLineDash([]);
}

function drawPromptCanvas() {
  const rect = promptCanvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  promptCanvas.width = Math.max(1, Math.round(rect.width * ratio));
  promptCanvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, promptCanvas.width, promptCanvas.height);
  if (!volume) return;
  const { width, height } = geom();
  const scale = Math.min(promptCanvas.width / width, promptCanvas.height / height);
  viewTransform = {
    scale,
    x: (promptCanvas.width - width * scale) / 2,
    y: (promptCanvas.height - height * scale) / 2,
  };
  context.imageSmoothingEnabled = false;
  context.drawImage(layers.base, viewTransform.x, viewTransform.y, width * scale, height * scale);
  context.drawImage(layers.overlay, viewTransform.x, viewTransform.y, width * scale, height * scale);
  if (!pending3D || (pending?.axis === axis && pending?.slice === currentSlice)) {
    if (prompt.box) drawBox(prompt.box, ratio, false);
    if (drag?.moved) {
      const box = boxFromCorners(drag.start, drag.end, width, height);
      if (box) drawBox(box, ratio, true);
    }
    for (const [x, y, label] of prompt.points) drawMarker(x, y, label === 1, ratio);
  }
}

new ResizeObserver(() => {
  if (activeView === "prompt") drawPromptCanvas();
}).observe(promptCanvas);

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (activeView === "prompt") {
    refreshOverlay();
    drawPromptCanvas();
  } else if (viewer && viewer.volumes.length > 1) {
    viewer.setOpacity(1, overlayOpacity);
  }
});

// ---------------------------------------------------------------------------------------------
// NiiVue 3D viewer and shared mask editor.

async function ensureViewer() {
  if (!viewerReady) {
    viewerReady = (async () => {
      viewer = new NiiVue({ isDragDropEnabled: false });
      await viewer.attachTo("gl1");
      niivueLayouts.multiplanar(viewer);
      viewer.isLegendVisible = false;
      editor = createMaskEditor({
        nv: viewer,
        onApply: async (_stage, file) => {
          await applyEditedMask(file);
          closeEdit();
        },
        onCancel: () => {
          if (!editing) return;
          status("Mask edit discarded");
          closeEdit();
        },
        onError: (_stage, error) => status(error.message, true),
      });
      editor.addEventListener("nd-mask-edit-end", () => results.setEditingEnabled(true));
      editor.addEventListener("nd-mask-edit-start", ({ detail }) => status(detail.message));
      toolbar.after(editor);
      viewer.createExtensionContext().on("locationChange", (event) => {
        if (activeView !== "prompt") $("location").textContent = event.detail.string;
      });
      automation.registerViewer("main", createNiivueAdapter(viewer, {
        tabs: {
          list: () => Object.entries(outputs).map(([id, entry]) => ({ id, label: entry.description, active: id === "segmentation" })),
          select: () => syncNiivue(),
        },
      }));
      return viewer;
    })();
  }
  return viewerReady;
}

function syncNiivue({ throwOnError = false } = {}) {
  if (!sourceFile) return Promise.resolve();
  const revision = ++viewRevision;
  viewQueue = viewQueue.catch(() => {}).then(async () => {
    if (revision !== viewRevision) return;
    const nv = await ensureViewer();
    if (revision !== viewRevision) return;
    const layersToLoad = [{ url: sourceFile, name: sourceFile.name }];
    if (outputs.segmentation?.file) {
      layersToLoad.push({
        url: outputs.segmentation.file,
        name: outputs.segmentation.file.name,
        colormap: "freesurfer",
        opacity: overlayOpacity,
      });
    }
    await nv.loadVolumes(layersToLoad);
    if (revision !== viewRevision) return;
    if (niivueLayouts[activeView]) niivueLayouts[activeView](nv);
    nv.drawScene();
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `3D viewer unavailable (${error.message}). Prompt view and NIfTI downloads remain available.`;
    log.log(error.message, "error", "technical");
    if (throwOnError) throw error;
  });
  return viewQueue;
}

async function switchView(viewId) {
  if (editing && viewId === "prompt") return;
  activeView = viewId;
  toolbar.setActive(viewId);
  const inPrompt = viewId === "prompt";
  promptCanvas.hidden = !inPrompt || !volume;
  $("gl1").hidden = inPrompt || !volume;
  if (inPrompt) {
    refreshBase();
    refreshOverlay();
    drawPromptCanvas();
  } else if (volume) {
    await syncNiivue();
  }
}

function closeEdit() {
  editing = null;
  results.setEditingEnabled(!editor || editor.session.state === "idle");
  void syncNiivue();
}

async function editResult(stage, result) {
  if (loading || propagating || editing || !sourceFile) return;
  const session = { stage };
  editing = session;
  results.setEditingEnabled(false);
  try {
    if (activeView === "prompt") {
      activeView = "multiplanar";
      toolbar.setActive("multiplanar");
      promptCanvas.hidden = true;
      $("gl1").hidden = false;
    }
    await syncNiivue({ throwOnError: true });
    if (editing !== session) return;
    if (!await editor.start({ stage, file: result.file, label: result.description, overlayIndex: 1 })) {
      closeEdit();
    }
  } catch (error) {
    if (editing !== session) return;
    status(error.message, true);
    closeEdit();
  }
}

async function applyEditedMask(file) {
  const decoded = await decodeNiftiBuffer(await file.arrayBuffer());
  const { data: nativeLabels } = readNiftiImageData(decoded, Uint8Array);
  const ras = orientToRAS(nativeLabels, volume.nativeDims, volume.perm, volume.flip, Uint8Array);
  labels = ras.data;
  const reconciled = reconcileObjectsFromLabels(labels, volume.dims, objects);
  objects = reconciled.objects;
  nextId = reconciled.nextId;
  refreshOutputs(objects.length ? file : null, objects.length ? nativeLabels : null);
  refreshOverlay();
  drawPromptCanvas();
  updateControls();
  status("Segmentation edited and updated");
}

// ---------------------------------------------------------------------------------------------
// Worker management: one persistent session worker, terminated to cancel propagation.

let worker = null;
let messageId = 0;
const replies = new Map();
let activePropagationMasks = null;

function stopWorker() {
  if (!worker) return;
  worker.terminate();
  worker = null;
  for (const [id, reply] of replies) {
    replies.delete(id);
    reply.reject(new DOMException("Cancelled", "AbortError"));
  }
  decoding = null;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      progress.setProgress(data.value, data.message);
      return;
    }
    if (data.type === "log") {
      log.log(data.message, "info", "technical");
      return;
    }
    if (data.type === "sliceMask") {
      if (activePropagationMasks && activePropagationMasks.id === data.id) {
        activePropagationMasks.masks.set(data.slice, data.mask);
        if (data.slice === currentSlice && activeView === "prompt") {
          refreshOverlay();
          drawPromptCanvas();
        }
      }
      return;
    }
    const reply = replies.get(data.id);
    if (!reply) return;
    replies.delete(data.id);
    if (data.type === "error") reply.reject(new Error(data.message));
    else reply.resolve(data);
  };
  worker.onerror = (event) => {
    for (const [id, reply] of replies) {
      replies.delete(id);
      reply.reject(new Error(event.message || "The MedSAM2 worker failed."));
    }
    worker = null;
  };
  return worker;
}

function callWorker(message, transfer = [], signal = null) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  }
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const onAbort = () => {
      replies.delete(id);
      stopWorker();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    replies.set(id, {
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (error) => { cleanup(); reject(error); },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    w.postMessage({ ...message, id }, transfer);
  });
}

async function resolveBackend(requested = $("backend").value) {
  if (requested !== "auto") return requested;
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
  if (!adapter || adapter.info?.isFallbackAdapter) return "wasm";
  return "webgpu";
}

// ---------------------------------------------------------------------------------------------
// Controls and outputs.

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (editing || loading || propagating) return;
    if (stage === "segmentation" && activeView === "prompt") void switchView("multiplanar");
    else void syncNiivue();
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
  onEdit: (stage, entry) => void editResult(stage, entry),
});

function updateControls() {
  const busy = Boolean(loading || propagating);
  const loaded = Boolean(volume);
  const { depth } = geom();
  $("imageInput").disabled = busy;
  $("seriesSelect").disabled = busy;
  $("windowPreset").disabled = busy;
  $("axisSelect").disabled = busy || !loaded;
  $("sliceSlider").disabled = busy || !loaded;
  $("backend").disabled = busy;
  $("maxRange").disabled = busy;
  $("stopOnEmpty").disabled = busy;
  exampleControl?.setDisabled(busy);
  if (loaded) {
    $("sliceSlider").max = String(Math.max(0, depth - 1));
    $("sliceSlider").value = String(currentSlice);
    $("sliceLabel").textContent = `${currentSlice + 1} / ${depth}`;
  } else {
    $("sliceLabel").textContent = "—";
  }
  const hasCandidate = Boolean(pending || pending3D);
  $("positiveTool").disabled = busy || !loaded;
  $("negativeTool").disabled = busy || !loaded;
  $("propagateButton").disabled = busy || !loaded || !hasPrompt(prompt);
  $("acceptButton").disabled = busy || !loaded || !hasCandidate || decoding !== null;
  $("clearButton").disabled = busy || (!hasPrompt(prompt) && !pending3D);
  $("undoButton").disabled = busy || (!hasPrompt(prompt) && !pending3D && !objects.length);
  $("positiveTool").setAttribute("aria-pressed", String(!negativeTool));
  $("negativeTool").setAttribute("aria-pressed", String(negativeTool));
  $("objectInfo").hidden = !loaded;
  $("objectInfo").textContent = `${objects.length} ${objects.length === 1 ? "object" : "objects"} accepted`;
}

function refreshOutputs(editedFile = null, editedNativeLabels = null) {
  if (!volume || !objects.length) {
    outputs = {};
    results.render();
    $("outputSection").open = false;
    return;
  }
  const nativeLabels = editedNativeLabels ?? toNativeLabels(labels, volume);
  const segBytes = editedFile ? null : exportLabelsNifti(labels, volume, nativeLabels);
  const segFile = editedFile ?? new File([segBytes], `${baseName()}_medsam2_seg.nii`, { type: "application/octet-stream" });
  const rows = measureObjects3D(nativeLabels, volume.nativeDims, volume.voxelVolumeMm3, objects, volume.perm);
  const tableFile = new File([objectsTsv(rows)], `${baseName()}_medsam2_volumes.tsv`, { type: "text/tab-separated-values" });
  outputs = {
    segmentation: {
      description: `3D labels · ${objects.length} ${objects.length === 1 ? "object" : "objects"}`,
      file: segFile,
      editable: true,
    },
    table: {
      description: "Volume table · TSV",
      file: tableFile,
      viewable: false,
    },
  };
  results.render(outputs);
  $("outputSection").open = true;
}

function resetPrompt() {
  prompt = { points: [], box: null };
  promptOrder = [];
  pending = null;
  pending3D = null;
  promptVersion++;
}

function resetSession() {
  volumeGeneration++;
  editing = null;
  editor?.cancel();
  const hadActiveWork = Boolean(decodeRun || propagating);
  decodeRun?.abort();
  decodeRun = null;
  propagating?.abort();
  if (hadActiveWork) stopWorker();
  resetPrompt();
  objects = [];
  nextId = 1;
  labels = volume ? new Uint8Array(volume.data.length) : null;
  refreshOutputs();
}

function begin(message, signal) {
  if (loading || propagating) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
  updateControls();
}

// ---------------------------------------------------------------------------------------------
// Volume loading (NIfTI or DICOM).

async function activateSeries(file, signal) {
  const parsed = await readNifti3D(file.name, await file.arrayBuffer());
  signal?.throwIfAborted();
  sourceFile = file;
  volume = parsed;
  intensityWindow = computeWindow(volume.data, $("windowPreset").value);
  axis = "axial";
  $("axisSelect").value = axis;
  currentSlice = Math.floor(geom().depth / 2);
  resetSession();
  labels = new Uint8Array(volume.data.length);
  $("windowField").hidden = false;
  $("emptyState").hidden = true;
  $("fileInfo").hidden = false;
  const [nx, ny, nz] = volume.dims;
  const [px, py, pz] = volume.pixDims.map((v) => v.toFixed(2));
  $("fileInfo").textContent = `${file.name} · ${nx} × ${ny} × ${nz} · ${px}×${py}×${pz} mm`;
  $("dropZone").classList.add("has-files");
  promptCanvas.hidden = activeView !== "prompt";
  $("gl1").hidden = activeView === "prompt";
  refreshBase();
  refreshOverlay();
  drawPromptCanvas();
  if (activeView !== "prompt") await syncNiivue();
  status(`${file.name} loaded · click or drag a box on any slice to prompt`);
  log.log(`${file.name}: RAS ${nx} × ${ny} × ${nz}, spacing ${px}×${py}×${pz} mm, window [${intensityWindow.lo.toFixed(1)}, ${intensityWindow.hi.toFixed(1)}]`, "info", "analysis");
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading scan and converting DICOM if needed…", signal);
  loading = operation.controller;
  updateControls();
  const current = operation.controller.signal;
  try {
    const rawFiles = await filesPromise;
    current.throwIfAborted();
    if (!rawFiles.length) throw new Error("Choose a NIfTI file or DICOM series.");
    const niftis = await readImageFiles(rawFiles, {
      signal: current,
      onLog: (line) => log.log(line, "info", "technical"),
    });
    current.throwIfAborted();
    if (!niftis.length) throw new Error("No NIfTI or DICOM image volume was found in the selected files.");
    seriesList = niftis;
    $("seriesSelect").replaceChildren(...seriesList.map((f, i) => new Option(f.name, String(i))));
    $("seriesField").hidden = seriesList.length < 2;
    await activateSeries(seriesList[0], current);
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: rawFiles } }));
    progress.setProgress(0);
  } finally {
    loading = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// Live 2D slice prompting and 3D SAM 2 memory propagation.

function windowKey() {
  return `${intensityWindow.lo.toFixed(3)}:${intensityWindow.hi.toFixed(3)}`;
}

function promptChanged(requestedBackend = $("backend").value) {
  const version = ++promptVersion;
  const gen = volumeGeneration;
  pending3D = null;
  if (!hasPrompt(prompt) || !volume) {
    pending = null;
    refreshOverlay();
    drawPromptCanvas();
    updateControls();
    return Promise.resolve(null);
  }
  drawPromptCanvas();
  const snapshot = structuredClone(prompt);
  const targetAxis = axis;
  const targetSlice = currentSlice;
  const { width, height } = geom();
  const sliceU8 = extractSliceUint8(volume.data, volume.dims, targetAxis, targetSlice, intensityWindow.lo, intensityWindow.hi);
  const sliceKey = `${gen}:${targetAxis}:${windowKey()}:${targetSlice}`;

  const run = (decoding ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (version !== promptVersion || gen !== volumeGeneration || !volume) return null;
    const controller = new AbortController();
    decodeRun = controller;
    progress.begin("Segmenting slice…");
    try {
      const backend = await resolveBackend(requestedBackend);
      if (version !== promptVersion || gen !== volumeGeneration || !volume || controller.signal.aborted) {
        progress.reset(volume ? "Ready" : undefined);
        return null;
      }
      const result = await callWorker({
        type: "decode",
        sliceKey,
        sliceUint8: sliceU8,
        prompt: snapshot,
        width,
        height,
        backend,
      }, [sliceU8.buffer], controller.signal);
      if (version !== promptVersion || gen !== volumeGeneration || !volume || controller.signal.aborted) {
        progress.reset(volume ? "Ready" : undefined);
        return null;
      }
      progress.end(`Slice ${targetSlice + 1} segmented (${result.seconds.toFixed(1)} s) · propagate in 3D or accept`);
      pending = {
        axis: targetAxis,
        slice: targetSlice,
        mask: result.mask,
        score: result.score,
        token: result.token,
        objScore: result.objScore,
        backend: result.backend,
        prompt: snapshot,
      };
      refreshOverlay();
      drawPromptCanvas();
      status(`Slice ${targetSlice + 1} preview ready (IoU ${result.score.toFixed(2)}) · click Propagate in 3D or Accept`);
      return pending;
    } finally {
      if (decodeRun === controller) {
        decodeRun = null;
        progress.stopTimer();
        progress.setCancellable(false);
      }
    }
  });
  decoding = run;
  updateControls();
  run.catch((error) => {
    progress.reset(volume ? "Ready" : undefined);
    if (version === promptVersion && gen === volumeGeneration) report(error);
  }).finally(() => {
    if (decoding === run) decoding = null;
    updateControls();
  });
  return run;
}

async function propagate3D(signal, {
  requestedBackend = $("backend").value,
  range = null,
  stopOnEmpty = $("stopOnEmpty").checked,
} = {}) {
  if (!volume || !hasPrompt(prompt)) throw new Error("Add at least one point or box on a slice before propagating in 3D.");
  if (decoding) await decoding.catch(() => null);
  const { width, height, depth } = geom();
  const maxPerSide = Math.max(0, Math.round(Number($("maxRange").value) || 0));
  const rangeMin = range ? range[0] : (maxPerSide > 0 ? Math.max(0, currentSlice - maxPerSide) : 0);
  const rangeMax = range ? range[1] : (maxPerSide > 0 ? Math.min(depth - 1, currentSlice + maxPerSide) : depth - 1);
  const keySlice = currentSlice;
  const targetAxis = axis;
  const snapshot = structuredClone(prompt);

  const operation = begin(`Propagating in 3D across slices ${rangeMin + 1}–${rangeMax + 1}…`, signal);
  propagating = operation.controller;
  const current = operation.controller.signal;
  updateControls();

  try {
    const backend = await resolveBackend(requestedBackend);
    const slicesUint8 = [];
    const transfers = [];
    for (let s = rangeMin; s <= rangeMax; s++) {
      const u8 = extractSliceUint8(volume.data, volume.dims, targetAxis, s, intensityWindow.lo, intensityWindow.hi);
      slicesUint8.push(u8);
      transfers.push(u8.buffer);
    }
    const masks = new Map();
    const id = messageId + 1;
    activePropagationMasks = { id, masks };
    const result = await callWorker({
      type: "propagate",
      volumeId: volumeGeneration,
      axis: targetAxis,
      windowKey: windowKey(),
      keySlice,
      rangeMin,
      rangeMax,
      slicesUint8,
      prompt: snapshot,
      width,
      height,
      backend,
      stopOnEmpty,
    }, transfers, current);
    current.throwIfAborted();
    pending3D = {
      axis: targetAxis,
      keySlice,
      masks,
      score: result.score,
      token: result.token,
      backend: result.backend,
      seconds: result.seconds,
      prompt: snapshot,
    };
    const nonEmpty = [...masks.values()].filter((m) => m.some(Boolean)).length;
    refreshOverlay();
    drawPromptCanvas();
    progress.end(`3D propagation finished (${nonEmpty} slices in ${result.seconds.toFixed(1)} s)`);
    status(`Propagated across ${nonEmpty} slices in ${result.seconds.toFixed(1)} s · click Accept object`);
    return pending3D;
  } catch (error) {
    progress.reset(volume ? "Ready" : undefined);
    throw error;
  } finally {
    activePropagationMasks = null;
    propagating = null;
    finish(operation);
  }
}

async function accept() {
  if (decoding) await decoding.catch(() => null);
  if (!volume || (!pending && !pending3D)) return null;
  if (nextId > 255) throw new Error("At most 255 objects can be stored in an 8-bit NIfTI label map.");
  const id = nextId;
  const targetAxis = pending3D ? pending3D.axis : pending.axis;
  const sliceMasks = pending3D ? pending3D.masks : new Map([[pending.slice, pending.mask]]);
  const usedPrompt = pending3D ? pending3D.prompt : pending.prompt;
  const score = pending3D ? pending3D.score : pending.score;
  const backend = pending3D ? pending3D.backend : pending.backend;
  const nonEmptySlices = [...sliceMasks.values()].filter((m) => m.some(Boolean)).length;
  if (!nonEmptySlices) throw new Error("MedSAM2 predicted an empty mask; adjust your prompt.");
  const claimed = commitObject3D(labels, sliceMasks, volume.dims, targetAxis, id);
  if (!claimed.length) throw new Error("This mask lies inside accepted objects; prompt a new object or undo one.");
  nextId++;
  const object = {
    id,
    claimed,
    axis: targetAxis,
    slices: nonEmptySlices,
    voxels: claimed.length,
    score,
    backend,
    prompt: usedPrompt,
  };
  objects.push(object);
  log.log(`Object ${id}: ${object.voxels} voxels across ${object.slices} ${targetAxis} slices`, "info", "analysis");
  resetPrompt();
  refreshOutputs();
  refreshOverlay();
  drawPromptCanvas();
  if (activeView !== "prompt") void syncNiivue();
  updateControls();
  status(`Object ${id} accepted (${object.voxels} voxels) · ${objects.length} ${objects.length === 1 ? "object" : "objects"}`);
  return object;
}

function clearPrompt() {
  resetPrompt();
  refreshOverlay();
  drawPromptCanvas();
  updateControls();
}

function undo() {
  if (pending3D) {
    pending3D = null;
    refreshOverlay();
    drawPromptCanvas();
    updateControls();
    return;
  }
  if (hasPrompt(prompt)) {
    if (promptOrder.pop() === "box") prompt.box = null;
    else prompt.points.pop();
    void promptChanged();
    return;
  }
  const object = objects.pop();
  if (!object) return;
  uncommitObject(labels, object.claimed, object.id);
  nextId = objects.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  refreshOutputs();
  refreshOverlay();
  drawPromptCanvas();
  if (activeView !== "prompt") void syncNiivue();
  updateControls();
  status(`Object ${object.id} removed`);
}

function setSlice(nextSlice) {
  if (!volume) return;
  const { depth } = geom();
  const clamped = Math.max(0, Math.min(depth - 1, nextSlice));
  if (clamped === currentSlice) return;
  currentSlice = clamped;
  if (!pending3D) resetPrompt();
  refreshBase();
  refreshOverlay();
  drawPromptCanvas();
  updateControls();
}

// ---------------------------------------------------------------------------------------------
// Events.

promptCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
promptCanvas.addEventListener("wheel", (event) => {
  if (!volume || loading || propagating) return;
  event.preventDefault();
  setSlice(currentSlice + (event.deltaY > 0 ? 1 : -1));
}, { passive: false });
promptCanvas.addEventListener("pointerdown", (event) => {
  if (!volume || loading || propagating || (event.button !== 0 && event.button !== 2)) return;
  promptCanvas.setPointerCapture(event.pointerId);
  const start = toSliceCoords(event);
  drag = { start, end: start, screen: [event.clientX, event.clientY], moved: false, negative: event.button === 2 || event.shiftKey };
});
promptCanvas.addEventListener("pointermove", (event) => {
  if (volume && activeView === "prompt") {
    const { width, height } = geom();
    const pixel = clickPixel(...toSliceCoords(event), width, height);
    $("location").textContent = pixel ? `${axis} slice ${currentSlice + 1} · x ${pixel[0]} · y ${pixel[1]}` : "";
  }
  if (!drag) return;
  drag.end = toSliceCoords(event);
  const ratio = window.devicePixelRatio || 1;
  drag.moved ||= Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) * ratio > DRAG_PIXELS * ratio;
  if (drag.moved) drawPromptCanvas();
});
promptCanvas.addEventListener("pointerup", (event) => {
  if (!drag) return;
  const { start, moved, negative } = drag;
  drag = null;
  const { width, height } = geom();
  if (moved) {
    const box = boxFromCorners(start, toSliceCoords(event), width, height);
    if (box) {
      if (!prompt.box) promptOrder.push("box");
      prompt.box = box;
      void promptChanged();
    } else {
      drawPromptCanvas();
    }
    return;
  }
  const pixel = clickPixel(...start, width, height);
  if (pixel) {
    prompt.points.push([pixel[0], pixel[1], negative || negativeTool ? 0 : 1]);
    promptOrder.push("point");
    void promptChanged();
  }
});
promptCanvas.addEventListener("pointercancel", () => {
  drag = null;
  drawPromptCanvas();
});

$("axisSelect").addEventListener("change", () => {
  axis = $("axisSelect").value;
  currentSlice = Math.floor(geom().depth / 2);
  resetPrompt();
  refreshBase();
  refreshOverlay();
  drawPromptCanvas();
  updateControls();
});
$("sliceSlider").addEventListener("input", () => setSlice(Number($("sliceSlider").value)));
$("windowPreset").addEventListener("change", () => {
  if (!volume) return;
  intensityWindow = computeWindow(volume.data, $("windowPreset").value);
  resetPrompt();
  refreshBase();
  refreshOverlay();
  drawPromptCanvas();
  status(`Window set to [${intensityWindow.lo.toFixed(1)}, ${intensityWindow.hi.toFixed(1)}]`);
});
$("seriesSelect").addEventListener("change", () => {
  const file = seriesList[Number($("seriesSelect").value)];
  if (file) void activateSeries(file).catch(report);
});
$("positiveTool").onclick = () => {
  negativeTool = false;
  updateControls();
};
$("negativeTool").onclick = () => {
  negativeTool = true;
  updateControls();
};
$("propagateButton").onclick = () => void propagate3D().catch(report);
$("acceptButton").onclick = () => void accept().catch(report);
$("clearButton").onclick = clearPrompt;
$("undoButton").onclick = undo;

document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || !volume || editing || loading || propagating) return;
  if (document.querySelector(".nd-modal.open, .nd-modal[aria-hidden='false'], dialog[open], [role='dialog']:not([aria-hidden='true'])")) return;
  if (event.target.closest?.("input, select, textarea, [contenteditable], dialog, .nd-modal")) return;
  if (event.key === "Enter" && !decoding && (pending || pending3D) && !event.target.closest?.("button, a, summary")) {
    event.preventDefault();
    void accept().catch(report);
  } else if (event.key === "Escape" && (hasPrompt(prompt) || pending3D)) {
    clearPrompt();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
    event.preventDefault();
    undo();
  } else if (activeView === "prompt" && (event.key === "[" || event.key === "ArrowDown")) {
    event.preventDefault();
    setSlice(currentSlice - 1);
  } else if (activeView === "prompt" && (event.key === "]" || event.key === "ArrowUp")) {
    event.preventDefault();
    setSlice(currentSlice + 1);
  }
});

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(report);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  decodeRun?.abort();
  propagating?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});
bindFileDrop($("dropZone"), importFiles);
const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    await loadFiles(Promise.resolve(files), signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

// ---------------------------------------------------------------------------------------------
// WebMCP automation contract.

const automation = registerAppAutomation({
  app: APP.id,
  convertDicom: runDcm2niix,
  operations: {
    segment: async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      if (parameters.window) {
        $("windowPreset").value = parameters.window;
        intensityWindow = computeWindow(volume.data, parameters.window);
      }
      const prompts = parsePrompts(parameters.prompts, volume.dims);
      const backend = parameters.backend ?? "auto";
      for (const item of prompts) {
        signal?.throwIfAborted();
        axis = item.axis;
        $("axisSelect").value = axis;
        currentSlice = item.slice;
        refreshBase();
        prompt = { points: structuredClone(item.points), box: item.box ? [...item.box] : null };
        promptOrder = [...prompt.points.map(() => "point"), ...(prompt.box ? ["box"] : [])];
        if (item.propagate) {
          await propagate3D(signal, {
            requestedBackend: backend,
            range: item.range,
            stopOnEmpty: parameters.stopOnEmpty ?? false,
          });
        } else {
          await promptChanged(backend);
        }
        if (!(await accept())) throw new Error("MedSAM2 returned no mask.");
      }
      return {
        artifacts: [
          { role: "labels", file: outputs.segmentation.file },
          { role: "table", file: outputs.table.file },
        ],
        provenance: {
          method: "MedSAM2 interactive 3D segmentation",
          model: MODEL.name,
          imageEncoderSha256: MODEL.imageEncoder.sha256,
          maskDecoderSha256: MODEL.maskDecoder.sha256,
          memoryEncoderSha256: MODEL.memoryEncoder.sha256,
          memoryAttentionSha256: MODEL.memoryAttention.sha256,
          dims: volume.dims,
          window: intensityWindow,
          objects: objects.map(({ id, axis: a, slices, voxels, score, backend: b, prompt: used }) => ({
            id, axis: a, slices, voxels, score, backend: b, prompt: used,
          })),
        },
      };
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  propagating?.abort();
  stopWorker();
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
