// Calcium imaging: two-photon movie preprocessing (motion correction, summary images, ROIs,
// ΔF/F and AR(1) deconvolution) in module workers. Numerics live in src/core, outputs in
// src/outputs.js; this file is the workflow and the viewer.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import NiiVue, { SLICE_TYPE } from "@niivue/niivue";
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
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { imagejDescription, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import { APP, MOTION_LABELS, SettingsError, provenance, readSettings } from "./config.js";
import { addDiscRoi, removeRoiAt } from "./core/rois.js";
import { borderMargin } from "./core/pipeline.js";
import { outputStem, roisCsv, shiftSvg, shiftsCsv, toInputType, traceSvg, tracesCsv } from "./outputs.js";
import { displayNifti, displaySpacing, roiColormap } from "./display.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const SHARED = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === "function";
const SETTING_IDS = ["frameRate", "motion", "diameter", "maxShift", "upsample", "normalization", "templatePasses", "patchSize", "patchOverlap", "maxDeviation", "seedZ", "neuropilCoefficient", "baselineWindow", "baselinePercentile"];
const ADVANCED = new Set(["maxShift", "upsample", "normalization", "templatePasses", "patchSize", "patchOverlap", "maxDeviation", "seedZ", "neuropilCoefficient", "baselineWindow", "baselinePercentile"]);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Two-photon motion correction, ROIs, ΔF/F and spikes",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

// Viewer toolbar: image or traces, a frame slider for movies and the ROI overlay opacity.
const frameSlider = document.createElement("input");
Object.assign(frameSlider, { id: "frameSlider", type: "range", min: "1", max: "1", step: "1", value: "1" });
frameSlider.setAttribute("aria-label", "Frame");
const frameValue = document.createElement("span");
frameValue.id = "frameValue";
const frameControl = document.createElement("label");
frameControl.className = "nd-opacity-control";
frameControl.hidden = true;
frameControl.append("Frame", frameSlider, frameValue);
const toolbar = createViewerToolbar({
  views: [
    { id: "image", label: "Image", active: true },
    { id: "traces", label: "Traces" },
  ],
  window: false,
  colormap: false,
  download: false,
  screenshot: false,
  actions: [frameControl],
});
$("viewer").prepend(toolbar);
const log = createConsole({ id: "technicalLog", resizable: true, channels: [{ id: "analysis", label: "Analysis" }, { id: "technical", label: "Technical" }] });
$("viewer").append(log);
const progress = new ProgressManager();
bindInfoTooltips(document);

const info = createInfoDialog();
$("aboutBtn").onclick = () => info.open(`About ${APP.title}`, $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

const viewer = new NiiVue({ isDragDropEnabled: false });
let attached = null;
let cursor = null;
let overlayOpacity = 0.6;
function viewerReady() {
  attached ??= viewer.attachTo("gl1").then(() => {
    viewer.sliceType = SLICE_TYPE.AXIAL;
    viewer.isLegendVisible = false;
    viewer.createExtensionContext().on("locationChange", (event) => {
      const vox = event.detail.vox;
      cursor = vox ? { x: Math.round(vox[0]), y: Math.round(vox[1]) } : null;
      const roi = cursor && run?.labels ? run.labels[cursor.y * input.dims.width + cursor.x] : 0;
      $("location").textContent = cursor ? `x ${cursor.x}, y ${cursor.y}${roi ? ` · ROI ${roi}` : ""} · ${event.detail.string}` : "";
      updateRoiButtons();
    });
  });
  return attached;
}

// State: the loaded movie, the last run, and the operation in progress.
let input = null;
let run = null;
let loading = null;
let running = null;
let shown = null;

function status(message, error = false) {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", "analysis");
}

function technical(message) {
  log.log(message, "info", "technical");
}

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => void show(stage).catch((error) => status(error.message, true)),
  onDownload: (_stage, result) => downloadFile(result.file),
});

function setBusy(busy) {
  results.inert = busy;
  for (const id of ["movieInput", ...SETTING_IDS, "deconvolution"]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
  updateRoiButtons(busy);
}

function updateRoiButtons(busy = Boolean(loading || running)) {
  const ready = Boolean(run && cursor && !busy);
  const onRoi = ready && run.labels[cursor.y * input.dims.width + cursor.x] > 0;
  $("addRoi").disabled = !ready || onRoi;
  $("removeRoi").disabled = !ready || !onRoi;
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  status(message);
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
}

/** One task in a fresh module worker; aborting terminates it. */
function callWorker(message, { signal, onProgress, transfer = [] } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const stop = () => {
      signal?.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The worker failed to start."));
    };
    worker.onmessage = ({ data }) => {
      if (data.progress !== undefined) {
        onProgress?.(data.progress);
        return;
      }
      stop();
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.postMessage(message, transfer);
  });
}

function floatArray(length) {
  return new Float32Array(SHARED ? new SharedArrayBuffer(length * 4) : new ArrayBuffer(length * 4));
}

function clearRun() {
  run = null;
  displayFiles.clear();
  results.render();
  $("outputSection").open = false;
  $("roiSection").open = false;
  $("traceReport").replaceChildren();
  updateRoiButtons();
}

async function loadFiles(filesPromise, signal) {
  const operation = begin("Reading movie…", signal);
  loading = operation.controller;
  setBusy(true);
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    if (files.length !== 1) throw new Error(`Choose one TIFF movie; this selection has ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    if (!/\.tiff?$/i.test(file.name)) throw new Error(`${file.name} is not a TIFF (.tif, .tiff or .ome.tif) movie.`);
    const buffer = await file.arrayBuffer();
    current.throwIfAborted();
    const decoded = await callWorker({ type: "decode", buffer, shared: SHARED }, {
      signal: current,
      transfer: [buffer],
      onProgress: (fraction) => progress.setProgress(fraction * 0.9, "Reading movie…"),
    });
    current.throwIfAborted();
    const { width, height, pages: frames, dtype, metadata } = decoded;
    if (frames < 20) throw new Error(`${file.name} has ${frames} pages; a movie needs at least 20 frames.`);
    if (metadata.sizeC > 1) throw new Error(`${file.name} has ${metadata.sizeC} channels; save the calcium channel as its own movie.`);
    if (metadata.sizeZ > 1 && metadata.sizeT > 1) throw new Error(`${file.name} is a volume time series (${metadata.sizeZ} planes); save one plane as its own movie.`);
    const dims = { width, height, frames, dtype, metadataKind: metadata.kind, pixelSize: metadata.pixelSize, frameInterval: metadata.frameInterval };
    const movieFile = displayNifti(`${outputStem(file.name)}.nii`, decoded.movie, { width, height, frames, spacing: displaySpacing(metadata.pixelSize), frameInterval: metadata.frameInterval ?? 1 });
    current.throwIfAborted();
    input = { file, dims, movie: decoded.movie, display: movieFile };
    clearRun();
    $("frameRate").value = metadata.frameInterval ? String(Number((1 / metadata.frameInterval).toPrecision(6))) : "";
    $("movieInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    $("fileInfo").hidden = false;
    const rate = metadata.frameInterval ? ` · ${(1 / metadata.frameInterval).toPrecision(4)} Hz` : " · frame rate not recorded";
    const pixel = metadata.pixelSize?.x ? ` · ${metadata.pixelSize.x.toPrecision(3)} µm` : "";
    $("fileInfo").textContent = `${file.name} · ${width} × ${height} · ${frames} frames · ${dtype}${rate}${pixel}`;
    $("dropZone").classList.add("has-files");
    technical(`Decoded ${metadata.kind} TIFF: ${frames} pages of ${width} × ${height} ${dtype}; ${SHARED ? "shared memory" : "copied buffers"}`);
    await show("input");
    progress.setProgress(0);
    status(metadata.frameInterval ? `${file.name} loaded` : `${file.name} loaded · enter its frame rate`);
    if (!metadata.frameInterval) $("frameRate").focus();
  } finally {
    loading = null;
    finish(operation);
    setBusy(false);
  }
}

function formValues() {
  const values = Object.fromEntries(SETTING_IDS.map((id) => [id, $(id).value]));
  values.deconvolution = $("deconvolution").checked;
  return values;
}

function showSettings(settings) {
  for (const id of SETTING_IDS) if (settings[id] !== undefined) $(id).value = String(settings[id]);
  if (settings.deconvolution !== undefined) $("deconvolution").checked = settings.deconvolution;
}

function splitFrames(frames, parts) {
  const ranges = [];
  for (let k = 0; k < parts; k++) {
    const start = Math.floor((k * frames) / parts);
    const end = Math.floor(((k + 1) * frames) / parts);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
}

async function motionCorrect(settings, signal) {
  const { width, height, frames } = input.dims;
  const plane = width * height;
  const movie = input.movie;
  const out = floatArray(movie.length);
  const threads = SHARED ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1, Math.ceil(frames / 16))) : 1;
  const passes = settings.motion === "none" ? 1 : settings.templatePasses;
  let { template } = await callWorker({ type: "template", movie, width, height, frames }, { signal });
  let shifts = [];
  let patches = null;
  let grid = null;
  technical(`Motion correction (${MOTION_LABELS[settings.motion]}) in ${threads} worker${threads > 1 ? "s" : ""}, ${passes} template pass${passes > 1 ? "es" : ""}`);
  for (let pass = 1; pass <= passes; pass++) {
    const motion = pass < passes ? "rigid" : settings.motion;
    const ranges = splitFrames(frames, threads);
    const done = new Array(ranges.length).fill(0);
    const report = () => {
      const fraction = (pass - 1 + done.reduce((a, b) => a + b, 0) / frames) / passes;
      progress.setProgress(0.05 + 0.75 * fraction, `Motion correction, pass ${pass} of ${passes}…`);
    };
    const parts = await Promise.all(ranges.map(([start, end], k) => callWorker(
      { type: "register", movie, out: SHARED ? out : null, template, width, height, start, end, options: { ...settings, motion } },
      { signal, onProgress: (count) => { done[k] = count; report(); } },
    )));
    if (!SHARED) parts.forEach((part, k) => out.set(part.frames, ranges[k][0] * plane));
    shifts = parts.flatMap((part) => part.shifts);
    patches = parts.every((part) => part.patches) ? parts.flatMap((part) => part.patches) : null;
    grid = parts[0].grid;
    if (pass < passes) {
      const sum = new Float64Array(plane);
      for (const part of parts) for (let i = 0; i < plane; i++) sum[i] += part.sum[i];
      template = Float64Array.from(sum, (value) => value / frames);
    }
  }
  return { registered: out, shifts, patches, grid };
}

function textFile(text, name, type) {
  return new File([text], name, { type });
}

function tiffFile(name, data, frames) {
  const { width, height, pixelSize, frameInterval } = input.dims;
  const description = imagejDescription({ frames, frameInterval: frames > 1 ? (frameInterval ?? 1 / run.settings.frameRate) : null, unit: pixelSize?.x ? "micron" : null });
  const bytes = writeTiffStack({ width, height, data, description, pixelSize: pixelSize?.x && pixelSize?.y ? pixelSize : null });
  return new File([bytes], name, { type: "image/tiff" });
}

/** The output files of the current run (rebuilt after ROI edits). */
function buildOutputs() {
  const stem = outputStem(input.file.name);
  const { frames } = input.dims;
  const { settings, analysis } = run;
  const cells = analysis.cells;
  const rate = settings.frameRate;
  const record = provenance({ input: input.file, settings, dims: input.dims, roiSource: run.roiSource, cells, detection: run.detection, timings: run.timings });
  run.files = {
    registered: { description: `Registered movie · ${MOTION_LABELS[settings.motion]}`, file: run.files?.registered?.file ?? tiffFile(`${stem}_registered.tif`, toInputType(run.registered, input.dims.dtype), frames) },
    shifts: { description: "Shifts (CSV)", file: textFile(shiftsCsv(run, rate), `${stem}_shifts.csv`, "text/csv"), viewable: false },
    mean: { description: "Mean image", file: run.files?.mean?.file ?? tiffFile(`${stem}_mean.tif`, analysis.mean, 1) },
    max: { description: "Max image", file: run.files?.max?.file ?? tiffFile(`${stem}_max.tif`, analysis.max, 1) },
    correlation: { description: "Correlation image", file: run.files?.correlation?.file ?? tiffFile(`${stem}_correlation.tif`, analysis.correlation, 1) },
    labels: { description: `ROI labels · ${cells.length} ROIs`, file: tiffFile(`${stem}_rois.tif`, run.labels, 1) },
    traces: { description: "Traces (CSV)", file: textFile(tracesCsv(cells, frames, rate), `${stem}_traces.csv`, "text/csv") },
    rois: { description: "ROI table (CSV)", file: textFile(roisCsv(cells), `${stem}_rois.csv`, "text/csv"), viewable: false },
    plot: { description: "Trace plot (SVG)", file: textFile(traceSvg(cells, frames, rate), `${stem}_traces.svg`, "image/svg+xml") },
    provenance: { description: "Provenance (JSON)", file: textFile(`${JSON.stringify(record, null, 2)}\n`, `${stem}_provenance.json`, "application/json"), viewable: false },
  };
  results.render(run.files);
  renderReport();
  return record;
}

function renderReport() {
  const { frames } = input.dims;
  const rate = run.settings.frameRate;
  const cells = run.analysis.cells;
  const figure = (caption, svg) => {
    const element = document.createElement("figure");
    element.className = "nd-chart-figure";
    const title = document.createElement("figcaption");
    title.textContent = caption;
    element.append(title);
    element.insertAdjacentHTML("beforeend", svg);
    return element;
  };
  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  const flagged = cells.filter((cell) => cell.undefinedSamples > 0).length;
  lead.textContent = `${cells.length} ROIs${flagged ? ` · ${flagged} with a non-positive baseline (ΔF/F undefined)` : ""}`;
  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent = "Grey: ΔF/F. Green: OASIS denoised calcium. Each row has its own scale, given at the left.";
  const children = [lead, figure("ΔF/F per ROI", traceSvg(cells, frames, rate))];
  if (run.settings.motion !== "none") children.push(figure("Rigid shifts", shiftSvg(run.shifts, rate)));
  children.push(notes);
  $("traceReport").replaceChildren(...children);
}

function setView(view) {
  toolbar.setActive(view);
  const traces = view === "traces";
  $("traceReport").hidden = !traces || !run;
  $("gl1").hidden = traces && Boolean(run);
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  if (detail.value === "traces" && !run) {
    status("Run preprocessing to see traces");
    toolbar.setActive("image");
    return;
  }
  setView(detail.value);
});

const displayFiles = new Map();
function displayFile(key, data, frames = 1, window = undefined) {
  if (!displayFiles.has(key)) {
    const { width, height, pixelSize } = input.dims;
    displayFiles.set(key, displayNifti(`${key}.nii`, data, { width, height, frames, spacing: displaySpacing(pixelSize), frameInterval: 1 / (run?.settings.frameRate ?? 1), window }));
  }
  return displayFiles.get(key);
}

/** Shows an input or result in the viewer, with the ROI labels over still images. */
async function show(stage) {
  if (["traces", "plot", "shifts", "rois", "provenance"].includes(stage)) {
    setView("traces");
    return;
  }
  setView("image");
  await viewerReady();
  const movie = stage === "input" || stage === "registered";
  let base;
  if (stage === "input") base = input.display;
  else if (stage === "registered") base = displayFile(`registered-${run.id}`, run.registered, input.dims.frames);
  else {
    const image = stage === "labels" ? "correlation" : stage;
    base = displayFile(`${image}-${run.id}`, run.analysis[image]);
  }
  const volumes = [{ url: base, name: base.name, colormap: "gray" }];
  const overlay = !movie && run?.labels && run.analysis.cells.length > 0;
  if (overlay) {
    const labels = displayFile(`labels-${run.id}-${run.labelVersion}`, run.labels, 1, [0, run.analysis.cells.length]);
    volumes.push({ url: labels, name: labels.name, opacity: overlayOpacity });
  }
  await viewer.loadVolumes(volumes);
  if (overlay) await viewer.setColormapLabel(1, roiColormap(run.analysis.cells.length));
  $("emptyState").hidden = true;
  frameControl.hidden = !movie;
  frameSlider.max = String(input.dims.frames);
  frameSlider.value = "1";
  frameValue.textContent = "1";
  shown = stage;
}

frameSlider.addEventListener("input", () => {
  frameValue.textContent = frameSlider.value;
  const volume = viewer.volumes?.[0];
  if (volume) void viewer.setFrame4D(volume.id, Number(frameSlider.value) - 1);
});

let runCount = 0;
async function preprocess(signal, settings) {
  if (!input) throw new Error("Load a movie before preprocessing it.");
  const operation = begin(`Preprocessing ${input.file.name}…`, signal);
  running = operation.controller;
  setBusy(true);
  progress.setCancellable(true);
  const current = operation.controller.signal;
  clearRun();
  try {
    const started = performance.now();
    const corrected = await motionCorrect(settings, current);
    const motionSeconds = (performance.now() - started) / 1000;
    progress.setProgress(0.82, "Summary images, ROIs and traces…");
    const dims = { ...input.dims, frameRate: settings.frameRate };
    const margin = borderMargin(corrected.shifts, corrected.patches);
    const analysis = await callWorker({ type: "analyse", registered: corrected.registered, dims, options: settings, margin }, { signal: current });
    current.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    run = {
      id: ++runCount,
      labelVersion: 0,
      settings,
      ...corrected,
      analysis,
      labels: analysis.labels,
      detection: analysis.detection,
      roiSource: "detected",
      timings: { motionCorrectionSeconds: Number(motionSeconds.toFixed(2)), totalSeconds: Number(seconds.toFixed(2)) },
    };
    const record = buildOutputs();
    const maxShift = corrected.shifts.reduce((m, [dy, dx]) => Math.max(m, Math.abs(dy), Math.abs(dx)), 0);
    log.log(`Motion correction: largest rigid shift ${maxShift.toFixed(1)} px over ${input.dims.frames} frames (${motionSeconds.toFixed(1)} s)`, "info", "analysis");
    log.log(`ROIs: ${analysis.cells.length} from ${analysis.detection.seeds} seeds (seed threshold ${analysis.detection.threshold.toFixed(3)} correlation)`, "info", "analysis");
    $("outputSection").open = true;
    $("roiSection").open = true;
    await show("correlation");
    current.throwIfAborted();
    progress.end("Preprocessing complete");
    status(`Preprocessing complete · ${analysis.cells.length} ROIs · ${seconds.toFixed(1)} s`);
    return { artifacts: Object.entries(run.files).map(([role, { file }]) => ({ role, file })), provenance: record };
  } catch (error) {
    if (!run) clearRun();
    progress.reset();
    throw error;
  } finally {
    running = null;
    finish(operation);
    setBusy(false);
  }
}

/** Recomputes traces and deconvolution after an ROI edit. */
async function editRois(nextLabels, message) {
  const operation = begin(message, undefined);
  running = operation.controller;
  setBusy(true);
  progress.setCancellable(true);
  try {
    const dims = { ...input.dims, frameRate: run.settings.frameRate };
    const activity = await callWorker({ type: "activity", registered: run.registered, dims, options: run.settings, labels: nextLabels }, { signal: operation.controller.signal });
    run.labels = activity.labels;
    run.analysis = { ...run.analysis, cells: activity.cells };
    run.labelVersion++;
    run.roiSource = "detected and edited";
    buildOutputs();
    await show(shown === "input" || shown === "registered" || !shown ? "correlation" : shown);
    progress.end("ROIs updated");
    status(`ROIs updated · ${activity.cells.length} ROIs`);
  } finally {
    running = null;
    finish(operation);
    setBusy(false);
  }
}

$("addRoi").addEventListener("click", () => {
  if (!run || !cursor) return;
  const { width, height } = input.dims;
  const { labels, added } = addDiscRoi(run.labels, height, width, { y: cursor.y, x: cursor.x, diameter: run.settings.diameter });
  if (!added) {
    status("No free pixels at the cursor for a new ROI", true);
    return;
  }
  void editRois(labels, `Adding ROI ${added}…`).catch(report);
});
$("removeRoi").addEventListener("click", () => {
  if (!run || !cursor) return;
  const { labels, removed } = removeRoiAt(run.labels, input.dims.width, cursor);
  if (!removed) return;
  void editRois(labels, `Removing ROI ${removed}…`).catch(report);
});

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
$("movieInput").addEventListener("change", (event) => {
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

function settingsOrReport() {
  try {
    return readSettings(formValues());
  } catch (error) {
    if (error instanceof SettingsError) {
      if (ADVANCED.has(error.field)) $("advancedSettings").open = true;
      $(error.field)?.focus();
    }
    report(error);
    return null;
  }
}

$("runButton").addEventListener("click", () => {
  const settings = settingsOrReport();
  if (settings) void preprocess(undefined, settings).catch(report);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    preprocess: async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.movie), signal);
      const values = { ...formValues(), ...parameters };
      const settings = readSettings(values);
      showSettings(settings);
      return preprocess(signal, settings);
    },
  },
});
window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

export default Object.freeze({ workspace, toolbar, log, info, results, run: () => run });
