// Dermoscope ABCD: deterministic dermoscopic preprocessing, lesion segmentation,
// and experimental automated ABCD morphometry in a Web Worker.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./dermoscope.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createResultList,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  createExampleSelector,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { decodeRasterImage } from "@neurodesk/webapp-components/file-io/raster-image";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import workerUrl from "./worker.js?worker&url";
import { APP, SettingsError, readSettings } from "./config.js";
import { DERMOSCOPIC_COLORS } from "./core/color.js";
import {
  buildColorMapPixels,
  buildOverlayPixels,
  drawMorphometryGuides,
  renderAbcdReport,
} from "./display.js";
import { buildOutputFiles } from "./outputs.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const ADVANCED_FIELDS = new Set(["thresholdBias", "pixelsPerMm"]);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Experimental dermoscopy ABCD morphometry",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "overlay", label: "Overlay", active: true },
    { id: "preprocessed", label: "Preprocessed" },
    { id: "colors", label: "Colors" },
    { id: "original", label: "Original" },
    { id: "report", label: "Report" },
  ],
  viewsLabel: "Dermoscopy view",
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
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

// Application state
let input = null;
let run = null;
let loading = null;
let running = null;
let activeView = "overlay";
let overlayOpacity = 0.5;
let workerMessageId = 0;

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function reportError(error) {
  if (error instanceof SettingsError) {
    if (ADVANCED_FIELDS.has(error.field)) $("advancedSettings").open = true;
    $(error.field)?.focus();
  }
  status(
    error.name === "AbortError" ? "Cancelled" : error.message,
    error.name !== "AbortError",
  );
}

function syncCommittedFiles(cancelPending = false) {
  $("imageInput").dispatchEvent(
    new CustomEvent("nd-files", {
      bubbles: true,
      detail: {
        files: input ? [input.file] : [],
        ...(cancelPending ? { cancelPending: true } : {}),
      },
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Canvas layers and rendering

const canvas = $("canvas");
const context = canvas.getContext("2d");
const layers = {
  original: document.createElement("canvas"),
  preprocessed: document.createElement("canvas"),
  overlay: document.createElement("canvas"),
  colors: document.createElement("canvas"),
};
let viewTransform = { scale: 1, x: 0, y: 0, width: 0, height: 0 };

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paintCanvas(target, rgba, width, height) {
  target.width = width;
  target.height = height;
  target.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
}

function refreshDynamicLayers() {
  if (!run) return;
  paintCanvas(
    layers.overlay,
    buildOverlayPixels(run.mask, run.boundaryMask, run.width, run.height, overlayOpacity),
    run.width,
    run.height,
  );
  paintCanvas(
    layers.colors,
    buildColorMapPixels(run.abcd.color.colorMap, run.width, run.height, overlayOpacity),
    run.width,
    run.height,
  );
}

function setView(viewId) {
  activeView = viewId;
  toolbar.setActive(viewId);
  const showReport = viewId === "report" && Boolean(run);
  $("report").hidden = !showReport;
  canvas.hidden = showReport;
  if (!showReport) draw();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, canvas.width, canvas.height);

  if (!input) return;

  const baseLayer = run && activeView !== "original" ? layers.preprocessed : layers.original;
  const imgW = baseLayer.width;
  const imgH = baseLayer.height;
  if (!imgW || !imgH) return;

  const scale = Math.min(canvas.width / imgW, canvas.height / imgH);
  const x = (canvas.width - imgW * scale) / 2;
  const y = (canvas.height - imgH * scale) / 2;
  viewTransform = { scale, x, y, width: imgW, height: imgH };

  context.imageSmoothingEnabled = true;
  context.drawImage(baseLayer, x, y, imgW * scale, imgH * scale);

  if (run && run.segmented && activeView === "overlay" && overlayOpacity > 0) {
    context.drawImage(layers.overlay, x, y, imgW * scale, imgH * scale);
    drawMorphometryGuides(context, run, viewTransform, ratio, {
      primary: token("--nd-color-primary") || "currentColor",
      warning: token("--nd-color-warning") || "currentColor",
      muted: token("--nd-color-text-muted") || "currentColor",
    });
  } else if (run && run.segmented && activeView === "colors" && overlayOpacity > 0) {
    context.drawImage(layers.colors, x, y, imgW * scale, imgH * scale);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  if (detail.value === "report" && !run) {
    status("Analyze a lesion to view the ABCD report");
    toolbar.setActive(activeView);
    return;
  }
  setView(detail.value);
});

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (run) {
    refreshDynamicLayers();
    draw();
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!input || !viewTransform.width) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const ratio = canvas.width / rect.width;
  const ix = Math.floor(((event.clientX - rect.left) * ratio - viewTransform.x) / viewTransform.scale);
  const iy = Math.floor(((event.clientY - rect.top) * ratio - viewTransform.y) / viewTransform.scale);
  if (ix < 0 || ix >= viewTransform.width || iy < 0 || iy >= viewTransform.height) {
    $("location").textContent = "";
    return;
  }
  if (!run || activeView === "original") {
    const o = (iy * input.width + ix) * 4;
    $("location").textContent = `x ${ix} · y ${iy} · RGB(${input.data[o]}, ${input.data[o + 1]}, ${input.data[o + 2]})`;
    return;
  }
  const idx = iy * run.width + ix;
  const region = run.transparentMask?.[idx]
    ? "transparent"
    : run.vignetteMask[idx]
      ? "vignette"
      : run.mask[idx]
        ? `lesion · ${DERMOSCOPIC_COLORS[run.abcd.color.colorMap[idx] - 1]?.label ?? "classified"}`
        : "skin";
  const o = idx * 4;
  $("location").textContent = `x ${ix} · y ${iy} · RGB(${run.preprocessedRgba[o]}, ${run.preprocessedRgba[o + 1]}, ${run.preprocessedRgba[o + 2]}) · ${region}`;
});

// ---------------------------------------------------------------------------------------------
// Controls and results

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (!run) return;
    if (stage === "preprocessed") setView("preprocessed");
    else if (stage === "mask") setView("overlay");
    else setView("report");
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function formValues() {
  return {
    removeHair: $("removeHair").checked,
    colorConstancy: $("colorConstancy").checked,
    differentialStructures: Number($("differentialStructures").value),
    thresholdBias: $("thresholdBias").value,
    pixelsPerMm: $("pixelsPerMm").value,
  };
}

function applyFormSettings(settings) {
  $("removeHair").checked = settings.removeHair;
  $("colorConstancy").checked = settings.colorConstancy;
  $("differentialStructures").value = String(settings.differentialStructures ?? 0);
  $("thresholdBias").value = String(settings.thresholdBias);
  $("pixelsPerMm").value = String(settings.pixelsPerMm);
}

function updateControls() {
  const busy = Boolean(loading || running);
  results.inert = busy;
  for (const id of [
    "imageInput",
    "removeHair",
    "colorConstancy",
    "differentialStructures",
    "thresholdBias",
    "pixelsPerMm",
  ]) {
    $(id).disabled = busy;
  }
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function clearRun() {
  run = null;
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  setView("overlay");
}

function beginOperation(message, signal) {
  if (loading || running) {
    throw new Error("Wait for the current operation to finish, or cancel it.");
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finishOperation(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
  updateControls();
}

// ---------------------------------------------------------------------------------------------
// Image loading

async function loadFiles(
  filesSource,
  signal,
  { message = "Reading image…", restoreOnError = false } = {},
) {
  const operation = beginOperation(message, signal);
  loading = operation.controller;
  updateControls();
  progress.setCancellable(true);
  const current = operation.controller.signal;
  try {
    const files =
      typeof filesSource === "function" ? await filesSource(current) : await filesSource;
    current.throwIfAborted();
    if (files.length !== 1) {
      throw new Error(`Choose one dermoscopy image; this selection has ${files.length} files.`);
    }
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const decoded = await decodeRasterImage(file, { signal: current });
    current.throwIfAborted();

    input = { file, ...decoded };
    $("differentialStructures").value = "0";
    clearRun();
    paintCanvas(layers.original, input.data, input.width, input.height);
    $("emptyState").hidden = true;
    draw();
    syncCommittedFiles(false);
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${input.width} × ${input.height} · ${input.format.toUpperCase()}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded · ready for ABCD analysis`);
    log.log(`Loaded ${file.name} (${input.width} × ${input.height}, ${input.format})`, "info", "technical");
  } catch (error) {
    progress.stopTimer(true);
    progress.setProgress(0);
    if (restoreOnError) syncCommittedFiles(true);
    throw error;
  } finally {
    loading = null;
    finishOperation(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// Worker execution

function runInWorker(payload, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const id = ++workerMessageId;
    const stop = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      stop();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      stop();
      reject(new Error(event.message || "The dermoscopy worker failed."));
    };
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") {
        onProgress?.(data.value, data.message);
        return;
      }
      stop();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data.result);
    };
    const copy = new Uint8ClampedArray(payload.rgba);
    worker.postMessage(
      {
        id,
        rgba: copy,
        width: payload.width,
        height: payload.height,
        settings: payload.settings,
      },
      [copy.buffer],
    );
  });
}

async function analyzeLesion(signal, rawSettings = formValues()) {
  if (!input) throw new Error("Load a dermoscopy image before running analysis.");
  const settings = readSettings(rawSettings);
  const operation = beginOperation(`Analyzing ${input.file.name}…`, signal);
  running = operation.controller;
  updateControls();
  progress.setCancellable(true);
  const current = operation.controller.signal;
  clearRun();
  try {
    const started = performance.now();
    const result = await runInWorker(
      {
        rgba: input.data,
        width: input.width,
        height: input.height,
        settings,
      },
      {
        signal: current,
        onProgress: (value, message) => {
          progress.setProgress(value * 0.9, message);
          log.log(message, "info", "technical");
        },
      },
    );
    current.throwIfAborted();

    if (!result.segmented) {
      throw new Error(result.failureReason || "No lesion detected.");
    }

    const { record, files } = buildOutputFiles(result, {
      name: input.file.name,
      size: input.file.size,
      format: input.format,
    });
    run = { ...result, record, files };

    paintCanvas(layers.preprocessed, run.preprocessedRgba, run.width, run.height);
    refreshDynamicLayers();
    renderAbcdReport($("report"), run, input.file.name);
    results.render(run.files);
    $("outputSection").open = true;
    setView("overlay");

    const seconds = (performance.now() - started) / 1000;
    const { scores, border } = run.abcd;
    const bLabel = scores.B !== null ? String(scores.B) : "—";
    const unavailableSectors = border.unavailableSectors;
    let summaryLog;
    let done;
    if (scores.tds !== null) {
      summaryLog = `ABCD (experimental): A=${scores.A}, B=${bLabel}, C=${scores.C}, D=${scores.D} · TDS ${scores.tds.toFixed(2)}`;
      done = `Analysis complete · TDS ${scores.tds.toFixed(2)} (A${scores.A} B${bLabel} C${scores.C} D${scores.D})`;
    } else if (scores.D !== null && unavailableSectors > 0) {
      summaryLog = `ABCD (experimental): A=${scores.A}, B=${bLabel}, C=${scores.C}, D=${scores.D} (TDS unavailable: ${unavailableSectors}/8 border sectors unavailable)`;
      done = `Analysis complete · A${scores.A} B${bLabel} C${scores.C} D${scores.D} (TDS unavailable: incomplete border)`;
    } else if (unavailableSectors > 0) {
      summaryLog = `ABCD (experimental): A=${scores.A}, B=${bLabel}, C=${scores.C} (D not scored; ${unavailableSectors}/8 border sectors unavailable; TDS not computed)`;
      done = `Analysis complete · A${scores.A} B${bLabel} C${scores.C} (D unscored; incomplete border)`;
    } else {
      summaryLog = `ABCD (experimental): A=${scores.A}, B=${bLabel}, C=${scores.C} (D not scored; TDS not computed)`;
      done = `Analysis complete · A${scores.A} B${bLabel} C${scores.C} (D unscored)`;
    }
    log.log(summaryLog, "info", "analysis");
    log.log(
      `Preprocessed ${run.width} × ${run.height} (vignette ${run.vignetteCoveragePct.toFixed(1)}%, hair ${run.hairCoveragePct.toFixed(1)}%, ${run.repairedPixels} px repaired) in ${seconds.toFixed(2)} s`,
      "info",
      "technical",
    );
    progress.end(done);
    status(done);

    return {
      artifacts: Object.entries(run.files).map(([role, { file }]) => ({ role, file })),
      provenance: run.record,
    };
  } catch (error) {
    run = null;
    results.render();
    $("outputSection").open = false;
    progress.reset(input ? "Ready" : "Drag and drop files");
    throw error;
  } finally {
    running = null;
    finishOperation(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// User events, examples, and automation

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files, undefined, { restoreOnError: true }).catch(reportError);
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

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    await loadFiles(
      async (loadSignal) => {
        const files = await fetchFiles();
        assertCurrent();
        loadSignal.throwIfAborted();
        return files;
      },
      signal,
      { message: `Loading ${example.label}…`, restoreOnError: true },
    );
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  void analyzeLesion(undefined, formValues()).catch(reportError);
});

registerAppAutomation({
  app: APP.id,
  operations: {
    analyze: async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      const merged = readSettings({ ...formValues(), ...parameters });
      applyFormSettings(merged);
      return analyzeLesion(signal, merged);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
