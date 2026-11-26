// Self-supervised denoising workspace for 2D images, 3D Z-stacks and 2D+T time-series.
// Runs Aydin FGR (Boosted Trees / Ridge), Zero-Shot Noise2Noise (ZS-N2N), and Generalized
// Anscombe VST + Non-Local Means inside a dedicated Web Worker with instant cancellation.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createNiivueVolumePreview,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { createFloat32Nifti, downloadFile } from "@neurodesk/webapp-components/file-io";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { DEFAULT_SETTINGS, METHODS, runSettings } from "@neurodesk/denoise/core";
import workerUrl from "./worker.js?worker&url";
import { APP, outputNames, provenance, resolvedSpacingUm, stackNifti, stackTiff } from "./config.js";
import { readVolume } from "./input.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Self-supervised denoising of 2D and 3D microscopy stacks",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const SLICE_TYPES = {
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  render: SLICE_TYPE.RENDER,
};
const viewer = new NiiVue({ isDragDropEnabled: false });
let layout = SLICE_TYPE.AXIAL;
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
toolbar.addEventListener("nd-view-change", ({ detail }) => {
  layout = SLICE_TYPES[detail.value] ?? SLICE_TYPE.MULTIPLANAR;
  if (attached) void attached.then(() => { viewer.sliceType = layout; });
});
$("viewer").prepend(toolbar);

const log = createConsole({
  id: "technicalLog",
  resizable: true,
  channels: [
    { id: "analysis", label: "Analysis" },
    { id: "technical", label: "Technical" },
  ],
});
$("viewer").append(log);

const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

let input = null;
let loading = null;
let loadingDone = Promise.resolve();
let importGeneration = 0;
let running = null;
let outputs = {};

function status(message, error = false, channel = "technical") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

const preview = createNiivueVolumePreview({ viewer, ready: Promise.resolve(), emptyState: $("emptyState") });
async function show(file, options) {
  await viewerReady();
  return preview({ file }, options);
}

const results = createResultList({
  element: $("resultList"),
  onView: (_stage, result) => {
    log.log(`Showing ${result.view.name}`, "info", "technical");
    void show(result.view).catch((error) => status(error.message, true));
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function clearOutputs() {
  outputs = {};
  results.render();
  $("outputSection").open = false;
}

async function clearPreview() {
  if (!attached) {
    $("emptyState").hidden = false;
    return;
  }
  await viewerReady();
  await preview(null);
}

async function clearInput() {
  const token = ++importGeneration;
  exampleControl.cancel();
  if (loading) {
    loading.abort();
    await loadingDone;
  }
  if (token !== importGeneration || running) return;
  input = null;
  clearOutputs();
  $("fileInfo").hidden = true;
  $("fileInfo").textContent = "";
  $("dropZone").classList.remove("has-files");
  $("runButton").disabled = true;
  $("location").textContent = "";
  await clearPreview();
  if (token !== importGeneration) return;
  progress.reset();
  $("statusText").textContent = "Drag and drop files";
  $("statusText").classList.remove("error");
}

const TASK_FORM_IDS = [
  "method",
  "mode",
  "nTrees",
  "maxDepth",
  "maxScale",
  "iterations",
  "channels",
  "noiseModel",
  "nlmStrength",
  "seed",
];

function syncDependentFields() {
  const method = $("method").value;
  const isGbdt = method === "fgr-gbdt";
  const isFgr = isGbdt || method === "fgr-ridge";
  const isZs = method === "zs-n2n";
  const isNlm = method === "vst-nlm";
  $("nTrees").disabled = !isGbdt;
  $("maxDepth").disabled = !isGbdt;
  $("maxScale").disabled = !isFgr;
  $("iterations").disabled = !isZs;
  $("channels").disabled = !isZs;
  $("noiseModel").disabled = !isNlm;
  $("nlmStrength").disabled = !isNlm;
  $("mode").disabled = isZs;
  $("seed").disabled = isNlm;
}
$("method").addEventListener("change", syncDependentFields);
syncDependentFields();

function setBusy(busy, { allowInputReplacement = false } = {}) {
  results.inert = busy;
  $("imageInput").disabled = busy && !allowInputReplacement;
  for (const id of TASK_FORM_IDS) $(id).disabled = busy;
  exampleControl?.setDisabled(busy && !allowInputReplacement);
  if (!busy) syncDependentFields();
  $("runButton").disabled = busy || !input;
}

function syncInputFiles(id, files) {
  $(id).dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files } }));
}

function begin(message, signal, { cancellable = false, allowInputReplacement = false } = {}) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  setBusy(true, { allowInputReplacement });
  progress.begin(message);
  progress.setCancellable(cancellable);
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  setBusy(false);
  progress.stopTimer();
  progress.setCancellable(false);
}

function niftiFor(volume, name) {
  const bytes = stackNifti(volume.data, volume.dims, volume.spacingUm, {
    axisKind: volume.axisKind,
    frameInterval: volume.frameInterval,
  });
  return new File([bytes], name, { type: "application/octet-stream" });
}

/** Explicit NIfTI dimensions for `createFloat32Nifti`, preserving 4D `[nx, ny, 1, nt]` movies. */
function niftiExportDims(volume) {
  const [nz, ny, nx] = volume.dims;
  return volume.axisKind === "t" && nz > 1 ? [nx, ny, 1, nz] : [nx, ny, nz];
}

function oneFile(files) {
  if (files.length !== 1) throw new Error(`Choose one TIFF or NIfTI file; this selection has ${files.length}.`);
  return files[0];
}

function describeVolume(volume) {
  const [nz, ny, nx] = volume.dims;
  const shape = nz > 1 ? `${nx} × ${ny} × ${nz}${volume.axisKind === "t" ? " frames" : ""}` : `${nx} × ${ny} (2D)`;
  const s = volume.spacingUm;
  const parts = [volume.name, shape];
  if (s?.x > 0 && s?.y > 0) {
    const sx = Number(s.x.toPrecision(4));
    const sy = Number(s.y.toPrecision(4));
    const zText = nz > 1 && volume.axisKind !== "t" && s.z > 0 ? ` × ${Number(s.z.toPrecision(4))}` : "";
    parts.push(`${sx} × ${sy}${zText} µm`);
  }
  if (volume.axisKind === "t" && volume.frameInterval > 0) {
    parts.push(`${Number(volume.frameInterval.toPrecision(4))} s/frame`);
  }
  return parts.join(" · ");
}

/**
 * Loads one file bundle inside a single busy transaction spanning fetch, parse and preview so
 * Run and previous outputs stay locked while loading. During an example fetch, keeps `#imageInput`
 * open to replacement drops and delegates cancellation to the example selector's single Cancel button.
 */
async function loadFiles(filesPromise, signal, { assertCurrent, label = "Reading image…", fromExample = false } = {}) {
  const operation = begin(label, signal, {
    cancellable: !fromExample,
    allowInputReplacement: fromExample,
  });
  loading = operation.controller;
  const current = operation.controller.signal;
  let done;
  loadingDone = new Promise((resolve) => { done = resolve; });
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    assertCurrent?.();
    const file = oneFile(files);
    const volume = await readVolume(file, { signal: current });
    current.throwIfAborted();
    assertCurrent?.();
    const [nz] = volume.dims;
    const is3dSpatial = nz > 1 && volume.axisKind !== "t";
    const viewId = is3dSpatial ? "multiplanar" : "axial";
    layout = SLICE_TYPES[viewId];
    toolbar.setActive(viewId);
    const names = outputNames(file.name);
    let view;
    if (volume.format === "nifti") {
      view = volume.previewBuffer
        ? new File([volume.previewBuffer], file.name, { type: "application/octet-stream" })
        : file;
    } else {
      view = niftiFor(
        { ...volume, spacingUm: resolvedSpacingUm(volume.spacingUm) },
        names.previewNifti.replace(/\.gz$/, ""),
      );
    }
    await show(view, { signal: current });
    if (attached) viewer.sliceType = layout;
    current.throwIfAborted();
    assertCurrent?.();

    input = { ...volume, file, view };
    clearOutputs();
    syncInputFiles("imageInput", files);
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = describeVolume(volume);
    $("dropZone").classList.add("has-files");
    log.log(`Loaded ${describeVolume(volume)} (${volume.format.toUpperCase()})`, "info", "analysis");
    progress.setProgress(0);
    status(`${file.name} loaded`);
  } catch (error) {
    // Keep the shell's page-drop / Undo record aligned with the last accepted input.
    if (error?.name !== "AbortError") {
      syncInputFiles("imageInput", input ? [input.file] : []);
    }
    progress.reset();
    throw error;
  } finally {
    loading = null;
    finish(operation);
    done();
  }
}

function inWorker(request, transfer, signal, onProgress) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
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
      reject(new Error(event.message || "The denoising worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        onProgress?.(data);
        return;
      }
      stop();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    };
    worker.postMessage(request, transfer);
  });
}

/** Reads only the active controls for the selected method so disabled fields cannot block a run. */
function formSettings() {
  const method = $("method").value;
  const raw = { method };
  if (method !== "zs-n2n") raw.mode = $("mode").value;
  if (method === "fgr-gbdt" || method === "fgr-ridge") {
    raw.maxScale = Number($("maxScale").value);
    raw.seed = $("seed").valueAsNumber;
  }
  if (method === "fgr-gbdt") {
    raw.nTrees = $("nTrees").valueAsNumber;
    raw.maxDepth = $("maxDepth").valueAsNumber;
  }
  if (method === "zs-n2n") {
    raw.iterations = $("iterations").valueAsNumber;
    raw.channels = $("channels").valueAsNumber;
    raw.seed = $("seed").valueAsNumber;
  }
  if (method === "vst-nlm") {
    raw.noiseModel = $("noiseModel").value;
    raw.nlmStrength = $("nlmStrength").valueAsNumber;
  }
  return runSettings(raw);
}

function applySettingsToForm(settings) {
  $("method").value = settings.method;
  $("mode").value = settings.mode;
  $("nTrees").value = String(settings.nTrees);
  $("maxDepth").value = String(settings.maxDepth);
  $("maxScale").value = String(settings.maxScale);
  $("iterations").value = String(settings.iterations);
  $("channels").value = String(settings.channels);
  $("noiseModel").value = settings.noiseModel;
  $("nlmStrength").value = String(settings.nlmStrength);
  $("seed").value = String(settings.seed);
  syncDependentFields();
}

function yieldFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function denoise(signal, settings = formSettings()) {
  if (!input) throw new Error("Load an image or stack before denoising.");
  const methodInfo = METHODS[settings.method];
  const operation = begin(`Denoising ${input.name} with ${methodInfo.shortLabel}…`, signal, { cancellable: true });
  running = operation.controller;
  const current = operation.controller.signal;
  clearOutputs();
  try {
    const started = performance.now();
    const copy = Float32Array.from(input.data);
    progress.setProgress(0.02);
    const { denoised, residual, diagnostics, details } = await inWorker(
      { type: "denoise", image: copy, dims: input.dims, settings },
      [copy.buffer],
      current,
      ({ fraction, stage }) => {
        progress.setProgress(0.02 + 0.88 * fraction);
        $("statusText").textContent = stage;
      },
    );
    current.throwIfAborted();
    await yieldFrame();
    current.throwIfAborted();

    const seconds = (performance.now() - started) / 1000;
    const names = outputNames(input.name);
    const exportOpts = { axisKind: input.axisKind, frameInterval: input.frameInterval };
    const niftiDims = niftiExportDims(input);

    const tiff = new File(
      [stackTiff(denoised, input.dims, input.spacingUm, exportOpts)],
      names.tiff,
      { type: "image/tiff" },
    );
    const niftiBytes = input.format === "nifti"
      ? createFloat32Nifti(denoised, input.niftiHeader, niftiDims)
      : stackNifti(denoised, input.dims, input.spacingUm, exportOpts);
    const nifti = await gzipFile(niftiBytes, names.nifti, current);
    current.throwIfAborted();

    const residualTiff = new File(
      [stackTiff(residual, input.dims, input.spacingUm, exportOpts)],
      names.residualTiff,
      { type: "image/tiff" },
    );
    // Preserve the original NIfTI affine/orientation and 4D frame count for the residual preview too.
    const residualViewBytes = input.format === "nifti"
      ? createFloat32Nifti(residual, input.niftiHeader, niftiDims)
      : stackNifti(residual, input.dims, resolvedSpacingUm(input.spacingUm), exportOpts);
    const residualView = new File(
      [residualViewBytes],
      names.residualNifti.replace(/\.gz$/, ""),
      { type: "application/octet-stream" },
    );

    await show(nifti, { signal: current });
    if (attached) viewer.sliceType = layout;
    current.throwIfAborted();

    const record = provenance({
      input: input.name,
      dims: input.dims,
      axisKind: input.axisKind,
      settings,
      details,
      diagnostics,
      seconds: Number(seconds.toFixed(1)),
    });

    outputs = {
      image: { description: `Denoised · ${methodInfo.shortLabel} (TIFF)`, file: tiff, view: nifti },
      nifti: { description: "Denoised (NIfTI)", file: nifti, view: nifti },
      residual: { description: "Noise residual · input − denoised (TIFF)", file: residualTiff, view: residualView },
    };
    results.render({ input: { description: "Input image", file: input.file, view: input.view }, ...outputs });
    $("outputSection").open = true;

    const acParts = [
      `X ${diagnostics.residualAutocorrX.toFixed(3)}`,
      `Y ${diagnostics.residualAutocorrY.toFixed(3)}`,
      ...(diagnostics.residualAutocorrZ === null ? [] : [`${input.axisKind === "t" ? "T" : "Z"} ${diagnostics.residualAutocorrZ.toFixed(3)}`]),
    ];
    const backendNote = details?.backend
      ? ` on ${details.backend === "webgpu" ? `WebGPU (${details.adapter ?? "GPU"})` : "CPU"}`
      : "";
    log.log(
      `${methodInfo.label}${backendNote} finished in ${seconds.toFixed(1)} s · estimated noise σ: ${diagnostics.inputNoiseSigma.toPrecision(3)} → ${diagnostics.denoisedNoiseSigma.toPrecision(3)} (noise-floor drop ${diagnostics.noiseFloorDropDb.toFixed(1)} dB) · residual lag-1 autocorr (${acParts.join(", ")})`,
      "info",
      "analysis",
    );
    if (diagnostics.structureWarning) {
      log.log(
        `Max |residual lag-1 autocorr| is ${diagnostics.residualMaxAbsAutocorr.toFixed(2)} (> 0.35): inspect the noise residual map for possible over-smoothing.`,
        "warning",
        "analysis",
      );
    }
    log.log(`Provenance: ${JSON.stringify(record)}`, "info", "technical");
    progress.end("Image denoised");
    status("Image denoised");
    return {
      artifacts: [
        { role: "image", file: tiff },
        { role: "nifti", file: nifti },
        { role: "residual", file: residualTiff },
      ],
      provenance: record,
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
  status(cancelled ? "Cancelled" : error.message, !cancelled, cancelled ? "technical" : "analysis");
}

async function importFiles(files) {
  const token = ++importGeneration;
  exampleControl.cancel();
  if (loading) {
    loading.abort();
    await loadingDone;
  }
  if (token !== importGeneration) return;
  try {
    await loadFiles(files);
  } catch (error) {
    if (token === importGeneration) report(error);
  }
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (!files.length) {
    // Undo back to an empty initial state cancels any in-flight load and clears the viewer.
    if (!running) void clearInput().catch(report);
    return;
  }
  void importFiles(Promise.resolve(files));
});

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    await loadFiles(fetchFiles(), signal, {
      assertCurrent,
      label: `Loading ${example.label}…`,
      fromExample: true,
    });
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = formSettings();
  } catch (error) {
    $("advancedSettings").open = true;
    report(error);
    return;
  }
  void denoise(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    denoise: async ({ inputs, parameters, signal }) => {
      const settings = runSettings({ ...DEFAULT_SETTINGS, ...parameters });
      await loadFiles(Promise.resolve(inputs.image), signal);
      applySettingsToForm(settings);
      return denoise(signal, settings);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, outputs: () => outputs });
