// DermViT: local 7-class HAM10000 dermoscopic lesion classification + optional 5x5 occlusion
// sensitivity mapping with ONNX Runtime Web. Pure preprocessing & statistics live in src/core/vit.js
// and execute in src/worker.js; this module owns the workspace UI, canvas overlay, report, and WebMCP.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./dermvit.css";
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
import { InputTooLargeError } from "@neurodesk/webapp-components/file-io/input-limits";
import { probeRasterImage } from "@neurodesk/webapp-components/file-io/raster-image";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import workerUrl from "./worker.js?worker&url";
import {
  APP,
  MAX_DECODED_BYTES,
  MODEL,
  SALIENCY_EXPORT_OPACITY,
  buildProvenance,
  readSettings,
} from "./config.js";
import { normalizeInputRgba } from "./core/vit.js";
import { saliencyOverlayRgba } from "./display.js";
import {
  outputStem,
  predictionsCsv,
  probabilityChartSvg,
  provenanceJson,
} from "./outputs.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "HAM10000 ViT dermoscopy classification",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "image", label: "Image", active: true },
    { id: "report", label: "Report" },
  ],
  viewsLabel: "Display",
  window: false,
  overlay: true,
  colormap: false,
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);

let overlayOpacity = SALIENCY_EXPORT_OPACITY;
const opacitySlider = toolbar.control("overlayOpacity");
if (opacitySlider) {
  opacitySlider.value = String(overlayOpacity);
  const opacityValue = toolbar.control("overlayOpacityValue");
  if (opacityValue) opacityValue.textContent = `${Math.round(overlayOpacity * 100)}%`;
}

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

// ---------------------------------------------------------------------------------------------
// Application state.

let input = null; // { file, width, height, format, rgba, hadTransparency }
let classification = null; // { result, settings, record, seconds }
let outputs = {};
let loading = null;
let loadingPromise = null;
let running = null;

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function technical(message) {
  log.log(message, "info", "technical");
}

function reportError(error) {
  const cancelled = error?.name === "AbortError";
  const message = cancelled ? "Cancelled" : error?.message || String(error);
  status(message, !cancelled);
  if (!cancelled) {
    log.log(message, "error", "technical");
  }
}

// ---------------------------------------------------------------------------------------------
// Color-managed sRGB raster decoding with unified alpha policy.

async function decodeColorManagedSrgb(file, { maxBytes = MAX_DECODED_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal?.throwIfAborted();
  const header = probeRasterImage(bytes);
  if (!header) throw new Error(`${file.name ?? "This file"} is not a PNG or JPEG image.`);
  if (!header.width || !header.height) throw new Error(`${file.name ?? "This image"} has no pixels.`);
  const decodedBytes = header.width * header.height * 4;
  if (decodedBytes > maxBytes) {
    throw new InputTooLargeError(decodedBytes, maxBytes, { subject: "Decoded image" });
  }
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(new Blob([bytes]), {
    imageOrientation: "none",
    premultiplyAlpha: "none",
    colorSpaceConversion: "default",
  });
  try {
    if (bitmap.width !== header.width || bitmap.height !== header.height) {
      throw new Error(
        `The decoded image is ${bitmap.width} × ${bitmap.height}, not ${header.width} × ${header.height} as its header says.`,
      );
    }
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = offscreen.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const { rgba, hadTransparency } = normalizeInputRgba(data, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      format: header.format,
      data: rgba,
      hadTransparency,
    };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Persistent worker (caches ONNX Runtime session across runs; recreated after any error/cancel).

let inferenceWorker = null;
let workerMessageId = 0;
const pendingReplies = new Map();

function terminateWorker(worker, error) {
  if (inferenceWorker === worker) {
    inferenceWorker = null;
  }
  worker.onmessage = null;
  worker.onerror = null;
  worker.terminate();
  for (const [id, entry] of pendingReplies) {
    pendingReplies.delete(id);
    entry.reject(error);
  }
}

function stopWorker(reason = "Inference cancelled") {
  if (!inferenceWorker) return;
  terminateWorker(inferenceWorker, new DOMException(reason, "AbortError"));
}

function getWorker() {
  if (inferenceWorker) return inferenceWorker;
  const worker = new Worker(workerUrl, { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      if (running) {
        progress.setProgress(data.value, data.message);
        for (const entry of pendingReplies.values()) {
          entry.onProgress?.(data.value, data.message);
        }
      }
      return;
    }
    if (data.type === "log") {
      technical(data.message);
      return;
    }
    const entry = pendingReplies.get(data.id);
    if (!entry) return;
    pendingReplies.delete(data.id);
    if (data.type === "error") {
      const error = new Error(data.message);
      // Tear down the worker after any runtime/session error so the next run spawns a clean
      // worker and retries WASM/session initialization while reusing the verified model cache.
      terminateWorker(worker, error);
      entry.reject(error);
      return;
    }
    entry.resolve(data.result);
  };
  worker.onerror = (event) => {
    const message = event.message || "The DermViT inference worker failed.";
    terminateWorker(worker, new Error(message));
  };
  inferenceWorker = worker;
  return worker;
}

function runWorkerClassify(payload, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = getWorker();
    const id = ++workerMessageId;
    const onAbort = () => {
      pendingReplies.delete(id);
      stopWorker("Cancelled");
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    pendingReplies.set(id, {
      onProgress,
      resolve: (value) => {
        cleanup();
        resolve(value);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    // Transfer a copy so cancelling mid-run never detaches the displayed base image.
    const rgbaCopy = new Uint8ClampedArray(payload.rgba);
    worker.postMessage(
      {
        type: "classify",
        id,
        rgba: rgbaCopy,
        width: payload.width,
        height: payload.height,
        backend: payload.backend,
        colorConstancy: payload.colorConstancy,
        computeSaliency: payload.computeSaliency,
      },
      [rgbaCopy.buffer],
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Canvas viewer & saliency heatmap overlay.

const canvas = $("canvas");
const context = canvas.getContext("2d");
const layers = {
  base: document.createElement("canvas"),
  saliency: document.createElement("canvas"),
};
let viewport = { scale: 1, x: 0, y: 0 };

function paintLayer(layer, rgba, width, height) {
  layer.width = width;
  layer.height = height;
  layer.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
}

function refreshBaseLayer() {
  if (!input) return;
  paintLayer(layers.base, input.rgba, input.width, input.height);
}

function refreshSaliencyLayer() {
  if (!input || !classification?.result?.saliencyMap) return;
  const overlay = saliencyOverlayRgba(
    classification.result.saliencyMap,
    input.width,
    input.height,
    overlayOpacity,
  );
  paintLayer(layers.saliency, overlay, input.width, input.height);
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!input) return;
  const scale = Math.min(canvas.width / input.width, canvas.height / input.height);
  viewport = {
    scale,
    x: (canvas.width - input.width * scale) / 2,
    y: (canvas.height - input.height * scale) / 2,
  };
  context.imageSmoothingEnabled = scale < 2;
  context.drawImage(layers.base, viewport.x, viewport.y, input.width * scale, input.height * scale);
  if (classification?.result?.saliencyMap && overlayOpacity > 0) {
    context.drawImage(layers.saliency, viewport.x, viewport.y, input.width * scale, input.height * scale);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

function toImageCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const ratio = canvas.width / Math.max(1, rect.width);
  return [
    ((event.clientX - rect.left) * ratio - viewport.x) / viewport.scale,
    ((event.clientY - rect.top) * ratio - viewport.y) / viewport.scale,
  ];
}

canvas.addEventListener("pointermove", (event) => {
  if (!input) return;
  const [fx, fy] = toImageCoords(event);
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix >= input.width || iy >= input.height) {
    $("location").textContent = "";
    return;
  }
  const idx = iy * input.width + ix;
  const base = idx * 4;
  const rgb = `RGB ${input.rgba[base]}, ${input.rgba[base + 1]}, ${input.rgba[base + 2]}`;
  if (classification?.result?.saliencyMap) {
    const relPct = Math.round(classification.result.saliencyMap[idx] * 100);
    $("location").textContent = `x ${ix}, y ${iy} · ${rgb} · Occlusion sensitivity ${relPct}% (relative drop % of max positive drop)`;
  } else {
    $("location").textContent = `x ${ix}, y ${iy} · ${rgb}`;
  }
});

function setView(viewId) {
  if (viewId === "report" && !classification) {
    status("Classify an image first to view the report");
    toolbar.setActive("image");
    return;
  }
  toolbar.setActive(viewId);
  const showReport = viewId === "report";
  $("report").hidden = !showReport;
  canvas.hidden = showReport;
  if (!showReport) {
    if (classification?.result?.saliencyMap) refreshSaliencyLayer();
    draw();
  }
}

toolbar.addEventListener("nd-view-change", ({ detail }) => setView(detail.value));
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (classification?.result?.saliencyMap) {
    refreshSaliencyLayer();
    draw();
  }
});

// ---------------------------------------------------------------------------------------------
// Report rendering (research-only notice, ranked 7-class table, SVG bar chart, metadata).

function buildTable(caption, headers, rows, numericCols = []) {
  const scroll = document.createElement("div");
  scroll.className = "nd-table-scroll";
  const table = document.createElement("table");
  table.className = "nd-data-table";
  const cap = document.createElement("caption");
  cap.textContent = caption;
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of headers) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const { cells, flag } of rows) {
    const tr = document.createElement("tr");
    if (flag) tr.dataset.flag = flag;
    cells.forEach((value, colIdx) => {
      const td = document.createElement("td");
      if (numericCols.includes(colIdx)) td.className = "nd-numeric";
      td.textContent = value;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  scroll.append(table);
  return scroll;
}

function renderReport() {
  if (!classification) {
    $("report").replaceChildren();
    return;
  }
  const { result, settings } = classification;
  const { summary } = result;
  const top = summary.top;

  const disclaimer = document.createElement("p");
  disclaimer.className = "nd-message warning";
  disclaimer.textContent =
    "Research and educational use only — outputs are uncalibrated softmax scores, not clinical probabilities. DermViT is not a medical device and must not be used for clinical diagnosis, screening, or triage.";

  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  lead.textContent = `Top class: ${top.code} (${top.label}) · Softmax score ${(top.probability * 100).toFixed(1)}% (uncalibrated) · Margin ${(summary.margin * 100).toFixed(1)}% · Entropy ${summary.entropyBits.toFixed(2)} bits (${(summary.normalizedEntropy * 100).toFixed(0)}% of max)`;

  const figure = document.createElement("figure");
  figure.className = "nd-chart-figure";
  const figcaption = document.createElement("figcaption");
  figcaption.textContent = "HAM10000 7-class uncalibrated softmax scores";
  figure.append(figcaption);
  figure.insertAdjacentHTML("beforeend", probabilityChartSvg(summary));

  const table = buildTable(
    "Ranked HAM10000 uncalibrated softmax scores",
    ["Rank", "Code", "Lesion class", "Softmax score", "Logit"],
    summary.ranked.map((item) => ({
      cells: [
        String(item.rank),
        item.code,
        item.label,
        `${(item.probability * 100).toFixed(2)}%`,
        item.logit.toFixed(3),
      ],
      flag: item.rank === 1 ? "top" : undefined,
    })),
    [0, 3, 4],
  );

  const backendLabel = result.backend === "webgpu"
    ? "WebGPU"
    : `WebAssembly (${result.threads} thread${result.threads === 1 ? "" : "s"})`;
  const colorNote = settings.colorConstancy && result.colorConstancyGains
    ? `Shades of Gray (p=6) gains R=${result.colorConstancyGains.r}, G=${result.colorConstancyGains.g}, B=${result.colorConstancyGains.b}`
    : "No color constancy preprocessing";
  const alphaNote = input?.hadTransparency ? ", alpha composited over white" : "";
  const saliencyNote = result.saliency
    ? `5×5 occlusion sensitivity computed for ${result.saliency.topClassCode} (max softmax drop ${(result.saliency.maxDrop * 100).toFixed(1)}%; PNG exported at ${result.saliency.exportWidth}×${result.saliency.exportHeight}, ${Math.round(result.saliency.exportOpacity * 100)}% opacity).`
    : "Occlusion sensitivity not computed.";

  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent = `Model: ${MODEL.name} (${MODEL.architecture}). Backend: ${backendLabel}${result.ortVersion ? ` · ORT ${result.ortVersion}` : ""} · Inference ${result.inferenceSeconds.toFixed(2)} s. Preprocessing: sRGB${alphaNote}, ${MODEL.imageSize}×${MODEL.imageSize} Pillow antialiased bilinear, ${colorNote}. ${saliencyNote}`;

  const stack = document.createElement("div");
  stack.className = "nd-report-stack";
  stack.append(disclaimer, lead, figure, table, notes);
  $("report").replaceChildren(stack);
}

// ---------------------------------------------------------------------------------------------
// Result list & downloadable artifacts.

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (stage === "predictions") setView("report");
    else if (stage === "saliency") setView("image");
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function rebuildOutputs(record) {
  if (!classification || !input) {
    outputs = {};
    results.render();
    $("outputSection").open = false;
    return;
  }
  const stem = outputStem(input.file.name);
  const { result } = classification;
  const csvFile = new File([predictionsCsv(result.summary)], `${stem}_dermvit-predictions.csv`, {
    type: "text/csv",
  });
  const provFile = new File([provenanceJson(record)], `${stem}_dermvit-provenance.json`, {
    type: "application/json",
  });

  const next = {
    predictions: {
      description: `Predictions · ${result.summary.top.code} (${(result.summary.top.probability * 100).toFixed(1)}% softmax)`,
      file: csvFile,
    },
  };
  if (result.saliency && result.saliencyPng) {
    const pngFile = new File([result.saliencyPng], `${stem}_dermvit-saliency.png`, { type: "image/png" });
    next.saliency = {
      description: `Occlusion saliency (${result.saliency.topClassCode}) · PNG`,
      file: pngFile,
    };
  }
  next.provenance = {
    description: "Provenance · JSON",
    file: provFile,
    viewable: false,
  };

  outputs = next;
  results.render(outputs);
  $("outputSection").open = true;
}

// ---------------------------------------------------------------------------------------------
// Controls, loading, classification & cancellation.

function updateControls() {
  const busy = Boolean(loading || running);
  $("imageInput").disabled = busy;
  $("colorConstancy").disabled = busy;
  $("computeSaliency").disabled = busy;
  $("backend").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
}

function formSettings() {
  return readSettings({
    backend: $("backend").value,
    colorConstancy: $("colorConstancy").checked,
    computeSaliency: $("computeSaliency").checked,
  });
}

function applySettingsToForm(settings) {
  $("backend").value = settings.backend;
  $("colorConstancy").checked = settings.colorConstancy;
  $("computeSaliency").checked = settings.computeSaliency;
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
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

function clearOutputs() {
  classification = null;
  outputs = {};
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  layers.saliency.width = 0;
  layers.saliency.height = 0;
  toolbar.setActive("image");
  $("report").hidden = true;
  canvas.hidden = false;
  $("location").textContent = "";
  draw();
}

function onSettingChange() {
  if (!classification) return;
  clearOutputs();
  if (input && !loading && !running) {
    progress.setProgress(0);
    status("Settings changed · click Classify lesion");
  }
}

$("colorConstancy").addEventListener("change", onSettingChange);
$("computeSaliency").addEventListener("change", onSettingChange);
$("backend").addEventListener("change", onSettingChange);

async function cancelActiveLoad() {
  exampleControl.cancel();
  loading?.abort();
  if (loadingPromise) {
    await loadingPromise.catch(() => {});
  }
}

async function loadFiles(filesPromise, signal, { message = "Reading image…", fromExample = false } = {}) {
  const operation = begin(message, signal);
  loading = operation.controller;
  clearOutputs();
  updateControls();
  const current = operation.controller.signal;
  const runPromise = (async () => {
    try {
      const files = await filesPromise;
      current.throwIfAborted();
      if (files.length !== 1) {
        throw new Error(`Choose one dermoscopy image; this selection has ${files.length} files.`);
      }
      const [file] = files;
      if (!file.size) throw new Error(`${file.name} is empty.`);
      progress.setIndeterminate(`Decoding ${file.name}…`);
      const decoded = await decodeColorManagedSrgb(file, { maxBytes: MAX_DECODED_BYTES, signal: current });
      current.throwIfAborted();
      input = {
        file,
        width: decoded.width,
        height: decoded.height,
        format: decoded.format,
        rgba: decoded.data,
        hadTransparency: decoded.hadTransparency,
      };
      if (!fromExample) {
        exampleControl.reset();
      }
      refreshBaseLayer();
      $("emptyState").hidden = true;
      draw();
      $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
      $("fileInfo").hidden = false;
      $("fileInfo").textContent = `${file.name} · ${decoded.width} × ${decoded.height} · ${decoded.format.toUpperCase()}`;
      $("dropZone").classList.add("has-files");
      progress.setProgress(0);
      status(`${file.name} loaded · click Classify lesion`);
      technical(
        `Decoded color-managed sRGB ${decoded.format.toUpperCase()} image: ${decoded.width} × ${decoded.height} (${file.size} bytes)${decoded.hadTransparency ? " · alpha composited over white" : ""}`,
      );
    } catch (error) {
      progress.stopTimer(true);
      progress.setCancellable(false);
      progress.setProgress(0);
      $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: input?.file ? [input.file] : [] } }));
      throw error;
    } finally {
      loading = null;
      loadingPromise = null;
      finish(operation);
    }
  })();
  loadingPromise = runPromise;
  return runPromise;
}

async function runClassification(signal, settings = formSettings(), onAutomationProgress = null) {
  if (!input) throw new Error("Load a dermoscopy image before classifying.");
  const operation = begin(`Classifying ${input.file.name}…`, signal);
  running = operation.controller;
  clearOutputs();
  updateControls();
  const current = operation.controller.signal;
  try {
    const started = performance.now();
    const result = await runWorkerClassify(
      {
        rgba: input.rgba,
        width: input.width,
        height: input.height,
        backend: settings.backend,
        colorConstancy: settings.colorConstancy,
        computeSaliency: settings.computeSaliency,
      },
      {
        signal: current,
        onProgress: (value, message) => {
          onAutomationProgress?.({ value, message });
        },
      },
    );
    current.throwIfAborted();
    const seconds = (performance.now() - started) / 1000;
    const record = buildProvenance({
      file: input.file,
      width: input.width,
      height: input.height,
      format: input.format,
      alphaComposited: input.hadTransparency,
      settings,
      result,
      seconds,
    });
    classification = { result, settings, record, seconds };
    if (result.saliencyMap) refreshSaliencyLayer();
    renderReport();
    rebuildOutputs(record);
    setView(result.saliencyMap ? "image" : "report");

    const top = result.summary.top;
    const summaryText = `Classified: ${top.code} (${(top.probability * 100).toFixed(1)}% softmax) · ${result.backend}`;
    progress.end(summaryText);
    status(summaryText);
    log.log(
      `${input.file.name} → ${result.summary.ranked.map((r) => `${r.code} ${(r.probability * 100).toFixed(1)}%`).join(", ")} (uncalibrated softmax)`,
      "info",
      "analysis",
    );

    return {
      artifacts: [
        { role: "predictions", file: outputs.predictions.file },
        ...(outputs.saliency ? [{ role: "saliency", file: outputs.saliency.file }] : []),
        { role: "provenance", file: outputs.provenance.file },
      ],
      provenance: record,
      measurements: {
        scoreType: "uncalibrated-softmax",
        topClass: top.code,
        topLabel: top.label,
        topSoftmaxScore: top.probability,
        margin: result.summary.margin,
        entropyBits: result.summary.entropyBits,
        normalizedEntropy: result.summary.normalizedEntropy,
        softmaxScores: Object.fromEntries(result.summary.ranked.map((item) => [item.code, item.probability])),
      },
    };
  } catch (error) {
    progress.reset(input ? "Ready" : undefined);
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

async function importFiles(filesPromise) {
  if (running) {
    reportError(new Error("Wait for the current operation to finish, or cancel it."));
    return;
  }
  await cancelActiveLoad();
  return loadFiles(filesPromise, undefined, { fromExample: false }).catch(reportError);
}

$("cancelButton").onclick = () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
};

// Shell bindPageDrop sets #imageInput.files and fires `change`; rely on it rather than custom drop code.
$("imageInput").addEventListener("change", (event) => {
  const files = Array.from(event.target.files);
  event.target.value = "";
  if (files.length) void importFiles(Promise.resolve(files));
});

const exampleControl = createExampleSelector({
  examples,
  onStatus: (message, error) => status(message, error, "technical"),
  onLoad: async (example, { fetchFiles, assertCurrent, signal }) => {
    if (loadingPromise) {
      loading?.abort();
      await loadingPromise.catch(() => {});
    }
    assertCurrent();
    // Start the loading operation BEFORE fetchFiles() resolves so #runButton is disabled
    // and footer #cancelButton stays wired through both download and decode.
    await loadFiles(
      fetchFiles().then((files) => {
        assertCurrent();
        return files;
      }),
      signal,
      { message: `Downloading ${example.label}…`, fromExample: true },
    );
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  if (input && !loading && !running) {
    void runClassification(undefined, formSettings()).catch(reportError);
  }
});

// ---------------------------------------------------------------------------------------------
// WebMCP / NeuroDesk automation contract.

registerAppAutomation({
  app: APP.id,
  operations: {
    classify: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      try {
        if (running) {
          throw new Error("Wait for the current operation to finish, or cancel it.");
        }
        await cancelActiveLoad();
        signal?.throwIfAborted();
        await loadFiles(Promise.resolve(inputs.image), signal, { fromExample: false });
        const settings = readSettings({ ...formSettings(), ...parameters });
        applySettingsToForm(settings);
        return await runClassification(signal, settings, reportProgress);
      } catch (error) {
        reportError(error);
        throw error;
      }
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
  stopWorker("Page closed");
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
