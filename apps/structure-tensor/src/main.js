// Structure Tensor: fibre orientation, coherency and energy of a 2D image or 3D stack (the
// OrientationJ method). Numerics are src/tensor.js, run in a module worker per analysis.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createPreviewQueue,
  bindFileDrop,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP, analysisSettings, baseName, imageRefusal } from "./config.js";
import { buildOutputs, niftiFile, readImages } from "./io.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Fibre orientation analysis",
  controlsContract: { privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.MULTIPLANAR;
let attached = null;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = layout;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      $("location").textContent = event.detail.string;
    });
  });
  return attached;
}
const toolbar = createViewerToolbar({ window: false, overlay: false, colormap: false, download: false, screenshot: false });
function setLayout(id) {
  layout = SLICE_TYPES[id] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
}
toolbar.addEventListener("nd-view-change", ({ detail }) => setLayout(detail.value));
$("viewer").prepend(toolbar);
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

// Shows one NiIVue volume: { file, colormap, range } or { file, rgb: true }; null clears it.
const show = createPreviewQueue({
  ready: Promise.resolve(),
  render: async (preview) => {
    await viewerReady();
    if (!preview) {
      await viewer.removeAllVolumes();
      $("emptyState").hidden = false;
      return;
    }
    const range = preview.range ? { calMin: preview.range[0], calMax: preview.range[1] } : {};
    await viewer.loadVolumes([{ url: preview.file, name: preview.file.name, colormap: preview.colormap ?? "gray", ...range }]);
    $("emptyState").hidden = true;
  },
});

// The loaded image ({ file, image, view }), the controllers of a load or run in progress, and
// the last run's results keyed by result id.
let input = null;
let loading = null;
let running = null;
let outputs = {};

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", "technical");
}

function analysisLog(message, level = "info") {
  log.log(message, level, "analysis");
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    if (!result?.view) return;
    void show(result.view).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["imageInput", "sigma", "rho", "minCoherency", "minEnergy"]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

// One load or run at a time: `begin` claims the slot and links the caller's signal.
function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(true);
  progress.begin(message);
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

function describe(image) {
  const [nx, ny, nz] = image.dims;
  const size = nz > 1 ? `${nx} × ${ny} × ${nz}` : `${nx} × ${ny}`;
  const voxel = image.unit === "pixel" ? "" : ` · ${image.spacing.slice(0, nz > 1 ? 3 : 2).map((s) => Number(s.toPrecision(4))).join(" × ")} ${image.unit}`;
  return `${nz > 1 ? "3D" : "2D"} ${size}${voxel}`;
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading image…", signal);
  loading = operation.controller;
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    if (!files.length) throw new Error("Choose an image.");
    const { name, image } = await readImages(files);
    current.throwIfAborted();
    // A stack of slices is named after its first slice; its input row downloads the stack.
    const file = files.length === 1 ? files[0] : new File([niftiFile(image.data, image, "stack.nii")], `${baseName(name)}_stack.nii`);
    const view = { file: niftiFile(image.data, image, `${name}.nii`), colormap: "gray" };
    await show(view, { signal: current });
    current.throwIfAborted();
    // A 2D image has one plane to show; a stack starts on all three.
    const plane = image.dims[2] > 1 ? "multiplanar" : "axial";
    toolbar.setActive(plane);
    setLayout(plane);
    input = { file, image, view };
    clearOutputs();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${files.length > 1 ? `${files.length} slices from ${name}` : file.name} · ${describe(image)}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded`);
  } finally {
    loading = null;
    finish(operation);
  }
}

/** One analysis in a new module worker; aborting terminates it. */
function analyseInWorker(image, settings, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The analysis worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) {
        progress.setProgress(0.9 * data.progress);
        return;
      }
      stop();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    const { data, dims, spacing } = image;
    worker.postMessage({ image: { data: data.slice(), dims, spacing }, settings });
  });
}

function formSettings() {
  return analysisSettings({
    sigma: $("sigma").valueAsNumber,
    rho: $("rho").valueAsNumber,
    minCoherency: $("minCoherency").valueAsNumber,
    minEnergy: $("minEnergy").valueAsNumber / 100,
  });
}

function showSettings(settings) {
  $("sigma").value = String(settings.sigma);
  $("rho").value = String(settings.rho);
  $("minCoherency").value = String(settings.minCoherency);
  $("minEnergy").value = String(settings.minEnergy * 100);
}

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

async function analyse(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image before analysing it.");
  const refusal = imageRefusal(input.image, settings);
  if (refusal) throw new Error(refusal);
  const operation = begin(`Analysing ${input.file.name}…`, signal);
  running = operation.controller;
  const current = operation.controller.signal;
  progress.setCancellable(true);
  clearOutputs();
  try {
    const started = performance.now();
    analysisLog(`${input.file.name} (${describe(input.image)}): σ ${settings.sigma} px, ρ ${settings.rho} px; distribution counts coherency ≥ ${settings.minCoherency} and energy ≥ ${settings.minEnergy * 100}% of max`);
    const result = await analyseInWorker(input.image, settings, current);
    log.log(`Structure tensor in ${((performance.now() - started) / 1000).toFixed(1)} s`, "info", "technical");
    progress.setProgress(0.95);
    const built = await buildOutputs({ name: input.file.name, image: input.image, settings, result, signal: current });
    current.throwIfAborted();
    await show(built.outputs.colour.view, { signal: current });
    current.throwIfAborted();
    outputs = built.outputs;
    results.render({ input: { description: "Input image", file: input.file, view: input.view, viewable: true }, ...outputs });
    $("outputSection").open = true;
    const { dominant } = result;
    const counted = Object.values(result.distributions)[0].total;
    if (result.dimensions === 2) {
      analysisLog(`Dominant orientation ${round(dominant.orientation)}°, coherency ${round(dominant.coherency, 3)}; ${counted} pixels in the distribution`);
    } else {
      analysisLog(`Dominant fibre direction azimuth ${round(dominant.azimuth)}°, elevation ${round(dominant.elevation)}°, coherency ${round(dominant.coherency, 3)}; ${counted} voxels in the distribution`);
    }
    progress.end("Orientation maps ready");
    status("Orientation maps ready");
    return {
      artifacts: Object.entries(outputs).map(([key, { file }]) => ({
        id: key,
        role: key === "distribution" || key === "summary" ? key : key === "colour" && result.dimensions === 2 ? "colour" : "maps",
        file,
      })),
      provenance: { ...built.report, seconds: round((performance.now() - started) / 1000, 1) },
    };
  } catch (error) {
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

function report(error) {
  const cancelled = error?.name === "AbortError";
  status(cancelled ? "Cancelled" : error.message, !cancelled);
  if (!cancelled) log.log(error.message, "error", "analysis");
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
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    if (/coherency|energy/i.test(error.message)) $("advancedSettings").open = true;
    report(error);
    return;
  }
  void analyse(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    analyse: async ({ inputs, parameters, signal }) => {
      const settings = analysisSettings(parameters);
      await loadFiles(Promise.resolve(inputs.image), signal);
      showSettings(settings);
      return analyse(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
