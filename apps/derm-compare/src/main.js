// DermCompare: sequential digital dermoscopy alignment and CIEDE2000 change comparator.
// Pure numerics live in src/core/ and execute inside src/worker.js; this file owns the
// workspace shell, two-image input flow, interactive comparison views, report and automation.
import "@neurodesk/webapp-components/styles/imaging-workspace.css";
import "./derm-compare.css";
import { mountImagingWorkspace } from "@neurodesk/webapp-components/core/mount-imaging-workspace";
import {
  createImagePair,
  createResultList,
  createInfoDialog,
  createConsole,
  createViewerToolbar,
  bindInfoTooltips,
  ProgressManager,
} from "@neurodesk/webapp-components/ui";
import { downloadFile } from "@neurodesk/webapp-components/file-io";
import { registerAppAutomation } from "@neurodesk/webapp-components/automation";
import {
  APP,
  DESCRIPTIVE_THRESHOLDS,
  LIMITS,
  SettingsError,
  TRANSFORM_CONVENTION,
  buildProvenance,
  clampFlickerInterval,
  readSettings,
} from "./config.js";
import {
  CONTOUR_COLORS,
  DELTA_E_SCALE_MAX,
  HEAT_STOPS,
  buildCheckerRgba,
  buildContourOverlayRgba,
  buildDeltaEHeatmapRgba,
  buildDiffUnderlayRgba,
} from "./display.js";
import { metricsCsv, outputStem, provenanceJson } from "./outputs.js";
import examples from "../examples.json";

const $ = (id) => document.getElementById(id);

// 1. Shared workspace shell, toolbar, console, status footer and info dialogs.
const workspace = mountImagingWorkspace({
  controls: "#controls",
  viewer: "#viewer",
  status: "#status",
  title: APP.title,
  subtitle: "Sequential digital dermoscopy comparator",
  controlsContract: { about: "#aboutBtn", privacy: "#privacyBtn" },
});

const toolbar = createViewerToolbar({
  views: [
    { id: "curtain", label: "Curtain", active: true },
    { id: "flicker", label: "Flicker" },
    { id: "checker", label: "Checker" },
    { id: "diff", label: "ΔE2000" },
    { id: "report", label: "Report" },
  ],
  viewsLabel: "Comparison view",
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

// 2. Application state.
let baseline = null; // { file, width, height, originalWidth, originalHeight, rgba }
let followup = null; // { file, width, height, originalWidth, originalHeight, rgba }
let comparison = null; // worker result + artifacts + provenance
let lastFailure = null; // explicit registration failure message for report display
let outputs = {};
let loading = null;
let running = null;
let pair = null;

let activeView = "curtain";
let overlayOpacity = 0.5;
let splitRatio = 0.5;
let activePointerId = null;
let flickerTimer = null;
let flickerPaused = false;
let flickerShowFollowup = false;

function status(message, error = false, channel = "analysis") {
  $("statusText").textContent = message;
  $("statusText").classList.toggle("error", error);
  log.log(message, error ? "error" : "info", channel);
}

function reportError(error) {
  if (error instanceof SettingsError) {
    $("advancedSettings").open = true;
    $(error.field)?.focus();
  }
  const cancelled = error?.name === "AbortError";
  status(cancelled ? "Cancelled" : (error?.message || String(error)), !cancelled);
}

// 3. Viewer canvas layers and interactive comparison modes.
const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const layers = {
  baseline: document.createElement("canvas"),
  followup: document.createElement("canvas"),
  checker: document.createElement("canvas"),
  diffUnderlay: document.createElement("canvas"),
  heatmap: document.createElement("canvas"),
  contours: document.createElement("canvas"),
};
let viewBox = { scale: 1, x: 0, y: 0, width: 0, height: 0 };

function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgbCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function paintCanvas(target, rgba, width, height) {
  target.width = width;
  target.height = height;
  target.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
}

function releaseCanvas(target) {
  target.width = 0;
  target.height = 0;
}

function refreshBaselineLayer() {
  if (comparison?.baselineRgba) {
    paintCanvas(layers.baseline, comparison.baselineRgba, comparison.width, comparison.height);
    return;
  }
  if (!baseline) {
    releaseCanvas(layers.baseline);
    return;
  }
  paintCanvas(layers.baseline, baseline.rgba, baseline.width, baseline.height);
}

function refreshFollowupPreviewLayer() {
  if (!followup) {
    releaseCanvas(layers.followup);
    return;
  }
  paintCanvas(layers.followup, followup.rgba, followup.width, followup.height);
}

function refreshComparisonLayers() {
  if (!comparison || !baseline) return;
  const { width, height } = comparison;
  const baseRgba = comparison.baselineRgba ?? baseline.rgba;
  paintCanvas(layers.followup, comparison.warpedFollowupRgba, width, height);
  paintCanvas(
    layers.checker,
    buildCheckerRgba({
      baselineRgba: baseRgba,
      warpedFollowupRgba: comparison.warpedFollowupRgba,
      validMask: comparison.validMask,
      width,
      height,
    }),
    width,
    height,
  );
  paintCanvas(
    layers.diffUnderlay,
    buildDiffUnderlayRgba({
      baselineRgba: baseRgba,
      validMask: comparison.validMask,
      width,
      height,
    }),
    width,
    height,
  );
  paintCanvas(
    layers.heatmap,
    buildDeltaEHeatmapRgba({
      deltaEMap: comparison.deltaEMap,
      deltaEMask: comparison.deltaEMask,
      validMask: comparison.validMask,
      width,
      height,
    }),
    width,
    height,
  );
  paintCanvas(
    layers.contours,
    buildContourOverlayRgba({
      baselineMask: comparison.baselineMask,
      followupMask: comparison.followupMask,
      width,
      height,
      opacity: 1,
    }),
    width,
    height,
  );
}

function stopFlicker() {
  if (flickerTimer !== null) {
    clearInterval(flickerTimer);
    flickerTimer = null;
  }
}

function syncFlicker() {
  stopFlicker();
  const canFlicker = activeView === "flicker" && Boolean(comparison) && !flickerPaused && !document.hidden;
  if (canFlicker) {
    const interval = clampFlickerInterval($("flickerInterval").value);
    flickerTimer = setInterval(() => {
      if (activeView !== "flicker" || !comparison || document.hidden) {
        stopFlicker();
        return;
      }
      flickerShowFollowup = !flickerShowFollowup;
      draw();
    }, interval);
  }
  updatePlaybackControls();
}

function updatePlaybackControls() {
  const busy = Boolean(loading || running);
  const flickerBtn = $("flickerToggle");
  const canToggleFlicker = !busy && Boolean(comparison) && activeView === "flicker";
  flickerBtn.disabled = !canToggleFlicker;
  flickerBtn.setAttribute("aria-pressed", String(flickerPaused));
  flickerBtn.textContent = flickerPaused ? "Resume flicker" : "Pause flicker";

  const curtainSlider = $("curtainSplit");
  const pct = Math.round(splitRatio * 100);
  curtainSlider.value = String(pct);
  curtainSlider.setAttribute("aria-valuetext", `${pct}%`);
  curtainSlider.disabled = busy || !comparison || activeView !== "curtain";
}

function updateViewHint() {
  if (!baseline && !followup) {
    $("viewHint").textContent = "";
    return;
  }
  if (!comparison) {
    if (lastFailure) {
      $("viewHint").textContent = `Registration failed · ${lastFailure}`;
      return;
    }
    $("viewHint").textContent = baseline && followup
      ? "Preview · click Align & compare"
      : (baseline ? "Baseline loaded · add follow-up" : "Follow-up loaded · add baseline");
    return;
  }
  if (activeView === "curtain") {
    $("viewHint").textContent = `Curtain ${Math.round(splitRatio * 100)}% · drag or use slider`;
  } else if (activeView === "flicker") {
    const frame = flickerShowFollowup ? "Aligned follow-up" : "Baseline";
    $("viewHint").textContent = `Flicker${flickerPaused ? " (paused)" : ""}: ${frame}`;
  } else if (activeView === "checker") {
    $("viewHint").textContent = "Checkerboard: baseline / aligned follow-up";
  } else if (activeView === "diff") {
    const heatText = overlayOpacity === 0 ? "heatmap hidden" : `overlay ${Math.round(overlayOpacity * 100)}%`;
    $("viewHint").textContent = `ΔE2000 (0–${DELTA_E_SCALE_MAX}) · ${heatText} · cyan baseline / lime follow-up`;
  } else {
    $("viewHint").textContent = "Quantitative comparison report";
  }
}

function drawBadge(text, x, y, ratio) {
  ctx.save();
  ctx.font = `600 ${Math.round(11 * ratio)}px Inter, system-ui, sans-serif`;
  const padX = 6 * ratio;
  const padY = 3 * ratio;
  const metrics = ctx.measureText(text);
  const w = metrics.width + padX * 2;
  const h = 16 * ratio + padY;
  ctx.fillStyle = cssToken("--nd-color-surface");
  ctx.globalAlpha = 0.88;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.fillStyle = cssToken("--nd-color-text");
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, y + h / 2);
  ctx.restore();
}

function drawDiffLegend(x0, y0, drawW, drawH, ratio) {
  const pad = 8 * ratio;
  const barW = Math.min(140 * ratio, Math.max(72 * ratio, drawW * 0.28));
  const barH = 10 * ratio;
  const lineH = 14 * ratio;
  const boxW = Math.max(barW + pad * 2, 168 * ratio);
  const boxH = pad * 2 + lineH + barH + lineH + 4 * ratio;
  if (drawW < boxW + 16 * ratio || drawH < boxH + 36 * ratio) return;

  const lx = x0 + 8 * ratio;
  const ly = y0 + drawH - boxH - 8 * ratio;

  ctx.save();
  ctx.fillStyle = cssToken("--nd-color-surface");
  ctx.globalAlpha = 0.9;
  ctx.fillRect(lx, ly, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = cssToken("--nd-color-border");
  ctx.lineWidth = Math.max(1, ratio);
  ctx.strokeRect(lx, ly, boxW, boxH);

  ctx.font = `600 ${Math.round(10 * ratio)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = cssToken("--nd-color-text");
  ctx.textBaseline = "top";
  ctx.fillText(`0–${DELTA_E_SCALE_MAX} ΔE2000`, lx + pad, ly + pad);

  const barY = ly + pad + lineH;
  const grad = ctx.createLinearGradient(lx + pad, barY, lx + pad + barW, barY);
  for (const [stopVal, r, g, b] of HEAT_STOPS) {
    grad.addColorStop(stopVal / DELTA_E_SCALE_MAX, rgbCss([r, g, b]));
  }
  ctx.fillStyle = grad;
  ctx.fillRect(lx + pad, barY, barW, barH);

  const contourY = barY + barH + 5 * ratio;
  const swatch = 8 * ratio;
  ctx.fillStyle = rgbCss(CONTOUR_COLORS.baseline);
  ctx.fillRect(lx + pad, contourY + 2 * ratio, swatch, swatch);
  ctx.fillStyle = cssToken("--nd-color-text");
  ctx.fillText("Baseline", lx + pad + swatch + 4 * ratio, contourY);

  const follX = lx + pad + swatch + 56 * ratio;
  ctx.fillStyle = rgbCss(CONTOUR_COLORS.followup);
  ctx.fillRect(follX, contourY + 2 * ratio, swatch, swatch);
  ctx.fillStyle = cssToken("--nd-color-text");
  ctx.fillText("Follow-up", follX + swatch + 4 * ratio, contourY);
  ctx.restore();
}

function draw() {
  canvas.dataset.mode = comparison ? activeView : "preview";
  updateViewHint();
  if (activeView === "report" && (comparison || lastFailure)) return;

  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * ratio));
  canvas.height = Math.max(1, Math.round(rect.height * ratio));
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const previewImage = baseline ?? followup;
  if (!previewImage) return;

  const imgW = comparison ? comparison.width : previewImage.width;
  const imgH = comparison ? comparison.height : previewImage.height;
  const scale = Math.min(canvas.width / imgW, canvas.height / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x0 = (canvas.width - drawW) / 2;
  const y0 = (canvas.height - drawH) / 2;
  viewBox = { scale, x: x0, y: y0, width: drawW, height: drawH };
  ctx.imageSmoothingEnabled = true;

  if (!comparison) {
    const src = baseline ? layers.baseline : layers.followup;
    ctx.drawImage(src, x0, y0, drawW, drawH);
    drawBadge(baseline ? "Baseline" : "Follow-up", x0 + 8 * ratio, y0 + 8 * ratio, ratio);
    return;
  }

  if (activeView === "curtain") {
    const splitPx = x0 + drawW * splitRatio;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, Math.max(0, splitPx - x0), drawH);
    ctx.clip();
    ctx.drawImage(layers.baseline, x0, y0, drawW, drawH);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(splitPx, y0, Math.max(0, x0 + drawW - splitPx), drawH);
    ctx.clip();
    ctx.drawImage(layers.followup, x0, y0, drawW, drawH);
    ctx.restore();

    if (overlayOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;
      ctx.drawImage(layers.contours, x0, y0, drawW, drawH);
      ctx.restore();
    }

    // Crisp curtain divider line and handle styled strictly with theme CSS tokens.
    ctx.save();
    ctx.strokeStyle = cssToken("--nd-color-primary");
    ctx.lineWidth = 2 * ratio;
    ctx.beginPath();
    ctx.moveTo(splitPx, y0);
    ctx.lineTo(splitPx, y0 + drawH);
    ctx.stroke();

    const handleY = y0 + drawH * 0.5;
    ctx.fillStyle = cssToken("--nd-color-primary");
    ctx.beginPath();
    ctx.arc(splitPx, handleY, 7 * ratio, 0, 2 * Math.PI);
    ctx.fill();
    ctx.lineWidth = 1.5 * ratio;
    ctx.strokeStyle = cssToken("--nd-color-bg");
    ctx.stroke();
    ctx.restore();

    drawBadge("Baseline", x0 + 8 * ratio, y0 + 8 * ratio, ratio);
    const rightLabel = "Aligned follow-up";
    ctx.font = `600 ${Math.round(11 * ratio)}px Inter, system-ui, sans-serif`;
    const rw = ctx.measureText(rightLabel).width + 12 * ratio;
    drawBadge(rightLabel, x0 + drawW - rw - 8 * ratio, y0 + 8 * ratio, ratio);
  } else if (activeView === "flicker") {
    const layer = flickerShowFollowup ? layers.followup : layers.baseline;
    ctx.drawImage(layer, x0, y0, drawW, drawH);
    if (overlayOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;
      ctx.drawImage(layers.contours, x0, y0, drawW, drawH);
      ctx.restore();
    }
    drawBadge(flickerShowFollowup ? "Aligned follow-up" : "Baseline", x0 + 8 * ratio, y0 + 8 * ratio, ratio);
  } else if (activeView === "checker") {
    ctx.drawImage(layers.checker, x0, y0, drawW, drawH);
    if (overlayOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;
      ctx.drawImage(layers.contours, x0, y0, drawW, drawH);
      ctx.restore();
    }
    drawBadge("Checkerboard", x0 + 8 * ratio, y0 + 8 * ratio, ratio);
  } else if (activeView === "diff") {
    ctx.drawImage(layers.diffUnderlay, x0, y0, drawW, drawH);
    if (overlayOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;
      ctx.drawImage(layers.heatmap, x0, y0, drawW, drawH);
      ctx.restore();
    }
    ctx.drawImage(layers.contours, x0, y0, drawW, drawH);
    drawBadge(`CIEDE2000 (0–${DELTA_E_SCALE_MAX} ΔE2000)`, x0 + 8 * ratio, y0 + 8 * ratio, ratio);
    drawDiffLegend(x0, y0, drawW, drawH, ratio);
  }
}

new ResizeObserver(() => draw()).observe(canvas);

function setView(view) {
  if (view === "report" && !comparison && !lastFailure) {
    status("Run alignment and comparison to view the report");
    toolbar.setActive(activeView);
    return;
  }
  activeView = view;
  toolbar.setActive(view);
  const showReport = view === "report" && Boolean(comparison || lastFailure);
  $("report").hidden = !showReport;
  canvas.hidden = showReport;
  syncFlicker();
  draw();
}

toolbar.addEventListener("nd-view-change", ({ detail }) => {
  setView(detail.value);
});

toolbar.addEventListener("nd-overlay-change", ({ detail }) => {
  overlayOpacity = detail.value;
  draw();
});

$("curtainSplit").addEventListener("input", (event) => {
  const pct = Math.max(0, Math.min(100, Number(event.target.value) || 0));
  splitRatio = pct / 100;
  event.target.setAttribute("aria-valuetext", `${Math.round(pct)}%`);
  draw();
});

$("flickerInterval").addEventListener("change", () => {
  const clamped = clampFlickerInterval($("flickerInterval").value);
  $("flickerInterval").value = String(clamped);
  if (activeView === "flicker") syncFlicker();
});

$("flickerToggle").addEventListener("click", () => {
  flickerPaused = !flickerPaused;
  syncFlicker();
  draw();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopFlicker();
  else if (activeView === "flicker" && comparison && !flickerPaused) syncFlicker();
});

// Pointer interaction: horizontal curtain wipe (active pointerId tracked) + pixel / ΔE2000 readout.
function pointerToImage(event) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height || !viewBox.scale) return null;
  const ratio = canvas.width / rect.width;
  const cx = (event.clientX - rect.left) * ratio;
  const cy = (event.clientY - rect.top) * ratio;
  return {
    cx,
    cy,
    ix: Math.floor((cx - viewBox.x) / viewBox.scale),
    iy: Math.floor((cy - viewBox.y) / viewBox.scale),
  };
}

function updateSplitFromPointer(event) {
  const pos = pointerToImage(event);
  if (!pos || viewBox.width <= 0) return;
  splitRatio = Math.max(0, Math.min(1, (pos.cx - viewBox.x) / viewBox.width));
  updatePlaybackControls();
  draw();
}

canvas.addEventListener("pointerdown", (event) => {
  if (!comparison || activeView !== "curtain" || event.button !== 0 || activePointerId !== null) return;
  activePointerId = event.pointerId;
  canvas.setPointerCapture(event.pointerId);
  updateSplitFromPointer(event);
});

canvas.addEventListener("pointermove", (event) => {
  const pos = pointerToImage(event);
  if (pos && comparison) {
    const { ix, iy } = pos;
    if (ix >= 0 && iy >= 0 && ix < comparison.width && iy < comparison.height) {
      const idx = iy * comparison.width + ix;
      const inValid = comparison.validMask[idx] === 1;
      const inDeltaE = comparison.deltaEMask[idx] === 1;
      const dEText = !inValid
        ? "outside valid FOV"
        : (inDeltaE ? comparison.deltaEMap[idx].toFixed(2) : "hair excluded");
      const region = comparison.baselineMask[idx] && comparison.followupMask[idx]
        ? "lesion (both)"
        : comparison.baselineMask[idx]
          ? "lesion (baseline)"
          : comparison.followupMask[idx]
            ? "lesion (follow-up)"
            : "skin";
      $("location").textContent = `x ${ix} · y ${iy} · ΔE2000 ${dEText}${inValid ? ` · ${region}` : ""}`;
    } else {
      $("location").textContent = "";
    }
  } else if (pos && (baseline || followup)) {
    const img = baseline ?? followup;
    if (pos.ix >= 0 && pos.iy >= 0 && pos.ix < img.width && pos.iy < img.height) {
      $("location").textContent = `x ${pos.ix} · y ${pos.iy}`;
    } else {
      $("location").textContent = "";
    }
  }
  if (activePointerId === event.pointerId) updateSplitFromPointer(event);
});

function releasePointer(event) {
  if (event.pointerId === activePointerId) activePointerId = null;
}

canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", releasePointer);
canvas.addEventListener("lostpointercapture", releasePointer);

// 4. Clinical comparison report rendering (shared design-system table classes).
const fmt = (value, digits = 2) => (value !== null && value !== undefined && Number.isFinite(value) ? Number(value).toFixed(digits) : "—");
const fmtSigned = (value, digits = 1) => (
  value !== null && value !== undefined && Number.isFinite(value)
    ? `${value >= 0 ? "+" : ""}${Number(value).toFixed(digits)}`
    : "—"
);

function segmentationStatusLabel(code) {
  if (code === "baseline-empty") return "Unavailable (baseline lesion mask empty)";
  if (code === "followup-empty") return "Unavailable (follow-up lesion mask empty)";
  if (code === "both-empty") return "Unavailable (no lesion segmented in either image)";
  return "Segmented in both images";
}

function growthStatusLabel(code) {
  if (code === "indeterminate-scale-fitted") return "Indeterminate (similarity scaling enabled — fitted magnification can absorb real lesion growth)";
  if (code === "indeterminate-fov-clipped") return "Indeterminate (lesion touches common valid FOV boundary)";
  if (code === "unavailable-empty-segmentation") return "Unavailable (lesion segmentation empty)";
  return "Measured at unit scale inside valid FOV";
}

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
    cells.forEach((cell, idx) => {
      const td = document.createElement("td");
      if (numericCols.includes(idx)) td.className = "nd-numeric";
      td.textContent = cell;
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(cap, thead, tbody);
  scroll.append(table);
  return scroll;
}

function renderFailureReport(reason) {
  const stack = document.createElement("div");
  stack.className = "nd-report-stack";
  const lead = document.createElement("p");
  lead.className = "nd-message error";
  lead.setAttribute("role", "alert");
  lead.textContent = `Registration failed: ${reason}. Scientific metrics and downloads are suppressed.`;
  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent = "Provide two dermoscopic images with overlapping field of view and visible surface texture.";
  stack.append(lead, notes);
  $("report").replaceChildren(stack);
}

function renderReport() {
  if (!comparison) {
    if (lastFailure) renderFailureReport(lastFailure);
    else $("report").replaceChildren();
    return;
  }
  const { registration: reg, metrics: m, preprocessing: prep, settings } = comparison;
  const scaleFitted = Boolean(settings.allowScale || m.growthStatus === "indeterminate-scale-fitted");
  const segOk = m.segmentationStatus === "ok";
  const stack = document.createElement("div");
  stack.className = "nd-report-stack";

  const lead = document.createElement("p");
  lead.className = "nd-report-lead";
  const areaLead = !segOk
    ? "Area change Unavailable"
    : scaleFitted
      ? `Post-alignment area diff ${fmtSigned(m.areaChangePct, 1)}% (scale-fitted, physical growth indeterminate)`
      : `Area change ${fmtSigned(m.areaChangePct, 1)}%`;
  lead.textContent = `NCC ${fmt(reg.initialNcc, 3)} → ${fmt(reg.alignedNcc, 3)} · ${areaLead} · Lesion mean ΔE2000 ${fmt(m.lesionMeanDeltaE, 2)} (95th pct ${fmt(m.lesionP95DeltaE, 2)})`;

  const regTable = buildTable(
    "Registration",
    ["Metric", "Value", "Units"],
    [
      { cells: ["Initial NCC", fmt(reg.initialNcc, 4), ""] },
      { cells: ["Aligned NCC", fmt(reg.alignedNcc, 4), ""] },
      { cells: ["Shift dx (sampling offset)", fmt(reg.dx, 2), "px"] },
      { cells: ["Shift dy (sampling offset)", fmt(reg.dy, 2), "px"] },
      { cells: ["Rotation (clockwise)", fmt(reg.angleDeg, 2), "°"] },
      { cells: ["Scale", fmt(reg.scale, 4), "×"] },
      { cells: ["Valid analysis overlap", String(m.validOverlapPx), "px²"] },
      { cells: ["Warped FOV overlap", fmt(reg.overlapPct, 1), "%"] },
    ],
    [1],
  );

  const areaRowLabel = scaleFitted ? "Post-alignment area difference (scale-fitted)" : "Area change";
  const diceRowLabel = scaleFitted ? "Post-alignment shape agreement (Dice)" : "Dice overlap";
  const jaccardRowLabel = scaleFitted ? "Post-alignment shape agreement (Jaccard)" : "Jaccard IoU";
  const areaFlag = segOk && !scaleFitted && !m.clippedByFov && Math.abs(m.areaChangePct) >= DESCRIPTIVE_THRESHOLDS.areaChangePct
    ? `descriptive threshold: |area| >= ${DESCRIPTIVE_THRESHOLDS.areaChangePct}%`
    : undefined;
  const p95Flag = m.lesionP95DeltaE !== null && m.lesionP95DeltaE > DESCRIPTIVE_THRESHOLDS.lesionP95DeltaE
    ? `descriptive threshold: p95 > ${DESCRIPTIVE_THRESHOLDS.lesionP95DeltaE}`
    : undefined;

  const changeRows = [
    { cells: ["Segmentation status", segmentationStatusLabel(m.segmentationStatus), ""], flag: segOk ? undefined : "unavailable" },
    { cells: ["Growth interpretation", growthStatusLabel(m.growthStatus), ""], flag: m.growthStatus !== "measured" ? m.growthStatus : undefined },
    { cells: ["FOV boundary clipping", m.clippedByFov ? "Yes — lesion touches common valid FOV edge" : "No", ""], flag: m.clippedByFov ? "fov-clipped" : undefined },
    { cells: ["Baseline lesion area", String(m.baselineAreaPx), "px²"] },
    { cells: ["Follow-up lesion area", String(m.followupAreaPx), "px²"] },
    { cells: [areaRowLabel, fmtSigned(m.areaChangePct, 1), segOk ? "%" : ""], flag: areaFlag },
    { cells: [diceRowLabel, fmt(m.dice, 3), ""] },
    { cells: [jaccardRowLabel, fmt(m.jaccard, 3), ""] },
    { cells: ["Centroid shift", fmt(m.centroidShiftPx, 2), segOk ? "px" : ""] },
    { cells: ["Lesion mean ΔE2000 (normalized)", fmt(m.lesionMeanDeltaE, 2), "ΔE2000"] },
    { cells: ["Lesion mean ΔE2000 (raw)", fmt(m.rawLesionMeanDeltaE, 2), "ΔE2000"] },
    { cells: ["Lesion 95th-pct ΔE2000", fmt(m.lesionP95DeltaE, 2), "ΔE2000"], flag: p95Flag },
    { cells: ["Lesion pixels ΔE2000 > 10", fmt(m.lesionDeltaEOver10Pct, 1), "%"] },
    { cells: ["Surrounding skin mean ΔE2000", fmt(m.skinMeanDeltaE, 2), "ΔE2000"] },
    { cells: ["Surrounding skin 95th-pct ΔE2000", fmt(m.skinP95DeltaE, 2), "ΔE2000"] },
    { cells: ["Overlap mean ΔE2000 (normalized / raw)", `${fmt(m.overlapMeanDeltaE, 2)} / ${fmt(m.rawOverlapMeanDeltaE, 2)}`, "ΔE2000"] },
    { cells: ["Hair-excluded ΔE2000 pixels", String(m.hairExcludedPx ?? 0), "px²"] },
  ];

  const changeTable = buildTable(
    scaleFitted ? "Post-alignment shape agreement & CIEDE2000 color change" : "Lesion morphometry & CIEDE2000 color change",
    ["Metric", "Value", "Units"],
    changeRows,
    [1],
  );

  const notes = document.createElement("p");
  notes.className = "nd-report-notes";
  notes.textContent = `Preprocessing: color constancy ${settings.normalizeColor ? `on (baseline RGB gains ${prep.baselineGains.join("/")}, follow-up ${prep.followupGains.join("/")})` : "off"}, hair suppression ${settings.suppressHair ? `on (baseline ${fmt(prep.baselineHairPct, 1)}%, follow-up ${fmt(prep.followupHairPct, 1)}%, excluded from ΔE2000)` : "off"}, scale ${settings.allowScale ? "allowed (0.85–1.15×)" : "rigid (1.0×)"}, max angle ±${settings.maxAngle}°. ${TRANSFORM_CONVENTION} Descriptive thresholds (|area| ≥ ${DESCRIPTIVE_THRESHOLDS.areaChangePct}%, p95 ΔE2000 > ${DESCRIPTIVE_THRESHOLDS.lesionP95DeltaE}) are descriptive review cues, not standalone clinical diagnostic criteria. References: Kittler et al. (2000, 2006), Korotkov & Garcia (2012), Sharma et al. (2005).`;

  stack.append(lead, regTable, changeTable, notes);
  $("report").replaceChildren(stack);
}

// 5. Results list and controls state.
const results = createResultList({
  element: $("resultList"),
  onView: (stage) => {
    if (!comparison) return;
    if (stage === "aligned") setView("curtain");
    else if (stage === "changeMap") setView("diff");
    else setView("report");
  },
  onDownload: (_stage, result) => downloadFile(result.file),
});

function setBusy(busy) {
  results.inert = busy;
  if (pair) pair.disabled = busy;
  for (const id of ["normalizeColor", "suppressHair", "allowScale", "maxAngle"]) {
    $(id).disabled = busy;
  }
  $("runButton").disabled = busy || !baseline || !followup;
  updatePlaybackControls();
}

function clearOutputs() {
  stopFlicker();
  comparison = null;
  lastFailure = null;
  outputs = {};
  results.render();
  $("outputSection").open = false;
  $("report").replaceChildren();
  $("location").textContent = "";
  releaseCanvas(layers.checker);
  releaseCanvas(layers.diffUnderlay);
  releaseCanvas(layers.heatmap);
  releaseCanvas(layers.contours);
  refreshBaselineLayer();
  refreshFollowupPreviewLayer();
  if (activeView === "report") {
    activeView = "curtain";
    toolbar.setActive("curtain");
    $("report").hidden = true;
    canvas.hidden = false;
  }
  $("emptyState").hidden = Boolean(baseline || followup);
  updatePlaybackControls();
  draw();
}

function beginOperation(message, signal) {
  if (loading || running) throw new Error("Wait for the current operation to finish, or cancel it.");
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
}

// 6. Image decoding & single-slot input workflow.
function guessMime(name) {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.webp$/i.test(name)) return "image/webp";
  return "";
}

async function decodeImageFile(file, signal) {
  if (!file || !file.size) throw new Error(`${file?.name || "Selected file"} is empty.`);
  if (file.size > LIMITS.maxFileBytes) {
    throw new Error(`${file.name} exceeds the ${Math.round(LIMITS.maxFileBytes / (1024 * 1024))} MB limit.`);
  }
  const buffer = await file.arrayBuffer();
  signal?.throwIfAborted();
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([buffer], { type: file.type || guessMime(file.name) }));
  } catch {
    throw new Error(`${file.name} is not a supported PNG or JPEG image.`);
  }
  try {
    signal?.throwIfAborted();
    const { width: originalWidth, height: originalHeight } = bitmap;
    if (originalWidth < LIMITS.minDimension || originalHeight < LIMITS.minDimension) {
      throw new Error(`${file.name} (${originalWidth} × ${originalHeight}) is smaller than ${LIMITS.minDimension} × ${LIMITS.minDimension} px.`);
    }
    if (originalWidth > LIMITS.maxDimension || originalHeight > LIMITS.maxDimension) {
      throw new Error(`${file.name} (${originalWidth} × ${originalHeight}) exceeds ${LIMITS.maxDimension} × ${LIMITS.maxDimension} px.`);
    }
    if (originalWidth * originalHeight > LIMITS.maxDecodedPixels) {
      throw new Error(`${file.name} (${originalWidth} × ${originalHeight}) exceeds the decoded pixel budget.`);
    }

    // Keep full decoded resolution (up to 16 MP) so both images retain their true relative
    // pixel pitch; the comparison worker applies one shared uniform working scale to both.
    const width = originalWidth;
    const height = originalHeight;

    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const offCtx = offscreen.getContext("2d");
    offCtx.drawImage(bitmap, 0, 0, width, height);
    const { data } = offCtx.getImageData(0, 0, width, height);
    offscreen.width = 0;
    offscreen.height = 0;
    return {
      file,
      width,
      height,
      originalWidth,
      originalHeight,
      rgba: new Uint8ClampedArray(data),
    };
  } finally {
    bitmap.close();
  }
}

pair = createImagePair({
  examples,
  slotLabels: { fixed: "Baseline", moving: "Follow-up" },
  exampleRoles: { fixed: "baseline", moving: "followup" },
  showFolder: false,
  read: (files) => {
    if (!files.length) throw new Error("Choose a PNG or JPEG dermoscopy image.");
    if (files.length > 1) {
      throw new Error("Select one image for baseline (and one for follow-up in its slot).");
    }
    return [{ name: files[0].name, file: files[0] }];
  },
  open: async (slot, candidate, { signal }) => {
    const decoded = candidate.decoded ?? await decodeImageFile(candidate.file, signal);
    candidate.decoded = decoded;
    if (slot === "fixed") {
      baseline = decoded;
      refreshBaselineLayer();
    } else {
      followup = decoded;
      refreshFollowupPreviewLayer();
    }
    return {
      name: decoded.file.name,
      dims: [decoded.width, decoded.height],
      dimensionality: 2,
    };
  },
  clear: (slot) => {
    if (slot === "fixed") {
      baseline = null;
      refreshBaselineLayer();
    } else {
      followup = null;
      refreshFollowupPreviewLayer();
    }
  },
  perform: async (message, task) => {
    const operation = beginOperation(message);
    loading = operation.controller;
    setBusy(true);
    progress.setCancellable(true);
    try {
      const out = await task(operation.controller.signal);
      progress.setProgress(0);
      return out;
    } catch (error) {
      progress.setProgress(0);
      throw error;
    } finally {
      loading = null;
      finishOperation(operation);
      setBusy(false);
    }
  },
  onStatus: (message, isError) => {
    if (isError) reportError(new Error(message));
    else status(message, false, "technical");
  },
  onChange: ({ slot, fixed, moving }) => {
    clearOutputs();
    $("emptyState").hidden = Boolean(baseline || followup);
    draw();
    setBusy(Boolean(loading || running));
    const loaded = slot === "fixed" ? fixed : moving;
    if (loaded) {
      const label = slot === "fixed" ? "Baseline" : "Follow-up";
      log.log(`${label}: ${loaded.image.name} · ${loaded.image.dims.join(" × ")}`, "info", "analysis");
    }
    if (baseline && followup) {
      status(`${loaded?.image.name ?? baseline.file.name} loaded · ready to compare`);
    } else if (baseline || followup) {
      const missing = baseline ? "follow-up" : "baseline";
      status(`${loaded?.image.name ?? (baseline || followup).file.name} loaded · add ${missing} image`);
    } else {
      progress.reset("Drag and drop files");
    }
  },
});
$("imagePair").replaceWith(pair);

// Invalidate stale comparison outputs whenever processing settings change.
function invalidateForSettingsChange() {
  if (!comparison && !lastFailure) return;
  clearOutputs();
  if (baseline && followup) status("Settings changed · click Align & compare");
}

for (const id of ["normalizeColor", "suppressHair", "allowScale", "maxAngle"]) {
  $(id).addEventListener("change", invalidateForSettingsChange);
}
$("maxAngle").addEventListener("input", invalidateForSettingsChange);

// 7. Web Worker invocation for alignment & change detection.
function runWorkerCompare(payload, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
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
      reject(new Error(event.message || "Comparison worker failed to start."));
    };
    worker.onmessageerror = () => {
      stop();
      reject(new Error("Comparison worker returned an unreadable message."));
    };
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") {
        onProgress?.(data.value, data.message);
        return;
      }
      stop();
      if (data.type === "error") {
        const err = new Error(data.message);
        if (data.code) err.code = data.code;
        reject(err);
      } else {
        resolve(data);
      }
    };
    // Clone typed arrays so baseline & followup stay intact if worker is cancelled.
    const bCopy = new Uint8ClampedArray(payload.baselineRgba);
    const fCopy = new Uint8ClampedArray(payload.followupRgba);
    try {
      worker.postMessage(
        {
          type: "compare",
          baselineRgba: bCopy,
          baselineWidth: payload.baselineWidth,
          baselineHeight: payload.baselineHeight,
          followupRgba: fCopy,
          followupWidth: payload.followupWidth,
          followupHeight: payload.followupHeight,
          settings: payload.settings,
        },
        [bCopy.buffer, fCopy.buffer],
      );
    } catch (error) {
      stop();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function readFormSettings() {
  return readSettings({
    normalizeColor: $("normalizeColor").checked,
    suppressHair: $("suppressHair").checked,
    allowScale: $("allowScale").checked,
    maxAngle: $("maxAngle").value,
  });
}

function applyFormSettings(settings) {
  $("normalizeColor").checked = settings.normalizeColor;
  $("suppressHair").checked = settings.suppressHair;
  $("allowScale").checked = settings.allowScale;
  $("maxAngle").value = String(settings.maxAngle);
}

async function executeComparisonLocked(current, settings, onAutomationProgress) {
  log.log(`Starting comparison: baseline ${baseline.file.name} vs follow-up ${followup.file.name} (normalizeColor=${settings.normalizeColor}, suppressHair=${settings.suppressHair}, allowScale=${settings.allowScale}, maxAngle=${settings.maxAngle}°)`, "info", "technical");
  const result = await runWorkerCompare(
    {
      baselineRgba: baseline.rgba,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
      followupRgba: followup.rgba,
      followupWidth: followup.width,
      followupHeight: followup.height,
      settings,
    },
    {
      signal: current,
      onProgress: (value, message) => {
        progress.setProgress(value, message);
        onAutomationProgress?.({ value, message });
      },
    },
  );
  current.throwIfAborted();

  const provenance = buildProvenance({
    baseline: {
      name: baseline.file.name,
      width: result.width,
      height: result.height,
      originalWidth: baseline.originalWidth,
      originalHeight: baseline.originalHeight,
    },
    followup: {
      name: followup.file.name,
      width: result.followupWidth ?? followup.width,
      height: result.followupHeight ?? followup.height,
      originalWidth: followup.originalWidth,
      originalHeight: followup.originalHeight,
    },
    settings,
    preprocessing: result.preprocessing,
    registration: result.registration,
    metrics: result.metrics,
    elapsedSeconds: result.elapsedSeconds,
  });

  const stem = `${outputStem(baseline.file.name)}_vs_${outputStem(followup.file.name)}`;
  const alignedFile = new File([result.alignedPng], `${stem}_aligned.png`, { type: "image/png" });
  const changeMapFile = new File([result.changeMapPng], `${stem}_deltaE2000.png`, { type: "image/png" });
  const metricsFile = new File([metricsCsv({ ...result, settings })], `${stem}_metrics.csv`, { type: "text/csv" });
  const provenanceFile = new File([provenanceJson(provenance)], `${stem}_provenance.json`, { type: "application/json" });

  comparison = {
    ...result,
    settings,
    provenance,
  };
  lastFailure = null;
  outputs = {
    aligned: { description: "Aligned follow-up · PNG", file: alignedFile },
    changeMap: { description: "ΔE2000 change map · PNG", file: changeMapFile },
    metrics: { description: "Comparison metrics · CSV", file: metricsFile },
    provenance: { description: "Provenance report · JSON", file: provenanceFile },
  };

  refreshBaselineLayer();
  refreshComparisonLayers();
  renderReport();
  results.render(outputs);
  $("outputSection").open = true;
  $("emptyState").hidden = true;
  updatePlaybackControls();
  syncFlicker();
  draw();

  const areaSummary = result.metrics.segmentationStatus !== "ok"
    ? "area Unavailable"
    : settings.allowScale
      ? `post-align area diff ${fmtSigned(result.metrics.areaChangePct, 1)}% (scale-fitted)`
      : `area ${fmtSigned(result.metrics.areaChangePct, 1)}%`;
  const summary = `Aligned (NCC ${fmt(result.registration.initialNcc, 3)} → ${fmt(result.registration.alignedNcc, 3)}, ${areaSummary}, mean ΔE2000 ${fmt(result.metrics.lesionMeanDeltaE, 2)})`;
  progress.end(summary);
  status(summary);
  log.log(`Transform: dx=${fmt(result.registration.dx, 3)} px, dy=${fmt(result.registration.dy, 3)} px, angle=${fmt(result.registration.angleDeg, 3)}°, scale=${fmt(result.registration.scale, 4)}×, overlap=${fmt(result.registration.overlapPct, 2)}% (${result.elapsedSeconds.toFixed(2)} s)`, "info", "technical");

  return {
    artifacts: [
      { role: "aligned", file: alignedFile },
      { role: "changeMap", file: changeMapFile },
      { role: "metrics", file: metricsFile },
      { role: "provenance", file: provenanceFile },
    ],
    provenance,
    measurements: {
      ...result.registration,
      ...result.metrics,
    },
  };
}

async function runCompare(signal, requestedSettings = null, onAutomationProgress = null) {
  if (!baseline || !followup) throw new Error("Load both a baseline and a follow-up image before comparing.");
  const settings = requestedSettings ?? readFormSettings();
  const operation = beginOperation("Aligning and comparing dermoscopy pair…", signal);
  running = operation.controller;
  setBusy(true);
  progress.setCancellable(true);
  const current = operation.controller.signal;
  clearOutputs();

  try {
    return await executeComparisonLocked(current, settings, onAutomationProgress);
  } catch (error) {
    clearOutputs();
    if (error?.code === "REGISTRATION_FAILED") {
      lastFailure = error.message;
      renderReport();
      draw();
      progress.end(error.message, { success: false });
    } else {
      progress.reset(baseline && followup ? "Ready" : "Drag and drop files");
    }
    throw error;
  } finally {
    running = null;
    finishOperation(operation);
    setBusy(false);
  }
}

$("runButton").addEventListener("click", () => {
  let settings;
  try {
    settings = readFormSettings();
  } catch (error) {
    reportError(error);
    return;
  }
  void runCompare(undefined, settings).catch(reportError);
});

$("cancelButton").onclick = () => {
  pair.exampleControl?.cancel();
  loading?.abort();
  running?.abort();
};

// 8. Automation contract (WebMCP & desktop automation).
// Acquires the single operation lock BEFORE mutating form settings or loading inputs.
registerAppAutomation({
  app: APP.id,
  operations: {
    compare: async ({ inputs, parameters, signal, progress: reportProgress }) => {
      const settings = readSettings({ ...readFormSettings(), ...parameters });
      const baseFile = inputs?.baseline?.[0];
      const follFile = inputs?.followup?.[0];
      if (!baseFile || !follFile) {
        throw new Error("Both baseline and followup image files are required.");
      }

      const operation = beginOperation("Aligning and comparing dermoscopy pair…", signal);
      running = operation.controller;
      setBusy(true);
      progress.setCancellable(true);
      const current = operation.controller.signal;
      try {
        // Apply settings only AFTER acquiring the operation lock, and decode both files
        // before committing either slot so a corrupt second file never leaves a mixed pair.
        applyFormSettings(settings);
        const [bDecoded, fDecoded] = await Promise.all([
          decodeImageFile(baseFile, current),
          decodeImageFile(follFile, current),
        ]);
        current.throwIfAborted();
        await pair.useWithin("fixed", { name: baseFile.name, file: baseFile, decoded: bDecoded }, current);
        await pair.useWithin("moving", { name: follFile.name, file: follFile, decoded: fDecoded }, current);
        current.throwIfAborted();

        return await executeComparisonLocked(current, settings, reportProgress);
      } catch (error) {
        clearOutputs();
        if (error?.code === "REGISTRATION_FAILED") {
          lastFailure = error.message;
          renderReport();
          draw();
          progress.end(error.message, { success: false });
        } else {
          progress.reset(baseline && followup ? "Ready" : "Drag and drop files");
        }
        throw error;
      } finally {
        running = null;
        finishOperation(operation);
        setBusy(false);
      }
    },
  },
});

window.addEventListener("pagehide", () => {
  stopFlicker();
  pair.exampleControl?.cancel();
  loading?.abort();
  running?.abort();
});

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    syncFlicker();
    draw();
  }
});

updatePlaybackControls();
setBusy(false);

export default Object.freeze({ workspace, toolbar, log, info, results, comparison: () => comparison });
