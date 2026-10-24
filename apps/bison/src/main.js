// BISON in the browser: a T1 (and optional FLAIR) in, tissue labels, probability maps and the
// classification mask out. The pipeline runs in src/worker.js; this page owns the inputs, the
// run, the viewer and the downloads.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { MULTIPLANAR_TYPE, SLICE_TYPE, SHOW_RENDER } from "@niivue/niivue";
import { zipSync } from "fflate";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createFileField,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  LabelLegend,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { readImageFiles } from "@neurodesk/runtime-support/dcm2niix-client";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { MAX_T1_VOXEL_MM } from "@neurodesk/bison";
import {
  APP,
  heldBaseUrl,
  inputMode,
  labelColormap,
  legendOf,
  memoryRefusal,
  modeHint,
  resultRows,
  statusLine,
  volumeLines,
} from "./config.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

// The URL of a local copy of the held model files (vite.config.js); null on the deployed site.
const HELD_BASE_URL = heldBaseUrl(import.meta.env.VITE_BISON_ASSET_BASE, location.origin);
// The worker refuses a run whose held files have no URL; the status line says so in one sentence.
const NOT_PUBLISHED = "The BISON model files are not published yet, so this app cannot segment images. Their authors must first allow publication.";

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
let overlayOpacity = 0.6;
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
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const flairField = createFileField({ id: "flairInput", rootId: "flairDrop", text: "Drop a FLAIR image or DICOM series", label: "Choose an optional FLAIR image or DICOM series" });
$("flairField").querySelector("label").after(flairField);
const legend = new LabelLegend({ element: $("classLegend") });

// The loaded images: { file, summary } each; the FLAIR is optional.
const inputs = { t1: null, flair: null };
// The Output rows: the inputs, then the run's files once it ends.
let outputs = {};
// The last run's mode, class volumes and files.
let result = null;
// What the viewer shows: a base image (t1 or flair) and an optional overlay (an output key).
const view = { base: "t1", overlay: null };
// One job at a time: reading images or segmenting them. Cancel aborts it and ends its worker.
let job = null;
let loads = Promise.resolve();

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "t1" || stage === "flair") view.base = stage;
    else view.overlay = view.overlay === stage ? null : stage;
    void show();
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

function status(message, { error = false, channel = "analysis" } = {}) {
  progress.setText(statusLine(message));
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  $("imageInput").disabled = busy;
  flairField.disabled = busy;
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !inputs.t1;
  $("downloadAll").disabled = busy;
}

function begin(kind, message) {
  const controller = new AbortController();
  job = { kind, controller, worker: null };
  progress.begin(statusLine(message));
  status(message, { channel: "technical" });
  refreshControls();
  return job;
}

function end(current, message, { success = true, error = false, value } = {}) {
  if (job !== current) return false;
  current.worker?.terminate();
  job = null;
  progress.end(statusLine(message), { success });
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", "analysis");
  refreshControls();
  if (current.completion) {
    if (success) current.completion.resolve(value);
    else current.completion.reject(current.controller.signal.aborted ? current.controller.signal.reason : new Error(message));
  }
  return true;
}

function renderInputs() {
  for (const [role, element, picker] of [["t1", $("fileInfo"), $("dropZone")], ["flair", $("flairInfo"), flairField]]) {
    const input = inputs[role];
    element.hidden = !input;
    element.textContent = input ? input.summary : "";
    if (picker === flairField) flairField.setHasFiles(Boolean(input));
    else picker.classList.toggle("has-files", Boolean(input));
  }
  $("modeHint").textContent = modeHint(inputMode(inputs));
  $("emptyState").hidden = Boolean(inputs.t1 || inputs.flair);
}

function renderOutputs() {
  results.render(outputs);
  const done = Boolean(result);
  $("classLegend").hidden = !done;
  if (done) {
    const { labels, metrics } = legendOf(result.mode, result.volumes);
    legend.render(labels, metrics);
  }
  $("downloadAll").hidden = !done;
  $("outputSection").open = done;
  markViewed();
}

function markViewed() {
  for (const [index, key] of Object.keys(outputs).entries()) {
    $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", key === view.base || key === view.overlay);
  }
}

function inputRows() {
  const rows = {};
  if (inputs.t1) rows.t1 = { description: "T1", file: inputs.t1.file };
  if (inputs.flair) rows.flair = { description: "FLAIR", file: inputs.flair.file };
  return rows;
}

function clearResults() {
  result = null;
  outputs = inputRows();
  if (!outputs[view.base]) view.base = inputs.t1 ? "t1" : "flair";
  view.overlay = null;
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

function overlayLayer(key) {
  const entry = outputs[key];
  if (!entry) return null;
  const layer = { url: entry.file, name: entry.file.name, opacity: overlayOpacity, isColorbarVisible: false };
  if (entry.kind === "probability") return { ...layer, colormap: "warm", calMin: 0.05, calMax: 1, isTransparentBelowCalMin: true };
  if (entry.kind === "mask") return { ...layer, colormap: "red", calMin: 0.5, calMax: 1, isTransparentBelowCalMin: true };
  return layer;
}

// The base image underneath and at most one output over it, loaded in order.
function show() {
  const revision = ++viewRevision;
  markViewed();
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    const base = outputs[view.base]?.file;
    if (!base) return;
    const nv = await ensureViewer();
    const layers = [{ url: base, name: base.name }];
    const overlay = view.overlay && overlayLayer(view.overlay);
    if (overlay) layers.push(overlay);
    const crosshair = shownBase === base && nv.getCrosshairPos();
    await nv.loadVolumes(layers);
    if (overlay && outputs[view.overlay].kind === "labels") await nv.setColormapLabel(1, labelColormap(result.mode));
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownBase = base;
    $("viewerNotice").hidden = true;
  }).catch((error) => {
    if (revision !== viewRevision) return;
    $("viewerNotice").hidden = false;
    $("viewerNotice").textContent = `Visualization unavailable. ${error.message}. Downloads remain available.`;
    log.log(error.message, "error", "technical");
  });
  return viewQueue;
}

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  viewQueue = viewQueue.then(async () => {
    if (viewer?.volumes.length > 1) await viewer.setVolume(1, { opacity: overlayOpacity });
  }).catch((error) => log.log(error.message, "error", "technical"));
});

// One image or DICOM series, one 3D volume; a T1 with voxels over 2 mm is refused.
async function readImage(files, role, signal) {
  const label = role === "t1" ? "T1" : "FLAIR";
  const images = await readImageFiles(files, { signal });
  signal?.throwIfAborted();
  if (images.length !== 1) throw new Error(`Choose one ${label} NIfTI image or one DICOM series at a time.`);
  const [file] = images;
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const description = await describeNiftiFile(file);
  if (description.dimensionality !== 3 || description.frames !== 1) throw new Error(`The ${label} must be a single 3D volume.`);
  if (role === "t1" && description.spacingMm.some((mm) => mm > MAX_T1_VOXEL_MM)) {
    throw new Error(`The T1 voxels are ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm; BISON needs ${MAX_T1_VOXEL_MM} mm or finer.`);
  }
  const summary = `${label}: ${file.name} · ${description.dims.join(" × ")} · ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm`;
  return { file, summary };
}

// request.t1 / request.flair: files to load, [] to remove, absent to keep. A new T1 that
// replaces a loaded one also removes the FLAIR, which belonged to the old session.
async function load(request, signal) {
  if (job) throw new Error("Wait for the segmentation to finish or cancel it, then retry.");
  const current = begin("loading", "Reading images…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const next = { ...inputs };
    if (request.t1) {
      if (inputs.t1 && !request.flair) next.flair = null;
      next.t1 = request.t1.length ? await readImage(request.t1, "t1", current.controller.signal) : null;
    }
    current.controller.signal.throwIfAborted();
    if (request.flair) next.flair = request.flair.length ? await readImage(request.flair, "flair", current.controller.signal) : null;
    current.controller.signal.throwIfAborted();
    Object.assign(inputs, next);
    for (const [role, input] of [["t1", $("imageInput")], ["flair", flairField.input]]) {
      input.dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: inputs[role] ? [inputs[role].file] : [] } }));
    }
    renderInputs();
    clearResults();
    const loaded = [inputs.t1, inputs.flair].filter(Boolean).map(({ summary }) => summary);
    end(current, inputs.t1 ? `${loaded.join(" · ")} · ready` : `${loaded.join(" · ")} · load a T1 image`);
    await show();
  } catch (error) {
    const cancelled = error.name === "AbortError";
    end(current, cancelled ? "Loading cancelled" : error.message, { success: false, error: !cancelled });
    if (signal) throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

// Imports run one after another, so a drop of a T1 and a FLAIR loads both.
function queueLoad(request, signal) {
  const next = loads.then(() => load(request, signal));
  loads = next.catch(() => {});
  return next;
}

function importFiles(role, filesPromise) {
  exampleControl.cancel();
  return Promise.resolve(filesPromise)
    .then((files) => queueLoad({ [role]: files }))
    .catch((error) => status(error.message, { error: true }));
}

$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles("t1", files);
});
bindFileDrop($("dropZone"), (files) => importFiles("t1", files));
flairField.onFiles((files) => void importFiles("flair", files));

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: (message, error) => status(message, { error }),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const files = await fetchFiles();
    assertCurrent();
    const byRole = (role) => files.filter((_, k) => example.files[k].role === role);
    await queueLoad({ t1: byRole("t1"), flair: byRole("flair") }, signal);
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

/** Runs BISON on the loaded images in a new worker; resolves to the automation result. */
async function segment(onProgress = () => {}) {
  if (!inputs.t1 || job) throw new Error("Load a T1 image and wait for the current step to finish.");
  const mode = inputMode(inputs);
  const refusal = memoryRefusal(navigator.deviceMemory);
  if (refusal) {
    status(refusal, { error: true });
    throw new Error(refusal);
  }
  clearResults();
  const current = begin("running", "Starting the segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const { t1, flair } = inputs;
  log.log(`${mode === "t1-flair" ? "BISON-WMH" : "BISON"} on ${t1.summary}${flair ? `; ${flair.summary}` : ""}`, "info", "analysis");
  try {
    const t1Bytes = new Uint8Array(await t1.file.arrayBuffer());
    const flairBytes = flair ? new Uint8Array(await flair.file.arrayBuffer()) : null;
    if (job !== current) return current.completion.promise;
    let lastMessage = "";
    current.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    current.worker.onmessage = ({ data }) => {
      if (job !== current) return;
      if (data.type === "progress") {
        progress.setProgress(data.fraction, statusLine(data.message));
        onProgress({ message: data.message, value: data.fraction });
        const stage = data.message.replace(/ · \d+ %$/, "");
        if (stage !== lastMessage) log.log(data.message, "info", "technical");
        lastMessage = stage;
      } else if (data.type === "log") {
        log.log(data.line, "info", "technical");
      } else if (data.type === "error") {
        const held = data.message.startsWith("The BISON models are not published yet");
        if (held) log.log(data.message, "info", "technical");
        end(current, held ? NOT_PUBLISHED : data.message, { success: false, error: true });
      } else if (data.type === "result") {
        finish(current, data, t1.file.name);
      }
    };
    current.worker.onerror = (event) => {
      event.preventDefault?.();
      end(current, event.message || "The BISON worker failed. Reload the page and try again.", { success: false, error: true });
    };
    const transfer = [t1Bytes.buffer, ...(flairBytes ? [flairBytes.buffer] : [])];
    current.worker.postMessage({ type: "run", t1: t1Bytes, flair: flairBytes, t1Name: t1.file.name, heldBaseUrl: HELD_BASE_URL }, transfer);
  } catch (error) {
    end(current, error.message, { success: false, error: true });
  }
  return current.completion.promise;
}

function finish(current, data, t1Name) {
  let rows;
  try {
    rows = resultRows(data.files.map(({ name, bytes }) => new File([bytes], name, { type: "application/gzip" })));
  } catch (error) {
    end(current, error.message, { success: false, error: true });
    return;
  }
  result = { mode: data.mode, volumes: data.volumes, t1Name };
  outputs = { ...inputRows(), ...rows };
  view.overlay = "labels";
  for (const line of volumeLines(data.volumes)) log.log(line, "info", "analysis");
  log.log(`Timings (s): ${JSON.stringify(data.timings)}`, "info", "technical");
  log.log(`Peak heap per stage (bytes): ${JSON.stringify(data.memory)}`, "info", "technical");
  renderOutputs();
  const artifacts = [
    { role: "labels", file: rows.labels.file },
    ...Object.values(rows).filter(({ kind }) => kind === "probability").map(({ file }) => ({ role: "probabilities", file })),
    { role: "mask", file: rows.mask.file },
  ];
  const classes = data.volumes.length;
  end(current, `Segmentation complete · ${classes} classes${data.mode === "t1-flair" ? " with WMH" : ""}`, {
    value: { artifacts, measurements: { volumes: data.volumes }, provenance: { method: data.mode === "t1-flair" ? "BISON-WMH" : "BISON", timings: data.timings } },
  });
  void show();
}

$("runButton").addEventListener("click", () => {
  void segment().catch((error) => {
    if (error.name !== "AbortError") log.log(error.message, "error", "technical");
  });
});

// The run's files, already gzipped, stored in one zip.
$("downloadAll").addEventListener("click", () => {
  if (!result) return;
  const files = Object.values(outputs).filter(({ kind }) => kind);
  void Promise.all(files.map(async ({ file }) => [file.name, new Uint8Array(await file.arrayBuffer())])).then((entries) => {
    const stem = result.t1Name.replace(/\.nii(\.gz)?$/i, "");
    downloadFile(new File([zipSync(Object.fromEntries(entries), { level: 0 })], `${stem}_bison.zip`, { type: "application/zip" }));
  }).catch((error) => status(error.message, { error: true }));
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
    segment: async ({ inputs: files, signal, progress: reportProgress }) => {
      exampleControl.cancel();
      await queueLoad({ t1: files.t1, flair: files.flair ?? [] }, signal);
      signal.throwIfAborted();
      return runAbortable(signal, () => segment(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
