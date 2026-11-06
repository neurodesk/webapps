// GlioMODA in the browser: up to four atlas-registered sequences in, BraTS tumour labels and a
// volume table out. Inference runs in src/worker.js; this page owns the inputs, the run, the
// viewer and the downloads.
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
import { createElement } from "@neurodesk/webapp-components/core";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { describeNiftiFile } from "@neurodesk/webapp-components/file-io/nifti";
import { registerAppAutomation, runAbortable } from "@neurodesk/webapp-components/automation";
import { ATLAS_DIMS } from "@neurodesk/gliomoda";
import { MODELS } from "@neurodesk/gliomoda/models";
import { caseName, segmentationResults } from "@neurodesk/gliomoda/results";
import { APP, SEQUENCES, assignSequences, labelColormap, legendOf, modelChoice } from "./config.js";
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
let overlayOpacity = 0.6;
toolbar.control("overlayOpacity").value = String(overlayOpacity);
toolbar.control("overlayOpacityValue").textContent = `${Math.round(overlayOpacity * 100)}%`;
const log = createConsole({ id: "technicalLog", resizable: true });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));
const legend = new LabelLegend({ element: $("labelLegend") });

// The loaded files, and which of them each sequence uses (an index into files, or null).
let files = [];
const assigned = Object.fromEntries(SEQUENCES.map(({ role }) => [role, null]));
// The Output rows: the inputs, then the run's files once it ends.
let outputs = {};
let result = null;
// What the viewer shows: an input role underneath, the segmentation over it when present.
const view = { base: null, overlay: true };
// One job at a time: reading images or segmenting them. Cancel aborts it and ends its worker.
let job = null;

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (job?.kind === "running") return;
    if (stage === "segmentation") view.overlay = !view.overlay;
    else if (outputs[stage]?.role) view.base = stage;
    void show();
  },
  onDownload: (_stage, entry) => downloadFile(entry.file),
});

const selects = {};
for (const { role, label, name } of SEQUENCES) {
  const select = createElement("select", { id: `${role}Select`, "aria-label": `${name} image` });
  select.addEventListener("change", () => {
    const index = select.value === "" ? null : Number(select.value);
    for (const other of Object.keys(assigned)) if (other !== role && index !== null && assigned[other] === index) assigned[other] = null;
    assigned[role] = index;
    renderInputs();
    clearResults();
    void show();
  });
  selects[role] = select;
  $("sequenceFields").append(createElement("div", { className: "nd-field" }, [
    createElement("label", { for: select.id, text: label }),
    select,
  ]));
}

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info");
}

const roles = () => SEQUENCES.map(({ role }) => role).filter((role) => assigned[role] !== null);
const MODEL_IDS = MODELS.map(({ id }) => id);
const choice = () => modelChoice(roles(), MODEL_IDS, { resEncL: $("resEncL").checked });

function refreshControls() {
  const busy = job !== null;
  exampleControl.setDisabled(busy);
  $("imageInput").disabled = busy;
  for (const select of Object.values(selects)) select.disabled = busy;
  $("mirror").disabled = busy;
  $("backend").disabled = busy;
  $("resEncL").disabled = busy || !MODEL_IDS.includes(`${roles().join("-")}_ResEncL`);
  results.inert = job?.kind === "running";
  $("runButton").disabled = busy || !choice().id;
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

function renderInputs() {
  for (const { role } of SEQUENCES) {
    const select = selects[role];
    select.replaceChildren(
      createElement("option", { value: "", text: "None" }),
      ...files.map((file, index) => createElement("option", { value: String(index), text: file.name })),
    );
    select.value = assigned[role] === null ? "" : String(assigned[role]);
  }
  $("sequenceFields").hidden = !files.length;
  $("dropZone").classList.toggle("has-files", files.length > 0);
  if (!MODEL_IDS.includes(`${roles().join("-")}_ResEncL`)) $("resEncL").checked = false;
  $("modelHint").textContent = choice().hint;
  $("emptyState").hidden = files.length > 0;
  refreshControls();
}

function inputRows() {
  const rows = {};
  for (const { role, label } of SEQUENCES) {
    if (assigned[role] !== null) rows[role] = { role, description: label, file: files[assigned[role]] };
  }
  return rows;
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
    const active = key === view.base || (key === "segmentation" && view.overlay);
    $("resultList").children[index]?.querySelector(".nd-view-btn")?.classList.toggle("active", active);
  }
}

function clearResults() {
  result = null;
  outputs = inputRows();
  if (!outputs[view.base]) view.base = Object.keys(outputs)[0] ?? null;
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

// The chosen input underneath and the segmentation over it, loaded in order.
function show() {
  const revision = ++viewRevision;
  renderOutputs();
  viewQueue = viewQueue.then(async () => {
    if (revision !== viewRevision) return;
    const base = outputs[view.base]?.file;
    if (!base) return;
    const nv = await ensureViewer();
    const layers = [{ url: base, name: base.name }];
    const segmentation = view.overlay && outputs.segmentation?.file;
    if (segmentation) layers.push({ url: segmentation, name: segmentation.name, opacity: overlayOpacity, isColorbarVisible: false });
    const crosshair = shownBase && nv.getCrosshairPos();
    await nv.loadVolumes(layers);
    if (segmentation) await nv.setColormapLabel(1, labelColormap());
    if (crosshair) nv.setCrosshairPos(crosshair);
    shownBase = base;
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

// A NIfTI on the atlas grid; anything else is refused with what GlioMODA needs.
async function checkImage(file) {
  if (!/\.nii(\.gz)?$/i.test(file.name)) throw new Error(`${file.name} is not a NIfTI image. GlioMODA reads .nii or .nii.gz.`);
  const description = await describeNiftiFile(file);
  const onGrid = description.dims.length === 3 && description.dims.every((n, a) => n === ATLAS_DIMS[a]);
  if (!onGrid || description.spacingMm.some((mm) => Math.abs(mm - 1) > 1e-3)) {
    throw new Error(`${file.name} is ${description.dims.join(" × ")} at ${description.spacingMm.map((mm) => mm.toFixed(2)).join(" × ")} mm. GlioMODA needs the 240 × 240 × 155, 1 mm BraTS/SRI24 grid.`);
  }
}

// A case's files replace the loaded ones; each takes the sequence its name states, or the next
// free one, and the selects can change that.
async function load(chosen, signal, roleOf = null) {
  if (job) throw new Error("Wait for the segmentation to finish or cancel it, then retry.");
  const current = begin("loading", "Reading images…");
  const abort = () => current.controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    if (!chosen.length) throw new Error("Choose up to four NIfTI images of one case.");
    const byName = roleOf ? null : assignSequences(chosen.map((file) => file.name));
    for (const file of chosen) {
      await checkImage(file);
      current.controller.signal.throwIfAborted();
    }
    files = chosen;
    for (const { role } of SEQUENCES) {
      const index = roleOf ? chosen.findIndex((file) => roleOf(file) === role) : chosen.findIndex((file) => file.name === byName[role]);
      assigned[role] = index < 0 ? null : index;
    }
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    renderInputs();
    view.base = null;
    clearResults();
    end(current, `${files.length} ${files.length === 1 ? "image" : "images"} loaded · ${choice().hint}`);
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
$("resEncL").addEventListener("change", () => {
  renderInputs();
  clearResults();
});

const exampleControl = createExampleSelector({
  examples,
  scope: $("inputSection"),
  onStatus: status,
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    const fetched = await fetchFiles();
    assertCurrent();
    const roleByName = new Map(example.files.map(({ name, role }) => [name, role]));
    await load(fetched, signal, (file) => roleByName.get(file.name));
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

const gzip = (bytes) => new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();

/** Runs GlioMODA on the assigned images in a new worker; resolves to the automation result. */
async function segment(onProgress = () => {}) {
  const { id: modelId } = choice();
  if (!modelId || job) throw new Error("Load the images and wait for the current step to finish.");
  clearResults();
  const current = begin("running", "Starting the segmentation…");
  current.completion = Promise.withResolvers();
  void current.completion.promise.catch(() => {});
  const inputs = inputRows();
  const name = caseName(Object.values(inputs).map(({ file }) => file.name));
  log.log(`GlioMODA ${modelId} on ${Object.values(inputs).map(({ description, file }) => `${description} ${file.name}`).join(", ")}`);
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
    end(current, event.message || "The GlioMODA worker failed. Reload the page and try again.", { success: false, error: true });
  };
  current.worker.postMessage({
    files: Object.fromEntries(Object.entries(inputs).map(([role, { file }]) => [role, file])),
    modelId,
    mirror: $("mirror").checked,
    backend: $("backend").value,
  });
  return current.completion.promise;
}

async function finish(current, data, name) {
  const { segmentation, table, rows } = segmentationResults(data, name);
  const segmentationFile = new File([await gzip(segmentation.bytes)], `${segmentation.name}.gz`, { type: "application/gzip" });
  const tableFile = new File([table.text], table.name, { type: "text/tab-separated-values" });
  if (job !== current) return;
  result = { rows };
  outputs = {
    ...inputRows(),
    segmentation: { description: "Tumour labels", file: segmentationFile },
    table: { description: "Volumes", file: tableFile, viewable: false },
  };
  view.overlay = true;
  for (const row of rows) log.log(`${row.name}: ${row.ml.toFixed(2)} ml`);
  log.log(`Run: ${JSON.stringify(data.provenance)}`);
  const wholeTumour = rows.find(({ id }) => id === "WT");
  end(current, `Segmentation complete · whole tumour ${wholeTumour.ml.toFixed(1)} ml`, {
    value: {
      artifacts: [{ role: "segmentation", file: segmentationFile }, { role: "volumes", file: tableFile }],
      measurements: { volumes: rows },
      provenance: data.provenance,
    },
  });
  await show();
}

$("runButton").addEventListener("click", () => {
  void segment().catch((error) => {
    if (error.name !== "AbortError") log.log(error.message, "error");
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
      const chosen = [];
      const roleOf = new Map();
      for (const { role } of SEQUENCES) {
        for (const file of inputs[role] ?? []) {
          chosen.push(file);
          roleOf.set(file, role);
        }
      }
      await load(chosen, signal, (file) => roleOf.get(file));
      signal.throwIfAborted();
      $("mirror").checked = parameters.mirror;
      $("backend").value = parameters.backend;
      $("resEncL").checked = parameters.resEncL;
      renderInputs();
      return runAbortable(signal, () => segment(reportProgress), cancel);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  cancel();
});

export default Object.freeze({ workspace, toolbar, log, info, results });
