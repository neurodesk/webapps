// Functional MRS SVG charts: metabolite time courses, QC time courses and
// per-transient frequency/phase drift. Pure: numbers and labels in, SVG string
// out, styled with the same .lcm-* theme-token classes as spectrum-plot.js.

import { tickStep } from "./spectrum-plot.js";

const WIDTH = 800;
const MARGIN = { top: 18, right: 18, bottom: 32, left: 56 };

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function finiteExtent(values, fallback = [0, 1]) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return fallback;
  if (!(hi > lo)) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

function drawEventBands(parts, events, baseline, xFn, xMin, xMax, yTop, plotH) {
  if (!events?.length) return;
  for (const ev of events) {
    if (baseline && ev.condition === baseline) continue;
    const start = Math.max(ev.onset, xMin);
    const end = Math.min(ev.onset + ev.duration, xMax);
    if (!(end > start)) continue;
    const x0 = xFn(start);
    const x1 = xFn(end);
    parts.push(`<rect class="lcm-gap" x="${x0.toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${plotH.toFixed(1)}"><title>${escapeXml(ev.condition)} (${ev.onset}–${ev.onset + ev.duration} s)</title></rect>`);
  }
}

function drawPanel({
  xMin, xMax, yMin, yMax,
  yTop, plotH, xLeft, plotW,
  yLabel, showXAxis, xLabel,
  events, baselineCondition,
  categories = null,
  series,
  referenceLine,
}) {
  const parts = [];
  const x = (t) => xLeft + ((t - xMin) / Math.max(1e-9, xMax - xMin)) * plotW;
  const y = (v) => yTop + (1 - (v - yMin) / Math.max(1e-9, yMax - yMin)) * plotH;

  if (!categories) {
    drawEventBands(parts, events, baselineCondition, x, xMin, xMax, yTop, plotH);
  }

  // Horizontal grid + Y ticks
  const yStep = tickStep(yMax - yMin, 4);
  for (let tv = Math.ceil(yMin / yStep) * yStep; tv <= yMax + 1e-9; tv += yStep) {
    const ty = y(tv).toFixed(1);
    parts.push(`<line class="lcm-grid" x1="${xLeft}" x2="${xLeft + plotW}" y1="${ty}" y2="${ty}"/>`);
    parts.push(`<text x="${xLeft - 6}" y="${(Number(ty) + 3).toFixed(1)}" text-anchor="end">${Number(tv.toPrecision(4))}</text>`);
  }

  // Vertical grid + optional X ticks (categorical or numeric time)
  if (categories?.length) {
    categories.forEach((label, idx) => {
      const px = x(idx).toFixed(1);
      parts.push(`<line class="lcm-grid" x1="${px}" x2="${px}" y1="${yTop.toFixed(1)}" y2="${(yTop + plotH).toFixed(1)}"/>`);
      if (showXAxis) {
        parts.push(`<text x="${px}" y="${(yTop + plotH + 14).toFixed(1)}" text-anchor="middle">${escapeXml(label)}</text>`);
      }
    });
  } else {
    const xStep = tickStep(xMax - xMin, 8);
    for (let tx = Math.ceil(xMin / xStep) * xStep; tx <= xMax + 1e-9; tx += xStep) {
      const px = x(tx).toFixed(1);
      parts.push(`<line class="lcm-grid" x1="${px}" x2="${px}" y1="${yTop.toFixed(1)}" y2="${(yTop + plotH).toFixed(1)}"/>`);
      if (showXAxis) {
        parts.push(`<text x="${px}" y="${(yTop + plotH + 14).toFixed(1)}" text-anchor="middle">${Number(tx.toFixed(1))}</text>`);
      }
    }
  }

  parts.push(`<line class="lcm-axis" x1="${xLeft}" x2="${xLeft + plotW}" y1="${(yTop + plotH).toFixed(1)}" y2="${(yTop + plotH).toFixed(1)}"/>`);
  parts.push(`<line class="lcm-axis" x1="${xLeft}" x2="${xLeft}" y1="${yTop.toFixed(1)}" y2="${(yTop + plotH).toFixed(1)}"/>`);
  if (yLabel) {
    const midY = yTop + plotH / 2;
    parts.push(`<text class="lcm-label" x="14" y="${midY.toFixed(1)}" text-anchor="middle" transform="rotate(-90 14 ${midY.toFixed(1)})">${escapeXml(yLabel)}</text>`);
  }
  if (showXAxis && xLabel) {
    parts.push(`<text x="${(xLeft + plotW / 2).toFixed(1)}" y="${(yTop + plotH + 28).toFixed(1)}" text-anchor="middle">${escapeXml(xLabel)}</text>`);
  }

  if (Number.isFinite(referenceLine) && referenceLine >= yMin && referenceLine <= yMax) {
    const ry = y(referenceLine).toFixed(1);
    parts.push(`<line class="lcm-background" x1="${xLeft}" x2="${xLeft + plotW}" y1="${ry}" y2="${ry}"/>`);
  }

  for (const s of series) {
    const valid = s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!valid.length) continue;
    if (s.connect !== false && !categories && valid.length >= 2) {
      const pts = valid.map((p) => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
      parts.push(`<polyline class="lcm-${escapeXml(s.kind)}" points="${pts}"><title>${escapeXml(s.label)}</title></polyline>`);
    }
    if (s.errorBars) {
      for (const p of valid) {
        if (!Number.isFinite(p.err) || !(p.err > 0)) continue;
        const px = x(p.x).toFixed(1);
        const yLo = y(Math.max(yMin, p.y - p.err)).toFixed(1);
        const yHi = y(Math.min(yMax, p.y + p.err)).toFixed(1);
        parts.push(`<line class="lcm-residual" x1="${px}" x2="${px}" y1="${yLo}" y2="${yHi}"/>`);
      }
    }
    for (const p of valid) {
      const px = x(p.x).toFixed(1);
      const py = y(p.y).toFixed(1);
      const cls = p.flagged ? "lcm-point-flag" : `lcm-point-${escapeXml(s.kind)}`;
      const r = p.flagged ? 3.5 : 3;
      const tip = p.tip ? `<title>${escapeXml(p.tip)}</title>` : "";
      parts.push(`<circle class="${cls}" cx="${px}" cy="${py}" r="${r}">${tip}</circle>`);
    }
  }
  return parts.join("");
}

/**
 * Single-panel metabolite time course over time (s) or discrete pooled
 * conditions (`categories`), with optional stimulus shading and %SD error bars.
 */
export function timeCourseSvg({
  points,
  events = [],
  baselineCondition = null,
  categories = null,
  yLabel = "Concentration",
  xLabel = "Time (s)",
  referenceLine = null,
  height = 360,
  ariaLabel = "Metabolite time course",
}) {
  const xs = points.map((p) => p.x).filter(Number.isFinite);
  const evMax = events.reduce((m, e) => Math.max(m, e.onset + e.duration), 0);
  const xMin = categories?.length ? -0.5 : (xs.length ? Math.min(0, ...xs) : 0);
  const xMax = categories?.length ? Math.max(0.5, categories.length - 0.5) : Math.max(evMax, xs.length ? Math.max(...xs) : 1, xMin + 1);
  const yVals = [];
  for (const p of points) {
    if (!Number.isFinite(p.y)) continue;
    yVals.push(p.y);
    if (Number.isFinite(p.err) && p.err > 0) {
      yVals.push(p.y - p.err, p.y + p.err);
    }
  }
  const [yMin, yMax] = finiteExtent(yVals);
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const body = drawPanel({
    xMin, xMax, yMin, yMax,
    yTop: MARGIN.top, plotH, xLeft: MARGIN.left, plotW,
    yLabel, showXAxis: true, xLabel,
    events, baselineCondition,
    categories,
    referenceLine,
    series: [{ label: yLabel, kind: "fit", errorBars: true, points }],
  });
  return `<svg class="lcm-plot" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">${body}</svg>`;
}

/**
 * Three-panel fMRS QC time course: Linewidth (Hz, comparing matching FID-A
 * pre-match and post-match estimators when BOLD linewidth matching is active),
 * LCModel S/N, and tNAA/tCr across windows or pooled conditions.
 */
export function qcTimeCourseSvg({
  windows,
  events = [],
  baselineCondition = null,
  categories = null,
  height = 520,
  ariaLabel = "fMRS quality control time courses",
}) {
  const xAt = (w, idx) => (categories?.length ? idx : w.midTimeS);
  const xs = windows.map(xAt).filter(Number.isFinite);
  const evMax = events.reduce((m, e) => Math.max(m, e.onset + e.duration), 0);
  const xMin = categories?.length ? -0.5 : (xs.length ? Math.min(0, ...xs) : 0);
  const xMax = categories?.length ? Math.max(0.5, categories.length - 0.5) : Math.max(evMax, xs.length ? Math.max(...xs) : 1, xMin + 1);
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const gap = 22;
  const panelH = (height - MARGIN.top - MARGIN.bottom - 2 * gap) / 3;

  const hasBold = windows.some((w) => (w.linewidthMatchStatus && w.linewidthMatchStatus !== "off") || (w.broadeningAppliedHz ?? 0) > 0.05);
  const lwBefore = windows.map((w, idx) => ({
    x: xAt(w, idx),
    y: w.linewidthBeforeHz ?? null,
    tip: `${w.label}: pre-match FID-A LW ${w.linewidthBeforeHz?.toFixed(1) ?? "?"} Hz`,
  }));
  const lwAfter = windows.map((w, idx) => ({
    x: xAt(w, idx),
    y: hasBold ? (w.linewidthAfterHz ?? null) : (w.lwHz ?? w.linewidthAfterHz ?? null),
    flagged: w.qc?.status === "FAIL",
    tip: hasBold
      ? `${w.label}: post-match FID-A LW ${w.linewidthAfterHz != null ? `${w.linewidthAfterHz.toFixed(1)} Hz` : "unavailable"} (${w.linewidthMatchStatus ?? ""}; LCModel ${w.lwHz?.toFixed(1) ?? "?"} Hz)`
      : `${w.label}: fit LW ${(w.lwHz ?? w.linewidthAfterHz)?.toFixed(1) ?? "?"} Hz (${w.qc?.status ?? ""})`,
  }));
  const snrPts = windows.map((w, idx) => ({
    x: xAt(w, idx),
    y: w.lcmSnr,
    flagged: w.qc?.status === "FAIL",
    tip: `${w.label}: S/N ${w.lcmSnr ?? "?"}`,
  }));
  const ratioPts = windows.map((w, idx) => ({
    x: xAt(w, idx),
    y: w.qc?.tNaaToTCr,
    flagged: w.qc?.status === "FAIL",
    tip: `${w.label}: ${w.qc?.tNaaToTCrBasis ?? "tNAA/tCr"} ${w.qc?.tNaaToTCr?.toFixed(3) ?? "?"}`,
  }));

  const [lwMin, lwMax] = finiteExtent(
    hasBold ? [...lwBefore.map((p) => p.y), ...lwAfter.map((p) => p.y)] : lwAfter.map((p) => p.y),
    [0, 30],
  );
  const [snrMin, snrMax] = finiteExtent(snrPts.map((p) => p.y), [0, 20]);
  const [rMin, rMax] = finiteExtent(ratioPts.map((p) => p.y), [0.5, 2.5]);

  const lwSeries = hasBold
    ? [
        { label: "Pre-match FID-A LW (Hz)", kind: "reference", points: lwBefore },
        { label: "Post-match FID-A LW (Hz)", kind: "fit", points: lwAfter },
      ]
    : [{ label: "Linewidth (Hz)", kind: "fit", points: lwAfter }];

  const panels = [
    drawPanel({
      xMin, xMax, yMin: lwMin, yMax: lwMax,
      yTop: MARGIN.top, plotH: panelH, xLeft: MARGIN.left, plotW,
      yLabel: "LW (Hz)", showXAxis: false, xLabel: "",
      events, baselineCondition, categories,
      series: lwSeries,
    }),
    drawPanel({
      xMin, xMax, yMin: snrMin, yMax: snrMax,
      yTop: MARGIN.top + panelH + gap, plotH: panelH, xLeft: MARGIN.left, plotW,
      yLabel: "LCModel S/N", showXAxis: false, xLabel: "",
      events, baselineCondition, categories,
      series: [{ label: "LCModel S/N", kind: "fit", points: snrPts }],
    }),
    drawPanel({
      xMin, xMax, yMin: rMin, yMax: rMax,
      yTop: MARGIN.top + 2 * (panelH + gap), plotH: panelH, xLeft: MARGIN.left, plotW,
      yLabel: "tNAA / tCr", showXAxis: true, xLabel: categories?.length ? "Condition" : "Time (s)",
      events, baselineCondition, categories,
      series: [{ label: "tNAA / tCr", kind: "fit", points: ratioPts }],
    }),
  ];

  return `<svg class="lcm-plot" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">${panels.join("")}</svg>`;
}

/**
 * Two-panel per-transient QC trace: frequency drift (Hz) and phase drift (deg)
 * across raw transient timestamps, with bad-average flags and stimulus shading.
 */
export function transientDriftSvg({
  transients,
  events = [],
  baselineCondition = null,
  height = 420,
  ariaLabel = "Per-transient frequency and phase drift",
}) {
  const xs = transients.map((t) => t.timeS).filter(Number.isFinite);
  const evMax = events.reduce((m, e) => Math.max(m, e.onset + e.duration), 0);
  const xMin = xs.length ? Math.min(0, ...xs) : 0;
  const xMax = Math.max(evMax, xs.length ? Math.max(...xs) : 1, xMin + 1);
  const plotW = WIDTH - MARGIN.left - MARGIN.right;
  const gap = 24;
  const panelH = (height - MARGIN.top - MARGIN.bottom - gap) / 2;

  const freqPts = transients.map((t) => ({
    x: t.timeS,
    y: t.kept ? t.freqHz : 0,
    flagged: !t.kept,
    tip: `#${t.index + 1} (${t.timeS.toFixed(1)} s): ${t.kept ? `${t.freqHz?.toFixed(2) ?? "0"} Hz` : "removed bad average"}`,
  }));
  const phasePts = transients.map((t) => ({
    x: t.timeS,
    y: t.kept ? t.phaseDeg : 0,
    flagged: !t.kept,
    tip: `#${t.index + 1} (${t.timeS.toFixed(1)} s): ${t.kept ? `${t.phaseDeg?.toFixed(1) ?? "0"} deg` : "removed bad average"}`,
  }));
  const [fMin, fMax] = finiteExtent(freqPts.map((p) => p.y), [-5, 5]);
  const [pMin, pMax] = finiteExtent(phasePts.map((p) => p.y), [-15, 15]);

  const keptFreq = freqPts.filter((p) => !p.flagged);
  const badFreq = freqPts.filter((p) => p.flagged);
  const keptPhase = phasePts.filter((p) => !p.flagged);
  const badPhase = phasePts.filter((p) => p.flagged);

  const panels = [
    drawPanel({
      xMin, xMax, yMin: fMin, yMax: fMax,
      yTop: MARGIN.top, plotH: panelH, xLeft: MARGIN.left, plotW,
      yLabel: "Freq drift (Hz)", showXAxis: false, xLabel: "",
      events, baselineCondition, referenceLine: 0,
      series: [
        { label: "Frequency drift (Hz)", kind: "fit", points: keptFreq },
        { label: "Removed averages", kind: "residual", connect: false, points: badFreq },
      ],
    }),
    drawPanel({
      xMin, xMax, yMin: pMin, yMax: pMax,
      yTop: MARGIN.top + panelH + gap, plotH: panelH, xLeft: MARGIN.left, plotW,
      yLabel: "Phase (deg)", showXAxis: true, xLabel: "Time (s)",
      events, baselineCondition, referenceLine: 0,
      series: [
        { label: "Phase drift (deg)", kind: "fit", points: keptPhase },
        { label: "Removed averages", kind: "residual", connect: false, points: badPhase },
      ],
    }),
  ];
  return `<svg class="lcm-plot" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${escapeXml(ariaLabel)}">${panels.join("")}</svg>`;
}
