// Wound Planimetry: calibrated digital wound planimetry and color-based
// Red-Yellow-Black (RYB) tissue estimation in CIE L*a*b* and HSV colour space.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./wound-planimetry.css";
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
import { APP, MAX_IMAGE_BYTES, SettingsError, readReferenceMm, readSettings } from "./config.js";
import { calibrationFromRuler } from "./core/planimetry.js";
import { RYB_CLASS_NAMES, imagePixel, overlayLayerRgba } from "./display.js";
import {
  RYB_CHART_SERIES,
  buildProvenance,
  outputStem,
  planimetryCsv,
  rybStackedBarSvg,
} from "./outputs.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);
const DRAG_PIXELS = 4;
const SETTING_IDS = ["pixelsPerMm", "sensitivity", "escharL", "granulationA", "sloughB"];
const RYB_SETTING_IDS = new Set(["escharL", "granulationA", "sloughB"]);
const COORD_INPUT_IDS = ["seedX", "seedY", "rulerX1", "rulerY1", "rulerX2", "rulerY2"];

const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Calibrated wound area & RYB tissue estimates",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "ryb", label: "RYB", active: true },
    { id: "boundary", label: "Boundary" },
    { id: "image", label: "Image" },
    { id: "report", label: "Report" },
  ],
  viewsLabel: "View",
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
$("aboutBtn").onclick = () => info.open("About Wound Planimetry", $("aboutContent"));
$("privacyBtn").onclick = () => info.open("Privacy", $("privacyContent"));

// ---------------------------------------------------------------------------------------------
// Application state.

let input = null; // { file, width, height, format, rgba }
let run = null; // { mask, boundary, rybLabels, planimetry, ryb, settings, files, provenance, seedFallback, ... }
let loading = null;
let running = null;
let activeView = "ryb";
let opacity = 0.5;
let activeTool = "inspect"; // "inspect" | "ruler" | "seed"
let ruler = null; // { p1, p2, pixelDist, referenceMm, pixelsPerMm }
let rulerPending = null; // [x, y] first click in click-click ruler mode
let seed = null; // [x, y]

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function reportError(error) {
  if (error instanceof SettingsError) {
    if (RYB_SETTING_IDS.has(error.field)) $("rybSettings").open = true;
    $(error.field)?.focus();
  }
  status(error.name === "AbortError" ? "Cancelled" : error.message, error.name !== "AbortError");
}

// ---------------------------------------------------------------------------------------------
// Viewer canvas, interactive 2-point ruler & seed marker rendering.

const canvas = $("canvas");
const context = canvas.getContext("2d");
const layers = {
  base: document.createElement("canvas"),
  overlay: document.createElement("canvas"),
};
let view = { scale: 1, x: 0, y: 0 };
let drag = null;

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function paintLayer(layer, rgba, width, height) {
  layer.width = width;
  layer.height = height;
  layer.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
}

function refreshBase() {
  if (!input) return;
  paintLayer(layers.base, new Uint8ClampedArray(input.rgba), input.width, input.height);
}

function refreshOverlay() {
  if (!input) return;
  const rgba = overlayLayerRgba({
    rybLabels: run?.rybLabels ?? null,
    boundary: run?.boundary ?? null,
    width: input.width,
    height: input.height,
    mode: activeView,
    opacity,
  });
  paintLayer(layers.overlay, rgba, input.width, input.height);
}

function toImage(event) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(1, rect.width);
  const scaleY = canvas.height / Math.max(1, rect.height);
  return [
    ((event.clientX - rect.left) * scaleX - view.x) / view.scale,
    ((event.clientY - rect.top) * scaleY - view.y) / view.scale,
  ];
}

function toCanvas(pt) {
  return [view.x + pt[0] * view.scale, view.y + pt[1] * view.scale];
}

function drawRulerLine(p1, p2, labelText, ratio, dashed = false) {
  const [x1, y1] = toCanvas(p1);
  const [x2, y2] = toCanvas(p2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);

  context.save();
  context.lineWidth = 2.5 * ratio;
  context.strokeStyle = token("--nd-color-bg");
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();

  context.setLineDash(dashed ? [5 * ratio, 4 * ratio] : []);
  context.lineWidth = 1.75 * ratio;
  context.strokeStyle = token("--nd-color-primary");
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  context.setLineDash([]);

  // Perpendicular end caps.
  if (len > 0) {
    const nx = (-dy / len) * 6 * ratio;
    const ny = (dx / len) * 6 * ratio;
    context.beginPath();
    context.moveTo(x1 - nx, y1 - ny);
    context.lineTo(x1 + nx, y1 + ny);
    context.moveTo(x2 - nx, y2 - ny);
    context.lineTo(x2 + nx, y2 + ny);
    context.stroke();
  }

  for (const [cx, cy] of [[x1, y1], [x2, y2]]) {
    context.beginPath();
    context.arc(cx, cy, 4 * ratio, 0, Math.PI * 2);
    context.fillStyle = token("--nd-color-primary");
    context.fill();
    context.lineWidth = 1.5 * ratio;
    context.strokeStyle = token("--nd-color-bg");
    context.stroke();
  }

  if (labelText) {
    const mx = (x1 + x2) * 0.5;
    const my = (y1 + y2) * 0.5 - 10 * ratio;
    context.font = `600 ${Math.round(11 * ratio)}px Inter, sans-serif`;
    const metrics = context.measureText(labelText);
    const padX = 6 * ratio;
    const padY = 4 * ratio;
    const boxW = metrics.width + padX * 2;
    const boxH = 14 * ratio + padY * 2;
    context.fillStyle = token("--nd-color-surface");
    context.strokeStyle = token("--nd-color-primary");
    context.lineWidth = 1 * ratio;
    context.fillRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
    context.strokeRect(mx - boxW / 2, my - boxH / 2, boxW, boxH);
    context.fillStyle = token("--nd-color-text");
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(labelText, mx, my);
  }
  context.restore();
}

function drawPointMarker(pt, colorToken, ratio, cross = false) {
  const [cx, cy] = toCanvas(pt);
  context.save();
  context.strokeStyle = token("--nd-color-bg");
  context.lineWidth = 3 * ratio;
  if (cross) {
    const arm = 8 * ratio;
    context.beginPath();
    context.moveTo(cx - arm, cy);
    context.lineTo(cx + arm, cy);
    context.moveTo(cx, cy - arm);
    context.lineTo(cx, cy + arm);
    context.stroke();
    context.strokeStyle = token(colorToken);
    context.lineWidth = 1.75 * ratio;
    context.stroke();
  }
  context.beginPath();
  context.arc(cx, cy, 4.5 * ratio, 0, Math.PI * 2);
  context.fillStyle = token(colorToken);
  context.fill();
  context.lineWidth = 1.5 * ratio;
  context.strokeStyle = token("--nd-color-bg");
  context.stroke();
  context.restore();
}

function drawPrincipalAxes(axes, ratio) {
  if (!axes) return;
  context.save();
  context.setLineDash([4 * ratio, 3 * ratio]);
  context.lineWidth = 1.5 * ratio;
  context.strokeStyle = token("--nd-color-primary");
  for (const segment of [axes.major, axes.minor]) {
    const [x1, y1] = toCanvas(segment[0]);
    const [x2, y2] = toCanvas(segment[1]);
    context.beginPath();
    context.moveTo(x1, y1);
    context.lineTo(x2, y2);
    context.stroke();
  }
  context.restore();
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!input || activeView === "report") return;

  const scale = Math.min(canvas.width / input.width, canvas.height / input.height);
  view = {
    scale,
    x: (canvas.width - input.width * scale) / 2,
    y: (canvas.height - input.height * scale) / 2,
  };
  context.imageSmoothingEnabled = scale < 2;
  context.drawImage(layers.base, view.x, view.y, input.width * scale, input.height * scale);
  context.drawImage(layers.overlay, view.x, view.y, input.width * scale, input.height * scale);

  if (activeView === "boundary" && run?.planimetry?.axes) {
    drawPrincipalAxes(run.planimetry.axes, ratio);
  }
  if (ruler) {
    drawRulerLine(
      ruler.p1,
      ruler.p2,
      `${ruler.referenceMm} mm (${ruler.pixelsPerMm.toFixed(2)} px/mm)`,
      ratio,
      false,
    );
  }
  if (drag?.moved) {
    const dist = Math.hypot(drag.end[0] - drag.start[0], drag.end[1] - drag.start[1]);
    drawRulerLine(drag.start, drag.end, `${dist.toFixed(1)} px`, ratio, true);
  } else if (rulerPending) {
    drawPointMarker(rulerPending, "--nd-color-primary", ratio, false);
  }
  if (seed) {
    drawPointMarker([seed[0] + 0.5, seed[1] + 0.5], "--nd-color-warning", ratio, true);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

// ---------------------------------------------------------------------------------------------
// Report rendering.

const formatNumber = (value, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : Number(value).toFixed(digits);

const formatPercent = (value, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${Number(value).toFixed(digits)}%`;

function buildTable(caption, headers, rows, { numeric = [] } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "nd-table-scroll";
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
  for (const cells of rows) {
    const tr = document.createElement("tr");
    cells.forEach((cell, index) => {
      const td = document.createElement("td");
      if (numeric.includes(index)) td.className = "nd-numeric";
      td.textContent = cell;
      tr.append(td);
    });
    tbody.append(tr);
  }

  table.append(cap, thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function renderReport() {
  const container = $("report");
  container.replaceChildren();
  if (!run) return;

  const { planimetry: p, ryb, seedFallback } = run;
  const woundDetected = p.areaPx > 0;
  const stack = document.createElement("div");
  stack.className = "nd-report-stack";

  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  if (!woundDetected) {
    lead.textContent = "No wound bed detected · Red — · Yellow — · Black — · Unclassified —";
  } else {
    const areaHeadline = p.calibrated
      ? `${formatNumber(p.areaCm2, 2)} cm² (${formatNumber(p.areaMm2, 1)} mm², ${p.areaPx} px²)`
      : `${p.areaPx} px² (uncalibrated)`;
    lead.textContent =
      `Wound bed: ${areaHeadline} · ` +
      `Red ${formatPercent(ryb.classes.red.percent)} · ` +
      `Yellow ${formatPercent(ryb.classes.yellow.percent)} · ` +
      `Black ${formatPercent(ryb.classes.black.percent)} · ` +
      `Unclassified ${formatPercent(ryb.classes.unclassified.percent)}`;
  }
  stack.append(lead);

  if (!woundDetected) {
    const warning = document.createElement("p");
    warning.className = "nd-message warning";
    warning.textContent = "No wound bed detected. Adjust Sensitivity or place a seed point inside the wound bed, then run Measure wound again.";
    stack.append(warning);
  } else if (seedFallback) {
    const notice = document.createElement("p");
    notice.className = "nd-message warning";
    notice.textContent = "Placed seed fell outside all segmented components; fell back to the nearest component.";
    stack.append(notice);
  }

  const geometryRows = [
    ["Calibration scale", p.calibrated ? `${formatNumber(p.pixelsPerMm, 3)} px/mm` : "Uncalibrated (0 px/mm)", ""],
    ["Area", `${p.areaPx} px²`, p.calibrated ? `${formatNumber(p.areaMm2, 2)} mm² (${formatNumber(p.areaCm2, 3)} cm²)` : "—"],
    ["Boundary perimeter", `${formatNumber(p.perimeterPx, 2)} px`, p.calibrated ? `${formatNumber(p.perimeterMm, 2)} mm` : "—"],
    ["Major length × perp. width", `${formatNumber(p.lengthPx, 1)} × ${formatNumber(p.widthPx, 1)} px`, p.calibrated ? `${formatNumber(p.lengthMm, 2)} × ${formatNumber(p.widthMm, 2)} mm` : "—"],
    ["Kundin ellipsoid area (π/4·L·W)", `${formatNumber(p.kundinAreaPx, 1)} px²`, p.calibrated ? `${formatNumber(p.kundinAreaMm2, 2)} mm² (${formatNumber(p.kundinAreaCm2, 3)} cm²)` : "—"],
    ["Circularity (4πA / P²)", woundDetected ? formatNumber(p.circularity, 3) : "—", "≤ 1.0 (circle)"],
    ["Compactness (P² / 4πA)", woundDetected ? formatNumber(p.compactness, 3) : "—", "≥ 1.0 (circle)"],
    ["Major axis orientation", woundDetected ? `${formatNumber(p.orientationDeg, 1)}°` : "—", ""],
  ];
  stack.append(buildTable("Planimetry Geometry", ["Metric", "Pixel / index", "Calibrated physical"], geometryRows, { numeric: [1, 2] }));

  const ratioLabel = !woundDetected
    ? "—"
    : ryb.granulationToDevitalizedRatio !== null
      ? `${formatNumber(ryb.granulationToDevitalizedRatio, 2)} : 1`
      : ryb.classes.red.pixels > 0 ? "∞ (no devitalized)" : "—";

  const rybRows = [
    ...Object.values(ryb.classes).map((cls) => [
      cls.label,
      woundDetected ? `${cls.pixels} px²` : "—",
      formatPercent(cls.percent),
      p.calibrated && woundDetected ? `${formatNumber(cls.areaCm2, 3)} cm²` : "—",
    ]),
    [
      "Devitalized (Yellow + Black)",
      woundDetected ? `${ryb.devitalizedPx} px²` : "—",
      formatPercent(ryb.devitalizedPercent),
      p.calibrated && woundDetected ? `${formatNumber(ryb.devitalizedAreaCm2, 3)} cm²` : "—",
    ],
    ["Granulation / devitalized ratio", ratioLabel, "", ""],
  ];
  stack.append(buildTable("Color-based RYB Tissue Estimates", ["Tissue class", "Area (px²)", "Share", "Area (cm²)"], rybRows, { numeric: [1, 2, 3] }));

  const figure = document.createElement("figure");
  figure.className = "nd-chart-figure";
  const caption = document.createElement("figcaption");
  caption.textContent = "Color-based RYB tissue estimates (% of segmented wound bed)";
  figure.append(caption);
  figure.insertAdjacentHTML("beforeend", rybStackedBarSvg(ryb));
  const legend = document.createElement("ul");
  legend.className = "nd-chart-legend";
  for (const item of RYB_CHART_SERIES) {
    const li = document.createElement("li");
    li.insertAdjacentHTML("beforeend", `<svg viewBox="0 0 18 10" aria-hidden="true"><rect x="1" y="1" width="16" height="8" rx="1" fill="${item.fill}"/></svg>`);
    li.append(`${item.label} (${formatPercent(ryb.classes[item.key].percent)})`);
    legend.append(li);
  }
  figure.append(legend);
  stack.append(figure);

  const disclaimer = document.createElement("p");
  disclaimer.className = "wp-disclaimer";
  disclaimer.textContent = "Research use only. Automated digital planimetry and color-based RYB estimates are heuristic approximations (not trained clinical tissue classification) and are not validated for clinical diagnosis, staging, or treatment decisions.";
  stack.append(disclaimer);

  container.append(stack);
}

// ---------------------------------------------------------------------------------------------
// View, tool & annotation coordinate helpers.

function setView(nextView) {
  if (nextView === "report" && !run) {
    status("Run Measure wound to view the planimetry report");
    toolbar.setActive(activeView);
    return;
  }
  activeView = nextView;
  toolbar.setActive(nextView);
  const showReport = nextView === "report" && Boolean(run);
  $("report").hidden = !showReport;
  canvas.hidden = showReport;
  if (!showReport) {
    refreshOverlay();
    draw();
  }
}

toolbar.addEventListener("nd-view-change", ({ detail }) => setView(detail.value));
toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  opacity = detail.value;
  if (input && activeView !== "report") {
    refreshOverlay();
    draw();
  }
});

function setTool(tool) {
  activeTool = tool;
  rulerPending = null;
  canvas.dataset.tool = tool;
  $("inspectTool").setAttribute("aria-pressed", String(tool === "inspect"));
  $("rulerTool").setAttribute("aria-pressed", String(tool === "ruler"));
  $("seedTool").setAttribute("aria-pressed", String(tool === "seed"));
  if (input && activeView === "report" && tool !== "inspect") {
    setView(run ? "ryb" : "image");
  }
  draw();
}

function syncCoordinateInputs() {
  $("seedX").value = seed ? String(seed[0]) : "";
  $("seedY").value = seed ? String(seed[1]) : "";
  $("rulerX1").value = ruler ? String(Number(ruler.p1[0].toFixed(2))) : "";
  $("rulerY1").value = ruler ? String(Number(ruler.p1[1].toFixed(2))) : "";
  $("rulerX2").value = ruler ? String(Number(ruler.p2[0].toFixed(2))) : "";
  $("rulerY2").value = ruler ? String(Number(ruler.p2[1].toFixed(2))) : "";
}

function syncCoordinateBounds() {
  const maxX = input ? String(input.width - 1) : "";
  const maxY = input ? String(input.height - 1) : "";
  const maxRulerX = input ? String(input.width) : "";
  const maxRulerY = input ? String(input.height) : "";
  $("seedX").max = maxX;
  $("seedY").max = maxY;
  $("rulerX1").max = maxRulerX;
  $("rulerX2").max = maxRulerX;
  $("rulerY1").max = maxRulerY;
  $("rulerY2").max = maxRulerY;
}

function invalidateRun() {
  if (!run) return;
  clearRun();
  refreshOverlay();
  draw();
}

function applySeedPoint(pixel) {
  seed = pixel;
  syncCoordinateInputs();
  invalidateRun();
  updateControls();
  draw();
  status(`Seed placed at (${seed[0]}, ${seed[1]}) · click Measure wound to segment`);
}

function applyRulerPoints(p1, p2) {
  try {
    const refMm = readReferenceMm($("referenceMm").value);
    const cal = calibrationFromRuler(p1, p2, refMm);
    ruler = { p1, p2, ...cal };
    rulerPending = null;
    $("pixelsPerMm").value = String(Number(cal.pixelsPerMm.toFixed(4)));
    syncCoordinateInputs();
    invalidateRun();
    updateControls();
    draw();
    status(`Calibrated: ${cal.pixelsPerMm.toFixed(2)} px/mm (${cal.pixelDist.toFixed(1)} px = ${refMm} mm)`);
  } catch (error) {
    rulerPending = null;
    draw();
    reportError(error);
  }
}

$("inspectTool").onclick = () => setTool("inspect");
$("rulerTool").onclick = () => {
  setTool("ruler");
  if (input) status("Calibrate ruler: click or drag two points across the reference length");
};
$("seedTool").onclick = () => {
  setTool("seed");
  if (input) status("Place seed: click inside the wound bed");
};
$("clearAnnotationsButton").onclick = () => {
  ruler = null;
  rulerPending = null;
  seed = null;
  $("pixelsPerMm").value = "0";
  syncCoordinateInputs();
  invalidateRun();
  updateControls();
  draw();
  status("Cleared ruler calibration and seed point");
};

$("applySeedButton").onclick = () => {
  if (!input || loading || running) return;
  const x = Number($("seedX").value);
  const y = Number($("seedY").value);
  if ($("seedX").value === "" || $("seedY").value === "" || !Number.isFinite(x) || !Number.isFinite(y)) {
    status("Enter numeric seed X and Y coordinates.", true);
    return;
  }
  const pixel = imagePixel(x, y, input.width, input.height);
  if (!pixel) {
    status(`Seed must be inside 0–${input.width - 1} × 0–${input.height - 1}.`, true);
    return;
  }
  applySeedPoint(pixel);
};

$("applyRulerButton").onclick = () => {
  if (!input || loading || running) return;
  const raw = [$("rulerX1").value, $("rulerY1").value, $("rulerX2").value, $("rulerY2").value];
  const nums = raw.map(Number);
  if (raw.some((v) => v === "") || nums.some((n) => !Number.isFinite(n))) {
    status("Enter numeric coordinates for both ruler endpoints.", true);
    return;
  }
  const [x1, y1, x2, y2] = nums;
  if (x1 < 0 || x1 > input.width || x2 < 0 || x2 > input.width || y1 < 0 || y1 > input.height || y2 < 0 || y2 > input.height) {
    status(`Ruler endpoints must lie within 0–${input.width} × 0–${input.height}.`, true);
    return;
  }
  applyRulerPoints([x1, y1], [x2, y2]);
};

for (const id of SETTING_IDS) {
  const onSettingChange = () => {
    if (id === "pixelsPerMm" && (ruler || rulerPending)) {
      ruler = null;
      rulerPending = null;
      syncCoordinateInputs();
      updateControls();
      draw();
    }
    invalidateRun();
  };
  $(id).addEventListener("input", onSettingChange);
  $(id).addEventListener("change", onSettingChange);
}

const onReferenceChange = (reportInvalid) => {
  if (!ruler) return;
  invalidateRun();
  try {
    const refMm = readReferenceMm($("referenceMm").value);
    const updated = calibrationFromRuler(ruler.p1, ruler.p2, refMm);
    ruler = { p1: ruler.p1, p2: ruler.p2, ...updated };
    $("pixelsPerMm").value = String(Number(ruler.pixelsPerMm.toFixed(4)));
    draw();
    if (reportInvalid) {
      status(`Calibrated: ${ruler.pixelsPerMm.toFixed(2)} px/mm (${ruler.pixelDist.toFixed(1)} px = ${refMm} mm)`);
    }
  } catch (error) {
    $("pixelsPerMm").value = "0";
    ruler = { p1: ruler.p1, p2: ruler.p2, pixelDist: ruler.pixelDist, pixelsPerMm: 0, referenceMm: 0 };
    draw();
    if (reportInvalid) reportError(error);
  }
};
$("referenceMm").addEventListener("input", () => onReferenceChange(false));
$("referenceMm").addEventListener("change", () => onReferenceChange(true));

// ---------------------------------------------------------------------------------------------
// Canvas pointer interaction (inspect, 2-point ruler, seed).

canvas.addEventListener("pointerdown", (event) => {
  if (!input || loading || running || event.button !== 0 || activeView === "report") return;
  const pt = toImage(event);
  const pixel = imagePixel(pt[0], pt[1], input.width, input.height);
  if (!pixel) return;

  if (activeTool === "seed") {
    applySeedPoint(pixel);
    return;
  }

  if (activeTool === "ruler") {
    if (drag) return;
    canvas.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      start: pt,
      end: pt,
      screen: [event.clientX, event.clientY],
      moved: false,
    };
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (!input || activeView === "report") return;
  const pt = toImage(event);
  const pixel = imagePixel(pt[0], pt[1], input.width, input.height);
  if (pixel) {
    const idx = pixel[1] * input.width + pixel[0];
    const clsName = run ? ` · ${RYB_CLASS_NAMES[run.rybLabels[idx]]}` : "";
    const scaleNote = ruler ? ` · ${ruler.pixelsPerMm.toFixed(2)} px/mm` : "";
    $("location").textContent = `x ${pixel[0]} · y ${pixel[1]}${clsName}${scaleNote}`;
  } else {
    $("location").textContent = "";
  }

  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.end = [
    Math.max(0, Math.min(input.width, pt[0])),
    Math.max(0, Math.min(input.height, pt[1])),
  ];
  drag.moved ||= Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) > DRAG_PIXELS;
  if (drag.moved) draw();
});

canvas.addEventListener("pointerup", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  const currentDrag = drag;
  drag = null;
  if (currentDrag.moved) {
    const pt = toImage(event);
    const end = [
      Math.max(0, Math.min(input.width, pt[0])),
      Math.max(0, Math.min(input.height, pt[1])),
    ];
    applyRulerPoints(currentDrag.start, end);
    return;
  }
  if (!rulerPending) {
    rulerPending = currentDrag.start;
    draw();
    status("First ruler point set · click the second point across the ruler");
  } else {
    applyRulerPoints(rulerPending, currentDrag.start);
  }
});

canvas.addEventListener("pointercancel", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  drag = null;
  draw();
});

// ---------------------------------------------------------------------------------------------
// Controls, result list, worker execution.

const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (stage === "rybOverlay") setView("ryb");
    else if (stage === "mask") setView("boundary");
    else setView("report");
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function updateControls() {
  const busy = Boolean(loading || running);
  results.inert = busy;
  // Keep file input enabled during loading so a newer file pick can supersede a pending load.
  $("imageInput").disabled = Boolean(running);
  for (const id of [...SETTING_IDS, "referenceMm"]) $(id).disabled = busy;
  exampleControl?.setDisabled(busy);
  $("runButton").disabled = busy || !input;
  const toolsDisabled = busy || !input;
  $("inspectTool").disabled = toolsDisabled;
  $("rulerTool").disabled = toolsDisabled;
  $("seedTool").disabled = toolsDisabled;
  $("clearAnnotationsButton").disabled = busy || (!ruler && !seed);
  for (const id of COORD_INPUT_IDS) $(id).disabled = toolsDisabled;
  $("applySeedButton").disabled = toolsDisabled;
  $("applyRulerButton").disabled = toolsDisabled;
}

function formValues() {
  return Object.fromEntries(SETTING_IDS.map((id) => [id, $(id).value]));
}

function showSettings(settings) {
  for (const id of SETTING_IDS) {
    if (settings[id] !== undefined && settings[id] !== null) $(id).value = String(settings[id]);
  }
}

function begin(message, signal, { supersedeLoad = false } = {}) {
  if (running) throw new Error("Wait for the current operation to finish, or cancel it.");
  if (loading) {
    if (!supersedeLoad) throw new Error("Wait for the current operation to finish, or cancel it.");
    const previous = loading;
    loading = null;
    previous.abort(new DOMException("Superseded by a newer image import", "AbortError"));
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  progress.begin(message);
  progress.setCancellable(true);
  status(message, false, "technical");
  return { controller, release: () => signal?.removeEventListener("abort", abort) };
}

function finish(operation) {
  operation.release();
  progress.stopTimer();
  progress.setCancellable(false);
  updateControls();
}

function clearRun() {
  run = null;
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  if (activeView === "report") setView("ryb");
}

function runInWorker(payload, { transfer = [], signal, onProgress } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { type: "module" });
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "The wound planimetry worker failed."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        onProgress?.(data.value, data.message);
        return;
      }
      cleanup();
      if (data.type === "error") reject(new Error(data.message));
      else resolve(data);
    };
    worker.postMessage({ id: 1, type: "measure", ...payload }, transfer);
  });
}

async function loadFiles(filesPromise, signal, { label = "Reading wound image…" } = {}) {
  const operation = begin(label, signal, { supersedeLoad: true });
  loading = operation.controller;
  updateControls();
  const current = operation.controller.signal;
  try {
    const files = await filesPromise;
    current.throwIfAborted();
    if (files.length !== 1) throw new Error(`Choose one wound photo (PNG or JPEG); received ${files.length} files.`);
    const [file] = files;
    if (!file.size) throw new Error(`${file.name} is empty.`);
    const decoded = await decodeRasterImage(file, { maxBytes: MAX_IMAGE_BYTES, signal: current });
    current.throwIfAborted();
    input = {
      file,
      width: decoded.width,
      height: decoded.height,
      format: decoded.format,
      rgba: decoded.data,
    };
    ruler = null;
    rulerPending = null;
    seed = null;
    $("pixelsPerMm").value = "0";
    syncCoordinateInputs();
    syncCoordinateBounds();
    clearRun();
    refreshBase();
    refreshOverlay();
    $("emptyState").hidden = true;
    setView("ryb");
    draw();
    $("imageInput").dispatchEvent(new CustomEvent("nd-files", { bubbles: true, detail: { files: [file] } }));
    $("fileInfo").hidden = false;
    $("fileInfo").textContent = `${file.name} · ${input.width} × ${input.height} · ${input.format.toUpperCase()}`;
    $("dropZone").classList.add("has-files");
    progress.setProgress(0);
    status(`${file.name} loaded · click Measure wound to analyse`);
    log.log(`Loaded ${file.name}: ${input.width} × ${input.height} (${input.format})`, "info", "analysis");
  } catch (error) {
    if (loading === operation.controller) {
      progress.reset(input ? "Ready" : "Drag and drop files");
    }
    throw error;
  } finally {
    operation.release();
    if (loading === operation.controller) {
      loading = null;
      finish(operation);
    }
  }
}

async function measureWound(signal, settings) {
  if (!input) throw new Error("Load a wound photo before measuring.");
  const operation = begin(`Measuring ${input.file.name}…`, signal);
  running = operation.controller;
  updateControls();
  const current = operation.controller.signal;
  try {
    const rgbaCopy = input.rgba.slice();
    const result = await runInWorker(
      {
        rgba: rgbaCopy,
        width: input.width,
        height: input.height,
        params: settings,
        seed,
        overlayOpacity: 0.55,
      },
      {
        transfer: [rgbaCopy.buffer],
        signal: current,
        onProgress: (value, message) => progress.setProgress(value, message),
      },
    );
    current.throwIfAborted();

    const stem = outputStem(input.file.name);
    const csvText = planimetryCsv({
      filename: input.file.name,
      width: input.width,
      height: input.height,
      planimetry: result.planimetry,
      ryb: result.ryb,
      settings,
      seed: result.seedUsed,
      seedFallback: result.seedFallback,
    });
    const provenance = buildProvenance({
      app: APP,
      input,
      settings,
      seed: result.seedUsed,
      seedFallback: result.seedFallback,
      ruler,
      threshold: result.threshold,
      otsuThreshold: result.otsuThreshold,
      planimetry: result.planimetry,
      ryb: result.ryb,
      elapsedMs: result.elapsedMs,
    });

    const files = {
      rybOverlay: {
        description: "RYB tissue overlay (PNG)",
        file: new File([result.rybPngBytes], `${stem}_wound-ryb-overlay.png`, { type: "image/png" }),
      },
      mask: {
        description: "Wound mask (PNG)",
        file: new File([result.maskPngBytes], `${stem}_wound-mask.png`, { type: "image/png" }),
      },
      planimetry: {
        description: "Planimetry table (CSV)",
        file: new File([csvText], `${stem}_wound-planimetry.csv`, { type: "text/csv" }),
      },
      provenance: {
        description: "Provenance report (JSON)",
        file: new File([`${JSON.stringify(provenance, null, 2)}\n`], `${stem}_wound-provenance.json`, { type: "application/json" }),
      },
    };

    run = { ...result, settings, files, provenance };
    results.render(files);
    $("outputSection").open = true;
    renderReport();
    refreshOverlay();
    draw();

    const woundDetected = result.planimetry.areaPx > 0;
    if (!woundDetected) {
      const warning = "No wound bed detected · R — / Y — / B — / U —";
      log.log(`${warning} (${result.elapsedMs.toFixed(0)} ms)`, "warn", "analysis");
      progress.end(warning, { success: false });
      status(warning, true, "analysis");
    } else {
      const areaText = result.planimetry.calibrated
        ? `${result.planimetry.areaCm2.toFixed(2)} cm² (${result.planimetry.areaMm2.toFixed(1)} mm²)`
        : `${result.planimetry.areaPx} px²`;
      const summary =
        `Wound measured · ${areaText} · ` +
        `R ${result.ryb.classes.red.percent.toFixed(0)}% / ` +
        `Y ${result.ryb.classes.yellow.percent.toFixed(0)}% / ` +
        `B ${result.ryb.classes.black.percent.toFixed(0)}% / ` +
        `U ${result.ryb.classes.unclassified.percent.toFixed(0)}%`;
      log.log(`${summary} (threshold ${result.threshold.toFixed(3)}, ${result.elapsedMs.toFixed(0)} ms)`, "info", "analysis");
      if (result.seedFallback) {
        log.log("Placed seed fell outside all segmented components; fell back to nearest component.", "warn", "analysis");
      }
      progress.end(summary);
      status(summary);
    }

    return {
      artifacts: Object.entries(files).map(([role, { file }]) => ({ role, file })),
      provenance,
    };
  } catch (error) {
    progress.reset(input ? "Ready" : "Drag and drop files");
    throw error;
  } finally {
    running = null;
    finish(operation);
  }
}

// ---------------------------------------------------------------------------------------------
// Input wiring, examples & WebMCP automation.

function importFiles(files) {
  exampleControl.cancel();
  return loadFiles(files).catch(reportError);
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
  onLoad: async (_example, { fetchFiles, assertCurrent, signal }) => {
    await loadFiles(fetchFiles(), signal, { label: "Loading example wound photo…" });
    assertCurrent();
  },
});
$("exampleControl").append(exampleControl);

$("runButton").addEventListener("click", () => {
  try {
    const settings = readSettings(formValues());
    void measureWound(undefined, settings).catch(reportError);
  } catch (error) {
    reportError(error);
  }
});

registerAppAutomation({
  app: APP.id,
  operations: {
    measure: async ({ inputs, parameters, signal }) => {
      await loadFiles(Promise.resolve(inputs.image), signal);
      const settings = readSettings({ ...formValues(), ...parameters });
      showSettings(settings);
      return measureWound(signal, settings);
    },
  },
});

window.addEventListener("pagehide", () => {
  exampleControl.destroy();
  loading?.abort();
  running?.abort();
});

setTool("inspect");
updateControls();

export default Object.freeze({ workspace, toolbar, log, info, results, run: () => run });
