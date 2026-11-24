// Skin Chromophore: quantitative skin colorimetry & uncalibrated RGB chromophore proxy mapping.
// Pure numerics and PNG encoding live in src/core/ + src/outputs.js and execute in src/worker.js;
// this file owns the workspace UI, canvas inspection/zoom/ROI placement, report rendering,
// outputs, and WebMCP automation.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./skin-chromophore.css";
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
  MAX_ANALYSIS_SIDE,
  MAX_DECODED_BYTES,
  buildProvenance,
  collectAnalysisWarnings,
  computeAnalysisDimensions,
  readSettings,
} from "./config.js";
import { ITA_UNAVAILABLE_LABEL, classifyIta } from "./core/colorimetry.js";
import { renderMapRgba, renderRoiContoursRgba } from "./display.js";
import { colorimetryCsv, itaDiagramSvg, outputStem, provenanceJson } from "./outputs.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Skin colorimetry & RGB chromophore proxies",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

function createZoomActionGroup() {
  const group = document.createElement("div");
  group.className = "nd-tool-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Canvas zoom");

  const makeBtn = (id, text, label) => {
    const btn = document.createElement("button");
    btn.id = id;
    btn.type = "button";
    btn.className = "nd-btn nd-btn-sm";
    btn.textContent = text;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.disabled = true;
    return btn;
  };

  group.append(
    makeBtn("zoomOutButton", "−", "Zoom out"),
    makeBtn("zoomResetButton", "100%", "Reset zoom"),
    makeBtn("zoomInButton", "+", "Zoom in"),
  );
  return group;
}

const toolbar = createViewerToolbar({
  views: [
    { id: "image", label: "Image", active: true },
    { id: "hemoglobin", label: "Hemoglobin" },
    { id: "melanin", label: "Melanin" },
    { id: "ita", label: "ITA°" },
    { id: "report", label: "Report" },
  ],
  viewsLabel: "Display",
  window: false,
  overlay: true,
  colormap: false,
  actions: [createZoomActionGroup()],
  download: false,
  screenshot: false,
});
$("viewer").prepend(toolbar);
const opacitySlider = toolbar.control("overlayOpacity");
if (opacitySlider) {
  opacitySlider.value = "0.7";
  const valueSpan = toolbar.control("overlayOpacityValue");
  if (valueSpan) valueSpan.textContent = "70%";
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
// Application state (committed atomically on completed runs).

let input = null; // { file, width, height, originalWidth, originalHeight, downscaled, format, rgba }
let analysis = null; // committed output of analyzeSkinImage
let activeWorker = null; // worker holding committed analysis maps for ROI recompute
let currentSettings = readSettings(); // committed settings matching `analysis`
let manualRoi = { target: null, reference: null };
let activeView = "image";
let renderedMapView = null;
let overlayOpacity = 0.7;
let activeTool = "inspect"; // "inspect" | "target" | "reference"
let outputs = {};
let loading = null;
let loadingPromise = null;
let running = null;
let workerMessageId = 0;
let roiRequestSeq = 0;

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
  status(cancelled ? "Cancelled" : error.message || String(error), !cancelled);
}

const fmt = (value, digits = 2) => (value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : "—");
const fmtSigned = (value, digits = 2) => (value !== null && value !== undefined && Number.isFinite(Number(value))
  ? `${Number(value) >= 0 ? "+" : ""}${Number(value).toFixed(digits)}`
  : "—");
const fmtMeanSd = (series, digits = 2) => (series && series.mean !== null && Number.isFinite(series.mean)
  ? `${fmt(series.mean, digits)} ± ${fmt(series.sd, digits)}`
  : "—");

function formatBandLabel(roi) {
  if (!roi || roi.pixelCount === 0) return "Unavailable";
  return roi.dominantItaBand ?? "Unavailable";
}

// ---------------------------------------------------------------------------------------------
// Canvas viewer, zoom/pan, overlays, hover inspection, and interactive circular ROI placement.

const canvas = $("canvas");
const context = canvas.getContext("2d");
const layers = {
  base: document.createElement("canvas"),
  map: document.createElement("canvas"),
  contours: document.createElement("canvas"),
};
let zoom = 1;
let panX = 0;
let panY = 0;
let viewport = { scale: 1, x: 0, y: 0 };
let drag = null;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paintCanvasLayer(layer, rgba, width, height) {
  layer.width = width;
  layer.height = height;
  layer.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
}

function refreshBaseLayer() {
  if (!input) return;
  paintCanvasLayer(layers.base, input.rgba, input.width, input.height);
}

function refreshMapLayer(force = false) {
  if (!analysis) return;
  if (activeView === "hemoglobin" || activeView === "melanin" || activeView === "ita") {
    if (force || renderedMapView !== activeView) {
      const rgba = renderMapRgba(activeView, analysis, { opaque: false, opacity: 1 });
      paintCanvasLayer(layers.map, rgba, analysis.width, analysis.height);
      renderedMapView = activeView;
    }
  }
}

function refreshContourLayer() {
  if (!analysis) return;
  const contours = renderRoiContoursRgba(
    analysis.roi.targetMask,
    analysis.roi.referenceMask,
    analysis.width,
    analysis.height,
  );
  paintCanvasLayer(layers.contours, contours, analysis.width, analysis.height);
}

function refreshOverlayLayers(forceMap = false) {
  refreshMapLayer(forceMap);
  refreshContourLayer();
}

function updateScaleLegend() {
  const legend = $("scaleLegend");
  if (!legend) return;
  if (!input) {
    legend.textContent = "";
    return;
  }
  if (analysis && activeView === "hemoglobin") {
    const [lo, hi] = analysis.ranges.hemoglobin;
    legend.textContent = `Hemoglobin OD proxy [${fmt(lo, 2)} – ${fmt(hi, 2)} a.u.]`;
    return;
  }
  if (analysis && activeView === "melanin") {
    const [lo, hi] = analysis.ranges.melanin;
    legend.textContent = `Melanin OD proxy [${fmt(lo, 2)} – ${fmt(hi, 2)} a.u.]`;
    return;
  }
  if (analysis && activeView === "ita") {
    legend.textContent = "ITA° bands (b* > 1; slate = outside skin domain)";
    return;
  }
  if (analysis && activeView === "report") {
    legend.textContent = `Strategy: ${analysis.roi.strategy}`;
    return;
  }
  legend.textContent = input.downscaled
    ? `${input.width} × ${input.height} (from ${input.originalWidth} × ${input.originalHeight})`
    : `${input.width} × ${input.height}`;
}

function resetZoom() {
  zoom = 1;
  panX = 0;
  panY = 0;
  updateZoomButtons();
  draw();
}

function clampPan(fitScale) {
  if (!input || zoom <= 1) {
    panX = 0;
    panY = 0;
    return;
  }
  const scaledW = input.width * fitScale * zoom;
  const scaledH = input.height * fitScale * zoom;
  const maxPanX = Math.max(0, (scaledW - canvas.width) / 2);
  const maxPanY = Math.max(0, (scaledH - canvas.height) / 2);
  panX = Math.max(-maxPanX, Math.min(maxPanX, panX));
  panY = Math.max(-maxPanY, Math.min(maxPanY, panY));
}

function setZoom(nextZoom, anchorCanvasX = null, anchorCanvasY = null) {
  if (!input) return;
  const clamped = Math.max(1, Math.min(8, nextZoom));
  if (clamped === 1) {
    zoom = 1;
    panX = 0;
    panY = 0;
  } else {
    const fitScale = Math.min(canvas.width / input.width, canvas.height / input.height);
    if (anchorCanvasX !== null && anchorCanvasY !== null && viewport.scale > 0) {
      const imgX = (anchorCanvasX - viewport.x) / viewport.scale;
      const imgY = (anchorCanvasY - viewport.y) / viewport.scale;
      const newScale = fitScale * clamped;
      const centeredX = (canvas.width - input.width * newScale) / 2;
      const centeredY = (canvas.height - input.height * newScale) / 2;
      panX = anchorCanvasX - imgX * newScale - centeredX;
      panY = anchorCanvasY - imgY * newScale - centeredY;
    } else {
      const factor = clamped / zoom;
      panX *= factor;
      panY *= factor;
    }
    zoom = clamped;
    clampPan(fitScale);
  }
  updateZoomButtons();
  draw();
}

function updateZoomButtons() {
  const canZoom = Boolean(input) && activeView !== "report";
  const outBtn = $("zoomOutButton");
  const resetBtn = $("zoomResetButton");
  const inBtn = $("zoomInButton");
  if (outBtn) outBtn.disabled = !canZoom || zoom <= 1;
  if (resetBtn) {
    resetBtn.disabled = !canZoom || zoom === 1;
    resetBtn.textContent = `${Math.round(zoom * 100)}%`;
  }
  if (inBtn) inBtn.disabled = !canZoom || zoom >= 8;
}

$("zoomOutButton").onclick = () => setZoom(zoom / 1.5);
$("zoomResetButton").onclick = () => resetZoom();
$("zoomInButton").onclick = () => setZoom(zoom * 1.5);

function toCanvasCoords(event) {
  const rect = canvas.getBoundingClientRect();
  const ratio = canvas.width / Math.max(1, rect.width);
  return [(event.clientX - rect.left) * ratio, (event.clientY - rect.top) * ratio];
}

function toImageCoords(event) {
  const [cx, cy] = toCanvasCoords(event);
  return [(cx - viewport.x) / viewport.scale, (cy - viewport.y) / viewport.scale];
}

function drawCircleOverlay(circle, colorToken, ratio, dashed) {
  const cx = viewport.x + circle.cx * viewport.scale;
  const cy = viewport.y + circle.cy * viewport.scale;
  const r = circle.r * viewport.scale;
  context.save();
  context.beginPath();
  context.arc(cx, cy, Math.max(2 * ratio, r), 0, 2 * Math.PI);
  context.lineWidth = 2 * ratio;
  context.strokeStyle = token(colorToken);
  if (dashed) context.setLineDash([5 * ratio, 4 * ratio]);
  context.stroke();
  context.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!input) return;
  const fitScale = Math.min(canvas.width / input.width, canvas.height / input.height);
  clampPan(fitScale);
  const scale = fitScale * zoom;
  viewport = {
    scale,
    x: (canvas.width - input.width * scale) / 2 + panX,
    y: (canvas.height - input.height * scale) / 2 + panY,
  };
  context.imageSmoothingEnabled = scale < 2;
  context.drawImage(layers.base, viewport.x, viewport.y, input.width * scale, input.height * scale);
  if (analysis) {
    if (activeView === "hemoglobin" || activeView === "melanin" || activeView === "ita") {
      context.save();
      context.globalAlpha = overlayOpacity;
      context.drawImage(layers.map, viewport.x, viewport.y, input.width * scale, input.height * scale);
      context.restore();
    }
    context.drawImage(layers.contours, viewport.x, viewport.y, input.width * scale, input.height * scale);
    if (manualRoi.target) drawCircleOverlay(manualRoi.target, "--nd-color-primary", ratio, false);
    if (manualRoi.reference) drawCircleOverlay(manualRoi.reference, "--nd-color-text", ratio, true);
  }
  if (drag && drag.kind === "roi") {
    const color = drag.tool === "target" ? "--nd-color-primary" : "--nd-color-text";
    drawCircleOverlay(drag.circle, color, ratio, true);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

function cancelActiveDrag() {
  if (!drag) return;
  const pointerId = drag.pointerId;
  drag = null;
  if (pointerId !== undefined && canvas.hasPointerCapture?.(pointerId)) {
    try {
      canvas.releasePointerCapture(pointerId);
    } catch {
      // Ignore if pointer capture already ended.
    }
  }
  draw();
}

function setView(viewId) {
  const needsAnalysis = viewId !== "image";
  if (needsAnalysis && !analysis) {
    status("Analyze the image first to view maps and reports");
    toolbar.setActive("image");
    return;
  }
  activeView = viewId;
  toolbar.setActive(viewId);
  const showReport = viewId === "report";
  if (showReport) cancelActiveDrag();
  $("report").hidden = !showReport;
  canvas.hidden = showReport;
  if (!showReport) {
    refreshMapLayer(false);
    draw();
  }
  updateScaleLegend();
  updateControls();
}

toolbar.addEventListener("nd-view-change", ({ detail }) => setView(detail.value));
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  if (analysis) draw();
});

// ---------------------------------------------------------------------------------------------
// Report rendering (warnings, Target vs Reference table, ΔE2000 summary, SVG L*–b* ITA° diagram).

function buildTable(caption, headers, rows, numericCols = []) {
  const scroll = document.createElement("div");
  scroll.className = "nd-table-scroll";
  const table = document.createElement("table");
  table.className = "nd-data-table";
  const cap = document.createElement("caption");
  cap.textContent = caption;
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  for (const label of headers) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = label;
    hrow.append(th);
  }
  thead.append(hrow);
  const tbody = document.createElement("tbody");
  for (const { cells, flag } of rows) {
    const tr = document.createElement("tr");
    if (flag) tr.dataset.flag = flag;
    cells.forEach((value, idx) => {
      const td = document.createElement("td");
      if (numericCols.includes(idx)) td.className = "nd-numeric";
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
  if (!analysis) {
    $("report").replaceChildren();
    return;
  }
  const { target, reference, comparison, strategy } = analysis.roi;
  const targetBand = formatBandLabel(target);
  const refBand = formatBandLabel(reference);

  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  const targetItaSummary = target.ita.mean !== null ? `${fmt(target.ita.mean, 1)}° (${targetBand})` : targetBand;
  const refItaSummary = reference.ita.mean !== null ? `${fmt(reference.ita.mean, 1)}° (${refBand})` : refBand;
  lead.textContent = `Target vs Reference ΔE2000 ${fmt(comparison.deltaE2000, 2)} · Target ITA ${targetItaSummary} vs Reference ${refItaSummary}`;

  const warnings = collectAnalysisWarnings(analysis);
  const warningNodes = warnings.map((message) => {
    const box = document.createElement("p");
    box.className = "nd-message warning";
    box.textContent = message;
    return box;
  });

  const formatMeanCoordCell = (roi) => {
    if (roi.pixelCount === 0) return "—";
    return roi.meanCoordIta !== null
      ? `${fmt(roi.meanCoordIta, 1)}° (${roi.meanCoordItaBand})`
      : `— (${ITA_UNAVAILABLE_LABEL})`;
  };

  const summaryTable = buildTable(
    "Target vs Perilesional Reference Colorimetry & RGB Optical-Density Proxies",
    ["Metric", "Target (mean ± SD)", "Target median", "Reference (mean ± SD)", "Reference median", "Δ (Target − Ref)"],
    [
      { cells: ["CIE L*", fmtMeanSd(target.L, 2), fmt(target.L.median, 2), fmtMeanSd(reference.L, 2), fmt(reference.L.median, 2), fmtSigned(comparison.deltaL, 2)] },
      { cells: ["CIE a*", fmtMeanSd(target.a, 2), fmt(target.a.median, 2), fmtMeanSd(reference.a, 2), fmt(reference.a.median, 2), fmtSigned(comparison.deltaA, 2)] },
      { cells: ["CIE b*", fmtMeanSd(target.b, 2), fmt(target.b.median, 2), fmtMeanSd(reference.b, 2), fmt(reference.b.median, 2), fmtSigned(comparison.deltaB, 2)] },
      { cells: ["ITA° (pixel-wise, b* > 1)", fmtMeanSd(target.ita, 1), fmt(target.ita.median, 1), fmtMeanSd(reference.ita, 1), fmt(reference.ita.median, 1), fmtSigned(comparison.deltaITA, 1)] },
      { cells: ["ITA° at (mean L*, mean b*)", formatMeanCoordCell(target), "—", formatMeanCoordCell(reference), "—", fmtSigned(comparison.deltaMeanCoordITA, 1)] },
      { cells: ["Erythema Index proxy (RGB EI)", fmtMeanSd(target.ei, 1), fmt(target.ei.median, 1), fmtMeanSd(reference.ei, 1), fmt(reference.ei.median, 1), fmtSigned(comparison.deltaEI, 1)] },
      { cells: ["Melanin Index proxy (RGB MI)", fmtMeanSd(target.mi, 1), fmt(target.mi.median, 1), fmtMeanSd(reference.mi, 1), fmt(reference.mi.median, 1), fmtSigned(comparison.deltaMI, 1)] },
      { cells: ["Melanin OD proxy (fixed RGB basis)", fmtMeanSd(target.melanin, 3), fmt(target.melanin.median, 3), fmtMeanSd(reference.melanin, 3), fmt(reference.melanin.median, 3), fmtSigned(comparison.deltaMelanin, 3)] },
      { cells: ["Hemoglobin OD proxy (fixed RGB basis)", fmtMeanSd(target.hemoglobin, 3), fmt(target.hemoglobin.median, 3), fmtMeanSd(reference.hemoglobin, 3), fmt(reference.hemoglobin.median, 3), fmtSigned(comparison.deltaHemoglobin, 3)] },
      { cells: ["CIEDE2000 (ΔE2000)", "—", "—", "—", "—", fmt(comparison.deltaE2000, 2)], flag: "summary" },
      { cells: ["Dominant ITA° band", targetBand, target.pixelCount > 0 ? `${target.itaValidPixels}/${target.pixelCount} valid px` : "0 px", refBand, reference.pixelCount > 0 ? `${reference.itaValidPixels}/${reference.pixelCount} valid px` : "0 px", "—"] },
    ],
    [1, 2, 3, 4, 5],
  );

  const figure = document.createElement("figure");
  figure.className = "nd-chart-figure";
  const figcaption = document.createElement("figcaption");
  figcaption.textContent = "CIE L*–b* Individual Typology Angle (ITA°) zones — markers show ROI mean (L*, b*) coordinates";
  figure.append(figcaption);
  figure.insertAdjacentHTML("beforeend", itaDiagramSvg(target, reference, comparison));

  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  const wbNote = currentSettings.whiteBalance
    ? `Shades of Gray (p=6) gains R=${fmt(analysis.whiteBalanceGains.r, 3)}, G=${fmt(analysis.whiteBalanceGains.g, 3)}, B=${fmt(analysis.whiteBalanceGains.b, 3)}. `
    : "No white-balance normalization. ";
  const [hbLo, hbHi] = analysis.ranges.hemoglobin;
  const [melLo, melHi] = analysis.ranges.melanin;
  notes.textContent = `${wbNote}ROI strategy: ${strategy}. Valid pixels: ${analysis.validCount.toLocaleString()} (${analysis.vignetteCount.toLocaleString()} vignette, ${(analysis.alphaExcludedCount ?? 0).toLocaleString()} transparent excluded). Map scales (p2–p98): Hemoglobin OD proxy [${fmt(hbLo, 2)}–${fmt(hbHi, 2)} a.u.], Melanin OD proxy [${fmt(melLo, 2)}–${fmt(melHi, 2)} a.u.]. EI, MI, Melanin OD, and Hemoglobin OD are uncalibrated fixed-basis RGB optical-density proxies (inspired by Tsumura et al. 1999, Diffey et al. 1984, and Takiwaki et al. 1994—not per-image ICA or calibrated spectrophotometry).`;

  const stack = document.createElement("div");
  stack.className = "nd-report-stack";
  stack.append(lead, ...warningNodes, summaryTable, figure, notes);
  $("report").replaceChildren(stack);
}

// ---------------------------------------------------------------------------------------------
// Result list & downloadable artifacts (PNGs encoded off-main-thread in src/worker.js).

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (stage === "colorimetry") setView("report");
    else if (stage === "hemoglobin" || stage === "melanin" || stage === "ita") setView(stage);
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function rebuildOutputs(workerPngs = null) {
  if (!analysis || !input) {
    outputs = {};
    results.render();
    $("outputSection").open = false;
    return null;
  }
  const stem = outputStem(input.file.name);
  const record = buildProvenance({
    file: input.file,
    width: input.width,
    height: input.height,
    originalWidth: input.originalWidth,
    originalHeight: input.originalHeight,
    downscaled: input.downscaled,
    format: input.format,
    settings: currentSettings,
    analysis,
    manualRoi,
  });

  const hemoglobinFile = workerPngs
    ? new File([workerPngs.hemoglobin], `${stem}_hemoglobin.png`, { type: "image/png" })
    : outputs.hemoglobin.file;
  const melaninFile = workerPngs
    ? new File([workerPngs.melanin], `${stem}_melanin.png`, { type: "image/png" })
    : outputs.melanin.file;
  const itaFile = workerPngs
    ? new File([workerPngs.ita], `${stem}_ita.png`, { type: "image/png" })
    : outputs.ita.file;
  const csvFile = new File([colorimetryCsv(analysis)], `${stem}_colorimetry.csv`, { type: "text/csv" });
  const provFile = new File([provenanceJson(record)], `${stem}_provenance.json`, { type: "application/json" });

  outputs = {
    hemoglobin: { description: "Hemoglobin map (OD proxy PNG)", file: hemoglobinFile },
    melanin: { description: "Melanin map (OD proxy PNG)", file: melaninFile },
    ita: { description: "ITA° typology map (PNG)", file: itaFile },
    colorimetry: { description: "Colorimetry metrics (CSV)", file: csvFile },
    provenance: { description: "Provenance (JSON)", file: provFile, viewable: false },
  };
  results.render(outputs);
  $("outputSection").open = true;
  return record;
}

// ---------------------------------------------------------------------------------------------
// Controls, keyboard ROI inputs, and ROI tools.

const MANUAL_INPUT_IDS = ["targetX", "targetY", "targetR", "refX", "refY", "refR"];

function syncManualRoiInputs() {
  if (!analysis) {
    for (const id of MANUAL_INPUT_IDS) {
      $(id).value = "";
      $(id).placeholder = "auto";
    }
    return;
  }
  const w = analysis.width;
  const h = analysis.height;
  const minDim = Math.min(w, h);
  const pct = (val, denom) => (denom > 0 && Number.isFinite(val) ? ((val / denom) * 100).toFixed(1) : "");

  const setGroup = (circle, autoRoi, xId, yId, rId) => {
    if (circle) {
      $(xId).value = pct(circle.cx, w);
      $(yId).value = pct(circle.cy, h);
      $(rId).value = pct(circle.r, minDim);
    } else {
      $(xId).value = "";
      $(yId).value = "";
      $(rId).value = "";
    }
    $(xId).placeholder = autoRoi?.centroid ? pct(autoRoi.centroid.x, w) : "auto";
    $(yId).placeholder = autoRoi?.centroid ? pct(autoRoi.centroid.y, h) : "auto";
    $(rId).placeholder = autoRoi?.equivalentRadius ? pct(autoRoi.equivalentRadius, minDim) : "auto";
  };

  setGroup(manualRoi.target, analysis.roi.target, "targetX", "targetY", "targetR");
  setGroup(manualRoi.reference, analysis.roi.reference, "refX", "refY", "refR");
}

function parseCircleInputs(xId, yId, rId, label) {
  const xRaw = $(xId).value.trim();
  const yRaw = $(yId).value.trim();
  const rRaw = $(rId).value.trim();
  if (!xRaw && !yRaw && !rRaw) return null;
  if (!xRaw || !yRaw || !rRaw) {
    throw new Error(`Enter X, Y, and R percentages for ${label}, or leave all three blank for Auto.`);
  }
  const xPct = Number(xRaw);
  const yPct = Number(yRaw);
  const rPct = Number(rRaw);
  if (!Number.isFinite(xPct) || !Number.isFinite(yPct) || !Number.isFinite(rPct)) {
    throw new Error(`${label} coordinates must be finite numbers.`);
  }
  if (xPct < 0 || xPct > 100 || yPct < 0 || yPct > 100 || rPct <= 0 || rPct > 100) {
    throw new Error(`${label} coordinates must have X and Y in [0, 100]% and R in (0, 100]%.`);
  }
  const minDim = Math.min(analysis.width, analysis.height);
  return {
    cx: (xPct / 100) * analysis.width,
    cy: (yPct / 100) * analysis.height,
    r: Math.max(1, (rPct / 100) * minDim),
  };
}

function updateControls() {
  const busy = Boolean(loading || running);
  const ready = Boolean(analysis) && !busy;
  const canEditCanvas = ready && activeView !== "report";
  $("imageInput").disabled = busy;
  $("roiMode").disabled = busy;
  $("whiteBalance").disabled = busy;
  $("maskVignette").disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
  $("inspectTool").disabled = !canEditCanvas;
  $("targetRoiTool").disabled = !canEditCanvas;
  $("refRoiTool").disabled = !canEditCanvas;
  $("resetRoiButton").disabled = !ready || (!manualRoi.target && !manualRoi.reference);
  for (const id of MANUAL_INPUT_IDS) $(id).disabled = !ready;
  $("applyManualRoiButton").disabled = !ready;
  $("inspectTool").setAttribute("aria-pressed", String(activeTool === "inspect"));
  $("targetRoiTool").setAttribute("aria-pressed", String(activeTool === "target"));
  $("refRoiTool").setAttribute("aria-pressed", String(activeTool === "reference"));
  updateZoomButtons();
  if (analysis) {
    $("roiInfo").hidden = false;
    const band = formatBandLabel(analysis.roi.target);
    $("roiInfo").textContent = `ΔE2000 ${fmt(analysis.roi.comparison.deltaE2000, 1)} · Target ${band} (${analysis.roi.target.pixelCount} px)`;
  } else {
    $("roiInfo").hidden = true;
  }
}

function setTool(tool) {
  cancelActiveDrag();
  activeTool = tool;
  updateControls();
}

$("inspectTool").onclick = () => setTool("inspect");
$("targetRoiTool").onclick = () => setTool("target");
$("refRoiTool").onclick = () => setTool("reference");

function runWorkerRoi(worker, options) {
  return new Promise((resolve, reject) => {
    const id = ++workerMessageId;
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      cleanup();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data.roi);
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(event.message || "ROI worker recomputation failed."));
    };
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ type: "recomputeRoi", id, options });
  });
}

async function recomputeRoiOnly(reason, nextManualRoi = manualRoi) {
  if (!analysis || !activeWorker || loading || running) return;
  const seq = ++roiRequestSeq;
  const worker = activeWorker;
  const committedAnalysis = analysis;
  try {
    const roi = await runWorkerRoi(worker, {
      roiMode: currentSettings.roiMode,
      customTarget: nextManualRoi.target,
      customReference: nextManualRoi.reference,
    });
    // Ignore stale ROI updates if superseded by a newer ROI edit or new analysis.
    if (seq !== roiRequestSeq || activeWorker !== worker || analysis !== committedAnalysis) return;
    manualRoi = {
      target: nextManualRoi.target ? { ...nextManualRoi.target } : null,
      reference: nextManualRoi.reference ? { ...nextManualRoi.reference } : null,
    };
    analysis.roi = roi;
    refreshContourLayer();
    draw();
    renderReport();
    rebuildOutputs(null);
    syncManualRoiInputs();
    updateScaleLegend();
    updateControls();
    const { comparison, target, reference } = analysis.roi;
    status(`${reason} · ΔE2000 ${fmt(comparison.deltaE2000, 2)} · ΔEI ${fmtSigned(comparison.deltaEI, 1)} · ΔMI ${fmtSigned(comparison.deltaMI, 1)}`);
    technical(`ROI updated (${analysis.roi.strategy}): target ${target.pixelCount} px (${formatBandLabel(target)}), reference ${reference.pixelCount} px (${formatBandLabel(reference)}), overlap ${analysis.roi.overlapPixels} px`);
  } catch (error) {
    if (seq === roiRequestSeq) reportError(error);
  }
}

$("resetRoiButton").onclick = () => {
  setTool("inspect");
  void recomputeRoiOnly("Auto ROIs restored", { target: null, reference: null });
};

function applyManualRoiFromInputs() {
  if (!analysis || loading || running) return;
  try {
    const target = parseCircleInputs("targetX", "targetY", "targetR", "Target ROI");
    const reference = parseCircleInputs("refX", "refY", "refR", "Reference ROI");
    void recomputeRoiOnly("Manual ROI coordinates updated", { target, reference });
  } catch (error) {
    reportError(error);
  }
}

$("applyManualRoiButton").onclick = applyManualRoiFromInputs;
for (const id of MANUAL_INPUT_IDS) {
  $(id).addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyManualRoiFromInputs();
    }
  });
}

canvas.addEventListener(
  "wheel",
  (event) => {
    if (!input || activeView === "report") return;
    event.preventDefault();
    const [cx, cy] = toCanvasCoords(event);
    const factor = event.deltaY < 0 ? 1.25 : 0.8;
    setZoom(zoom * factor, cx, cy);
  },
  { passive: false },
);

canvas.addEventListener("pointerdown", (event) => {
  if (!input || loading || running || activeView === "report" || event.button !== 0) return;
  if (activeTool === "inspect") {
    if (zoom <= 1) return;
    const [cx, cy] = toCanvasCoords(event);
    canvas.setPointerCapture(event.pointerId);
    drag = { kind: "pan", pointerId: event.pointerId, startX: cx, startY: cy, panX, panY };
    return;
  }
  if (!analysis) return;
  const [x, y] = toImageCoords(event);
  if (x < 0 || y < 0 || x >= input.width || y >= input.height) return;
  canvas.setPointerCapture(event.pointerId);
  drag = { kind: "roi", pointerId: event.pointerId, tool: activeTool, circle: { cx: x, cy: y, r: 0 } };
  draw();
});

canvas.addEventListener("pointermove", (event) => {
  if (input && activeView !== "report") {
    const [fx, fy] = toImageCoords(event);
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    if (ix >= 0 && iy >= 0 && ix < input.width && iy < input.height) {
      const idx = iy * input.width + ix;
      if (analysis) {
        if (analysis.alphaMask && !analysis.alphaMask[idx]) {
          $("location").textContent = `x ${ix}, y ${iy} · Transparent (excluded)`;
        } else if (!analysis.validMask[idx]) {
          $("location").textContent = `x ${ix}, y ${iy} · Vignette (excluded)`;
        } else {
          const L = analysis.maps.L[idx];
          const a = analysis.maps.a[idx];
          const b = analysis.maps.b[idx];
          const ita = analysis.maps.ita[idx];
          const ei = analysis.maps.ei[idx];
          const mi = analysis.maps.mi[idx];
          const itaText = Number.isFinite(ita)
            ? `${ita.toFixed(1)}° (${classifyIta(ita)})`
            : `n/a (${ITA_UNAVAILABLE_LABEL})`;
          $("location").textContent = `x ${ix}, y ${iy} · L* ${L.toFixed(1)} a* ${a.toFixed(1)} b* ${b.toFixed(1)} · ITA ${itaText} · EI ${ei.toFixed(1)} · MI ${mi.toFixed(1)}`;
        }
      } else {
        const base = idx << 2;
        const alpha = input.rgba[base + 3];
        $("location").textContent = alpha < 128
          ? `x ${ix}, y ${iy} · Transparent (α ${alpha})`
          : `x ${ix}, y ${iy} · RGB ${input.rgba[base]}, ${input.rgba[base + 1]}, ${input.rgba[base + 2]}`;
      }
    } else {
      $("location").textContent = "";
    }
  }
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (drag.kind === "pan") {
    const [cx, cy] = toCanvasCoords(event);
    panX = drag.panX + (cx - drag.startX);
    panY = drag.panY + (cy - drag.startY);
    draw();
    return;
  }
  const [x, y] = toImageCoords(event);
  drag.circle.r = Math.hypot(x - drag.circle.cx, y - drag.circle.cy);
  draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const finished = drag;
  drag = null;
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if pointer capture already ended.
    }
  }
  if (finished.kind === "pan") return;
  if (!analysis || loading || running || activeView === "report") {
    draw();
    return;
  }
  const [x, y] = toImageCoords(event);
  const r = Math.hypot(x - finished.circle.cx, y - finished.circle.cy);
  const finalRadius = r >= 3 ? r : Math.max(8, Math.round(Math.min(input.width, input.height) * 0.08));
  const placed = { cx: finished.circle.cx, cy: finished.circle.cy, r: finalRadius };
  const nextManual = {
    target: finished.tool === "target" ? placed : manualRoi.target,
    reference: finished.tool === "reference" ? placed : manualRoi.reference,
  };
  void recomputeRoiOnly(
    finished.tool === "target" ? "Target ROI updated" : "Reference ROI updated",
    nextManual,
  );
});

canvas.addEventListener("pointercancel", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  cancelActiveDrag();
});

// ---------------------------------------------------------------------------------------------
// Color-managed sRGB image decoding, loading, and Worker execution.

async function decodeColorManagedSrgb(
  file,
  { maxBytes = MAX_DECODED_BYTES, maxSide = MAX_ANALYSIS_SIDE, signal } = {},
) {
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
      throw new Error(`The decoded image is ${bitmap.width} × ${bitmap.height}, not ${header.width} × ${header.height} as its header says.`);
    }
    const dims = computeAnalysisDimensions(bitmap.width, bitmap.height, maxSide);
    const offscreen = new OffscreenCanvas(dims.width, dims.height);
    const ctx = offscreen.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
    ctx.imageSmoothingEnabled = dims.downscaled;
    if (dims.downscaled) ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
    const imageData = ctx.getImageData(0, 0, dims.width, dims.height);
    return {
      width: dims.width,
      height: dims.height,
      originalWidth: bitmap.width,
      originalHeight: bitmap.height,
      downscaled: dims.downscaled,
      format: header.format,
      data: imageData.data,
    };
  } finally {
    bitmap.close();
  }
}

function begin(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
  signal?.throwIfAborted();
  cancelActiveDrag();
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

function terminateActiveWorker() {
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  roiRequestSeq++;
}

function clearAnalysis() {
  cancelActiveDrag();
  terminateActiveWorker();
  analysis = null;
  renderedMapView = null;
  manualRoi = { target: null, reference: null };
  activeTool = "inspect";
  outputs = {};
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  activeView = "image";
  toolbar.setActive("image");
  $("report").hidden = true;
  canvas.hidden = false;
  syncManualRoiInputs();
  updateScaleLegend();
}

async function loadFiles(filesPromise, signal, initialMessage = "Reading image…") {
  const operation = begin(initialMessage, signal);
  loading = operation.controller;
  updateControls();
  const current = operation.controller.signal;
  const runPromise = (async () => {
    try {
      const files = await filesPromise;
      current.throwIfAborted();
      if (files.length !== 1) throw new Error(`Choose one dermatology image; this selection has ${files.length} files.`);
      const [file] = files;
      if (!file.size) throw new Error(`${file.name} is empty.`);
      progress.setIndeterminate(`Decoding ${file.name}…`);
      const decoded = await decodeColorManagedSrgb(file, {
        maxBytes: MAX_DECODED_BYTES,
        maxSide: MAX_ANALYSIS_SIDE,
        signal: current,
      });
      current.throwIfAborted();
      input = {
        file,
        width: decoded.width,
        height: decoded.height,
        originalWidth: decoded.originalWidth,
        originalHeight: decoded.originalHeight,
        downscaled: decoded.downscaled,
        format: decoded.format,
        rgba: decoded.data,
      };
      clearAnalysis();
      zoom = 1;
      panX = 0;
      panY = 0;
      refreshBaseLayer();
      $("emptyState").hidden = true;
      draw();
      $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
      $("fileInfo").hidden = false;
      $("fileInfo").textContent = decoded.downscaled
        ? `${file.name} · ${decoded.originalWidth} × ${decoded.originalHeight} (analyzed at ${decoded.width} × ${decoded.height}) · ${decoded.format.toUpperCase()}`
        : `${file.name} · ${decoded.width} × ${decoded.height} · ${decoded.format.toUpperCase()}`;
      $("dropZone").classList.add("has-files");
      updateScaleLegend();
      progress.setProgress(0);
      status(`${file.name} loaded · click Analyze chromophores`);
      technical(`Decoded color-managed sRGB ${decoded.format.toUpperCase()}: ${decoded.originalWidth} × ${decoded.originalHeight}${decoded.downscaled ? ` -> ${decoded.width} × ${decoded.height}` : ""} (${file.size} bytes)`);
    } catch (error) {
      progress.stopTimer(true);
      progress.setCancellable(false);
      progress.setProgress(0);
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

function runWorkerAnalyze({ rgba, width, height, options }, { signal, onProgress }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const id = ++workerMessageId;
    const detach = () => {
      signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
    };
    const fail = (error) => {
      detach();
      worker.terminate();
      reject(error);
    };
    const abort = () => {
      fail(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      fail(new Error(event.message || "The skin chromophore worker failed."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        onProgress?.(data.value, data.message);
        return;
      }
      if (data.id !== id) return;
      if (data.type === "error") {
        fail(new Error(data.message));
        return;
      }
      detach();
      resolve({ result: data.result, pngs: data.pngs, worker });
    };
    // Transfer a copy so cancelling mid-run never detaches the displayed base image.
    const rgbaCopy = new Uint8ClampedArray(rgba);
    worker.postMessage({ type: "analyze", id, rgba: rgbaCopy, width, height, options }, [rgbaCopy.buffer]);
  });
}

function formSettings() {
  return readSettings({
    whiteBalance: $("whiteBalance").checked,
    maskVignette: $("maskVignette").checked,
    roiMode: $("roiMode").value,
  });
}

function applySettingsToForm(settings) {
  $("whiteBalance").checked = settings.whiteBalance;
  $("maskVignette").checked = settings.maskVignette;
  $("roiMode").value = settings.roiMode;
}

async function runAnalysis(signal, settings = formSettings(), onAutomationProgress = null) {
  if (!input) throw new Error("Load a dermatology photo before analyzing.");
  const operation = begin(`Analyzing ${input.file.name}…`, signal);
  running = operation.controller;
  // Do NOT mutate committed analysis, currentSettings, manualRoi, or outputs until success.
  updateControls();
  const current = operation.controller.signal;
  let candidateWorker = null;
  try {
    const started = performance.now();
    const completed = await runWorkerAnalyze(
      {
        rgba: input.rgba,
        width: input.width,
        height: input.height,
        options: settings,
      },
      {
        signal: current,
        onProgress: (value, message) => {
          progress.setProgress(value, message);
          onAutomationProgress?.({ value, message });
        },
      },
    );
    candidateWorker = completed.worker;
    current.throwIfAborted();

    // Atomic commit of the completed run.
    terminateActiveWorker();
    activeWorker = candidateWorker;
    candidateWorker = null;
    analysis = completed.result;
    currentSettings = settings;
    manualRoi = { target: null, reference: null };
    renderedMapView = null;

    const record = rebuildOutputs(completed.pngs);
    refreshOverlayLayers(true);
    renderReport();
    syncManualRoiInputs();
    setView(activeView === "image" ? "hemoglobin" : activeView);

    const seconds = (performance.now() - started) / 1000;
    const { target, reference, comparison } = analysis.roi;
    technical(`Analysis finished in ${seconds.toFixed(2)} s · valid ${analysis.validCount} px · vignette ${analysis.vignetteCount} px (guard ${analysis.vignetteGuardTriggered}) · transparent ${analysis.alphaExcludedCount} px · strategy ${analysis.roi.strategy}`);
    const targetBand = formatBandLabel(target);
    const targetItaNote = target.ita.mean !== null ? `${fmt(target.ita.mean, 1)}°` : "n/a";
    const summaryLine = `Analysis ready · ΔE2000 ${fmt(comparison.deltaE2000, 2)} · Target ${targetBand} (${targetItaNote})`;
    progress.end(summaryLine);
    status(summaryLine);
    log.log(`Target (${targetBand}): L*=${fmt(target.L.mean, 1)}, a*=${fmt(target.a.mean, 1)}, b*=${fmt(target.b.mean, 1)}, EI proxy=${fmt(target.ei.mean, 1)}, MI proxy=${fmt(target.mi.mean, 1)}`, "info", "analysis");
    log.log(`Reference (${formatBandLabel(reference)}): L*=${fmt(reference.L.mean, 1)}, a*=${fmt(reference.a.mean, 1)}, b*=${fmt(reference.b.mean, 1)}, EI proxy=${fmt(reference.ei.mean, 1)}, MI proxy=${fmt(reference.mi.mean, 1)}`, "info", "analysis");
    return {
      artifacts: [
        { role: "hemoglobin", file: outputs.hemoglobin.file },
        { role: "melanin", file: outputs.melanin.file },
        { role: "ita", file: outputs.ita.file },
        { role: "colorimetry", file: outputs.colorimetry.file },
        { role: "provenance", file: outputs.provenance.file },
      ],
      provenance: record,
      measurements: {
        target,
        reference,
        comparison,
      },
    };
  } catch (error) {
    if (candidateWorker) candidateWorker.terminate();
    progress.reset(input ? "Ready" : undefined);
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

async function importFiles(filesPromise) {
  exampleControl.cancel();
  loading?.abort();
  if (loadingPromise) {
    await loadingPromise.catch(() => {});
  }
  return loadFiles(filesPromise).catch(reportError);
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
    // Start loading operation BEFORE fetchFiles() resolves so #runButton is disabled
    // and footer #cancelButton is wired throughout download and decode.
    await loadFiles(
      fetchFiles().then((files) => {
        assertCurrent();
        return files;
      }),
      signal,
      `Downloading ${example.label}…`,
    );
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  if (input && !loading && !running) {
    void runAnalysis(undefined, formSettings()).catch(reportError);
  }
});

// ---------------------------------------------------------------------------------------------
// WebMCP / NeuroDesk automation contract.

registerAppAutomation({
  app: APP.id,
  operations: {
    analyze: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      const settings = readSettings({ ...formSettings(), ...parameters });
      applySettingsToForm(settings);
      return runAnalysis(signal, settings, reportProgress);
    },
  },
});

// Abort in-flight work on pagehide without destroying exampleControl so bfcache restore keeps it intact.
window.addEventListener("pagehide", (event) => {
  exampleControl.cancel();
  loading?.abort();
  running?.abort();
  if (!event.persisted) terminateActiveWorker();
});

updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results });
